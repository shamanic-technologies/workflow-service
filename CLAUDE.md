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
- `src/lib/periodic-cleanup.ts` — 24h interval re-running stale-deprecation + Windmill orphan-flow cleanup
- `scripts/nodes/` — TypeScript scripts deployed to Windmill (one per node type)

## Key concepts
- Our DAG format: `{ nodes: [{id, type, config, inputMapping}], edges: [{from, to, condition?}] }`
- Windmill OpenFlow: `{ value: { modules: [...] }, schema: {...} }`
- Input mapping: `$ref:node-id.output.field` → `results.node_id.field` in Windmill
- Node scripts in Windmill call our existing services via HTTP
- Stubs throw errors with clear messages until the real service is built
- **Windmill job retention** (`completed_job` rows) is set instance-wide at boot via `POST /api/settings/global/retention_period_secs` with value 604800 (7 days). The API requires the Windmill token to be superadmin; we log a warn but do not block boot if it isn't. CE caps retention at 30 days — anything over is clamped server-side.

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

Workflows follow a dynasty model: each workflow belongs to a lineage (dynasty) that tracks its evolution through upgrades. Names and slugs are derived from the `feature_slug` and a poetic `workflow_dynasty_signature_name` generated once per dynasty.

### Naming rule

The bare word `dynasty` does not exist in this repo — always `workflow_dynasty_*` (and `workflowDynasty*` in TypeScript). Never bare `signature_name` either: the column is `workflow_dynasty_signature_name` (Drizzle field `workflowDynastySignatureName`). Indexes prefixed `idx_workflows_*` stay as-is — the table prefix in the index name already disambiguates.

### Scope rule

`workflow_dynasty_signature_name` is unique among **all** workflows (any `status`, any `org_id`) within the same `feature_slug`. Once a name is chosen for a feature, it is burned for that feature forever — even after deprecation. The dedup query uses `WHERE feature_slug = ?` only — no `org_id` filter, no `status` filter.

### Database columns

| Column | Type | Unique? | Description |
|---|---|---|---|
| `workflow_slug` | text | Yes (globally) | Technical identifier, immutable once created. Used as API key for execution (`POST /workflows/by-slug/:workflowSlug/execute`). |
| `workflow_name` | text | Yes (globally) | Human-readable display name. |
| `workflow_dynasty_signature_name` | text | Unique per `feature_slug` (any status, any org) | Poetic word generated deterministically from the DAG hash. Set once at dynasty creation, never changes within the dynasty. Burned for life. |
| `workflow_dynasty_slug` | text | No | Stable lineage slug. Constant across all versions of a dynasty. |
| `workflow_dynasty_name` | text | No | Stable lineage display name. Constant across all versions of a dynasty. |
| `signature` | text | Unique per `(feature_slug, status='active')` | Hash of the DAG structure. Used for deduplication on upgrade. |
| `version` | integer | No | Version number within the dynasty. Starts at 1. |
| `feature_slug` | text | No | Reference to the feature in features-service. Passed by clients. |

### Name composition

```
workflow_dynasty_slug = feature_slug + "-" + workflow_dynasty_signature_name
workflow_dynasty_name = TitleCase(feature_slug.replace("-", " ")) + " " + Capitalize(workflow_dynasty_signature_name)
workflow_slug         = workflow_dynasty_slug                        if version == 1
                      | workflow_dynasty_slug + "-v{version}"        if version >= 2
workflow_name         = workflow_dynasty_name                        if version == 1
                      | workflow_dynasty_name + " v{version}"        if version >= 2
```

Example with `feature_slug = "sales-cold-outreach"`, `workflow_dynasty_signature_name = "obsidian"`, version 3:
```
workflow_dynasty_slug: "sales-cold-outreach-obsidian"
workflow_dynasty_name: "Sales Cold Outreach Obsidian"
workflow_slug:         "sales-cold-outreach-obsidian-v3"
workflow_name:         "Sales Cold Outreach Obsidian v3"
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
- Body: `{ featureSlug, description, hints? }`. LLM generates the DAG.
- If an active workflow with the same `(orgId, featureSlug, signature)` already exists, returns 200 with that row unchanged (idempotent).
- Otherwise inserts a new row with `creation_type='scratch'`, `created_from_workflow=NULL`, `version=1`, no version suffix.
- This endpoint never upgrades existing dynasties.

**Upgrade — `POST /workflows/upgrade`:**
- Body: `{ workflowSlug, description, hints? }`. LLM regenerates the DAG.
- 404 if no active workflow matches `workflowSlug`.
- If the new signature equals the existing one → in-place update, returns 200.
- Otherwise inserts a new row in the **same** dynasty (`workflow_dynasty_slug`, `workflow_dynasty_name`, `workflow_dynasty_signature_name` all unchanged — the dynasty signature name is immutable per dynasty) with `creation_type='upgrade'`, `created_from_workflow=existing.id`, `version=existing.version+1`, version suffix on `workflow_slug`/`workflow_name`. The predecessor is deprecated via `deprecateWorkflow()` (which also deletes its Windmill flow when no active campaign still references it). Returns 201.

**Fork — `PUT /workflows/{id}` with a DAG of new signature:**
- Inserts a new dynasty (new `workflow_dynasty_signature_name`, new `workflow_dynasty_slug`, new `workflow_dynasty_name`) with `creation_type='fork'`, `created_from_workflow=existing.id`, `version=1`.
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

### Feature naming

Workflow-service uses `feature_slug` directly to derive both the slug and the display name — there is no remote lookup, no `feature_dynasty_*` concept. The `featureSlugToName` helper titlecases the slug (`"sales-cold-outreach"` → `"Sales Cold Outreach"`) for display, and the slug itself is used verbatim in `workflow_dynasty_slug`. Clients only ever pass `featureSlug`.
