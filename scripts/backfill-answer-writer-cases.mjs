#!/usr/bin/env node
/**
 * ONE-WRITER-N-MODELS-1116-ANSWERER: the lead answer WRITER (`message_written/dy_answer_lead`) gets the real cases the
 * answerer's per-model copies were proven on. Each `message_sent` writer case of `dy_answer_lead*` is replayed through
 * the SENDER (its recorded reads answered from the record, nothing called, nothing sent) up to the material it hands
 * its writer; the model's recorded answer becomes the completion the writer asked. Kept as a `message_written` case
 * (`wrote` as production: it sent after its model). Dry run by default; `--apply` writes (idempotent per run id).
 * Runs inside the workflow-service container (dist): docker exec <container> node scripts/backfill-answer-writer-cases.mjs [--apply]
 */
import { createHash } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { db } from "../dist/db/index.js";
import { scripts, writerCases } from "../dist/db/schema.js";
import { runScript } from "../dist/lib/scripts/sandbox.js";
import { sameJson } from "../dist/lib/scripts/replay.js";
import { ANSWER_DYNASTY, ANSWER_SENDER_OUTCOME, ANSWER_WRITER_OUTCOME, splitAnswerLead, writerCaseFromStoredCase } from "../dist/lib/scripts/answer-lead-split.js";

const apply = process.argv.includes("--apply");
const active = async (outcome) =>
  (await db.select().from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, ANSWER_DYNASTY), eq(scripts.status, "active"))))[0] ?? null;

const writer = await active(ANSWER_WRITER_OUTCOME);
if (!writer) throw new Error(`no active ${ANSWER_WRITER_OUTCOME}/${ANSWER_DYNASTY}: store the writer first`);
const sender = await active(ANSWER_SENDER_OUTCOME);
if (!sender) throw new Error(`no active ${ANSWER_SENDER_OUTCOME}/${ANSWER_DYNASTY}`);
// Before the sender's upgrade its active code still writes itself: the sender is cut from it, exactly as stored next.
const senderCode = sender.code.includes('"llm.pick"') ? splitAnswerLead(sender.code).sender : sender.code;
const writerMd5 = createHash("md5").update(writer.code).digest("hex");

const old = await db.select().from(writerCases).where(and(eq(writerCases.outcome, ANSWER_SENDER_OUTCOME), like(writerCases.recordedFrom, `${ANSWER_SENDER_OUTCOME}/${ANSWER_DYNASTY}%`)));
let kept = 0;
let skipped = 0;
for (const c of old) {
  const body = await writerCaseFromStoredCase(senderCode, c.body, (code, spec, bridge) => runScript(code, spec, bridge), sameJson);
  if (!body) {
    skipped++;
    continue;
  }
  kept++;
  if (!apply) continue;
  await db
    .insert(writerCases)
    .values({ outcome: ANSWER_WRITER_OUTCOME, runId: c.runId, recordedFrom: `${ANSWER_WRITER_OUTCOME}/${ANSWER_DYNASTY}/v${writer.version} (from ${c.recordedFrom})`, codeMd5: writerMd5, wrote: c.wrote, orgId: c.orgId, body, createdAt: c.createdAt })
    .onConflictDoNothing();
}
console.log(`${old.length} answerer cases read: ${kept} writer cases${apply ? " kept" : " (dry run)"}, ${skipped} did not fit the sender or never reached the model`);
process.exit(0);
