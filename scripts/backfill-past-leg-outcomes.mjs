/**
 * LEDGER-HISTORY-1024: the past AI Instant Call runs declare the outcome their leg produced (`booking_call`) on
 * runs-service's ledger, as if declared when they ran
 * (`occurredAt: run_started_at`), exactly as the live nodes do today. What counts, and for whom:
 * src/lib/past-leg-outcomes.ts.
 *
 * Input: three read-only CSV exports in one directory (prod databases on the box, `psql \copy ... CSV HEADER`):
 *   runs.csv      workflow_service: SELECT run_id, feature_slug AS f, inputs->'trigger'->'item' AS item FROM workflow_runs
 *                                   WHERE feature_slug = 'ai-instant-call' AND run_id IS NOT NULL
 *   followups.csv lead_service:     SELECT run_id, lead_id, action FROM followup_actions WHERE run_id IN (<runs.csv ids>)
 *   calls.csv     twilio_service:   SELECT parent_run_id, call_sid FROM twilio_calls WHERE parent_run_id IS NOT NULL
 *
 * Runs against the COMPILED code inside the workflow-service container (RUNS_SERVICE_URL / RUNS_SERVICE_API_KEY):
 *   docker cp scripts/backfill-past-leg-outcomes.mjs <container>:/app/scripts/
 *   docker cp <dir> <container>:/tmp/past-leg-outcomes
 *   docker exec <container> node /app/scripts/backfill-past-leg-outcomes.mjs /tmp/past-leg-outcomes          # dry run
 *   docker exec <container> node /app/scripts/backfill-past-leg-outcomes.mjs /tmp/past-leg-outcomes --apply
 *
 * Idempotent: runs-service answers `already_recorded` for an occurrence stated before (a run the live node already
 * declared included), so a re-run writes nothing. A batch refused (422 lists the runs) stops the script loudly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pastLegEvidence } from "../dist/lib/past-leg-outcomes.js";
import { batchOutcomeRuns } from "../dist/lib/past-run-outcomes.js";

function readCsv(path) {
  const text = readFileSync(path, "utf8");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

async function main() {
  const dir = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!dir) throw new Error("usage: backfill-past-leg-outcomes.mjs <exports dir> [--apply]");

  const runRows = readCsv(join(dir, "runs.csv"));
  const input = {
    runFeatures: new Map(runRows.map((r) => [r.run_id.toLowerCase(), r.f])),
    runTriggerItems: new Map(runRows.filter((r) => r.item).map((r) => [r.run_id.toLowerCase(), JSON.parse(r.item)])),
    followupActions: readCsv(join(dir, "followups.csv")).map((r) => ({ runId: r.run_id, leadId: r.lead_id, action: r.action })),
    calls: readCsv(join(dir, "calls.csv")).map((r) => ({ parentRunId: r.parent_run_id, callSid: r.call_sid || null })),
  };
  const { runs, unnamed } = pastLegEvidence(input);
  const byKey = {};
  for (const r of runs) byKey[r.produced[0].outcomeKey] = (byKey[r.produced[0].outcomeKey] ?? 0) + 1;
  console.log(`[past-leg outcomes] ${runs.length} runs produced their leg's outcome:`, byKey);
  for (const u of unnamed) console.error(`[past-leg outcomes] SKIPPED (subject not named): ${u.featureSlug} run ${u.runId}: ${u.why}`);

  const batches = batchOutcomeRuns(runs);
  if (!apply) {
    console.log(`[past-leg outcomes] dry run: ${batches.length} batch call(s):`);
    for (const r of runs) console.log(JSON.stringify(r));
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
    console.log(`[past-leg outcomes] batch ${i + 1}/${batches.length}: recorded ${body.recordedCount}, already ${body.alreadyRecordedCount}`);
  }
  console.log(`[past-leg outcomes] done: recorded ${recorded}, already recorded ${already}`);
}

main().catch((err) => {
  console.error("[past-leg outcomes] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
