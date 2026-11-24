/**
 * ANSWER-CHECK-BEFORE-WRITE-1124 (ENGINE-GET-ASK-1123 migration list, owner's go 2026-11-24): the lead answerer's sender
 * (`message_sent/dy_answer_lead`) asks the email send's own check BEFORE its writer, where the email can only leave
 * through that send.
 *
 * What the stored sender does on email (read off its code): the WRITER picks the channel, the thread and who it goes to
 * (EVERY-PERSON-ON-THE-THREAD-1109), so three of its four email paths are `instantly.reply.send` (a reply in a thread
 * of theirs, or a new thread from the mailbox of their conversation): instantly-service's reply door, which holds NO
 * address verdict gate (the person wrote to us from that address). Only the fourth, `email.send` (email-gateway
 * `/orgs/send`, the door `email.send_check` answers for), verifies the address, and it is taken exactly when the person
 * has an address, no email we can answer in its thread (`n === 0`) and no replied conversation. That is known BEFORE the
 * writer is asked, and the address is the person's own (`to: recipient`, the person whenever one is known).
 *
 * So, under tactic `checksEmailBeforeWriter: true` only (absent = the run byte for byte):
 * - in that one situation the sender asks `email.send_check` for the person's own address (the send's own checks:
 *   opted out, not a prospect, stated not to the brand, the address verdict; free on a held verdict);
 * - a pass = the run goes on as before (the send right after reuses the verdict);
 * - a named refusal (the predicate the send's own refusal is read with: a code on a 4xx) = EMAIL IS NOT OFFERED, which
 *   is two branches the stored code already has: WhatsApp still open = the writer is asked with WhatsApp alone; nothing
 *   open = its `no_channel` end (next date 30 days out, row stopped `follow_up_no_channel`), no writer asked;
 * - anything else from the check (5xx, transport) throws, as the send's does.
 * Never asked when the email may leave through the reply door: the check would refuse (and pay to verify) a person
 * that door answers today.
 *
 * Applied to the STORED code by one anchored edit (`addAnswerCheck`); proven on production's recorded answerer runs
 * (`compareAnswerCheckOnCase`, `scripts/prove-answer-check-before-write.mjs`).
 */

export const ANSWER_CHECK_MARK = "ANSWER-CHECK-BEFORE-WRITE-1124";
export const ANSWER_CHECK_DOOR = "email.send_check";
export const ANSWER_CHECK_TACTIC = "checksEmailBeforeWriter";
export const ANSWER_CHECK_SENDERS = [{ outcome: "message_sent", dynasty: "dy_answer_lead" }] as const;

/** The stored code's own line (found exactly once, else nothing is generated). */
export const ANSWER_CHECK_ANCHOR = '  if (email || n > 0) open.push("email");\n';
/** Lines the edit leans on: the send it answers for, and the end a person with no open channel already takes. */
const LEANS_ON = ['    sent = door("email.send", { body: { type: "broadcast", tag: "follow-up", followUp: true, to: recipient,', "  } else if (n === 0 && replied) {\n", '    close("follow_up_no_channel");\n'];

const CHECK_LINES =
  `  // ${ANSWER_CHECK_MARK}: where this person's email can only leave through email.send (an address, no email of\n` +
  "  // theirs to answer in its thread, no replied conversation), the send's own check is asked before the writer. A named\n" +
  "  // refusal = email is not offered: WhatsApp alone when it is open, else the no-channel end below. Tactic only.\n" +
  `  const onlyTheSend = ctx.tactics.${ANSWER_CHECK_TACTIC} === true && Boolean(email) && n === 0 && !threads.some(function (t) { return t.replied === true && s(t.campaignId); });\n` +
  `  const sendCheck = onlyTheSend ? door("${ANSWER_CHECK_DOOR}", { body: { type: "broadcast", followUp: true, to: email } }) : null;\n` +
  `  if (sendCheck && !sendCheck.ok && !(s(sendCheck.data.code) && sendCheck.data.status >= 400 && sendCheck.data.status < 500)) throw new Error("${ANSWER_CHECK_DOOR} failed: " + String(sendCheck.data.error));\n` +
  "  const emailRefused = Boolean(sendCheck && !sendCheck.ok);\n" +
  '  if ((email || n > 0) && !emailRefused) open.push("email");\n';

function once(code: string, anchor: string, name: string): number {
  const at = code.indexOf(anchor);
  if (at < 0 || code.indexOf(anchor, at + 1) >= 0) throw new Error(`answer-check: the stored code holds the ${name} line ${at < 0 ? "nowhere" : "more than once"}: nothing generated`);
  return at;
}

/** The sender's stored code with the check before its writer. Throws when an anchor moved or the check is already in. */
export function addAnswerCheck(code: string): string {
  if (code.includes(ANSWER_CHECK_MARK) || code.includes(`"${ANSWER_CHECK_DOOR}"`)) throw new Error("answer-check: the stored code already asks the check");
  const at = once(code, ANSWER_CHECK_ANCHOR, "open email channel");
  LEANS_ON.forEach((l, i) => once(code, l, `leaned-on #${i + 1}`));
  return code.slice(0, at) + CHECK_LINES + code.slice(at + ANSWER_CHECK_ANCHOR.length);
}

/** The sender's tactics with the check on. */
export function answerCheckTactics(tactics: Record<string, unknown>): Record<string, unknown> {
  return { ...tactics, [ANSWER_CHECK_TACTIC]: true };
}

// ---- the proof on one recorded case ----

type Answer = { ok: boolean; data: Record<string, unknown> };
export interface RecordedCall {
  name: string;
  args?: unknown;
  answer: Answer;
}
/** A recorded answerer run (`writer_cases` of `message_sent`): what production read and did. */
export interface AnswerCase {
  id: string;
  request?: Record<string, unknown> | null;
  tactics?: Record<string, unknown>;
  subject?: string | null;
  brand?: string;
  day?: number;
  calls: RecordedCall[];
  asked?: Record<string, unknown>;
}
export interface Step {
  kind: "vendor" | "ask";
  name: string;
  args: unknown;
}
type End = { kind: "done"; result: unknown } | { kind: "error"; message: string } | { kind: "stopped"; reason: string };
type RunFn = (
  code: string,
  spec: { subject: string | null; brand: string; day: number; tactics: Record<string, unknown>; request: Record<string, unknown> | null },
  bridge: (op: string, args: unknown[]) => Promise<{ v: unknown } | { stop: string }>,
) => Promise<End>;
/** The writer's Unit for what the sender handed it (the pair's writer on the record's own completion); null = none. */
export type WriterOf = (asked: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

/** Reads the active sender makes that older records do not hold: answered "nothing stated" to both codes alike. */
export const UNRECORDED_READS = ["brand.sales_rep"];
const WRITER_OUTCOME = "message_written";
const json = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** The check's answer on this record: the recorded `email.send`'s own named refusal when it was one, else a pass. */
export function answerCheckFromRecord(c: AnswerCase): { answer: Answer; refused: boolean } {
  const send = c.calls.find((x) => x.name === "email.send");
  const data = (send?.answer?.data ?? {}) as Record<string, unknown>;
  const status = Number(data.status);
  if (send && send.answer.ok === false && typeof data.code === "string" && data.code && status >= 400 && status < 500) return { answer: json(send.answer), refused: true };
  return { answer: { ok: true, data: { sendable: true, transport: "instantly", verdict: "valid", reused: true, verifiedAt: null } }, refused: false };
}

async function replay(code: string, c: AnswerCase, tactics: Record<string, unknown>, run: RunFn, same: (a: unknown, b: unknown) => boolean, writerOf: WriterOf, check: Answer | null) {
  const steps: Step[] = [];
  const used = new Set<number>();
  let asked: Record<string, unknown> | null = null;
  const end = await run(code, { subject: c.subject ?? null, brand: c.brand ?? "replay", day: c.day ?? 0, tactics, request: c.request ?? null }, async (op, args) => {
    if (op === "vendor") {
      const name = String(args[0]);
      const sent = json(args[1] ?? null);
      steps.push({ kind: "vendor", name, args: sent });
      if (name === ANSWER_CHECK_DOOR && check) return { v: json(check) };
      let at = c.calls.findIndex((r, i) => !used.has(i) && r.name === name && same(r.args ?? null, sent));
      if (at < 0) at = c.calls.findIndex((r, i) => !used.has(i) && r.name === name);
      if (at < 0) return UNRECORDED_READS.includes(name) ? { v: { ok: false, data: { error: "not recorded" } } } : { stop: `${name} not recorded` };
      used.add(at);
      return { v: json(c.calls[at]!.answer) };
    }
    if (op.startsWith("storage.")) return { v: null };
    if (op === "ask") {
      asked = (args[0] ?? null) as Record<string, unknown> | null;
      steps.push({ kind: "ask", name: "ask", args: json(asked) });
      return { v: null };
    }
    if (op === "get") {
      const outcome = String(args[0]);
      if (outcome === WRITER_OUTCOME && asked) {
        const unit = await writerOf(asked);
        return unit ? { v: { id: "written", outcome, subject: "", ageDays: 0, ...unit } } : { stop: "the writer's answer is not recorded" };
      }
      const held = (c.asked ?? {})[outcome];
      return held !== undefined ? { v: json(held) } : { stop: `${outcome} not recorded` };
    }
    return { stop: String(op) };
  });
  return { steps, end };
}

export interface AnswerCheckComparison {
  /**
   * `unchecked`: the check was not asked (not the situation, or never reached it); `passed`: asked, it passed;
   * `refused`: asked, the record's send had been refused; `unfit`: the stored code does not replay the record.
   */
  kind: "unchecked" | "passed" | "refused" | "unfit";
  same: boolean;
  diff: string | null;
  old: { steps: Step[]; end: End };
  next: { steps: Step[]; end: End };
}

/**
 * The stored sender and its checked upgrade on ONE recorded run, every door answered from the record (nothing called,
 * nothing sent). Not checked or passed = the very same calls, asks and end (plus the check, asked for the address the
 * send then goes to). Refused = no email send; with nothing else open no writer is asked and the run takes the stored
 * no-channel end; with WhatsApp open the writer is asked with WhatsApp alone.
 */
export async function compareAnswerCheckOnCase(
  oldCode: string,
  newCode: string,
  c: AnswerCase,
  tactics: Record<string, unknown>,
  run: RunFn,
  same: (a: unknown, b: unknown) => boolean,
  writerOf: WriterOf,
): Promise<AnswerCheckComparison> {
  const checked = answerCheckFromRecord(c);
  const old = await replay(oldCode, c, tactics, run, same, writerOf, null);
  if (old.end.kind === "stopped") return { kind: "unfit", same: false, diff: `the stored code does not replay it: ${old.end.reason}`, old, next: { steps: [], end: old.end } };
  const next = await replay(newCode, c, tactics, run, same, writerOf, checked.answer);
  const asksCheck = next.steps.filter((s) => s.name === ANSWER_CHECK_DOOR);
  const kind: AnswerCheckComparison["kind"] = asksCheck.length === 0 ? "unchecked" : checked.refused ? "refused" : "passed";
  let diff: string | null = null;
  if (next.end.kind === "stopped") diff = `the upgrade does not replay it: ${next.end.reason}`;
  if (diff === null && asksCheck.length > 1) diff = "the check was asked more than once";
  const oldSend = old.steps.find((s) => s.name === "email.send");
  if (diff === null && tactics[ANSWER_CHECK_TACTIC] !== true && asksCheck.length > 0) diff = "the check was asked with the tactic absent";
  if (diff === null && kind !== "refused") {
    // Asked exactly when the stored run's email left through email.send (or never wrote an email at all).
    if (oldSend && tactics[ANSWER_CHECK_TACTIC] === true && asksCheck.length === 0) diff = "the stored run sent through email.send, the upgrade asked no check";
    if (diff === null && asksCheck.length === 1 && old.steps.some((s) => s.name === "instantly.reply.send")) diff = "the check was asked on a run that answers through the reply door";
    const got = next.steps.filter((s) => s.name !== ANSWER_CHECK_DOOR);
    if (diff === null && old.steps.length !== got.length) diff = `the stored code made ${old.steps.length} calls, the upgrade ${got.length}`;
    for (let i = 0; diff === null && i < got.length; i++) {
      const x = old.steps[i]!;
      const y = got[i]!;
      if (x.kind !== y.kind || x.name !== y.name) diff = `call ${i + 1}: the stored code made ${x.kind} ${x.name}, the upgrade ${y.kind} ${y.name}`;
      else if (!same(x.args, y.args)) diff = `call ${i + 1} ${x.name}: not the same request`;
    }
    if (diff === null && asksCheck.length === 1 && oldSend) {
      const sentTo = (oldSend.args as { body?: { to?: unknown } } | null)?.body?.to;
      const checkedTo = (asksCheck[0]!.args as { body?: { to?: unknown } } | null)?.body?.to;
      if (sentTo !== checkedTo) diff = "the check asked another address than the send's";
    }
    if (diff === null && !same(old.end, next.end)) diff = `not the same end (${old.end.kind} / ${next.end.kind})`;
  }
  if (diff === null && kind === "refused") {
    if (next.steps.some((s) => s.name === "email.send" || s.name === "instantly.reply.send")) diff = "a refused run still emailed";
    const ask = next.steps.find((s) => s.kind === "ask" && Boolean((s.args as { units?: Record<string, unknown> } | null)?.units?.answer_requested));
    const open = ((ask?.args as { units?: { answer_requested?: { content?: { open?: unknown } } } } | undefined)?.units?.answer_requested?.content?.open ?? null) as string[] | null;
    if (diff === null && open && open.includes("email")) diff = "a refused run still offered email to its writer";
    const result = next.end.kind === "done" ? (next.end.result as { unmade?: unknown } | null) : null;
    if (diff === null && !ask && result?.unmade !== "no_channel") diff = "a refused run with nothing else open did not take the no-channel end";
  }
  return { kind, same: diff === null, diff, old, next };
}
