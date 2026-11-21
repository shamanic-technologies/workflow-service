import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { ANSWER_REQUESTED, answerTactics } from "../../src/lib/scripts/answer-lead-split.js";
import { buildCompletionSource } from "../../scripts/engine-ports/llm-completion.js";
import { addSalesRepToSender, addSalesRepToWriter } from "../../src/lib/scripts/answer-cc-signer.js";

// ANSWER-CC-SIGNER-1121: the lead answerer halves as production stores them (sender v15, writer v4): the sender hands
// the brand's stated sales rep, the writer states it as one fact; none stated = the same prompt and doors as stored.
const SENDER0 = readFileSync(join(__dirname, "../fixtures/stored-scripts/message_sent__dy_answer_lead.v15.ts.txt"), "utf8");
const WRITER0 = readFileSync(join(__dirname, "../fixtures/stored-scripts/message_written__dy_answer_lead.v4.ts.txt"), "utf8");
const SENDER1 = addSalesRepToSender(SENDER0);
const WRITER1 = addSalesRepToWriter(WRITER0);
const COMPLETION = buildCompletionSource();
const NOW = "2026-11-17T15:00:00.000Z";
const WRITE = { decision: "write", channel: "email", replyTo: "M1", to: [] as string[], cc: ["Boss@co.test", "jay@co.test"], bcc: [] as string[], message: "<p>Hi Jay — Tuesday 10am works.</p>", subject: "", bookSlot: "", bookedMessage: "", nextFollowUpAt: "2026-11-20T16:00:00Z", nextFollowUpWhy: "next week", question: "", reason: "they asked" };

type Answer = { ok: boolean; data: Record<string, unknown> };
function doors(draft: Record<string, unknown>, extra: Record<string, (a: Record<string, unknown>) => Answer> = {}): Record<string, (a: Record<string, unknown>) => Answer> {
  return {
    "lead.followup.claim": () => ({ ok: true, data: { found: true, followup: { id: "row-1", email: "jay@co.test", phone: "+15551234567", leadId: "lead-1", dueAt: NOW } } }),
    "lead.followup_date.read": () => ({ ok: true, data: { owed: { kind: "owed", reasons: [] } } }),
    "lead.detail": () => ({ ok: true, data: { leadDetail: { lead: { firstName: "Jay", lastName: "Worley", leadId: "lead-1", timezone: "America/Denver" } } } }),
    "crm.person.thread": () => ({ ok: true, data: { items: [{ at: "2026-11-16T15:00:00Z", kind: "message", direction: "inbound", channel: "email", text: "Can we meet Tuesday?", messageId: "<m1@co.test>", from: "jay@co.test", to: "kevin@mailbox.test", cc: "boss@co.test" }] } }),
    "instantly.conversation": () => ({ ok: true, data: { conversation: { threads: [{ replied: true, campaignId: "his-thread", lastInboundAt: "2026-11-16T15:00:00Z" }] } } }),
    "crm.whatsapp.reach": () => ({ ok: true, data: { reachable: true, persona: { name: "Sophie", role: "AI assistant" } } }),
    "brand.profile": () => ({ ok: true, data: { brand: { name: "Acme", salesRepPhone: "+15550000000" } } }),
    "brand.offer.economics": () => ({ ok: true, data: { name: "Meetings", bookingUrl: "https://book.test/acme" } }),
    "brand.offer.answers": () => ({ ok: true, data: { answers: [{ question: "Price?", answer: "$100 per meeting" }, { question: "Refunds?", answer: "PLACEHOLDER" }] } }),
    "brand.offer.fields": () => ({ ok: true, data: { fields: { guarantee: { provenance: "confirmed", value: "a meeting or your money back" } } } }),
    "voice.read": () => ({ ok: true, data: { content: "OUR VOICE" } }),
    "booking.slots": () => ({ ok: true, data: { slots: ["2026-11-24T17:00:00Z", "2026-11-24T19:00:00Z"], timezone: "America/Denver", calendarId: "cal-1" } }),
    "llm.pick": () => ({ ok: true, data: { provider: "zai", model: "glm-flash" } }),
    "llm.complete": () => ({ ok: true, data: { json: draft, brandToolCalls: 2 } }),
    "crm.meeting.book": () => ({ ok: true, data: { status: "booked" } }),
    "instantly.reply.send": () => ({ ok: true, data: { status: "sent" } }),
    "crm.whatsapp.send": () => ({ ok: true, data: { status: "sent" } }),
    "email.send": () => ({ ok: true, data: { status: "sent" } }),
    "lead.followup_date.set": () => ({ ok: true, data: {} }),
    "lead.followup.record": () => ({ ok: true, data: {} }),
    ...extra,
  };
}

const REQUEST = { now: NOW, brandIds: ["brand-1"], campaignId: "camp-1", offerId: "offer-1", brief: "Book meetings.", goal: null, trigger: { leadId: "lead-1", eventId: "ev-1", person: { email: "jay@co.test" }, item: { kind: "reply" } } };
const spec = (tactics: Record<string, unknown>) => ({ subject: "lead-1", brand: "brand-1", day: 0, tactics, request: REQUEST });

type Call = { script: string; name: string; args: Record<string, unknown> };

/** The stored answerer, alone. */
async function _unusedStored(d: Record<string, unknown>, extra = {}) {
  const calls: Call[] = [];
  const answers = doors(d, extra);
  const bridge: Bridge = async (op, args) => {
    if (op === "storage.claim") return { v: null };
    if (op === "storage.set") return { v: null };
    if (op !== "vendor") return { stop: `unexpected ${op}` };
    const name = String(args[0]);
    calls.push({ script: "stored", name, args: (args[1] ?? {}) as Record<string, unknown> });
    return { v: answers[name]!(args[1] as Record<string, unknown>) };
  };
  const out = await runScript(STORED, spec({ llm: { provider: "zai", model: "glm-flash" }, relationships: "pure_prospect" }), bridge);
  return { out, calls };
}

/** The split pair, the sender asking the writer asking the completion, as the runner's ctx.ask does. */
async function runPair(SENDER: string, WRITER: string, d: Record<string, unknown>, extra = {}) {
  const calls: Call[] = [];
  const answers = doors(d, extra);
  const vendor = (script: string) => (name: string, a: Record<string, unknown>): { v: Answer } => {
    calls.push({ script, name, args: a });
    return { v: answers[name]!(a) };
  };
  let handedToWriter: Record<string, unknown> | null = null;
  const completion = async (request: Record<string, unknown>) =>
    runScript(COMPLETION, { subject: null, brand: "brand-1", day: 0, tactics: { llm: { provider: "zai", model: "glm-flash", name: "GLM Flash" } }, request }, async (op, args) => (op === "vendor" ? vendor("completion")(String(args[0]), args[1] as Record<string, unknown>) : { stop: op }));
  const writer = async (units: Record<string, { content: Record<string, unknown> }>) => {
    handedToWriter = units;
    let asked: Record<string, unknown> | null = null;
    return runScript(WRITER, { subject: "lead-1", brand: "brand-1", day: 0, tactics: answerTactics({}).writer, request: null }, async (op, args) => {
      if (op === "vendor") return vendor("writer")(String(args[0]), args[1] as Record<string, unknown>);
      if (op === "ask") {
        asked = args[0] as Record<string, unknown>;
        return { v: null };
      }
      if (op === "get" && args[0] === ANSWER_REQUESTED) return { v: { id: "u", outcome: ANSWER_REQUESTED, subject: "", ageDays: 0, content: units[ANSWER_REQUESTED]!.content } };
      if (op === "get" && args[0] === "llm_completion") {
        const done = await completion((asked!.request ?? {}) as Record<string, unknown>);
        if (done.kind !== "done") return { stop: JSON.stringify(done) };
        return { v: { id: "c", outcome: "llm_completion", subject: "lead-1", ageDays: 0, content: done.result!.content } };
      }
      return { stop: `unexpected ${op}` };
    });
  };
  let askedSender: Record<string, unknown> | null = null;
  const out = await runScript(SENDER, spec(answerTactics({ llm: { provider: "zai", model: "glm-flash" }, asks: ["booking_call"], relationships: "pure_prospect", recorded_by: "sender" }).sender), async (op, args) => {
    if (op === "storage.claim" || op === "storage.set") return { v: null };
    if (op === "vendor") return vendor("sender")(String(args[0]), args[1] as Record<string, unknown>);
    if (op === "ask") {
      askedSender = args[0] as Record<string, unknown>;
      return { v: null };
    }
    if (op === "get" && args[0] === "message_written") {
      const w = await writer(askedSender!.units as Record<string, { content: Record<string, unknown> }>);
      if (w.kind !== "done") return { stop: JSON.stringify(w) };
      const r = w.result!;
      return { v: r.content ? { id: "w", outcome: "message_written", subject: "lead-1", ageDays: 0, content: r.content } : { id: "w", outcome: "message_written", subject: "", ageDays: 0, content: null, unmade: r.unmade, decided: r.decided, answer: r.answer } };
    }
    return { stop: `unexpected ${op} ${String(args[0])}` };
  });
  return { out, calls, handedToWriter: handedToWriter as Record<string, unknown> | null };
}


const llmMessage = (calls: Call[]) => String(calls.find((x) => x.name === "llm.complete")!.args.message ?? "");
const REP = { salesRepEmail: "Kevin@Distribute.you", salesRepFirstName: "Kevin", salesRepRole: "Founder", salesRepPhone: null };
const noRep = { "brand.sales_rep": () => ({ ok: false, data: { status: 404, error: "no sales rep" } }) };
const rep = { "brand.sales_rep": () => ({ ok: true, data: REP }) };

describe("ANSWER-CC-SIGNER-1121", () => {
  it("both edited halves are valid scripts; the sender reads brand.sales_rep", async () => {
    expect((await validateSource(SENDER1)).vendors).toContain("brand.sales_rep");
    expect((await validateSource(WRITER1)).vendors).toEqual((await validateSource(WRITER0)).vendors);
    expect(() => addSalesRepToSender(SENDER1)).toThrow(/already/);
    expect(() => addSalesRepToWriter(WRITER1)).toThrow(/already/);
  });

  it("a rep stated: the writer reads who the brand's sales rep is, address included", async () => {
    const r = await runPair(SENDER1, WRITER1, WRITE, rep);
    expect(r.out.kind).toBe("done");
    expect((r.handedToWriter as any)[ANSWER_REQUESTED].content.salesRep).toEqual({ firstName: "Kevin", role: "Founder", email: "kevin@distribute.you" });
    expect(llmMessage(r.calls)).toContain("THE BRAND'S SALES REP (a person of the brand, never the person you answer): Kevin, Founder, kevin@distribute.you");
  });

  it("no rep stated: the very same prompt and the same doors as the stored halves", async () => {
    const before = await runPair(SENDER0, WRITER0, WRITE, noRep);
    const after = await runPair(SENDER1, WRITER1, WRITE, noRep);
    expect(llmMessage(after.calls)).toBe(llmMessage(before.calls));
    const strip = (c: Call[]) => c.filter((x) => x.name !== "brand.sales_rep").map((x) => ({ name: x.name, args: x.args }));
    expect(strip(after.calls)).toEqual(strip(before.calls));
  });
});
