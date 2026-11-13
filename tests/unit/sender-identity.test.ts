import { describe, it, expect } from "vitest";
import { runScript } from "../../src/lib/scripts/sandbox.js";
import { replayAll, type ReplayCase } from "../../src/lib/scripts/replay.js";
import {
  PLACEHOLDERS_LINE,
  WHO_SENDS_LINE,
  coldEmailSignatureFirstSource,
  senderIdentityCase,
  senderIdentitySource,
  senderIdentitySystemPrompt,
} from "../../src/lib/scripts/sender-identity.js";

// SENDER-NAME-BODY-1111: the fleet writer is told who sends; the signing cold email scripts hand it the signature.
// A fictional writer carrying the same prompt lines and anchor as dy_template_writer_full v3.
const OLD_SIGN_OFF =
  "- NEVER include a sign-off, signature, or footer at the end of the email (e.g. '— [Your name]', 'Best, [Name]', 'Regards, …'). The sending service appends the sender's name, title, and organization automatically. Your output must end with the last sentence of the email body — nothing after it.";
const OLD_PLACEHOLDERS = "- NEVER use placeholders like [Your name], [Company], [Insert X], etc. Every piece of text you produce must be ready to send as-is.";

const WRITER_V3 = `
import type { ScriptContext, ScriptResult } from "@gtm-factory/core";
export default function run(ctx: ScriptContext): ScriptResult {
  const template = ctx.get("template_written");
  const voiceRead = ctx.vendor.call("voice.read", {});
  const voice = String(voiceRead.data.content ?? "");
  let systemPrompt = \`\${GLOBAL_SYSTEM_PROMPT}\\n\${buildClientCommsVoiceDirective(voice)}\`;
  systemPrompt = \`\${systemPrompt}\\n\${rules()}\`;
  const answer = ctx.vendor.call("llm.complete", { message: String(template.content.text), systemPrompt });
  if (!answer.ok) throw new Error("llm.complete failed");
  return { content: answer.data.json as Record<string, unknown> };
}
function buildClientCommsVoiceDirective(voice: string): string {
  return ["", "OUR VOICE:", voice].join("\\n");
}
function rules(): string {
  return [
    "- It never changes the JSON format above, and never the universal rules (no sign-off, no placeholder).",
    "WHO THE RECIPIENT ALREADY IS TO US. It never changes the JSON format above, and never the universal rules (no sign-off, no placeholder).",
  ].join("\\n");
}
const GLOBAL_SYSTEM_PROMPT = [
  "You are generating email content for an automated sending pipeline.",
  "Universal rules (always apply, regardless of the prompt):",
  ${JSON.stringify(OLD_SIGN_OFF)},
  ${JSON.stringify(OLD_PLACEHOLDERS)},
].join("\\n");
`;

const EMAIL = { subject: "Hi", body: "Beyond Logic builds custom software." };

async function sentRequest(source: string, request: Record<string, unknown> | null): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> = {};
  const out = await runScript(source, { subject: null, brand: "t", day: 0, tactics: {}, request }, (op, args) => {
    if (op === "get") return { v: { id: "u", outcome: args[0], subject: "", ageDays: 0, content: { text: "Write to Ana." } } };
    if (op === "vendor") {
      if (args[0] === "voice.read") return { v: { ok: true, data: { content: "Plain words." } } };
      sent = args[1] as Record<string, unknown>;
      return { v: { ok: true, data: { json: EMAIL } } };
    }
    return { v: null };
  });
  expect(out.kind).toBe("done");
  return sent;
}

describe("sender identity: the fleet writer", () => {
  it("tells the writer who sends, keeps the four sender placeholders, deletes the lines that hid it", async () => {
    const next = senderIdentitySource(WRITER_V3);
    const prompt = String((await sentRequest(next, null)).systemPrompt);
    expect(prompt).toContain(WHO_SENDS_LINE);
    expect(prompt).toContain(PLACEHOLDERS_LINE);
    for (const token of ["{first_name}", "{last_name}", "{full_name}", "{sender_email}"]) expect(prompt).toContain(token);
    expect(prompt).not.toContain("The sending service appends the sender's name, title, and organization");
    expect(prompt).not.toContain(OLD_PLACEHOLDERS);
    expect(prompt.split("(no sign-off, no placeholder but the four sender ones).").length - 1).toBe(2);
    expect(prompt).not.toContain("(no sign-off, no placeholder).");
    // A recorded case states no signature: nothing about it in the prompt.
    expect(prompt).not.toContain("THE SIGNATURE appended");
  });

  it("reads the signature the asking script states, word for word", async () => {
    const prompt = String((await sentRequest(senderIdentitySource(WRITER_V3), { signature: "{full_name}\nBeyond Logic" })).systemPrompt);
    expect(prompt).toContain("THE SIGNATURE appended after your text for this email (the sender placeholders in it are filled at send):\n<<<\n{full_name}\nBeyond Logic\n>>>");
  });

  it("refuses a source in neither form (never guessed)", () => {
    expect(() => senderIdentitySource(WRITER_V3.replace(OLD_SIGN_OFF, "x"))).toThrow(/expected/);
    expect(() => senderIdentitySource(senderIdentitySource(WRITER_V3))).toThrow(/expected/);
  });

  it("restates a recorded system prompt; the new form stays as is; any other form is null", () => {
    const old = `A\n${OLD_SIGN_OFF}\n${OLD_PLACEHOLDERS}\nB (no sign-off, no placeholder).\nC (no sign-off, no placeholder).`;
    const next = senderIdentitySystemPrompt(old);
    expect(next).toBe(`A\n${WHO_SENDS_LINE}\n${PLACEHOLDERS_LINE}\nB (no sign-off, no placeholder but the four sender ones).\nC (no sign-off, no placeholder but the four sender ones).`);
    expect(senderIdentitySystemPrompt(next!)).toBe(next);
    expect(senderIdentitySystemPrompt("something else")).toBeNull();
  });

  it("a recorded case of the active version replays 100 % on the next one once restated", async () => {
    const asRecorded: ReplayCase = {
      id: "rec-1",
      units: { template_written: { text: "Write to Ana." } },
      calls: [
        { name: "voice.read", answer: { ok: true, data: { content: "Plain words." } } },
        { name: "llm.complete", args: await sentRequest(WRITER_V3, null), answer: { ok: true, data: { json: EMAIL } } },
      ],
      expect: { content: EMAIL },
    };
    expect((await replayAll(WRITER_V3, [asRecorded])).matches).toBe(1);
    expect((await replayAll(senderIdentitySource(WRITER_V3), [asRecorded])).matches).toBe(0);
    const restated = senderIdentityCase(asRecorded);
    if (!("case" in restated)) throw new Error(restated.excluded);
    expect((await replayAll(senderIdentitySource(WRITER_V3), [restated.case])).matches).toBe(1);
    expect(senderIdentityCase({ ...asRecorded, calls: [] })).toEqual({ excluded: "no single llm.complete with a system prompt" });
  });
});

// A fictional cold email script carrying the same steps, in the same order, as dy_cold_email_signed_* v1.
const COLD_V1 = `
import type { ScriptContext, ScriptResult } from "@gtm-factory/core";
export default function run(ctx: ScriptContext): ScriptResult {
  const tactics = ctx.tactics as Record<string, any>;
  const brand = { data: { brand: { name: "Beyond Logic" } } };

  // 4. The email: materials, written by Engine message_written's script, stored by content-generation.
  const m = { units: {}, subject: null, tactics: {}, existing: null } as Record<string, any>;
  let written: unknown = m;
  if (m.existing == null) {
    ctx.ask({ units: m.units, subject: m.subject, tactics: m.tactics, recordedBy: "content-generation", trace: true });
    const got = ctx.get("message_written") as any;
    written = got.content;
  }

  // 5. Who signs (tactic \`signedBy\`): the writer uses what it has; no name known = the brand alone, never a refusal.
  const brandName = String((brand.data as any).brand?.name ?? "").trim();
  let signature: unknown = undefined;
  if (tactics.signedBy === "sender_with_client_brand") {
    signature = { text: "{full_name}" + (brandName ? "\\n" + brandName : "") };
  }

  // 6. Sent.
  const send = ctx.vendor.call("email.send", { body: { written, ...(signature !== undefined ? { signature } : {}) } });
  return { content: { sent: send.ok } };
}
`;

async function coldRun(source: string, tactics: Record<string, unknown>) {
  const asked: unknown[] = [];
  let sendBody: Record<string, unknown> = {};
  const out = await runScript(source, { subject: null, brand: "t", day: 0, tactics, request: null }, (op, args) => {
    if (op === "ask") {
      asked.push(args[0]);
      return { v: null };
    }
    if (op === "get") return { v: { id: "u", outcome: args[0], subject: "", ageDays: 0, content: { subject: "Hi" } } };
    if (op === "vendor") {
      sendBody = (args[1] as { body: Record<string, unknown> }).body;
      return { v: { ok: true, data: {} } };
    }
    return { v: null };
  });
  expect(out.kind).toBe("done");
  return { asked, sendBody };
}

describe("sender identity: the cold email scripts that choose the signature", () => {
  it("decide the signature before the writer and hand it over; the send keeps the same signature", async () => {
    const next = coldEmailSignatureFirstSource(COLD_V1);
    expect(next.indexOf("// 4. Who signs")).toBeLessThan(next.indexOf("// 5. The email"));
    const before = await coldRun(COLD_V1, { signedBy: "sender_with_client_brand" });
    const after = await coldRun(next, { signedBy: "sender_with_client_brand" });
    expect(after.asked).toEqual([{ ...(before.asked[0] as object), request: { signature: "{full_name}\nBeyond Logic" } }]);
    expect(after.sendBody).toEqual(before.sendBody);
  });

  it("a script stating no signedBy asks exactly as before (byte for byte)", async () => {
    const next = coldEmailSignatureFirstSource(COLD_V1);
    expect(await coldRun(next, {})).toEqual(await coldRun(COLD_V1, {}));
  });

  it("refuses a source whose steps it does not know", () => {
    expect(() => coldEmailSignatureFirstSource(COLD_V1.replace("// 6. Sent.", "// sent"))).toThrow(/exactly once/);
    expect(() => coldEmailSignatureFirstSource(coldEmailSignatureFirstSource(COLD_V1))).toThrow(/exactly once/);
  });
});

// SENDER-NAME-REGRESS-1113: a client saw "I'm Nag Pusuluri ... I run AscendQE" signed "Kevin Lourd" on 2026-11-13.
// The email was written 2026-11-09 by the writer BEFORE the fix and waited 4 days in the send queue; the template and
// LLM picks shipped 2026-11-12 do not touch who sends. This pins it: whatever template and LLM the Rating picks, and
// whatever signature the cold email script states, the writer's request carries who sends.
const WRITER_V3_PICKED = WRITER_V3.replace(
  'const answer = ctx.vendor.call("llm.complete", { message: String(template.content.text), systemPrompt });',
  "const llm = (ctx.tactics.llm ?? {}) as { provider?: string; model?: string };\n" +
    '  const answer = ctx.vendor.call("llm.complete", { message: String(template.content.text), systemPrompt, provider: llm.provider, model: llm.model });',
);

async function writerRequest(source: string, template: string, llm: { provider: string; model: string }, request: Record<string, unknown> | null) {
  let sent: Record<string, unknown> = {};
  const out = await runScript(source, { subject: null, brand: "t", day: 0, tactics: { llm }, request }, (op, args) => {
    if (op === "get") return { v: { id: "u", outcome: args[0], subject: "", ageDays: 0, content: { text: template } } };
    if (op === "vendor") {
      if (args[0] === "voice.read") return { v: { ok: true, data: { content: "Plain words." } } };
      sent = args[1] as Record<string, unknown>;
      return { v: { ok: true, data: { json: EMAIL } } };
    }
    return { v: null };
  });
  expect(out.kind).toBe("done");
  return sent;
}

describe("sender identity: every template, LLM and signature path (SENDER-NAME-REGRESS-1113)", () => {
  const templates = [
    "yc-cold-email-v3: Write to {{leadFirstName}}. The client is AscendQE, founded by Nag Pusuluri.",
    "blind-discovery-email-v14: Write without naming the client.",
    "acquisition-questions-email-v1: Ask their per-person price.",
  ];
  const llms = [
    { provider: "zai", model: "glm-flash" },
    { provider: "anthropic", model: "sonnet" },
    { provider: "openai", model: "gpt-pro" },
    { provider: "deepseek", model: "deepseek-flash" },
  ];
  const signings: Array<{ signedBy?: string; signature: string | null }> = [
    { signature: null },
    { signedBy: "sender_with_client_brand", signature: "{full_name}\nBeyond Logic" },
  ];

  it("the writer's system prompt always says who sends; the stated signature rides to it word for word", async () => {
    const writer = senderIdentitySource(WRITER_V3_PICKED);
    const cold = coldEmailSignatureFirstSource(COLD_V1);
    let paths = 0;
    for (const signing of signings) {
      const { asked } = await coldRun(cold, signing.signedBy ? { signedBy: signing.signedBy } : {});
      expect(asked).toHaveLength(1);
      const request = ((asked[0] as { request?: Record<string, unknown> }).request ?? null) as Record<string, unknown> | null;
      for (const template of templates) {
        for (const llm of llms) {
          const sent = await writerRequest(writer, template, llm, request);
          expect(sent).toMatchObject({ provider: llm.provider, model: llm.model, message: template });
          const prompt = String(sent.systemPrompt);
          expect(prompt).toContain(WHO_SENDS_LINE);
          expect(prompt).toContain(PLACEHOLDERS_LINE);
          expect(prompt).not.toContain("The sending service appends the sender's name, title, and organization");
          if (signing.signature) expect(prompt).toContain(`<<<\n${signing.signature}\n>>>`);
          else expect(prompt).not.toContain("THE SIGNATURE appended");
          paths++;
        }
      }
    }
    expect(paths).toBe(signings.length * templates.length * llms.length);
  });
});
