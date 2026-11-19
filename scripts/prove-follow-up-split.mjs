#!/usr/bin/env node
/**
 * WRITER-SENDER-SPLIT-1118: proves the cut of the lead follow-up (`lead_interested/dy_follow_up_due`) on production's
 * own recorded cases BEFORE anything is stored, then gives its writer those cases.
 *
 * For every recorded case of the ACTIVE stored code (`writer_cases`, same code md5): the stored code and its two halves
 * (`splitFollowUp`) are run in the sandbox on the same record (each door answered from it, in order; the model answered
 * by the recorded completion; nothing called, nothing sent) and compared call by call: the same doors with the same
 * bodies, the model asked the same request, the same end (`compareFollowUpOnCase`). One case that differs = exit 1:
 * nothing may be stored. Prints counts and run ids only (cases hold personal data).
 *
 * `--writer-cases` keeps, for each case where the sender asked its writer, the writer's own case (what it was handed +
 * the model's recorded answer) as a `message_written` case, `wrote` = it made its Unit: what its pair proofs replay.
 * Dry run by default; `--apply` writes (idempotent per run id; needs the writer stored and every case the same).
 *
 * Runs inside the workflow-service container, from /app/scripts (it reads ../dist):
 *   docker exec <container> node scripts/prove-follow-up-split.mjs [--writer-cases [--apply]]
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../dist/db/index.js";
import { scripts, writerCases } from "../dist/db/schema.js";
import { readMaterials, runScript } from "../dist/lib/scripts/sandbox.js";
import { sameJson } from "../dist/lib/scripts/replay.js";
import { FOLLOW_UP_DYNASTY, FOLLOW_UP_SENDER_OUTCOME, FOLLOW_UP_WRITER_OUTCOME, compareFollowUpOnCase, followUpTactics, followUpWriterCase, splitFollowUp } from "../dist/lib/scripts/follow-up-split.js";

const keep = process.argv.includes("--writer-cases");
const apply = process.argv.includes("--apply");
const md5 = (s) => createHash("md5").update(s).digest("hex");
const active = async (outcome) =>
  (await db.select().from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, FOLLOW_UP_DYNASTY), eq(scripts.status, "active"))))[0] ?? null;

const sender = await active(FOLLOW_UP_SENDER_OUTCOME);
if (!sender) throw new Error(`no active ${FOLLOW_UP_SENDER_OUTCOME}/${FOLLOW_UP_DYNASTY}`);
const already = sender.code.includes(`ctx.get("${FOLLOW_UP_WRITER_OUTCOME}")`);
// Once the sender is upgraded, its stored code is the sender half: the unsplit code is its previous version.
const unsplit = already
  ? (await db.select().from(scripts).where(and(eq(scripts.outcome, FOLLOW_UP_SENDER_OUTCOME), eq(scripts.dynasty, FOLLOW_UP_DYNASTY), eq(scripts.version, sender.version - 1))))[0]
  : sender;
if (!unsplit || unsplit.code.includes(`ctx.get("${FOLLOW_UP_WRITER_OUTCOME}")`)) throw new Error("the unsplit follow-up code is not the active version nor the one before it");
const halves = splitFollowUp(unsplit.code);
const codeMd5 = md5(unsplit.code);
// A run draws a script only when every material its code reads is one it asks for or one its asker hands it: a sender
// reading a material nobody hands it would be stored and never run (2026-11-19, v9).
const tactics = followUpTactics(unsplit.tactics ?? {});
const unfed = { sender: readMaterials(halves.sender).filter((m) => !tactics.sender.asks.includes(m)), writer: readMaterials(halves.writer).filter((m) => !tactics.writer.asks.includes(m)) };
console.log(`materials: sender ${JSON.stringify(readMaterials(halves.sender))} asks ${JSON.stringify(tactics.sender.asks)}; writer ${JSON.stringify(readMaterials(halves.writer))} asks ${JSON.stringify(tactics.writer.asks)}`);
if (unfed.sender.length > 0 || unfed.writer.length !== 1) {
  console.log(`a half reads a material nobody hands it (sender: ${JSON.stringify(unfed.sender)}, writer beyond its one handed material: ${JSON.stringify(unfed.writer)}): nothing may be stored`);
  process.exit(1);
}
console.log(`unsplit code: ${FOLLOW_UP_SENDER_OUTCOME}/${FOLLOW_UP_DYNASTY}/v${unsplit.version} (md5 ${codeMd5})${already ? ", the active version is already the sender half" : ""}`);

const all = await db.select().from(writerCases).where(eq(writerCases.outcome, FOLLOW_UP_SENDER_OUTCOME));
const cases = all.filter((c) => c.codeMd5 === codeMd5);
const SENDS = ["email.send", "crm.whatsapp.send"];
const count = { read: cases.length, unfit: 0, same: 0, different: 0, wroteAndSame: 0, sendsCompared: 0, asksCompared: 0, writerAsked: 0, writerWrote: 0, productionWrote: cases.filter((c) => c.wrote).length };
const different = [];
const writerOnes = [];
for (const c of cases) {
  const r = await compareFollowUpOnCase(unsplit.code, halves, c.body, runScript, sameJson);
  // The stored code itself does not replay on this record (a read made that the record does not hold): no evidence.
  if (r.stored.end.kind === "stopped") {
    count.unfit++;
    continue;
  }
  if (!r.same) {
    count.different++;
    different.push(`${c.runId}: ${r.diff}`);
    continue;
  }
  count.same++;
  if (c.wrote) count.wroteAndSame++;
  count.sendsCompared += r.stored.steps.filter((s) => s.kind === "vendor" && SENDS.includes(s.name)).length;
  count.asksCompared += r.stored.steps.filter((s) => s.kind === "ask").length;
  if (r.handed) {
    count.writerAsked++;
    if (r.wrote) count.writerWrote++;
    writerOnes.push({ c, body: followUpWriterCase(c.body, r.handed), wrote: r.wrote });
  }
}
console.log(JSON.stringify({ casesOfOtherCode: all.length - cases.length, ...count }));
for (const d of different.slice(0, 20)) console.log(`DIFFERENT ${d}`);
if (count.different > 0) {
  console.log("the halves do NOT do what the stored code did on every recorded case: nothing may be stored");
  process.exit(1);
}

if (keep) {
  const writer = await active(FOLLOW_UP_WRITER_OUTCOME);
  if (apply && !writer) throw new Error(`no active ${FOLLOW_UP_WRITER_OUTCOME}/${FOLLOW_UP_DYNASTY}: store the writer first`);
  if (writer && writer.code !== halves.writer) throw new Error("the stored writer is not the writer cut from the unsplit code: nothing kept");
  let kept = 0;
  for (const w of writerOnes) {
    if (!apply) continue;
    const inserted = await db
      .insert(writerCases)
      .values({ outcome: FOLLOW_UP_WRITER_OUTCOME, runId: w.c.runId, recordedFrom: `${FOLLOW_UP_WRITER_OUTCOME}/${FOLLOW_UP_DYNASTY}/v${writer.version} (from ${w.c.recordedFrom})`, codeMd5: md5(writer.code), wrote: w.wrote, orgId: w.c.orgId, body: w.body, createdAt: w.c.createdAt })
      .onConflictDoNothing()
      .returning({ id: writerCases.id });
    kept += inserted.length;
  }
  console.log(`${writerOnes.length} writer cases (${writerOnes.filter((w) => w.wrote).length} wrote)${apply ? `: ${kept} kept now` : " (dry run)"}`);
}
process.exit(0);
