import { describe, it, expect } from "vitest";
import { runScript, validateSource } from "../../src/lib/scripts/sandbox.js";
import { answerLeadScriptSource, ANSWER_LOCAL_TIME_EDITS, ANSWER_SCHEMA } from "../../src/lib/scripts/answer-lead-script.js";

// LOCAL-TIME-ANSWERER-1115 (prod 2026-11-15): every follow-up of the day went out on a SUNDAY where the lead lives.
// The game tells the writer to read THEIR LOCAL TIME; the message now carries it, computed, never a send rule in code.
type Answers = Record<string, (args: Record<string, unknown>) => { ok: boolean; data: Record<string, unknown> }>;

const NOW = "2026-11-15T19:34:00.000Z";
const WRITE = { decision: "write", channel: "email", replyTo: "", to: [] as string[], cc: [] as string[], bcc: [] as string[], message: "<p>Hi Jay.</p>", subject: "", bookSlot: "", bookedMessage: "", nextFollowUpAt: "2026-11-20T16:00:00Z", nextFollowUpWhy: "next week", question: "", reason: "they asked" };

function world(lead: Record<string, unknown>, draft: Record<string, unknown> = WRITE) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const answers: Answers = {
    "lead.followup.claim": () => ({ ok: true, data: { found: true, followup: { id: "row-1", email: "jay@co.test", phone: null, leadId: "lead-1", dueAt: NOW } } }),
    "lead.followup_date.read": () => ({ ok: true, data: { owed: { kind: "owed", reasons: [] } } }),
    "lead.detail": () => ({ ok: true, data: { leadDetail: { lead: { firstName: "Jay", lastName: "Worley", leadId: "lead-1", ...lead } } } }),
    "crm.person.thread": () => ({ ok: true, data: { items: [{ at: "2026-11-14T15:00:00Z", kind: "message", direction: "inbound", channel: "email", text: "Tell me more", messageId: "<m1@co.test>", from: "jay@co.test", to: "kevin@mailbox.test" }] } }),
    "instantly.conversation": () => ({ ok: true, data: { conversation: { threads: [{ replied: true, campaignId: "his-thread", lastInboundAt: "2026-11-14T15:00:00Z" }] } } }),
    "brand.profile": () => ({ ok: true, data: { brand: { name: "Acme" } } }),
    "brand.fields": () => ({ ok: true, data: { fields: {} } }),
    "voice.read": () => ({ ok: true, data: { content: "OUR VOICE" } }),
    "llm.pick": () => ({ ok: true, data: { provider: "anthropic", model: "opus" } }),
    "llm.complete": () => ({ ok: true, data: { json: draft } }),
    "instantly.reply.send": () => ({ ok: true, data: { status: "sent" } }),
    "email.send": () => ({ ok: true, data: { status: "sent" } }),
    "lead.followup_date.set": () => ({ ok: true, data: {} }),
    "lead.followup.record": () => ({ ok: true, data: {} }),
  };
  const bridge = async (op: string, args: unknown[]) => {
    if (op !== "vendor") return { stop: `unexpected ${op}` };
    const name = String(args[0]);
    const a = (args[1] ?? {}) as Record<string, unknown>;
    calls.push({ name, args: a });
    const f = answers[name];
    return f ? { v: f(a) } : { stop: `no answer recorded for ${name}` };
  };
  return { calls, bridge };
}

const REQUEST = { now: NOW, brandIds: ["brand-1"], campaignId: "camp-1", offerId: null, brief: null, trigger: { leadId: "lead-1", eventId: "ev-1", person: { email: "jay@co.test" }, item: {} } };
const spec = { subject: "lead-1", brand: "brand-1", day: 0, tactics: {}, request: REQUEST };

async function writerMessage(lead: Record<string, unknown>): Promise<string> {
  const { calls, bridge } = world(lead);
  await runScript(answerLeadScriptSource(), spec, bridge);
  return String(calls.find((c) => c.name === "llm.complete")!.args.message);
}

describe("the answerer reads their local time (LOCAL-TIME-ANSWERER-1115)", () => {
  it("a lead in America/Denver at 2026-11-15T19:34Z: Sunday, 12:34 where they are", async () => {
    const message = await writerMessage({ timezone: "America/Denver", city: "Denver", country: "United States" });
    expect(message).toContain("THEIR LOCAL TIME:\nNow, where they are: Sunday, November 15, 2026, 12:34 PM America/Denver (UTC-07:00). In UTC: Sunday, November 15, 2026, 19:34 UTC.");
    expect(message).not.toContain("THEIR TIMEZONE:");
    expect(message).not.toContain("NOW: ");
  });

  it("a lead with no time zone: said in words, beside the clues we hold", async () => {
    const message = await writerMessage({ city: "Lyon", country: "France" });
    expect(message).toContain("THEIR LOCAL TIME:\nNow, in UTC: Sunday, November 15, 2026, 19:34 UTC.\nTheir timezone is unknown: nothing we hold states it.");
    expect(message).toContain("their city: Lyon, France");
  });

  it("the cc description says what the sender does by default", () => {
    expect(ANSWER_SCHEMA.properties.cc.description).toContain("nobody when the person never wrote to us, our team and the brand's sales rep once they did");
    expect(ANSWER_SCHEMA.properties.cc.description).not.toContain("our usual copy (our team)");
  });

  it("the address it goes to is never also copied (default To included)", async () => {
    const own = world({ timezone: "America/Denver" }, { ...WRITE, replyTo: "M1", cc: ["Jay@Co.test", "boss@co.test"], bcc: ["jay@co.test"] });
    await runScript(answerLeadScriptSource(), spec, own.bridge);
    const send = own.calls.find((c) => c.name === "instantly.reply.send")!.args.body as Record<string, unknown>;
    expect(send.email).toBe("jay@co.test");
    expect(send.cc).toEqual(["boss@co.test"]);
    expect(send.bcc).toBeUndefined();

    const named = world({ timezone: "America/Denver" }, { ...WRITE, replyTo: "M1", to: ["ann@co.test"], cc: ["ann@co.test", "jay@co.test"], bcc: ["Ann@co.test"] });
    await runScript(answerLeadScriptSource(), spec, named.bridge);
    const body = named.calls.find((c) => c.name === "instantly.reply.send")!.args.body as Record<string, unknown>;
    expect(body.to).toEqual(["ann@co.test"]);
    expect(body.cc).toEqual(["jay@co.test"]);
    expect(body.bcc).toBeUndefined();
  });

  it("the stored-code edits: each anchor is in the old code exactly once and the edited code is the generator's", async () => {
    const generated = answerLeadScriptSource();
    // The code stored before this fix = the generator with every edit undone.
    let old = generated;
    for (const e of [...ANSWER_LOCAL_TIME_EDITS].reverse()) {
      expect(old.split(e.to).length - 1).toBe(1);
      old = old.replace(e.to, () => e.from);
    }
    let edited = old;
    for (const e of ANSWER_LOCAL_TIME_EDITS) {
      expect(edited.split(e.from).length - 1).toBe(1);
      edited = edited.replace(e.from, () => e.to);
    }
    expect(edited).toBe(generated);
    await expect(validateSource(edited)).resolves.toBeTruthy();
  });
});
