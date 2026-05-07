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
- **Always forward ALL downstream headers.** Every service-to-service call MUST spread `DownstreamHeaders` (from `src/lib/downstream-headers.ts`) into the fetch headers. Never cherry-pick individual headers — use `extractDownstreamHeaders(req)` in routes and pass the full object through. Missing headers don't always crash, but they silently break tracing and logging in downstream services.

## Database migrations

Migrations are **auto-applied on startup** via `drizzle-orm/postgres-js/migrator` (see `src/index.ts`). The service runs `migrate(db, { migrationsFolder: "./drizzle" })` before listening.

**All migrations MUST go in `drizzle/`** — never create a separate `migrations/` folder. The startup migrator only reads from `drizzle/`.

When adding a migration:
1. Create `drizzle/NNNN_description.sql` (next sequential number)
2. Add an entry to `drizzle/meta/_journal.json` with the matching `tag` and next `idx`
3. Use `IF NOT EXISTS` / `DO $$ BEGIN ... END $$` guards to make migrations idempotent
4. Use `--> statement-breakpoint` between statements (drizzle convention)
5. Commit the migration file + journal update in the same PR as the schema change

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

### Lineage columns

Lineage is tracked by two forward-pointing columns on every workflow row:

| Column | Type | Description |
|---|---|---|
| `creation_type` | text, NOT NULL, CHECK in (`scratch`, `upgrade`, `fork`) | How this row was created. |
| `created_from_workflow` | uuid, nullable | Predecessor row id. Null only when `creation_type='scratch'`. |

The legacy `upgraded_to` and `forked_from` columns are gone. The successor of a deprecated row is found by reverse lookup: `SELECT id FROM workflows WHERE created_from_workflow = <deprecated.id> AND creation_type = 'upgrade'`.

### Operations and behavior

**Creation — `POST /workflows/create`:**
- Body: `{ featureSlug, description, hints?, style? }`. LLM generates the DAG.
- If an active workflow with the same `(orgId, featureSlug, signature)` already exists, returns 200 with that row unchanged (idempotent).
- Otherwise inserts a new row with `creation_type='scratch'`, `created_from_workflow=NULL`, `version=1`, no version suffix.
- This endpoint never upgrades existing dynasties.

**Upgrade — `POST /workflows/upgrade`:**
- Body: `{ workflowSlug, description, hints? }`. LLM regenerates the DAG.
- 404 if no active workflow matches `workflowSlug`.
- If the new signature equals the existing one → in-place update, returns 200.
- Otherwise inserts a new row in the **same** dynasty (`dynasty_slug`, `dynasty_name` unchanged) with `creation_type='upgrade'`, `created_from_workflow=existing.id`, `version=existing.version+1`, version suffix on `slug`/`name`. The predecessor is deprecated via `deprecateWorkflow()` (which also deletes its Windmill flow when no active campaign still references it). Returns 201.

**Fork — `PUT /workflows/{id}` with a DAG of new signature:**
- Inserts a new dynasty (new `signature_name`, new `dynasty_name`) with `creation_type='fork'`, `created_from_workflow=existing.id`, `version=1`.
- The source workflow is **always kept active** — there is no auto-deprecate-on-fork path.
- Returns 201.

**Metadata update — `PUT /workflows/{id}` with no DAG (or same signature):**
- Updates `description`, `tags`, etc. in-place. Returns 200.
- DAG-only changes that produce a new signature take the fork path above.

### Stats aggregation across lineages

Stats (costs, email metrics, completed runs) are aggregated by walking the upgrade chain in `getUpgradeChainIds()` (`src/lib/workflow-scoring.ts`):

- Linear walk from the active workflow back along `created_from_workflow`, only following `creation_type='upgrade'` edges.
- Stops at `creation_type='scratch'` (chain origin) and at `creation_type='fork'` boundaries (forks start a fresh dynasty for stats).
- A `visited` set prevents infinite loops on any pathological self-references.

The walker is fed the union of (active + deprecated) workflows so cross-dynasty convergence is followed naturally — when an upgrade was applied across dynasties, the chain crosses into the predecessor's dynasty and keeps walking.

### Dependency on features-service

Workflow-service needs `feature_dynasty_name` and `feature_dynasty_slug` from features-service. These are the stable, unversioned identifiers for a feature (as opposed to `feature_name`/`feature_slug` which may carry version suffixes).

- Workflow-service receives only `feature_slug` from clients in requests.
- It calls `GET /features/dynasty?slug=<featureSlug>` on features-service to resolve `feature_dynasty_name` and `feature_dynasty_slug`.
- Falls back to slug derivation (strip `-v{N}`, capitalize words) if features-service is not configured or unreachable.
- Requires env vars: `FEATURES_SERVICE_URL`, `FEATURES_SERVICE_API_KEY`.
