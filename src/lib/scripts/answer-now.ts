/**
 * ANSWER-NOW-1119: our writers never wait for a "sensible hour".
 *
 * Owner 2026-11-19: « mets tout le tps l'instant, ça n'a aucun sens d'attendre pour personne. Upgrade le script
 * existant ». A Doc Dinners prospect replied at 9:30pm Chicago time on 2026-11-10; `message_written/dy_answer_lead`
 * answered `later` ("not a sensible hour to write, next working hour is 8:00am Chicago"). Chiropractors reply mostly in
 * the evening, so most positive replies waited until the next morning, while an answer within the minute is what books.
 *
 * The prompt LICENSED the wait (THEIR LOCAL TIME: "Write now only at a sensible hour for them ... Outside it, set
 * decision to later"), so the fix deletes that licence (the writer is trusted: no gate forcing `write`). Their local
 * time stays context for HOW the message reads. The next date loses its "working day and working hour" pick (a due
 * follow-up is written when it is due, at any hour); the meeting reminder keeps "the day before or a few hours before"
 * and drops its "sensible hour". Everything else (how long to wait between follow-ups, a timing anyone stated) is kept.
 *
 * The same three edits are applied to the shared prompt text (`right-moment.ts`, `answering-strategies.ts`) and, as an
 * UPGRADE of each live dynasty (owner rule), to the stored scripts' sources and their recorded cases. Every text here
 * holds no double quote and no backslash: identical in a script source, a JSON-encoded constant and a rendered prompt.
 */

/** THEIR LOCAL TIME: the licence to answer `later` on the clock, replaced by "the clock never delays a message". */
export const ANSWER_NOW_LOCAL_TIME_EDIT = [
  "Work out their local time first. Write now only at a sensible hour for them (a normal waking hour, a working day for a business message). Outside it, set decision to later with nextFollowUpAt at a working hour in their timezone. When nothing tells you their timezone",
  "Work out their local time first. Their local hour and weekday never delay a message: when it is the right moment to write, write now, at any hour, any day. Their local time only shapes how you write (a greeting that fits their evening, any day or time you name). When nothing tells you their timezone",
] as const;

/** THE NEXT DATE: the working-hour pick removed (the gap in days/weeks and any stated timing stay). */
export const ANSWER_NOW_NEXT_DATE_EDIT = ["(honour it exactly). Pick a working day and a working hour in their timezone when you know it. ISO 8601", "(honour it exactly). ISO 8601"] as const;

/** The meeting reminder keeps its moment before the meeting, without a "sensible hour". */
export const ANSWER_NOW_MEETING_EDIT = [
  "(the day before or a few hours before, at a sensible hour in their timezone)",
  "(the day before or a few hours before)",
] as const;

export const ANSWER_NOW_EDITS: ReadonlyArray<readonly [string, string]> = [ANSWER_NOW_LOCAL_TIME_EDIT, ANSWER_NOW_NEXT_DATE_EDIT, ANSWER_NOW_MEETING_EDIT];

/** Any instruction to wait for the clock: none may remain in a live script or in the shared prompt text. */
export const CLOCK_WAIT_PATTERN = /sensible hour|waking hour|working hour|working day/i;

/** The live dynasties that held the clock rule on 2026-11-19 (each upgraded once). */
export const ANSWER_NOW_DYNASTIES: ReadonlyArray<readonly [outcome: string, dynasty: string]> = [
  ["message_written", "dy_answer_lead"],
  ["message_written", "dy_follow_up_due"],
  ["lead_interested", "dy_follow_up_due"],
  ["message_written", "dy_client_check_in"],
  ["paid_client", "dy_client_check_in"],
  ["message_written", "dy_brand_team"],
  ["paid_client", "dy_brand_team"],
  ["client_satisfied", "dy_client_whatsapp"],
];

function countOf(text: string, part: string): number {
  return text.split(part).length - 1;
}

/**
 * The next version's source from the active one's: the local-time licence must be there (once per medium), every edit
 * applied everywhere it stands, and no clock-wait instruction may survive. Throws otherwise (a source in an unexpected
 * form is reported, never guessed at).
 */
export function answerNowSource(code: string): string {
  if (countOf(code, ANSWER_NOW_LOCAL_TIME_EDIT[1]) > 0) throw new Error("script source: already answers now");
  if (countOf(code, ANSWER_NOW_LOCAL_TIME_EDIT[0]) === 0) throw new Error("script source: the local-time licence is not there");
  let out = code;
  for (const [before, after] of ANSWER_NOW_EDITS) out = out.split(before).join(after);
  const left = CLOCK_WAIT_PATTERN.exec(out);
  if (left) throw new Error(`script source: a clock-wait instruction is left: ...${out.slice(Math.max(0, left.index - 120), left.index + 60)}...`);
  return out;
}

/**
 * A recorded case under the rule: every recorded string that held the old texts (the writer's prompt) restated; the
 * recorded answers keep their words (the edits' long texts never appear in a model answer). `{excluded}` when already
 * restated.
 */
export function answerNowCase<C>(c: C): { case: C } | { excluded: string } {
  const text = JSON.stringify(c);
  if (countOf(text, ANSWER_NOW_LOCAL_TIME_EDIT[1]) > 0) return { excluded: "already restated" };
  let out = text;
  for (const [before, after] of ANSWER_NOW_EDITS) out = out.split(before).join(after);
  return { case: JSON.parse(out) as C };
}
