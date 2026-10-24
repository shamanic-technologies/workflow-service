/**
 * LEDGER-HISTORY-1024: past message-writer runs that consumed `lead_found` on a pipe that starts elsewhere are voided
 * and re-declared on a correction run, consuming the pipe's `from` step. What and why: src/lib/consumed-from-step.ts.
 *
 * Input: one CSV (prod runs_service + campaign_service on the box, `psql \copy ... CSV HEADER`), one row per run this
 * service declared `message_written` on, with its lead and its campaign's leg:
 *   run_id, org_id, user_id, campaign_id, workflow_slug, feature_slug, brand_id, declared_at (ISO), lead_id, leg_key
 *
 * Runs inside the workflow-service container (RUNS_SERVICE_URL / RUNS_SERVICE_API_KEY):
 *   docker exec <container> node /app/scripts/correct-consumed-from-step.mjs <csv>           # dry run
 *   docker exec <container> node /app/scripts/correct-consumed-from-step.mjs <csv> --apply
 *
 * Idempotent: a second void answers already_voided, the correction run is created under an idempotency key per voided
 * run (the replay returns it), its declaration answers already_recorded.
 */
import { readFileSync } from "node:fs";
import { correctionDeclaration, correctionIdempotencyKey, correctionsFor } from "../dist/lib/consumed-from-step.js";

function readCsv(path) {
  const [header, ...lines] = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const cols = header.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
}

async function call(method, url, headers, body) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function main() {
  const file = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!file) throw new Error("usage: correct-consumed-from-step.mjs <csv> [--apply]");
  const rows = readCsv(file);
  const byRun = new Map(rows.map((r) => [r.run_id, r]));
  const { corrections, unreadable } = correctionsFor(
    rows.map((r) => ({ runId: r.run_id, legKey: r.leg_key || null, leadId: r.lead_id, declaredAt: r.declared_at })),
  );
  const byStep = {};
  for (const c of corrections) byStep[c.fromStep ?? "(start: none)"] = (byStep[c.fromStep ?? "(start: none)"] ?? 0) + 1;
  console.log(`[from-step] ${rows.length} runs read, ${corrections.length} to correct:`, byStep);
  for (const u of unreadable) console.error(`[from-step] SKIPPED (leg unreadable): run ${u.runId} leg ${u.legKey}`);
  if (!apply) {
    for (const c of corrections.slice(0, 3)) console.log(JSON.stringify({ runId: c.runId, ...correctionDeclaration(c) }));
    return;
  }

  const base = (process.env.RUNS_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!base || !key) throw new Error("RUNS_SERVICE_URL / RUNS_SERVICE_API_KEY missing");
  let done = 0;
  for (const c of corrections) {
    const r = byRun.get(c.runId);
    await call("POST", `${base}/v1/platform-runs/${c.runId}/outcomes/void`, { "x-api-key": key, "x-service-name": "workflow" }, {
      reason: `Consumed lead_found on pipe ${r.leg_key}, which starts from ${c.fromStep ?? "Start (no input)"}; re-declared on a correction run (LEDGER-HISTORY-1024)`,
      voidedBy: "workflow-service LEDGER-HISTORY-1024",
    });
    const ids = { "x-api-key": key, "x-org-id": r.org_id, "x-user-id": r.user_id };
    const tags = {
      "x-run-id": c.runId,
      ...(r.campaign_id ? { "x-campaign-id": r.campaign_id } : {}),
      ...(r.workflow_slug ? { "x-workflow-slug": r.workflow_slug } : {}),
      ...(r.feature_slug ? { "x-feature-slug": r.feature_slug } : {}),
      ...(r.brand_id ? { "x-brand-id": r.brand_id } : {}),
    };
    const run = await call("POST", `${base}/v1/runs`, { ...ids, ...tags }, {
      serviceName: "workflow",
      taskName: "outcome-correction",
      idempotencyKey: correctionIdempotencyKey(c.runId),
    });
    const declared = await call("POST", `${base}/v1/runs/${run.id}/outcomes`, { ...ids, "x-service-name": "workflow" }, correctionDeclaration(c));
    if (run.status !== "completed") await call("PATCH", `${base}/v1/runs/${run.id}`, ids, { status: "completed" });
    done++;
    console.log(`[from-step] ${c.runId} -> ${run.id}: consumed ${c.fromStep ?? "nothing"}, recorded ${declared.recordedCount}, already ${declared.alreadyRecordedCount}`);
  }
  console.log(`[from-step] done: ${done} runs corrected`);
}

main().catch((err) => {
  console.error("[from-step] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
