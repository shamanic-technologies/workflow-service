/**
 * SENDER-NAME-BODY-1111 (owner 2026-11-11: « ça dépend du script, template email, donc de la tactique choisie »).
 *
 * A cold email goes out from a mailbox chosen AFTER it is written, and the personas rotate ("Kevin Lourd", "Brylee
 * Merrill"...). The writer did not know it: it read "founded by Chaim Tesser" in the brand facts and wrote "My name is
 * Chaim and I run Beyond Logic" above a signature the script chose, "{full_name} / Beyond Logic", rendered "Kevin
 * Lourd / Beyond Logic"; 24 Beyond Logic emails since 2026-11-07 also ended on a hand-written "Chaim Tesser / Beyond
 * Logic" above the appended signature (two signatures).
 *
 * The fix is FACTS of the game, never a rule for one brand, a check or a retry (the writer is trusted):
 *  - the fleet writer `message_written/dy_template_writer_full` (an UPGRADE of the dynasty) is told who sends: a
 *    mailbox persona chosen after it writes, whose name reaches the email only through the four sender placeholders
 *    instantly-service fills per email (`{first_name}`, `{last_name}`, `{full_name}`, `{sender_email}`, in the body
 *    and the subject since SENDER-NAME-BODY-1111 there), that a signature naming the sender is appended after its
 *    text, and that anyone else it names is not the sender; it then decides who speaks and keeps it coherent. The
 *    deleted lines: "The sending service appends the sender's name, title, and organization" (it never said WHO the
 *    sender is, so the founder in the facts read as the sender) and the ban on every placeholder (it forbade the only
 *    way to name the sender). When the asking script states the signature it will have appended (`ctx.request
 *    .signature`), the writer reads it word for word.
 *  - the cold email scripts that CHOOSE the signature (tactic `signedBy`, the `_signed_*` dynasties, an UPGRADE each)
 *    decide it BEFORE asking the writer and hand it over as the ask's `request.signature`. A script stating no
 *    `signedBy` hands nothing: its ask stays byte for byte, so `dy_cold_email` and `dy_cold_email_site` are untouched.
 *
 * Applied like FOLLOWUP-JIT (`first-email-only.ts`): the same edits on the active version's source and on each
 * recorded writer case's system prompt (a recorded case states no signature: the generic facts only).
 */

/** The sender facts, one prompt line each (no double quote, no backslash: identical in the source and the prompt). */
export const WHO_SENDS_LINE =
  "- WHO SENDS THIS EMAIL: it goes out from one of several sending mailboxes, picked after you write, each with its own person, so you know neither the sender's name nor their role. Their name reaches the email only through four placeholders, filled per email at send from the mailbox that sends it, in the subject and the body alike: {first_name}, {last_name}, {full_name}, {sender_email} (single braces, written exactly so). That same person is the From of the email, and a signature block naming them is appended after your text by the sending service. Anyone else you name, the client's founder or team included, is a different person. Decide who speaks in this email and keep it true from the first line to the signature: whoever writes in the first person is the sender; anyone else is named in the third person. Your output ends with the last sentence of the email body, the signature follows it.";

export const PLACEHOLDERS_LINE =
  "- The four sender placeholders are the only placeholders: never [Your name], [Company], [Insert X] or any other. Every other piece of text you produce must be ready to send as-is.";

/** [before, after] in the writer's system prompt, identical in the script source (plain quoted strings) and the request. */
export const SENDER_IDENTITY_PROMPT_EDITS: ReadonlyArray<readonly [string, string]> = [
  [
    "- NEVER include a sign-off, signature, or footer at the end of the email (e.g. '— [Your name]', 'Best, [Name]', 'Regards, …'). The sending service appends the sender's name, title, and organization automatically. Your output must end with the last sentence of the email body — nothing after it.",
    WHO_SENDS_LINE,
  ],
  [
    "- NEVER use placeholders like [Your name], [Company], [Insert X], etc. Every piece of text you produce must be ready to send as-is.",
    PLACEHOLDERS_LINE,
  ],
];

/** Twice in the prompt (campaign instruction + who the recipient is): both name the universal rules. */
export const UNIVERSAL_RULES_EDIT = ["(no sign-off, no placeholder).", "(no sign-off, no placeholder but the four sender ones)."] as const;

/** The writer reads the signature the asking script states, right after the voice. */
const SIGNATURE_READ_ANCHOR = "  let systemPrompt = `${GLOBAL_SYSTEM_PROMPT}\\n${buildClientCommsVoiceDirective(voice)}`;\n";
const SIGNATURE_READ = [
  "  // SENDER-NAME-BODY-1111: the signature the asking script will have appended, word for word, when it states one.",
  "  const statedSignature = typeof (ctx.request as Record<string, unknown> | null)?.signature === \"string\" ? String((ctx.request as Record<string, unknown>).signature).trim() : \"\";",
  "  if (statedSignature) systemPrompt = `${systemPrompt}\\n${buildSignatureDirective(statedSignature)}`;",
  "",
].join("\n");

export const SIGNATURE_DIRECTIVE_SOURCE = [
  "",
  "// SENDER-NAME-BODY-1111: the signature appended after the text, as the asking script chose it (placeholders filled at send).",
  "function buildSignatureDirective(signature: string): string {",
  "  return [",
  "    \"\",",
  "    \"THE SIGNATURE appended after your text for this email (the sender placeholders in it are filled at send):\",",
  "    \"<<<\",",
  "    signature,",
  "    \">>>\",",
  "  ].join(\"\\n\");",
  "}",
  "",
].join("\n");

function countOf(text: string, part: string): number {
  return text.split(part).length - 1;
}

function replaceExactly(text: string, [before, after]: readonly [string, string], times: number, where: string): string {
  const n = countOf(text, before);
  if (n !== times) throw new Error(`${where}: expected "${before.slice(0, 60)}" ${times} time(s), found ${n}`);
  return text.split(before).join(after);
}

/** The writer's next version from the active one's. Throws when the source is not in the form these edits know. */
export function senderIdentitySource(code: string): string {
  let out = code;
  for (const edit of SENDER_IDENTITY_PROMPT_EDITS) out = replaceExactly(out, edit, 1, "script source");
  out = replaceExactly(out, UNIVERSAL_RULES_EDIT, 2, "script source");
  out = replaceExactly(out, [SIGNATURE_READ_ANCHOR, SIGNATURE_READ_ANCHOR + SIGNATURE_READ], 1, "script source");
  return out.replace(/\n*$/, "\n") + SIGNATURE_DIRECTIVE_SOURCE;
}

/** A recorded request's system prompt under the rule: null when it is in neither the old nor the new form. */
export function senderIdentitySystemPrompt(systemPrompt: string): string | null {
  const edits = [...SENDER_IDENTITY_PROMPT_EDITS];
  if (edits.every(([, after]) => countOf(systemPrompt, after) === 1) && countOf(systemPrompt, UNIVERSAL_RULES_EDIT[0]) === 0) return systemPrompt;
  if (!edits.every(([before]) => countOf(systemPrompt, before) === 1)) return null;
  let out = systemPrompt;
  for (const [before, after] of edits) out = out.replace(before, () => after);
  return out.split(UNIVERSAL_RULES_EDIT[0]).join(UNIVERSAL_RULES_EDIT[1]);
}

interface WriterCaseLike {
  calls: Array<{ name: string; args?: Record<string, unknown> }>;
}

/** A recorded full-writer case under the rule (its answer and expected email unchanged). `{excluded}` when unknown. */
export function senderIdentityCase<C extends WriterCaseLike>(c: C): { case: C } | { excluded: string } {
  const calls = c.calls.map((call) => ({ ...call }));
  const llm = calls.filter((call) => call.name === "llm.complete");
  if (llm.length !== 1 || typeof llm[0]!.args?.systemPrompt !== "string") return { excluded: "no single llm.complete with a system prompt" };
  const systemPrompt = senderIdentitySystemPrompt(llm[0]!.args.systemPrompt);
  if (systemPrompt === null) return { excluded: "system prompt in neither the old nor the sender-identity form" };
  llm[0]!.args = { ...llm[0]!.args, systemPrompt };
  return { case: { ...c, calls } };
}

// ─── The cold email scripts that choose the signature (tactic `signedBy`) ───

const ASK_LINE = '    ctx.ask({ units: m.units, subject: m.subject, tactics: m.tactics, recordedBy: "content-generation", trace: true });\n';
const ASK_LINE_AFTER =
  '    ctx.ask({ units: m.units, subject: m.subject, tactics: m.tactics, recordedBy: "content-generation", trace: true, ...(statedSignature ? { request: { signature: statedSignature } } : {}) });\n';
const WRITE_HEAD = "  // 4. The email: materials, written by Engine message_written's script, stored by content-generation.\n";
const SIGN_HEAD = "  // 5. Who signs (tactic `signedBy`): the writer uses what it has; no name known = the brand alone, never a refusal.\n";
const SEND_HEAD = "  // 6. Sent.\n";
const SIGN_HEAD_AFTER =
  "  // 4. Who signs (tactic `signedBy`), decided BEFORE the email is written so the writer reads it word for word\n" +
  "  // (SENDER-NAME-BODY-1111): no name known = the brand alone, never a refusal.\n";
const STATED_SIGNATURE =
  '  const statedSignature = signature !== undefined && typeof (signature as any).text === "string" ? String((signature as any).text) : "";\n\n';
const WRITE_HEAD_AFTER = "  // 5. The email: materials, written by Engine message_written's script, stored by content-generation.\n";

/**
 * A `_signed_*` cold email script's next version: its signature block moves before the writer and is handed to it.
 * The send keeps the same `signature`; a script stating no `signedBy` asks exactly as before.
 */
export function coldEmailSignatureFirstSource(code: string): string {
  for (const part of [WRITE_HEAD, SIGN_HEAD, SEND_HEAD, ASK_LINE]) {
    if (countOf(code, part) !== 1) throw new Error(`cold email source: expected "${part.trim().slice(0, 60)}" exactly once, found ${countOf(code, part)}`);
  }
  const iWrite = code.indexOf(WRITE_HEAD);
  const iSign = code.indexOf(SIGN_HEAD);
  const iSend = code.indexOf(SEND_HEAD);
  if (!(iWrite < iSign && iSign < iSend)) throw new Error("cold email source: the write, sign and send steps are not in that order");
  const writeBlock = code.slice(iWrite + WRITE_HEAD.length, iSign);
  const signBlock = code.slice(iSign + SIGN_HEAD.length, iSend);
  return (
    code.slice(0, iWrite) +
    SIGN_HEAD_AFTER +
    signBlock.replace(/\n*$/, "\n") +
    STATED_SIGNATURE +
    WRITE_HEAD_AFTER +
    writeBlock.replace(ASK_LINE, ASK_LINE_AFTER) +
    code.slice(iSend)
  );
}
