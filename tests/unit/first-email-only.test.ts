import { describe, it, expect } from "vitest";
import { replayAll, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { firstEmailOnlyCase, firstEmailOnlySource, firstEmailOnlySystemPrompt } from "../../src/lib/scripts/first-email-only.js";

// FOLLOWUP-JIT-1107-WRITER: the full writer's system prompt asks for ONE email and only the first step is read.
// A fictional writer carrying the same prompt lines, language line and parse step as dy_template_writer_full v1.
const WRITER_V1 = `
import type { ScriptContext, ScriptResult } from "@gtm-factory/core";
const GLOBAL_SYSTEM_PROMPT = [
  "You are generating email content.",
  "You must respond with a JSON object matching this exact schema:",
  '{"subject": "<email subject line>", "emails": [{"body": "<plain text email body>", "daysSinceLastStep": <number>}]}',
  "- subject: the email subject line (string)",
  "- emails: array of email steps. Each has:",
  "  - body: plain text email body (string)",
  "  - daysSinceLastStep: days to wait since the previous email, 0 for the first (number)",
  "Return ONLY the JSON object, no additional text or markdown.",
].join("\\n");
function buildLanguageDirective(language: string): string {
  return ["", "Language:", \`- Write the ENTIRE email in \${language} — subject line and every step of the sequence. The recipient does not read English.\`].join("\\n");
}
function parse(json: { subject: string; emails: Array<{ body: string; daysSinceLastStep: number }> }) {
  const emails = withSequenceDelays(json.emails);
  return { subject: json.subject, sequence: emails.map((e, i) => ({ step: i + 1, bodyText: e.body, daysSinceLastStep: e.daysSinceLastStep })) };
}
function withSequenceDelays<T>(s: T[]): T[] { return s; }
export default function run(ctx: ScriptContext): ScriptResult {
  const lead = ctx.get("lead_identified");
  const template = ctx.get("template_written");
  let systemPrompt = GLOBAL_SYSTEM_PROMPT;
  if (lead.content.language) systemPrompt = systemPrompt + "\\n" + buildLanguageDirective(String(lead.content.language));
  const answer = ctx.vendor.call("llm.complete", { message: String(template.content.text), systemPrompt });
  if (!answer.ok) throw new Error("llm.complete failed");
  return { content: parse(answer.data.json as { subject: string; emails: Array<{ body: string; daysSinceLastStep: number }> }) };
}`;

const THREE = { subject: "Hi", emails: [{ body: "First", daysSinceLastStep: 0 }, { body: "Second", daysSinceLastStep: 3 }, { body: "Third", daysSinceLastStep: 7 }] };

async function recorded(language?: string): Promise<ReplayCase> {
  // What production recorded under v1: the request it sent (captured by a first replay) and the three steps it stored.
  let request: Record<string, unknown> = {};
  const probe: ReplayCase = {
    id: `rec-${language ?? "en"}`,
    units: { lead_identified: { ...(language ? { language } : {}) }, template_written: { text: "Write a 3-step sequence to Ana." } },
    calls: [{ name: "llm.complete", answer: { ok: true, data: { json: THREE } } }],
    expect: { content: { subject: "Hi", sequence: THREE.emails.map((e, i) => ({ step: i + 1, bodyText: e.body, daysSinceLastStep: e.daysSinceLastStep })) } },
  };
  const { runScript } = await import("../../src/lib/scripts/sandbox.js");
  await runScript(WRITER_V1, { subject: null, brand: "t", day: 0, tactics: {}, request: null }, (op, args) => {
    if (op === "get") return { v: { id: "u", outcome: args[0], subject: "", ageDays: 0, content: (probe.units as Record<string, unknown>)[String(args[0])] } };
    if (op === "vendor") {
      request = args[1] as Record<string, unknown>;
      return { v: probe.calls[0]!.answer };
    }
    return { v: null };
  });
  return { ...probe, calls: [{ ...probe.calls[0]!, args: request }] };
}

describe("first email only", () => {
  it("v1 replays its record (three steps); the upgraded source replays the restated record (one step, the new prompt)", async () => {
    const v2 = firstEmailOnlySource(WRITER_V1);
    for (const lang of [undefined, "French"]) {
      const rec = await recorded(lang);
      expect((await replayAll(WRITER_V1, [rec])).matches).toBe(1);
      const out = firstEmailOnlyCase(rec);
      if (!("case" in out)) throw new Error(out.excluded);
      const restated = out.case;
      expect((restated.expect.content!.sequence as unknown[]).length).toBe(1);
      const sp = String(restated.calls[0]!.args!.systemPrompt);
      expect(sp).toContain("an array holding exactly ONE item, the first email. Write only that first email");
      expect(sp).toContain('"daysSinceLastStep": 0}]}');
      expect(sp).not.toContain("array of email steps");
      if (lang) expect(sp).toContain("in French — subject line and body.");
      // Same message (the first-email instructions) byte for byte.
      expect(restated.calls[0]!.args!.message).toBe(rec.calls[0]!.args!.message);
      expect((await replayAll(v2, [restated])).matches).toBe(1);
      expect((await replayAll(WRITER_V1, [restated])).matches).toBe(0);
    }
  });

  it("a case already in the one-email form is kept; a source or prompt in an unknown form is refused, never guessed", async () => {
    const rec = await recorded();
    const once = firstEmailOnlyCase(rec);
    if (!("case" in once)) throw new Error("excluded");
    const twice = firstEmailOnlyCase(once.case);
    expect(twice).toEqual({ case: once.case });
    expect(firstEmailOnlySystemPrompt("You write emails.")).toBeNull();
    expect(() => firstEmailOnlySource("export default function run() { return null; }")).toThrow(/exactly once/);
    expect(firstEmailOnlyCase({ ...rec, calls: [] })).toEqual({ excluded: "no single llm.complete with a system prompt" });
  });
});
