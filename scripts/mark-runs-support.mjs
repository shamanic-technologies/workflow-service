/**
 * LEDGER-HISTORY-1024: marks runs of THIS service support on runs-service's ledger, naming the function, through the
 * OWNER door (`/v1/platform-runs/support-marks/{preview,apply}`, x-service-name = workflow). For spend that produced
 * no outcome BY DESIGN (cost-accounting doctrine), e.g. the staff probe runs (`staff_experiment`) or the past AI Lead
 * Proposal runs (`copilot`, marked live by the DAG's own `mark-support` node since LEDGER-HISTORY-1024).
 *
 * Input: one run id per line (prod runs_service, `psql \copy ... CSV`). Runs inside the workflow-service container:
 *   docker exec <container> node /app/scripts/mark-runs-support.mjs <ids file> <kind> "<reason>"           # preview
 *   docker exec <container> node /app/scripts/mark-runs-support.mjs <ids file> <kind> "<reason>" --apply
 *
 * Idempotent (an already marked run is counted, never re-marked; a declaring run is left untouched and counted).
 */
import { readFileSync } from "node:fs";

const CHUNK = 5000;

async function main() {
  const [file, kind, reason] = process.argv.slice(2);
  const apply = process.argv.includes("--apply");
  if (!file || !kind || !reason) throw new Error('usage: mark-runs-support.mjs <ids file> <kind> "<reason>" [--apply]');
  const base = (process.env.RUNS_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!base || !key) throw new Error("RUNS_SERVICE_URL / RUNS_SERVICE_API_KEY missing");
  const ids = [...new Set(readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim().replace(/^"|"$/g, "")).filter((l) => /^[0-9a-f-]{36}$/i.test(l)))];
  console.log(`[support marks] ${ids.length} runs as ${kind}, ${apply ? "APPLY" : "preview"}`);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const res = await fetch(`${base}/v1/platform-runs/support-marks/${apply ? "apply" : "preview"}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "x-service-name": "workflow" },
      body: JSON.stringify({ kind, reason, markedBy: "workflow-service LEDGER-HISTORY-1024", runIds: ids.slice(i, i + CHUNK) }),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`[support marks] chunk ${i / CHUNK + 1} refused ${res.status}: ${text.slice(0, 1000)}`);
    console.log(`[support marks] chunk ${i / CHUNK + 1}: ${text.slice(0, 600)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
