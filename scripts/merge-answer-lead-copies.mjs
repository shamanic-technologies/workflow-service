#!/usr/bin/env node
/**
 * ONE-WRITER-N-MODELS-1116-ANSWERER: merges the 6 per-model copies of the lead answerer (`message_sent/dy_answer_lead__<model>`)
 * into what they now run as: the writer `message_written/dy_answer_lead` asked by the sender `message_sent/dy_answer_lead`,
 * and the model's completion script `llm_completion/dy_<model>` asked by that writer. Each copy is retired with the
 * reason; its runs keep their names; features-service pools its history at both places (`GET /internal/scripts/merges`).
 * Refused per copy (nothing written for it) when it is already merged or a survivor does not run.
 * Dry run by default; `--apply` writes. Runs inside the workflow-service container:
 *   docker exec <container> node scripts/merge-answer-lead-copies.mjs [--apply]
 */
const apply = process.argv.includes("--apply");
const key = process.env.WORKFLOW_SERVICE_API_KEY;
const base = (process.env.WORKFLOW_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
if (!key) throw new Error("WORKFLOW_SERVICE_API_KEY is required");

/** Copy suffix -> the completion script of its model (`COMPLETION_LLMS`: dy_<model with underscores>). */
const COPIES = ["claude_haiku", "gemini_flash_lite", "gemini_pro", "glm", "gpt_terra", "kimi_k2"];
const SENDER = { outcome: "message_sent", dynasty: "dy_answer_lead" };
const WRITER = { outcome: "message_written", dynasty: "dy_answer_lead" };
const REASON =
  "ONE-WRITER-N-MODELS-1116-ANSWERER (owner 2026-11-16): one lead answerer; its writing is message_written/dy_answer_lead asked by message_sent/dy_answer_lead, and the model is the LLM completion Engine's pick for that writer";
const slug = (r) => `${r.outcome}/${r.dynasty}`;

let failed = 0;
for (const model of COPIES) {
  const body = {
    absorbed: `message_sent/dy_answer_lead__${model}`,
    places: [
      { survivor: slug(WRITER), askedBy: slug(SENDER) },
      { survivor: `llm_completion/dy_${model}`, askedBy: slug(WRITER) },
    ],
    reason: REASON,
  };
  if (!apply) {
    console.log(`merge ${body.absorbed} -> ${body.places.map((p) => `${p.survivor} (asked by ${p.askedBy})`).join(" + ")} (dry run)`);
    continue;
  }
  const res = await fetch(`${base}/internal/scripts/merges`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "x-email": process.env.STAFF_EMAIL ?? "" }, body: JSON.stringify(body) });
  const text = await res.text();
  console.log(`merge ${body.absorbed}: ${res.status} ${text.slice(0, 300)}`);
  if (res.status >= 300 && !text.includes("already_merged")) failed++;
}
process.exit(failed ? 1 : 0);
