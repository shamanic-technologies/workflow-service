import { describe, it, expect } from "vitest";
import { replayAll, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { oneEmailSchemaCase, oneEmailSchemaOf, oneEmailSchemaSource, WRITER_SCHEMAS } from "../../src/lib/scripts/one-email-schema.js";

// WRITER-EMPTY-BODY-1108: a fictional writer carrying dy_template_writer_full v2's two schema constants byte for byte
// (their formatting is what the source edits key on) and its provider switch.
const WRITER_V2 = `
import type { ScriptContext, ScriptResult } from "@gtm-factory/core";
export default function run(ctx: ScriptContext): ScriptResult {
  const template = ctx.get("template_written");
  const llm = (ctx.tactics.llm ?? {}) as { provider?: string; model?: string };
  const responseSchema = llm.provider === "anthropic" ? GENERATE_RESPONSE_SCHEMA_STRICT : GENERATE_RESPONSE_SCHEMA;
  const answer = ctx.vendor.call("llm.complete", { message: String(template.content.text), systemPrompt: "an array holding exactly ONE item", responseSchema, provider: llm.provider, model: llm.model });
  if (!answer.ok) throw new Error("llm.complete failed");
  const json = answer.data.json as { subject: string; emails: Array<{ body: string }> };
  return { content: { subject: json.subject, sequence: json.emails.slice(0, 1).map((e, i) => ({ step: i + 1, bodyText: e.body })) } };
}

const GENERATE_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    emails: {
      type: "array",
      items: {
        type: "object",
        properties: {
          body: { type: "string" },
          daysSinceLastStep: { type: "number" },
        },
        required: ["body", "daysSinceLastStep"],
      },
    },
  },
  required: ["subject", "emails"],
};

const GENERATE_RESPONSE_SCHEMA_STRICT = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: { type: "string" },
    emails: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          body: { type: "string" },
          daysSinceLastStep: { type: "number" },
        },
        required: ["body", "daysSinceLastStep"],
      },
    },
  },
  required: ["subject", "emails"],
};`;

const ANSWER = { subject: "dinner events for your clinic?", emails: [{ body: "Hi Huy, Doc Dinners runs dinner events.", daysSinceLastStep: 0 }] };

/** What production recorded under v2 for one provider: the request it sent (captured by a run) and the email it stored. */
async function recorded(provider: string, model: string): Promise<ReplayCase> {
  let request: Record<string, unknown> = {};
  const probe: ReplayCase = {
    id: `rec-${provider}`,
    units: { template_written: { text: "Write one cold email to Huy." } },
    tactics: { llm: { provider, model } },
    calls: [{ name: "llm.complete", answer: { ok: true, data: { json: ANSWER } } }],
    expect: { content: { subject: ANSWER.subject, sequence: [{ step: 1, bodyText: ANSWER.emails[0]!.body }] } },
  };
  const { runScript } = await import("../../src/lib/scripts/sandbox.js");
  await runScript(WRITER_V2, { subject: null, brand: "t", day: 0, tactics: probe.tactics!, request: null }, (op, args) => {
    if (op === "get") return { v: { id: "u", outcome: args[0], subject: "", ageDays: 0, content: (probe.units as Record<string, unknown>)[String(args[0])] } };
    if (op === "vendor") {
      request = args[1] as Record<string, unknown>;
      return { v: probe.calls[0]!.answer };
    }
    return { v: null };
  });
  return { ...probe, calls: [{ ...probe.calls[0]!, args: request }] };
}

describe("one email schema", () => {
  it("adds minItems/maxItems 1 to the loose schema and minItems 1 to the strict one, nothing else", () => {
    const v3 = oneEmailSchemaSource(WRITER_V2);
    const added = v3.split("\n").length - WRITER_V2.split("\n").length;
    expect(added).toBe(3);
    expect(v3.replace(/\n\s*(minItems|maxItems): 1,/g, "")).toBe(WRITER_V2);
    expect(() => oneEmailSchemaSource(v3)).toThrow(/exactly once, found 0/);
  });

  it("the recorded v2 schemas are the forms the restatement knows", async () => {
    const google = await recorded("google", "gemini-3.5-flash-lite");
    const anthropic = await recorded("anthropic", "claude-sonnet-5-5");
    expect(google.calls[0]!.args!.responseSchema).toEqual(WRITER_SCHEMAS.loose.before);
    expect(anthropic.calls[0]!.args!.responseSchema).toEqual(WRITER_SCHEMAS.strict.before);
    expect(oneEmailSchemaOf({ type: "object" })).toBeNull();
    expect(oneEmailSchemaOf(WRITER_SCHEMAS.loose.after)).toEqual(WRITER_SCHEMAS.loose.after);
  });

  it("v2 replays its record; v3 replays the restated record (same answer, same email); v3 refuses the unrestated one", async () => {
    const v3 = oneEmailSchemaSource(WRITER_V2);
    for (const [provider, model, schema] of [
      ["google", "gemini-3.5-flash-lite", WRITER_SCHEMAS.loose.after],
      ["zai", "glm-flash", WRITER_SCHEMAS.loose.after],
      ["anthropic", "claude-sonnet-5-5", WRITER_SCHEMAS.strict.after],
    ] as const) {
      const rec = await recorded(provider, model);
      expect((await replayAll(WRITER_V2, [rec])).matches).toBe(1);
      const out = oneEmailSchemaCase(rec);
      if (!("case" in out)) throw new Error(out.excluded);
      expect(out.case.calls[0]!.args!.responseSchema).toEqual(schema);
      // Nothing the model reads changes, nor what it answered, nor the email expected.
      expect(out.case.calls[0]!.args!.message).toBe(rec.calls[0]!.args!.message);
      expect(out.case.calls[0]!.args!.systemPrompt).toBe(rec.calls[0]!.args!.systemPrompt);
      expect(out.case.calls[0]!.answer).toEqual(rec.calls[0]!.answer);
      expect(out.case.expect).toEqual(rec.expect);
      expect((await replayAll(v3, [out.case])).matches).toBe(1);
      expect((await replayAll(v3, [rec])).matches).toBe(0);
    }
  });

  it("excludes a case it does not know, never guesses", () => {
    expect(oneEmailSchemaCase({ calls: [{ name: "voice.read" }] })).toEqual({ excluded: "no single llm.complete with a recorded request" });
    expect(oneEmailSchemaCase({ calls: [{ name: "llm.complete", args: { responseSchema: { type: "object" } } }] })).toEqual({
      excluded: "response schema in neither the v2 nor the one-email form",
    });
  });
});
