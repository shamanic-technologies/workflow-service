#!/usr/bin/env node
/**
 * MIGRATE-1105 S1: store the lead-answering scripts in the catalogue:
 *   - `message_sent/dy_answer_lead`: the one answer a lead is owed (the source built from this repo's strategies);
 *   - `paid_client/dy_answer_lead_pull`: the Lead event campaign's Target script, which asks the first for it.
 * Each is created once, then UPGRADED when its built source or tactics differ from its latest version. Dry run by
 * default; `--apply` stores them PARKED (dynasty deprecated: a runnable dynasty is a live candidate the Rating may pick
 * for any org whose Engine is switched, so a writer that waits for the owner's go is never runnable). `--live` (only
 * on the owner's go) restores both dynasties. Switching an org's Engine is a separate act.
 *
 * Run from /app/scripts inside the workflow-service container (reads the compiled source from dist):
 *   docker exec distribute-workflow-service-1 node scripts/seed-answer-lead-script.mjs [--apply] [--live]
 * Env (the container's): WORKFLOW_SERVICE_API_KEY, RUNS_SERVICE_URL, RUNS_SERVICE_API_KEY. Acts as the staff test org.
 */
const apply = process.argv.includes("--apply");
const live = process.argv.includes("--live");
const { answerLeadScriptSource, ANSWER_LEAD_OUTCOME, ANSWER_LEAD_DYNASTY, ANSWER_LEAD_PULL } = await import("../dist/lib/scripts/answer-lead-script.js");

const STAFF_ORG = "06ffd332-b05d-4468-bc33-fe2789caad95"; // STAFF TEST - Email Sending E2E
const STAFF_USER = "cfe148ed-e3d8-40a2-8920-f8c040a81934";
const SCRIPTS = [
  {
    outcome: ANSWER_LEAD_OUTCOME,
    dynasty: ANSWER_LEAD_DYNASTY,
    code: answerLeadScriptSource(),
    tactics: {
      // The Lead event campaigns run on this feature: the Rating keeps the script for them only.
      channel: "ai-follow-up-email",
      relationships: "pure_prospect",
      // The service that sends declares the Message sent (instantly-service, crm-service): never twice.
      recorded_by: "sender",
    },
    description:
      "Answers one lead the moment something happens with them: reads their whole thread and state, then writes once (in the thread they last wrote in, from the address they wrote to, or on WhatsApp where they talk), books the time they picked and confirms it, hands what only the team decides to the sales rep, or waits, always leaving their one next follow-up date. Leads only.",
  },
  { outcome: ANSWER_LEAD_PULL.outcome, dynasty: ANSWER_LEAD_PULL.dynasty, code: ANSWER_LEAD_PULL.source, tactics: ANSWER_LEAD_PULL.tactics, description: ANSWER_LEAD_PULL.description },
];

const base = `http://localhost:${process.env.PORT ?? 3000}`;
const key = process.env.WORKFLOW_SERVICE_API_KEY;
if (!key) throw new Error("WORKFLOW_SERVICE_API_KEY is required");

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

for (const s of SCRIPTS) {
  const at = `${base}/scripts/dynasty/${s.outcome}/${s.dynasty}`;
  const read = await fetch(at, { headers });
  const existing = read.ok ? await read.json() : null;
  const latest = existing?.versions?.at?.(-1) ?? null;
  const current = latest && latest.code === s.code && JSON.stringify(latest.tactics ?? {}) === JSON.stringify(s.tactics);
  const what = current ? "keep" : latest ? "upgrade" : "create";
  console.log(`${s.outcome}/${s.dynasty}: would ${what} (${s.code.length} chars), then ${live ? "restore" : "park"} the dynasty${apply ? "" : " (dry run)"}`);
  if (!apply) continue;
  if (what !== "keep") {
    const res =
      what === "create"
        ? await fetch(`${base}/scripts`, { method: "POST", headers, body: JSON.stringify({ outcome: s.outcome, dynasty: s.dynasty, code: s.code, description: s.description, tactics: s.tactics }) })
        : await fetch(`${at}/upgrade`, { method: "POST", headers, body: JSON.stringify({ code: s.code, description: s.description, tactics: s.tactics }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${s.outcome}/${s.dynasty} ${what}: ${res.status} ${text.slice(0, 400)}`);
    const row = JSON.parse(text);
    console.log(`  ${what}d v${row.version} (${row.id})`);
  }
  const status = await fetch(`${at}/status`, {
    method: "PUT",
    headers,
    body: JSON.stringify(live ? { status: "active", reason: "The owner's go on the before/after table" } : { status: "deprecated", reason: "Parked: awaiting the owner's go on the before/after table" }),
  });
  if (!status.ok) throw new Error(`${s.outcome}/${s.dynasty} status: ${status.status} ${(await status.text()).slice(0, 300)}`);
  console.log(live ? "  dynasty LIVE (a candidate wherever its Engine is switched)" : "  dynasty PARKED (runs nowhere until --live)");
}
await fetch(`${runsBase}/v1/runs/${runId}`, { method: "PATCH", headers: { "content-type": "application/json", "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "", "x-org-id": STAFF_ORG }, body: JSON.stringify({ status: "completed" }) });
