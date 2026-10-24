/**
 * COST-SUPPORT-1024-WORKFLOW (owner 2026-10-24: « Trouver des leads journalistes, rediriger des experts quotes avec
 * AI… sont des features deprecated mais qui pourraient revenir dans le produit. On peut les classer dans
 * retired_product pour le moment »): the execute-workflow runs of the retired PR features (`pr-cold-email-outreach`,
 * `pr-expert-quote-outreach`, any `pr-*` workflow) are marked SUPPORT `retired_product` on runs-service's ledger,
 * through its OWNER door (`/v1/platform-runs/support-marks/{preview,apply}`, x-service-name = our runs' service name).
 * A mark covers the run's whole subtree that declares nothing, and runs-service can undo it if the product returns.
 *
 * Input: one run id per line (prod runs_service on the box, `psql \copy ... CSV`):
 *   SELECT id FROM runs WHERE service_name = 'workflow' AND task_name = 'execute-workflow' AND workflow_slug LIKE 'pr-%'
 *
 * Runs inside the workflow-service container (RUNS_SERVICE_URL / RUNS_SERVICE_API_KEY):
 *   docker cp scripts/mark-retired-pr-runs.mjs <container>:/app/scripts/
 *   docker cp pr-runs.csv <container>:/tmp/pr-runs.csv
 *   docker exec <container> node /app/scripts/mark-retired-pr-runs.mjs /tmp/pr-runs.csv           # dry run (preview)
 *   docker exec <container> node /app/scripts/mark-retired-pr-runs.mjs /tmp/pr-runs.csv --apply
 *
 * Idempotent (an already marked run is counted, never re-marked) and resumable: a refused call stops loudly.
 */
import { readFileSync } from "node:fs";

const CHUNK = 5000;
const SERVICE_NAME = "workflow";
const MARK = {
  kind: "retired_product",
  reason: "Retired PR features (journalist cold email, expert quote outreach): execute-workflow runs of pr-* workflows; may return onto outcomes later (owner 2026-10-24)",
  markedBy: "workflow-service COST-SUPPORT-1024-WORKFLOW (session singapore-v2)",
};

async function main() {
  const file = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!file) throw new Error("usage: mark-retired-pr-runs.mjs <run ids file> [--apply]");
  const base = (process.env.RUNS_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!base || !key) throw new Error("RUNS_SERVICE_URL / RUNS_SERVICE_API_KEY missing");
  const ids = [...new Set(readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim().replace(/^"|"$/g, "")).filter((l) => /^[0-9a-f-]{36}$/i.test(l)))];
  console.log(`[retired PR] ${ids.length} runs, ${apply ? "APPLY" : "dry run (preview)"}`);
  const totals = { matched: 0, toMark: 0, alreadyMarked: 0, declares: 0, onOutcomeNow: 0, grossCents: 0 };
  for (let i = 0; i < ids.length; i += CHUNK) {
    const runIds = ids.slice(i, i + CHUNK);
    const res = await fetch(`${base}/v1/platform-runs/support-marks/${apply ? "apply" : "preview"}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "x-service-name": SERVICE_NAME },
      body: JSON.stringify({ ...MARK, runIds }),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`[retired PR] chunk ${i / CHUNK + 1} refused ${res.status}: ${text.slice(0, 1000)}`);
    const j = JSON.parse(text);
    const r = j.selection ?? j;
    totals.matched += r.matchedRunCount ?? 0;
    totals.toMark += r.toMarkCount ?? r.markedCount ?? 0;
    totals.alreadyMarked += r.alreadyMarkedCount ?? 0;
    totals.declares += r.declaresOutcomesCount ?? 0;
    totals.onOutcomeNow += r.onOutcomeNowCount ?? 0;
    totals.grossCents += Number(r.spend?.grossCents ?? 0);
    console.log(`[retired PR] chunk ${i / CHUNK + 1}: ${text.slice(0, 400)}`);
  }
  console.log("[retired PR] totals:", totals);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
