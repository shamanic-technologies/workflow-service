/**
 * LEAD-EVENT-FOUNDER-HELLO-DOUBLE-1124: THE RIGHT MOMENT keys on THE THREAD's last message.
 *
 * 2026-11-22 a lead signed up at 14:04 UTC. At 14:31 our founder hello wrote to him on WhatsApp and our assistant's
 * line wrote right after. At 14:34 the lead follow-up fired on the fact "signed up 30 minutes ago, not paid"; its
 * writer read a thread already holding our five messages and still decided `write`: a third introduction in nine
 * minutes, to a person who had written nothing. The prompt licensed it: "It is NOT the right moment when someone on
 * our side already wrote to them after their last message" says nothing about a person with no message at all, and the
 * fact that made the run due (the signup) was older than our last message.
 *
 * The fix is the writer's INPUT (the writer is trusted: never a check, retry or rule on its output): both clauses of
 * THE RIGHT MOMENT restated as one two-sided invariant on the thread's last message (`rightMomentStrategy`,
 * `../right-moment.ts`). Every stored writer carries that text in its code, for both media, so each is UPGRADED by the
 * anchored edits below (whole prompt lines: no quote, no backslash, no newline, so a line reads the same in a script's
 * source, in the rendered prompt and in a recorded case). A moved anchor = nothing generated.
 */
import { EMAIL_MEDIUM, WHATSAPP_MEDIUM, rightMomentStrategy, type RightMomentMedium } from "../right-moment.js";

/** The two lines as every stored writer holds them today (frozen: what the edits look for). */
const storedLines = (m: RightMomentMedium): [string, string] => [
  "It is NOT the right moment when someone on our side already wrote to them after their last message and they have not answered it yet (a person of our team writing by hand counts exactly like an " + m.automated + "), or when what this " + m.message + " would say was already said to them. Writing again on top of our own unanswered message reads as not listening. Then set decision to later: nothing is sent, " + m.emptyFields + ", and choose nextFollowUpAt from the history (how recently we wrote, what we told them and when, anything they said about timing).",
  "It IS the right moment when they are waiting for us (their message is the last one and nobody on our side answered it), or when enough time passed since our last message for a new, useful follow-up. Then set decision to write: " + m.whereItGoes + ", so never re-introduce us and never repeat what the thread already says.",
];

export interface AnchoredEdit {
  why: string;
  from: string;
  to: string;
}

const MEDIA: ReadonlyArray<[string, RightMomentMedium]> = [
  ["email", EMAIL_MEDIUM],
  ["WhatsApp", WHATSAPP_MEDIUM],
];

/** Stored line -> the line `rightMomentStrategy` states now, per medium (NOT clause, then IS clause). */
export const OUR_MESSAGE_LAST_EDITS: ReadonlyArray<AnchoredEdit> = MEDIA.flatMap(([name, m]) => {
  const now = rightMomentStrategy(m).split("\n");
  const [notBefore, isBefore] = storedLines(m);
  return [
    { why: `${name}: it is NOT the right moment while our message is the thread's last one, whoever of ours wrote it; a fact older than it is no reason to write`, from: notBefore, to: now[1] },
    { why: `${name}: it IS the right moment when theirs is last, when they did something after ours, or when enough time passed`, from: isBefore, to: now[2] },
  ];
});

/** The stored writers carrying the text, none with a recorded case: upgraded through the catalogue poster. */
export const OUR_MESSAGE_LAST_WRITER_OUTCOME = "message_written";
export const OUR_MESSAGE_LAST_WRITERS = ["dy_answer_lead", "dy_follow_up_due", "dy_client_check_in", "dy_brand_team"] as const;

/** A text only the restated lines hold: a source or a case carrying it is already done. */
export const OUR_MESSAGE_LAST_MARKER = "when the last message in THE THREAD is ours";

function countOf(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** True when the source holds THE RIGHT MOMENT as stored before this change (either medium). */
export function carriesStoredRightMoment(code: string): boolean {
  return OUR_MESSAGE_LAST_EDITS.some((e) => countOf(code, e.from) > 0);
}

/**
 * The next version's source from the active one's: every edit found exactly once, applied in order. Throws on a
 * source already restated, or holding any line in another count (a moved anchor = nothing generated).
 */
export function ourMessageLastSource(code: string): string {
  if (countOf(code, OUR_MESSAGE_LAST_MARKER) > 0) throw new Error("our-message-last: the script source already keys THE RIGHT MOMENT on the thread's last message");
  let out = code;
  for (const e of OUR_MESSAGE_LAST_EDITS) {
    const n = countOf(out, e.from);
    if (n !== 1) throw new Error(`our-message-last: expected the stored line once, found ${n} (${e.why}): nothing generated`);
    out = out.replace(e.from, () => e.to);
  }
  return out;
}

/**
 * A recorded case under the rule: every recorded string holding a stored line (the writer's prompt, as it was sent)
 * restated, the recorded answers untouched (a model answer never holds a whole prompt line). A case whose writer
 * never ran is returned as is. `{excluded}` when the case is already restated.
 */
export function ourMessageLastCase<C>(c: C): { case: C } | { excluded: string } {
  const text = JSON.stringify(c);
  if (countOf(text, OUR_MESSAGE_LAST_MARKER) > 0) return { excluded: "already restated" };
  let out = text;
  for (const e of OUR_MESSAGE_LAST_EDITS) out = out.split(e.from).join(e.to);
  return { case: JSON.parse(out) as C };
}
