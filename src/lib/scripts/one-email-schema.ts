/**
 * WRITER-EMPTY-BODY-1108: the full writer's response schema holds `emails` to exactly ONE item.
 *
 * Since FOLLOWUP-JIT-1107 the system prompt of `message_written/dy_template_writer_full` asks for "an array holding
 * exactly ONE item", but the JSON schema the vendor enforces still allowed an EMPTY array. GLM-5.3 Flash used that
 * room: on 2026-11-08 two of sixteen replayed production requests came back `{"subject": "...", "emails": []}`, a
 * subject with no email (Doc Dinners, Huy Tran: « dinner events for your clinic? »). The schema now says what the
 * prompt says: `minItems: 1` everywhere, `maxItems: 1` on the vendors that take it (Anthropic's strict structured
 * output accepts `minItems` 0 or 1 and nothing else on arrays, so its schema carries `minItems` only). Probed live
 * 2026-11-08 through chat-service on GLM-5.3 Flash, DeepSeek V4.1 Flash, GPT-6 Sol, GPT-5.6 Terra (loose) and Claude
 * Sonnet 5.5 (strict): all 200 with one email. Gemini drops no array keyword (`sanitizeGeminiSchema` strips only
 * `additionalProperties`, `$ref` and the like).
 *
 * Nothing the model READS changes: the system prompt, the message and the parse stay byte for byte. Applied like
 * FOLLOWUP-JIT (`first-email-only.ts`): the same edits on the active version's source (an UPGRADE of the dynasty,
 * never a fork) and on each recorded case's `llm.complete` request, whose recorded answer and expected email are
 * unchanged. The writer stays trusted: a schema the vendor enforces, never a check, retry or refusal of its answer.
 */

const ARRAY_OPEN = '    emails: {\n      type: "array",\n      items: {\n';

/** [before, after] in the script source: the two schema constants, each named so neither edit can land on the other. */
export const ONE_EMAIL_SCHEMA_SOURCE_EDITS: ReadonlyArray<readonly [string, string]> = [
  [
    `const GENERATE_RESPONSE_SCHEMA = {\n  type: "object",\n  properties: {\n    subject: { type: "string" },\n${ARRAY_OPEN}`,
    `const GENERATE_RESPONSE_SCHEMA = {\n  type: "object",\n  properties: {\n    subject: { type: "string" },\n    emails: {\n      type: "array",\n      minItems: 1,\n      maxItems: 1,\n      items: {\n`,
  ],
  [
    `const GENERATE_RESPONSE_SCHEMA_STRICT = {\n  type: "object",\n  additionalProperties: false,\n  properties: {\n    subject: { type: "string" },\n${ARRAY_OPEN}`,
    `const GENERATE_RESPONSE_SCHEMA_STRICT = {\n  type: "object",\n  additionalProperties: false,\n  properties: {\n    subject: { type: "string" },\n    emails: {\n      type: "array",\n      minItems: 1,\n      items: {\n`,
  ],
];

const ITEM = {
  type: "object",
  properties: { body: { type: "string" }, daysSinceLastStep: { type: "number" } },
  required: ["body", "daysSinceLastStep"],
};
const ITEM_STRICT = { ...ITEM, additionalProperties: false };

/** The two schemas as the dynasty's v2 sends them (and production recorded them), and as they become. */
export const WRITER_SCHEMAS = {
  loose: {
    before: { type: "object", properties: { subject: { type: "string" }, emails: { type: "array", items: ITEM } }, required: ["subject", "emails"] },
    after: { type: "object", properties: { subject: { type: "string" }, emails: { type: "array", minItems: 1, maxItems: 1, items: ITEM } }, required: ["subject", "emails"] },
  },
  strict: {
    before: { type: "object", additionalProperties: false, properties: { subject: { type: "string" }, emails: { type: "array", items: ITEM_STRICT } }, required: ["subject", "emails"] },
    after: { type: "object", additionalProperties: false, properties: { subject: { type: "string" }, emails: { type: "array", minItems: 1, items: ITEM_STRICT } }, required: ["subject", "emails"] },
  },
} as const;

function countOf(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** The next version's source from the active one's. Throws when the source is not in the form these edits know. */
export function oneEmailSchemaSource(code: string): string {
  let out = code;
  for (const [before, after] of ONE_EMAIL_SCHEMA_SOURCE_EDITS) {
    const n = countOf(out, before);
    if (n !== 1) throw new Error(`script source: expected "${before.slice(0, 40)}..." exactly once, found ${n}`);
    out = out.replace(before, () => after);
  }
  return out;
}

/** Deep equality on JSON values, key order ignored. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => same(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** A recorded request's schema under the rule: null when it is in neither the v2 nor the new form (never guessed). */
export function oneEmailSchemaOf(schema: unknown): Record<string, unknown> | null {
  for (const form of [WRITER_SCHEMAS.loose, WRITER_SCHEMAS.strict]) {
    if (same(schema, form.before) || same(schema, form.after)) return structuredClone(form.after) as Record<string, unknown>;
  }
  return null;
}

interface WriterCaseLike {
  calls: Array<{ name: string; args?: Record<string, unknown> }>;
}

/**
 * A recorded full-writer case under the rule: its `llm.complete` request carries the one-email schema; the recorded
 * answer and the expected email are untouched. `{excluded}` when the case is not in a known form.
 */
export function oneEmailSchemaCase<C extends WriterCaseLike>(c: C): { case: C } | { excluded: string } {
  const calls = c.calls.map((call) => ({ ...call }));
  const llm = calls.filter((call) => call.name === "llm.complete");
  if (llm.length !== 1 || !llm[0]!.args) return { excluded: "no single llm.complete with a recorded request" };
  const responseSchema = oneEmailSchemaOf(llm[0]!.args.responseSchema);
  if (responseSchema === null) return { excluded: "response schema in neither the v2 nor the one-email form" };
  llm[0]!.args = { ...llm[0]!.args, responseSchema };
  return { case: { ...c, calls } };
}
