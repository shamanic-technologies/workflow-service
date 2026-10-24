/**
 * COST-BACKFILL-1023-WORKFLOW: the chat-writer workflow runs that ran before the live `declare-message-written` node
 * (COST-ACCOUNTING-1023-P1) declare the message they wrote, on runs-service's ledger, as if declared when they ran.
 * What counts as written and sent, and for whom: src/lib/past-run-outcomes.ts.
 *
 * Input: five read-only CSV exports in one directory (prod databases on the box, `psql \copy ... CSV HEADER`), with
 * `my` = the execute-workflow run ids of the chat-writer features (from workflow_runs):
 *   features.csv  workflow_service: SELECT run_id, feature_slug AS f FROM workflow_runs WHERE run_id IS NOT NULL
 *   kids.csv      runs_service:     SELECT c.id, c.parent_run_id FROM runs c JOIN my ON my.id::uuid = c.parent_run_id
 *   outcomes.csv  runs_service:     SELECT c.parent_run_id AS wf, o.direction, o.outcome_key, o.subject_service, o.subject_id
 *                                   FROM runs c JOIN my ON my.id::uuid = c.parent_run_id JOIN run_outcomes o ON o.run_id = c.id
 *   followups.csv lead_service:     SELECT f.run_id, f.lead_id, f.action FROM followup_actions f JOIN my ON my.id = f.run_id
 *   whatsapp.csv  crm_service:      SELECT w.run_id, w.status, w.idempotency_key FROM whatsapp_sends w
 *                                   WHERE w.run_id IN (<kids.csv ids>)
 *
 * Runs against the COMPILED code inside the workflow-service container (RUNS_SERVICE_URL / RUNS_SERVICE_API_KEY):
 *   docker cp scripts/backfill-past-run-outcomes.mjs <container>:/app/scripts/
 *   docker cp <dir> <container>:/tmp/past-run-outcomes
 *   docker exec <container> node /app/scripts/backfill-past-run-outcomes.mjs /tmp/past-run-outcomes          # dry run
 *   docker exec <container> node /app/scripts/backfill-past-run-outcomes.mjs /tmp/past-run-outcomes --apply
 *
 * Idempotent: runs-service answers `already_recorded` for an occurrence stated before, so a re-run writes nothing.
 * Resumable: a batch refused (422 lists the runs) stops the script loudly; fix and re-run, done batches are no-ops.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pastRunBatches, pastRunEvidence } from "../dist/lib/past-run-outcomes.js";

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
  // Superseded (LEDGER-HISTORY-1024): applied 2026-10-23. It consumed lead_found on every pipe; the doctrine is the
  // pipe's `from` step, corrected by scripts/correct-consumed-from-step.mjs, and its voided runs refuse a replay.
  if (!process.argv.includes("--superseded-i-know")) throw new Error("superseded: see scripts/correct-consumed-from-step.mjs");
  const dir = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!dir) throw new Error("usage: backfill-past-run-outcomes.mjs <exports dir> [--apply]");

  const input = {
    runFeatures: new Map(readCsv(join(dir, "features.csv")).map((r) => [r.run_id, r.f])),
    childParents: new Map(readCsv(join(dir, "kids.csv")).map((r) => [r.id, r.parent_run_id])),
    childOutcomes: readCsv(join(dir, "outcomes.csv")).map((r) => ({
      parentRunId: r.wf, direction: r.direction, outcomeKey: r.outcome_key, subjectService: r.subject_service, subjectId: r.subject_id,
    })),
    followupActions: readCsv(join(dir, "followups.csv")).map((r) => ({ runId: r.run_id, leadId: r.lead_id, action: r.action })),
    whatsappSends: readCsv(join(dir, "whatsapp.csv")).map((r) => ({ runId: r.run_id, status: r.status, idempotencyKey: r.idempotency_key })),
  };
  const { declarations, unnamed } = pastRunEvidence(input);
  const byFeature = {};
  for (const d of declarations) byFeature[d.featureSlug] = (byFeature[d.featureSlug] ?? 0) + 1;
  console.log(`[past-run outcomes] ${declarations.length} runs wrote and sent a message:`, byFeature);
  console.log(`[past-run outcomes] ${declarations.reduce((n, d) => n + d.leadIds.length, 0)} messages written`);
  for (const u of unnamed) console.error(`[past-run outcomes] SKIPPED (person not named): run ${u.runId} send ${u.idempotencyKey}`);

  const batches = pastRunBatches(declarations);
  if (!apply) {
    console.log(`[past-run outcomes] dry run: ${batches.length} batch call(s); first run body:`, JSON.stringify(batches[0]?.runs[0] ?? null));
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
    console.log(`[past-run outcomes] batch ${i + 1}/${batches.length}: recorded ${body.recordedCount}, already ${body.alreadyRecordedCount}`);
  }
  console.log(`[past-run outcomes] done: recorded ${recorded}, already recorded ${already}`);
}

main().catch((err) => {
  console.error("[past-run outcomes] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
