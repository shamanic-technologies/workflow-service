/**
 * FOLLOWUP-JIT-1107-WRITER (owner 2026-11-07): the cold-email writer writes ONE email, the first one.
 *
 * A follow-up is written on the day it is due by the follow-up path, with the lead's latest context, and paid then.
 * Writing the follow-ups with the first email made the sender hold their sending cost for 3 to 10 days (about a third
 * of a $10 top-up looked frozen) and paid the model for emails nobody sends.
 *
 * The fleet writer is the stored script `message_written/dy_template_writer_full`, which carries its own copy of
 * content-generation's system prompt. content-generation #392 changed ITS copy; these are the same edits, byte for
 * byte, applied to the script's source (an UPGRADE of the dynasty, never a fork) and to each recorded case of it
 * (what the recorded production request becomes under the owner's rule). Nothing else changes: the template text,
 * the first-email instructions and every other byte of the request stay as recorded. The writer stays trusted: the
 * only output rule is the deterministic keep-the-first-step (content-generation's `firstEmailOnly`), never a check,
 * retry or refusal.
 */

/** [before, after] in the system prompt text, identical in the script source (plain quoted strings) and the request. */
export const FIRST_EMAIL_ONLY_PROMPT_EDITS: ReadonlyArray<readonly [string, string]> = [
  [
    '{"subject": "<email subject line>", "emails": [{"body": "<plain text email body>", "daysSinceLastStep": <number>}]}',
    '{"subject": "<email subject line>", "emails": [{"body": "<plain text email body>", "daysSinceLastStep": 0}]}',
  ],
  [
    "- emails: array of email steps. Each has:",
    "- emails: an array holding exactly ONE item, the first email. Write only that first email, even when the prompt below describes follow-up emails or a multi-step sequence: each follow-up is written later, on the day it is due. The item has:",
  ],
  ["  - daysSinceLastStep: days to wait since the previous email, 0 for the first (number)", "  - daysSinceLastStep: 0 (number)"],
];

/** The language directive (only in a request whose recipient's language is known). */
export const FIRST_EMAIL_ONLY_LANGUAGE_EDIT = ["subject line and every step of the sequence.", "subject line and body."] as const;

/** The parse step of the script: only the first step the writer answers is read. */
export const FIRST_EMAIL_ONLY_PARSE_EDIT = [
  "const emails = withSequenceDelays(json.emails);",
  "// FOLLOWUP-JIT-1107: one email per generation, the first; a step an older template still asked for is dropped.\n  const emails = withSequenceDelays(json.emails.slice(0, 1));",
] as const;

function countOf(text: string, part: string): number {
  return text.split(part).length - 1;
}

function replaceOnce(text: string, [before, after]: readonly [string, string], where: string): string {
  const n = countOf(text, before);
  if (n !== 1) throw new Error(`${where}: expected "${before.slice(0, 60)}" exactly once, found ${n}`);
  return text.replace(before, () => after);
}

/** The next version's source from the active one's. Throws when the source is not in the form these edits know. */
export function firstEmailOnlySource(code: string): string {
  let out = code;
  for (const edit of FIRST_EMAIL_ONLY_PROMPT_EDITS) out = replaceOnce(out, edit, "script source");
  out = replaceOnce(out, FIRST_EMAIL_ONLY_LANGUAGE_EDIT, "script source");
  return replaceOnce(out, FIRST_EMAIL_ONLY_PARSE_EDIT, "script source");
}

/** The system prompt of a recorded request under the rule: null when it is in neither the old nor the new form. */
export function firstEmailOnlySystemPrompt(systemPrompt: string): string | null {
  const edits = [...FIRST_EMAIL_ONLY_PROMPT_EDITS];
  if (edits.every(([, after]) => countOf(systemPrompt, after) === 1) && countOf(systemPrompt, FIRST_EMAIL_ONLY_LANGUAGE_EDIT[0]) === 0) return systemPrompt;
  if (!edits.every(([before]) => countOf(systemPrompt, before) === 1)) return null;
  let out = systemPrompt;
  for (const edit of edits) out = out.replace(edit[0], () => edit[1]);
  const lang = countOf(out, FIRST_EMAIL_ONLY_LANGUAGE_EDIT[0]);
  if (lang > 1) return null;
  if (lang === 1) out = out.replace(FIRST_EMAIL_ONLY_LANGUAGE_EDIT[0], () => FIRST_EMAIL_ONLY_LANGUAGE_EDIT[1]);
  return out;
}

interface WriterCaseLike {
  calls: Array<{ name: string; args?: Record<string, unknown> }>;
  expect: { content?: Record<string, unknown> };
}

/**
 * A recorded full-writer case under the rule: its `llm.complete` request carries the new system prompt and it expects
 * the first step only. `{excluded}` when the case is not a full-writer case in a known form (never guessed).
 */
export function firstEmailOnlyCase<C extends WriterCaseLike>(c: C): { case: C } | { excluded: string } {
  const calls = c.calls.map((call) => ({ ...call }));
  const llm = calls.filter((call) => call.name === "llm.complete");
  if (llm.length !== 1 || typeof llm[0]!.args?.systemPrompt !== "string") return { excluded: "no single llm.complete with a system prompt" };
  const systemPrompt = firstEmailOnlySystemPrompt(llm[0]!.args.systemPrompt);
  if (systemPrompt === null) return { excluded: "system prompt in neither the old nor the one-email form" };
  llm[0]!.args = { ...llm[0]!.args, systemPrompt };
  const sequence = c.expect.content?.sequence;
  if (!Array.isArray(sequence) || sequence.length === 0) return { excluded: "no stored sequence" };
  return { case: { ...c, calls, expect: { ...c.expect, content: { ...c.expect.content, sequence: sequence.slice(0, 1) } } } };
}
