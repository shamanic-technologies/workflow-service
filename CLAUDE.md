# Workflow Service

Workflow orchestration service powered by Windmill. Translates internal DAG format to Windmill OpenFlow, manages workflow lifecycle, and tracks executions.

## Commands
- `npm test` — run all tests (Vitest)
- `npm run test:unit` — unit tests only
- `npm run test:integration` — integration tests only
- `npm run build` — compile TypeScript + generate OpenAPI spec
- `npm run dev` — local dev server (tsx watch)
- `npm start` — start production server
- `npm run generate:openapi` — regenerate openapi.json from Zod schemas

## Architecture
- `src/routes/workflows.ts` — CRUD workflow endpoints
- `src/routes/workflow-runs.ts` — Execution + status endpoints
- `src/lib/windmill-client.ts` — HTTP client for Windmill REST API
- `src/lib/dag-to-openflow.ts` — Core: translates our DAG → Windmill OpenFlow
- `src/lib/dag-validator.ts` — Validates DAG structure before translation
- `src/lib/node-type-registry.ts` — Maps node types to Windmill script paths
- `src/lib/input-mapping.ts` — Translates $ref syntax to Windmill input transforms
- `src/lib/job-poller.ts` — Background polling of running Windmill jobs
- `scripts/nodes/` — TypeScript scripts deployed to Windmill (one per node type)

## Key concepts
- Our DAG format: `{ nodes: [{id, type, config, inputMapping}], edges: [{from, to, condition?}] }`
- Windmill OpenFlow: `{ value: { modules: [...] }, schema: {...} }`
- Input mapping: `$ref:node-id.output.field` → `results.node_id.field` in Windmill
- Node scripts in Windmill call our existing services via HTTP
- Stubs throw errors with clear messages until the real service is built

## Rules
- Never edit `openapi.json` manually — regenerate with `npm run generate:openapi`
- Commit `openapi.json` alongside schema changes in `src/schemas.ts`
- When adding a node type: update `node-type-registry.ts` + create script in `scripts/nodes/`
- Every bug fix must include a regression test

## Workflow naming and versioning

Workflows follow a dynasty model: each workflow belongs to a lineage (dynasty) that tracks its evolution through upgrades. Names and slugs are derived from the feature dynasty name (from features-service) and a poetic signature name generated once per dynasty.

### Database columns

| Column | Type | Unique? | Description |
|---|---|---|---|
| `slug` | text | Yes (globally) | Technical identifier, immutable once created. Used as API key for execution (`POST /execute/:slug`). |
| `name` | text | Yes (globally) | Human-readable display name. |
| `signature_name` | text | Unique among active workflows within the same `feature_slug` | Poetic word generated deterministically from the DAG hash. Set once at dynasty creation, never changes within the dynasty. |
| `dynasty_name` | text | No | Stable name for the lineage. Constant across all versions of a dynasty. |
| `signature` | text | Unique per `(feature_slug, status='active')` | Hash of the DAG structure. Used for deduplication on upgrade. |
| `version` | integer | No | Version number within the dynasty. Starts at 1. |
| `feature_slug` | text | No | Reference to the feature in features-service. Passed by clients. |

### Name composition

All workflow names are derived from two sources:
- **`feature_dynasty_name`** and **`feature_dynasty_slug`**: fetched from features-service using the `feature_slug`. These are the stable (unversioned) names of the feature. Never use `feature_name` or `feature_slug` directly, as those may contain version suffixes (e.g. "Sales Cold Outreach v2").
- **`signature_name`**: the poetic word generated once at dynasty creation (e.g. "obsidian").

```
dynasty_name = feature_dynasty_name + " " + signature_name
slug         = feature_dynasty_slug + "-" + signature_name [+ "-v{N}" if N >= 2]
name         = dynasty_name [+ " v{N}" if N >= 2]
```

Example with `feature_dynasty_name = "Sales Cold Outreach"`, `signature_name = "obsidian"`, version 3:
```
dynasty_name:  "Sales Cold Outreach Obsidian"
slug:          "sales-cold-outreach-obsidian-v3"
name:          "Sales Cold Outreach Obsidian v3"
```

No `-v1` or `v1` suffix for version 1 — the first version has no version suffix in slug or name.

### Operations and behavior

**Creation (new workflow, new dynasty):**
- Generate a new `signature_name` (poetic word, unique among active workflows for this `feature_slug`).
- Fetch `feature_dynasty_name` and `feature_dynasty_slug` from features-service.
- Set `version = 1`. No version suffix in slug or name.
- Compose `dynasty_name`, `slug`, `name` per the formulas above.

**Upgrade (DAG changed) — via `PUT /workflows/upgrade`:**
- Match existing active workflow by `feature_slug` (one active workflow per feature_slug).
- If `signature` unchanged → update metadata in-place, no new record.
- If `signature` changed:
  - Deprecate the old workflow (`status = "deprecated"`, `upgraded_to = new.id`).
  - Create new workflow with same `signature_name` and `dynasty_name`.
  - Increment `version`. Add version suffix to `slug` and `name` (e.g. `-v2`, `v2`).

**Fork (new style):**
- Creates a new dynasty — new `signature_name`, new `dynasty_name`.
- `version = 1`, no version suffix.
- `forked_from` points to the source workflow (for lineage tracking only).

**PATCH (individual workflow):**
- Metadata-only: can update `description`, `display_name`, `tags`, `category`, etc.
- DAG changes are forbidden via PATCH. Structural changes go through `PUT /workflows/upgrade`.

### Lineage convergence

When two dynasties evolve independently and eventually produce the same DAG for the same `feature_slug`:
- The upgrade that arrives second finds an active workflow with the same `(feature_slug, signature)`.
- It does NOT create a new workflow. Instead, it deprecates its own predecessor and sets `upgraded_to` pointing to the already-existing active workflow.
- The two lineages now converge on a single active workflow.
- Ancestors from both branches retain their original `dynasty_name`.

### Stats aggregation across lineages

Stats (costs, email metrics, completed runs) are aggregated across the entire upgrade chain using `getUpgradeChainIds()` in `workflow-scoring.ts`.

- The function builds a `predecessorMap` (`Map<string, string[]>`) from all deprecated workflows' `upgraded_to` pointers.
- BFS traversal from the active workflow collects ALL ancestors, including multiple branches when lineages have converged.
- A `visited` set prevents double-counting.
- Stats are aggregated by `slug` (formerly `name`) across the entire chain, then summed.

This means: if dynasty A and dynasty B converge, the active workflow's stats include runs from both lineages — which is the correct behavior.

### Dependency on features-service

Workflow-service needs `feature_dynasty_name` and `feature_dynasty_slug` from features-service. These are the stable, unversioned identifiers for a feature (as opposed to `feature_name`/`feature_slug` which may carry version suffixes).

- Workflow-service receives only `feature_slug` from clients in requests.
- It calls `GET /features/dynasty?slug=<featureSlug>` on features-service to resolve `feature_dynasty_name` and `feature_dynasty_slug`.
- Falls back to slug derivation (strip `-v{N}`, capitalize words) if features-service is not configured or unreachable.
- Requires env vars: `FEATURES_SERVICE_URL`, `FEATURES_SERVICE_API_KEY`.
