#!/usr/bin/env node
/**
 * MIGRATE-1105 S1: store the answering script (`paid_client/dy_answer_lead`) in the catalogue: created once, then
 * UPGRADED when the source built from this repo's strategies differs from the active version. Dry run by default
 * (prints what it would do), `--apply` stores. Storing switches NOTHING on: a campaign runs it only once its Engine is
 * switched for that org (`POST /internal/engines/paid_client/switch`), which waits for the owner's go.
 *
 * Run from /app/scripts inside the workflow-service container (reads the compiled source from dist):
 *   docker exec distribute-workflow-service-1 node scripts/seed-answer-lead-script.mjs [--apply]
 * Env (the container's): WORKFLOW_SERVICE_API_KEY, RUNS_SERVICE_URL, RUNS_SERVICE_API_KEY. Acts as the staff test org.
 */
const apply = process.argv.includes("--apply");
const { answerLeadScriptSource, ANSWER_LEAD_OUTCOME, ANSWER_LEAD_DYNASTY } = await import("../dist/lib/scripts/answer-lead-script.js");

const STAFF_ORG = "06ffd332-b05d-4468-bc33-fe2789caad95"; // STAFF TEST - Email Sending E2E
const STAFF_USER = "cfe148ed-e3d8-40a2-8920-f8c040a81934";
const TACTICS = {
  llm: { provider: "anthropic", model: "opus" },
  // The Lead event campaigns run on this feature: the Rating keeps the script for them only.
  channel: "ai-follow-up-email",
  relationships: "pure_prospect",
  // The paid client is lead-service's fact (a payment): this script never declares one.
  recorded_by: "lead",
};
const DESCRIPTION =
  "Answers one lead the moment something happens with them: reads their whole thread and state, then writes once (in the thread they last wrote in, from the address they wrote to, or on WhatsApp where they talk), books the time they picked and confirms it, hands what only the team decides to the sales rep, or waits, always leaving their one next follow-up date. Leads only.";

const base = `http://localhost:${process.env.PORT ?? 3000}`;
const key = process.env.WORKFLOW_SERVICE_API_KEY;
if (!key) throw new Error("WORKFLOW_SERVICE_API_KEY is required");
const code = answerLeadScriptSource();

// Every read and write here is an identified act: one run for it on the staff test org.
const runsBase = (process.env.RUNS_SERVICE_URL ?? "").replace(/\/$/, "");
const run = await fetch(`${runsBase}/v1/runs`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "", "x-org-id": STAFF_ORG, "x-user-id": STAFF_USER },
  body: JSON.stringify({ serviceName: "workflow", taskName: "seed-answer-lead-script" }),
});
if (!run.ok) throw new Error(`runs-service: ${run.status} ${await run.text()}`);
const runId = (await run.json()).id;
const headers = { "content-type": "application/json", "x-api-key": key, "x-org-id": STAFF_ORG, "x-user-id": STAFF_USER, "x-run-id": runId };
const read = await fetch(`${base}/scripts/dynasty/${ANSWER_LEAD_OUTCOME}/${ANSWER_LEAD_DYNASTY}`, { headers });
const existing = read.ok ? await read.json() : null;
const active = existing?.versions?.find?.((v) => v.status === "active") ?? null;
if (active && active.code === code && JSON.stringify(active.tactics ?? {}) === JSON.stringify(TACTICS)) {
  console.log(`${ANSWER_LEAD_OUTCOME}/${ANSWER_LEAD_DYNASTY}: v${active.version} is current, nothing to do`);
  process.exit(0);
}
const what = existing && (existing.versions?.length ?? 0) > 0 ? "upgrade" : "create";
console.log(`${ANSWER_LEAD_OUTCOME}/${ANSWER_LEAD_DYNASTY}: would ${what} (${code.length} chars)${apply ? "" : " (dry run)"}`);
if (!apply) process.exit(0);

const res =
  what === "create"
    ? await fetch(`${base}/scripts`, { method: "POST", headers, body: JSON.stringify({ outcome: ANSWER_LEAD_OUTCOME, dynasty: ANSWER_LEAD_DYNASTY, code, description: DESCRIPTION, tactics: TACTICS }) })
    : await fetch(`${base}/scripts/dynasty/${ANSWER_LEAD_OUTCOME}/${ANSWER_LEAD_DYNASTY}/upgrade`, { method: "POST", headers, body: JSON.stringify({ code, description: DESCRIPTION, tactics: TACTICS }) });
const text = await res.text();
if (!res.ok) throw new Error(`${what}: ${res.status} ${text.slice(0, 400)}`);
const row = JSON.parse(text);
console.log(`${what}d ${row.outcome}/${row.dynasty}/v${row.version} (${row.id})`);
await fetch(`${runsBase}/v1/runs/${runId}`, { method: "PATCH", headers: { "content-type": "application/json", "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "", "x-org-id": STAFF_ORG }, body: JSON.stringify({ status: "completed" }) });
