#!/usr/bin/env node
/**
 * ANSWER-CHECK-BEFORE-WRITE-1124: proves the check-before-write upgrade of the lead answerer's sender
 * (`message_sent/dy_answer_lead`) on production's recorded answerer runs BEFORE anything is stored, then prints the
 * catalogue write. It writes NOTHING itself and calls nobody (reads `scripts` and `writer_cases` only).
 *
 * The sender holds no recorded port cases; production's answerer runs are kept as writer cases of `message_sent`
 * (every door's answer + the model's completion). For each: the ACTIVE stored sender and its upgrade (`addAnswerCheck`,
 * tactic `checksEmailBeforeWriter: true`) run in the sandbox on the same record (every door answered from it, the
 * writer = the ACTIVE `message_written/dy_answer_lead` answering from the record's own completion; the check answered
 * by what the record's `email.send` said) and are compared (`compareAnswerCheckOnCase`): not checked or passed = the
 * very same calls, asks and end (plus the check, for the address the send goes to); refused = no email, the stored
 * no-channel end or WhatsApp alone. The upgrade is also run with the tactic ABSENT: the very same run, no check.
 * A record the stored sender does not replay (an older version's reads) is excluded with its reason.
 * One case that differs = exit 1: nothing may be stored. Prints counts, run ids and reasons only (cases hold personal data).
 *
 * `--ops` prints the `upgrade` line for `node scripts/post-catalogue-ops.mjs` (dry run first).
 *
 * Inside the workflow-service container, from /app/scripts (it reads ../dist):
 *   docker exec <container> node scripts/prove-answer-check-before-write.mjs [--ops]
 * Or on a build of this repo, the read piped from the box (`--print-sql` prints the read-only query):
 *   node scripts/prove-answer-check-before-write.mjs --print-sql | ssh <box> "docker exec -i <postgres> psql -U postgres -d workflow_service -At" | node scripts/prove-answer-check-before-write.mjs --stdin [--ops]
 */
import { readFileSync } from "node:fs";

const SQL = `SELECT json_build_object(
  'sender', (SELECT json_build_object('version', version, 'code', code, 'tactics', tactics) FROM scripts WHERE outcome='message_sent' AND dynasty='dy_answer_lead' AND status='active' AND dynasty_status='active'),
  'writer', (SELECT json_build_object('version', version, 'code', code, 'tactics', tactics) FROM scripts WHERE outcome='message_written' AND dynasty='dy_answer_lead' AND status='active' AND dynasty_status='active'),
  'cases', (SELECT coalesce(json_agg(json_build_object('id', run_id, 'wrote', wrote, 'body', body)), '[]'::json) FROM writer_cases WHERE outcome='message_sent' AND recorded_from LIKE 'message_sent/dy_answer_lead%')
);`;
if (process.argv.includes("--print-sql")) {
  console.log(SQL);
  process.exit(0);
}

const { runScript, validateSource } = await import("../dist/lib/scripts/sandbox.js");
const { sameJson } = await import("../dist/lib/scripts/replay.js");
const { ANSWER_CHECK_MARK, ANSWER_CHECK_SENDERS, ANSWER_CHECK_TACTIC, addAnswerCheck, answerCheckTactics, compareAnswerCheckOnCase } = await import("../dist/lib/scripts/answer-check-before-write.js");

const ops = process.argv.includes("--ops");
const log = (...a) => (ops ? console.error(...a) : console.log(...a));
const { outcome, dynasty } = ANSWER_CHECK_SENDERS[0];

async function load() {
  if (process.argv.includes("--stdin")) return JSON.parse(readFileSync(0, "utf8"));
  const { and, eq, like } = await import("drizzle-orm");
  const { db } = await import("../dist/db/index.js");
  const { scripts, writerCases } = await import("../dist/db/schema.js");
  const active = async (o) => (await db.select().from(scripts).where(and(eq(scripts.outcome, o), eq(scripts.dynasty, dynasty), eq(scripts.status, "active"), eq(scripts.dynastyStatus, "active"))))[0] ?? null;
  const rows = await db.select().from(writerCases).where(and(eq(writerCases.outcome, outcome), like(writerCases.recordedFrom, `${outcome}/${dynasty}%`)));
  return { sender: await active(outcome), writer: await active("message_written"), cases: rows.map((r) => ({ id: r.runId, wrote: r.wrote, body: r.body })) };
}

const { sender, writer, cases } = await load();
if (!sender) throw new Error(`no active ${outcome}/${dynasty}`);
if (!writer) throw new Error(`no active message_written/${dynasty}`);
if (sender.code.includes(ANSWER_CHECK_MARK)) {
  log(`${outcome}/${dynasty}/v${sender.version} already checks before writing: nothing to do`);
  process.exit(0);
}
const next = addAnswerCheck(sender.code);
await validateSource(next);
const stored = sender.tactics ?? {};
const tactics = answerCheckTactics(stored);

/** The ACTIVE writer on what the sender handed it, its model answering from the record's own completion. */
const writerOf = (c) => async (asked) => {
  const completion = c.calls.find((x) => x.name === "llm.complete");
  const content = asked?.units?.answer_requested?.content;
  if (!completion?.answer?.ok || !content) return null;
  const pick = c.calls.find((x) => x.name === "llm.pick");
  const llm = (pick?.answer?.ok ? pick.answer.data : null) ?? { provider: completion.args?.provider, model: completion.args?.model };
  const w = await runScript(writer.code, { subject: asked.subject?.id ?? null, brand: c.brand ?? "replay", day: c.day ?? 0, tactics: writer.tactics ?? {}, request: null }, async (op, args) => {
    if (op === "get" && String(args[0]) === "answer_requested") return { v: { id: "handed", outcome: "answer_requested", subject: "", ageDays: 0, content } };
    if (op === "get" && String(args[0]) === "llm_completion") return { v: { id: "recorded", outcome: "llm_completion", subject: "", ageDays: 0, content: { answer: completion.answer.data, llm } } };
    if (op === "ask") return { v: null };
    return { stop: `writer ${String(op)}` };
  });
  if (w.kind !== "done") return null;
  const r = w.result ?? {};
  return r.content ? { content: r.content } : { content: null, unmade: r.unmade, decided: r.decided, answer: r.answer };
};

const count = { cases: cases.length, unfit: 0, unchecked: 0, passed: 0, refused: 0, different: 0, differentWithoutTactic: 0, sentThroughEmailSend: 0, sentThroughReplyDoor: 0 };
const unfit = {};
for (const row of cases) {
  const c = { ...row.body, id: row.id };
  const r = await compareAnswerCheckOnCase(sender.code, next, c, { ...tactics, ...(c.tactics ?? {}), [ANSWER_CHECK_TACTIC]: true }, runScript, sameJson, writerOf(c));
  if (r.kind === "unfit") {
    count.unfit++;
    const why = r.diff.replace(/^the stored code does not replay it: /, "").slice(0, 80);
    unfit[why] = (unfit[why] ?? 0) + 1;
    continue;
  }
  if (!r.same) {
    count.different++;
    log(`DIFFERENT ${row.id}: ${r.diff}`);
    continue;
  }
  count[r.kind]++;
  if (r.old.steps.some((s) => s.name === "email.send")) count.sentThroughEmailSend++;
  if (r.old.steps.some((s) => s.name === "instantly.reply.send")) count.sentThroughReplyDoor++;
  // Tactic absent: the upgrade is the stored code, call for call.
  const off = await compareAnswerCheckOnCase(sender.code, next, c, { ...stored, ...(c.tactics ?? {}) }, runScript, sameJson, writerOf(c));
  if (!(off.same && off.kind === "unchecked")) {
    count.differentWithoutTactic++;
    log(`DIFFERENT WITHOUT THE TACTIC ${row.id}: ${off.diff ?? off.kind}`);
  }
}
log(`${outcome}/${dynasty}/v${sender.version} -> upgrade (${next.length} chars, tactic ${ANSWER_CHECK_TACTIC}=true), writer v${writer.version}: ${JSON.stringify(count)}`);
for (const [why, n] of Object.entries(unfit)) log(`EXCLUDED ${n}: ${why}`);
if (count.different > 0 || count.differentWithoutTactic > 0) {
  log(`${dynasty}: the upgrade does NOT do what the stored code did on every recorded run: nothing may be stored`);
  process.exit(1);
}
if (ops) console.log(JSON.stringify({ op: "upgrade", outcome, dynasty, fromVersion: sender.version, code: next, tactics, skipIfIncludes: ANSWER_CHECK_MARK }));
process.exit(0);
