/**
 * INTRO-VERIFY-BEFORE-WRITE-1124 (ENGINE-GET-ASK-1123 migration list, owner's go 2026-11-24): the intro conversation
 * (`message_sent/dy_intro_answer`) asks the email send's own check on the OTHER person's address before its writer,
 * when its next step can be a NEW email to them.
 *
 * What the stored script does (read off its code): ONE writer call decides the action and writes every text. Every
 * reply goes through `instantly.reply.send` (the reply door: no address verdict gate, the person wrote to us from that
 * address; never checked, ANSWER-CHECK-BEFORE-WRITE-1124). ONE action opens a new thread: `ask_other`, the double
 * opt-in email to the person we proposed (`email.send`), and it is open exactly when the reader's pending intro is
 * `proposed`. That is known BEFORE the writer is asked, and so is the address (`me.pending.email`).
 *
 * So, under tactic `checksEmailBeforeWriter: true` only (absent = the run byte for byte):
 * - a reader whose pending intro is `proposed` and names an address: `email.send_check` on that address (the send's
 *   own checks; free on a held verdict), before the writer;
 * - a pass = the run goes on as before;
 * - a named refusal (the predicate the stored `ask_other` send's refusal is read with: a code on a 409) = the branch
 *   the stored code already takes when that send is refused: the pending intro is kept `refused` with the door's code
 *   (`pending: {..., state: "refused", refusal: code}`). `ask_other` is then not open and a new intro is (the stored
 *   rule: « a new one once nothing is pending (none yet, or the last one introduced, declined or refused) »): the
 *   writer is asked knowing it, and never writes the two emails of an ask the door would refuse;
 * - anything else from the check throws, as the send's does.
 *
 * Applied to the STORED code by one anchored edit (`addIntroAnswerCheck`); a moved anchor = nothing generated.
 */

export const INTRO_ANSWER_CHECK_MARK = "INTRO-VERIFY-BEFORE-WRITE-1124";
export const INTRO_ANSWER_CHECK_DOOR = "email.send_check";
/** The lead answerer's tactic of the same meaning (ANSWER-CHECK-BEFORE-WRITE-1124): one name for one decision. */
export const INTRO_ANSWER_CHECK_TACTIC = "checksEmailBeforeWriter";
export const INTRO_ANSWER_SENDERS = [{ outcome: "message_sent", dynasty: "dy_intro_answer" }] as const;

/** The stored code's own line the check goes in front of (found exactly once, else nothing is generated). */
export const INTRO_ANSWER_ANCHOR = '  const open: string[] = ["reply", "later", "stop", "escalate"];\n';
/**
 * Lines the edit leans on, each found exactly once: where `ask_other` opens, the refused send's predicate and the
 * branch it takes (the one the check reproduces), and the rule that a refused pending intro lets a new one be found.
 */
const LEANS_ON = [
  '    if (me.pending && me.pending.state === "proposed") open.unshift("ask_other");\n',
  "      if (!(code && Number(ask.data?.status) === 409)) throw new Error(\"email.send (double opt-in) failed: \" + String(ask.data?.error ?? \"\").slice(0, 300));\n",
  '      save(email, { ...me, pending: { ...other, state: "refused", refusal: code } });\n',
  '    const pendingOpen = me.pending && ["proposed", "asked"].indexOf(String(me.pending.state)) >= 0;\n',
];

const CHECK_LINES =
  `  // ${INTRO_ANSWER_CHECK_MARK}: when the next step can be a NEW email to the person we proposed (ask_other), the send's\n` +
  "  // own check is asked on their address before the writer. A named refusal = the stored branch of a refused ask: the\n" +
  "  // pending intro is kept refused with the door's code, so ask_other is not open and a new intro is. Tactic only.\n" +
  '  const proposedEmail = me.role === "reader" && me.pending && me.pending.state === "proposed" ? emailOf(me.pending.email) : "";\n' +
  `  if (t.${INTRO_ANSWER_CHECK_TACTIC} === true && proposedEmail) {\n` +
  `    const otherCheck = ctx.vendor.call("${INTRO_ANSWER_CHECK_DOOR}", { body: { type: "broadcast", to: proposedEmail } });\n` +
  "    if (!otherCheck.ok) {\n" +
  "      const refusalCode = s(otherCheck.data?.code) || s(otherCheck.data?.body?.code);\n" +
  `      if (!(refusalCode && Number(otherCheck.data?.status) === 409)) throw new Error("${INTRO_ANSWER_CHECK_DOOR} (double opt-in) failed: " + String(otherCheck.data?.error ?? "").slice(0, 300));\n` +
  '      me.pending = { ...me.pending, state: "refused", refusal: refusalCode };\n' +
  "      ctx.storage.set(PEOPLE, email, me);\n" +
  "    }\n" +
  "  }\n";

function once(code: string, anchor: string, name: string): number {
  const at = code.indexOf(anchor);
  if (at < 0 || code.indexOf(anchor, at + 1) >= 0) throw new Error(`intro-answer-check: the stored code holds the ${name} line ${at < 0 ? "nowhere" : "more than once"}: nothing generated`);
  return at;
}

/** The stored intro conversation with the check before its writer. Throws when an anchor moved or the check is already in. */
export function addIntroAnswerCheck(code: string): string {
  if (code.includes(INTRO_ANSWER_CHECK_MARK) || code.includes(`"${INTRO_ANSWER_CHECK_DOOR}"`)) throw new Error("intro-answer-check: the stored code already asks the check");
  const at = once(code, INTRO_ANSWER_ANCHOR, "open actions");
  LEANS_ON.forEach((l, i) => once(code, l, `leaned-on #${i + 1}`));
  for (const needs of ["  const t: any = ", "const PEOPLE = ", "  const me: any = ", "  const email = emailOf("]) {
    const i = code.indexOf(needs);
    if (i < 0 || i > at) throw new Error(`intro-answer-check: the stored code does not state \`${needs.trim()}\` before the open actions: nothing generated`);
  }
  return code.slice(0, at) + CHECK_LINES + code.slice(at);
}

/** The tactics with the check on. */
export function introAnswerCheckTactics(tactics: Record<string, unknown>): Record<string, unknown> {
  return { ...tactics, [INTRO_ANSWER_CHECK_TACTIC]: true };
}
