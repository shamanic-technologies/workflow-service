/**
 * LEAD-STATES-1024-MEETING-WRITES: every past workflow run that acted on a lead states the lead it consumed (the
 * occurrence its pipe starts from), as the live `declare-consumed-lead` node does. What and why:
 * src/lib/past-consumed-leads.ts.
 *
 * Input: four read-only CSV exports in one directory (prod databases on the box, `psql \copy ... CSV HEADER`):
 *   claims.csv  lead_service:     SELECT run_id, lead_id FROM followup_actions WHERE action = 'claimed' AND run_id IS NOT NULL
 *   runs.csv    runs_service:     SELECT r.id AS run_id, r.campaign_id, r.feature_slug FROM runs r
 *                                 WHERE r.service_name = 'workflow' AND r.task_name = 'execute-workflow'
 *                                   AND r.id IN (<claims.csv run ids>)
 *                                   AND NOT EXISTS (SELECT 1 FROM outcome_declaration_events e
 *                                                   WHERE e.run_id = r.id AND e.event_type = 'outcomes.voided')
 *                                   AND NOT EXISTS (SELECT 1 FROM run_support_marks m WHERE m.run_id = r.id)
 *   legs.csv    campaign_service: SELECT id, leg_key FROM campaigns
 *   features.csv workflow_service: SELECT run_id, feature_slug FROM workflow_runs WHERE run_id IS NOT NULL
 * The feature is THIS service's record (`workflow_runs`): runs-service opens many execute-workflow runs unlabelled
 * (`runs.feature_slug` NULL on 73 of 640 claimed runs, 2026-10-25), so it is only the fallback.
 *
 * Runs against the COMPILED code inside the workflow-service container (RUNS_SERVICE_URL / RUNS_SERVICE_API_KEY):
 *   docker cp scripts/backfill-consumed-leads.mjs <container>:/app/scripts/
 *   docker cp <dir> <container>:/tmp/consumed-leads
 *   docker exec <container> node /app/scripts/backfill-consumed-leads.mjs /tmp/consumed-leads           # dry run
 *   docker exec <container> node /app/scripts/backfill-consumed-leads.mjs /tmp/consumed-leads --apply
 *
 * Idempotent: an occurrence stated before answers `already_recorded`. A batch refused (422 lists the runs) stops the
 * script loudly; fix the export and re-run, done batches are no-ops.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pastConsumedLeadBatches } from "../dist/lib/past-consumed-leads.js";

function readCsv(path) {
  const [header, ...lines] = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const cols = header.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
}

async function main() {
  const dir = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!dir) throw new Error("usage: backfill-consumed-leads.mjs <exports dir> [--apply]");

  const claims = new Map();
  for (const c of readCsv(join(dir, "claims.csv"))) {
    const id = c.run_id.toLowerCase();
    if (!claims.has(id)) claims.set(id, []);
    claims.get(id).push(c.lead_id);
  }
  const legs = new Map(readCsv(join(dir, "legs.csv")).map((c) => [c.id.toLowerCase(), c.leg_key || null]));
  const features = new Map(readCsv(join(dir, "features.csv")).map((c) => [c.run_id.toLowerCase(), c.feature_slug || null]));
  const rows = readCsv(join(dir, "runs.csv")).map((r) => ({
    runId: r.run_id,
    featureSlug: features.get(r.run_id.toLowerCase()) ?? (r.feature_slug || null),
    legKey: r.campaign_id ? legs.get(r.campaign_id.toLowerCase()) ?? null : null,
    leadIds: claims.get(r.run_id.toLowerCase()) ?? [],
  }));

  const { batches, skipped } = pastConsumedLeadBatches(rows);
  const byKey = {};
  for (const b of batches) for (const r of b.runs) for (const o of r.consumed) byKey[o.outcomeKey] = (byKey[o.outcomeKey] ?? 0) + 1;
  const why = {};
  for (const s of skipped) why[s.why] = (why[s.why] ?? 0) + 1;
  console.log(`[consumed leads] ${rows.length} runs read; ${batches.reduce((n, b) => n + b.runs.length, 0)} declare:`, byKey, "skipped:", why);
  if (!apply) {
    console.log(`[consumed leads] dry run: ${batches.length} batch call(s); first run body:`, JSON.stringify(batches[0]?.runs[0] ?? null));
    return;
  }

  const base = (process.env.RUNS_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!base || !key) throw new Error("RUNS_SERVICE_URL / RUNS_SERVICE_API_KEY missing");
  let recorded = 0;
  let already = 0;
  for (const [i, batch] of batches.entries()) {
    const res = await fetch(`${base}/v1/platform-runs/outcomes/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "x-service-name": "workflow" },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(120000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`batch ${i + 1}/${batches.length}: ${res.status} ${text}`);
    const body = JSON.parse(text);
    recorded += body.recordedCount;
    already += body.alreadyRecordedCount;
    console.log(`[consumed leads] batch ${i + 1}/${batches.length}: recorded ${body.recordedCount}, already ${body.alreadyRecordedCount}`);
  }
  console.log(`[consumed leads] done: recorded ${recorded}, already recorded ${already}`);
}

main().catch((err) => {
  console.error("[consumed leads] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
