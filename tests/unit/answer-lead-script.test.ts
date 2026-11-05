import { describe, it, expect } from "vitest";
import { runScript, validateSource } from "../../src/lib/scripts/sandbox.js";
import { answerLeadScriptSource, ANSWER_SCHEMA, ANSWER_LEAD_OUTCOME, ANSWER_LEAD_PULL } from "../../src/lib/scripts/answer-lead-script.js";

// MIGRATE-1105 S1: ONE script answers a lead. The Doc Dinners case of 2026-11-04 (two confirmations from two people),
// rebuilt with made-up data: the person picks a time we offered; the script books it and sends ONE confirmation, in
// the thread they answered (instantly picks the mailbox they wrote to).
const NOW = "2026-11-04T13:54:38.000Z";
const SLOT = "2026-11-06T15:30:00-06:00";

type Answers = Record<string, (args: Record<string, unknown>) => { ok: boolean; data: Record<string, unknown> }>;

function world(draft: Record<string, unknown>, over: Answers = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const answers: Answers = {
    "lead.followup.claim": () => ({ ok: true, data: { found: true, followup: { id: "row-1", email: "dr@clinic.test", phone: null, leadId: "lead-1", dueAt: NOW } } }),
    "lead.followup_date.read": () => ({ ok: true, data: { owed: { kind: "stop", reasons: ["positive_reply"] }, followupDate: {}, queued: {} } }),
    "lead.detail": () => ({ ok: true, data: { leadDetail: { lead: { firstName: "Josh", lastName: "Doe", timezone: "America/Chicago", leadId: "lead-1" } } } }),
    "crm.person.thread": () => ({ ok: true, data: { items: [
      { at: "2026-11-04T13:50:58Z", kind: "message", direction: "outbound", channel: "email", text: "Would Thursday 12:00 PM or Friday 3:30 PM (Central) work?" },
      { at: "2026-11-04T13:54:00Z", kind: "message", direction: "inbound", channel: "email", text: "This Friday at 3:30 Central" },
    ] } }),
    "instantly.conversation": () => ({ ok: true, data: { conversation: { threads: [
      { replied: false, campaignId: "old-thread", lastInboundAt: null },
      { replied: true, campaignId: "his-thread", lastInboundAt: "2026-11-04T13:54:00Z" },
    ] } } }),
    "brand.profile": () => ({ ok: true, data: { brand: { name: "Doc Dinners", salesRepPhone: "+15550001111" } } }),
    "brand.offer.economics": () => ({ ok: true, data: { name: "Doc Dinners", bookingUrl: "https://book.test/x" } }),
    "brand.offer.answers": () => ({ ok: true, data: { answers: [{ question: "How much is it?", answer: "PLACEHOLDER not real" }] } }),
    "brand.offer.fields": () => ({ ok: true, data: { fields: { urgency: { value: "One clinic per area", provenance: "confirmed" }, neverGive: { value: null, provenance: "suggested" } } } }),
    "voice.read": () => ({ ok: true, data: { content: "OUR VOICE", version: 1 } }),
    "booking.slots": () => ({ ok: true, data: { timezone: "America/Chicago", slots: ["2026-11-05T12:00:00-06:00", SLOT], calendarId: "cal-1" } }),
    "features.writer_pick": () => ({ ok: true, data: { llm: { provider: "anthropic", model: "opus" } } }),
    "llm.complete": () => ({ ok: true, data: { json: draft } }),
    "crm.meeting.book": () => ({ ok: true, data: { status: "booked" } }),
    "instantly.reply.send": () => ({ ok: true, data: { status: "sent" } }),
    "crm.whatsapp.send": () => ({ ok: true, data: { status: "sent" } }),
    "lead.followup_date.set": () => ({ ok: true, data: {} }),
    "lead.followup.record": () => ({ ok: true, data: {} }),
    ...over,
  };
  const bridge = async (op: string, args: unknown[]) => {
    if (op !== "vendor") return { stop: `unexpected ${op}` };
    const name = String(args[0]);
    const a = (args[1] ?? {}) as Record<string, unknown>;
    calls.push({ name, args: a });
    const f = answers[name];
    if (!f) return { stop: `no answer recorded for ${name}` };
    return { v: f(a) };
  };
  return { calls, bridge };
}

const spec = (request: Record<string, unknown>) => ({ subject: "lead-1", brand: "brand-1", day: 0, tactics: {}, request });
const REQUEST = { now: NOW, brandIds: ["brand-1"], campaignId: "camp-lead-event", offerId: "offer-1", brief: null, trigger: { leadId: "lead-1", eventId: "ev-1", person: { email: "Dr@Clinic.test" }, item: { kind: "replied" } } };
const BOOK = { decision: "write", message: "<p>Friday works.</p>", subject: "", bookSlot: SLOT, bookedMessage: "<p>You are booked for Friday, November 6 at 3:30 PM Central.</p>", nextFollowUpAt: "2026-11-05T15:00:00Z", nextFollowUpWhy: "Reminder the day before", question: "", reason: "They picked a time" };

describe("the answering script", () => {
  it("is a valid script: transpiles, evaluates, a strict schema", async () => {
    await expect(validateSource(answerLeadScriptSource())).resolves.toMatchObject({ materials: [] });
    expect(ANSWER_SCHEMA.required).toEqual(Object.keys(ANSWER_SCHEMA.properties));
  });

  it("books the time they picked and sends ONE confirmation, in the thread they answered", async () => {
    const { calls, bridge } = world(BOOK);
    const out = await runScript(answerLeadScriptSource(), spec(REQUEST), bridge);
    expect(out).toEqual({ kind: "done", result: { content: { decision: "write", channel: "email", booked: SLOT, inThread: true } } });
    const sends = calls.filter((c) => ["instantly.reply.send", "email.send", "crm.whatsapp.send"].includes(c.name));
    expect(sends).toEqual([{ name: "instantly.reply.send", args: { body: { campaign_id: "his-thread", email: "dr@clinic.test", body_html: "<p>You are booked for Friday, November 6 at 3:30 PM Central.</p>", sent_by: "automation" } } }]);
    expect(calls.find((c) => c.name === "crm.meeting.book")!.args).toMatchObject({ body: { startTime: SLOT, calendarId: "cal-1", idempotencyKey: "answer-lead:event:ev-1:book", person: { email: "dr@clinic.test", firstName: "Josh" } } });
    expect(calls.find((c) => c.name === "lead.followup.claim")!.args).toEqual({ params: { campaignId: "camp-lead-event" }, body: { person: { email: "dr@clinic.test", phone: null, leadId: "lead-1" }, relationships: "pure_prospect" } });
    expect(calls.find((c) => c.name === "lead.followup_date.set")!.args).toMatchObject({ body: { nextFollowupAt: "2026-11-05T15:00:00Z", sent: { channel: "email" } } });
    expect(calls.find((c) => c.name === "lead.followup.record")!.args).toEqual({ params: { id: "row-1" }, body: { kind: "stopped", reason: "booking_confirmed" } });
    const llm = calls.find((c) => c.name === "llm.complete")!.args;
    expect(llm).toMatchObject({ provider: "anthropic", model: "opus" });
    expect(calls.find((c) => c.name === "features.writer_pick")!.args).toEqual({ query: { campaignId: "camp-lead-event" } });
    expect(String(llm.systemPrompt)).toMatch(/^OUR VOICE/);
    expect(String(llm.message)).toContain("(not answered by our client yet)");
    expect(String(llm.message)).not.toContain("PLACEHOLDER");
  });

  it("a taken slot (named refusal) sends the usual answer, never a false confirmation", async () => {
    const { calls, bridge } = world(BOOK, { "crm.meeting.book": () => ({ ok: false, data: { status: 422, code: "slot_not_open", error: "taken" } }) });
    const out = await runScript(answerLeadScriptSource(), spec(REQUEST), bridge);
    expect(out).toMatchObject({ kind: "done", result: { content: { booked: null } } });
    expect(calls.find((c) => c.name === "instantly.reply.send")!.args).toMatchObject({ body: { body_html: "<p>Friday works.</p>" } });
  });

  it("later sends nothing and leaves the one next date; escalate alerts the rep, nothing to them", async () => {
    const later = world({ ...BOOK, decision: "later", message: "", bookSlot: "", bookedMessage: "" });
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), later.bridge)).toMatchObject({ kind: "done", result: { unmade: expect.stringMatching(/^later/) } });
    expect(later.calls.some((c) => ["instantly.reply.send", "email.send", "crm.whatsapp.send", "crm.meeting.book"].includes(c.name))).toBe(false);
    const esc = world({ ...BOOK, decision: "escalate", message: "", bookSlot: "", bookedMessage: "", question: "What is the price?" });
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), esc.bridge)).toMatchObject({ kind: "done", result: { content: { decision: "escalate", repAlerted: true } } });
    const alert = esc.calls.filter((c) => c.name === "crm.whatsapp.send");
    expect(alert).toHaveLength(1);
    expect(alert[0]!.args).toMatchObject({ body: { phone: "+15550001111" }, omitHeaders: ["x-campaign-id"] });
    expect(esc.calls.some((c) => c.name === "instantly.reply.send")).toBe(false);
  });

  it("no writer picked for the campaign = nothing written, the run fails loud (never a default model)", async () => {
    const { calls, bridge } = world(BOOK, { "features.writer_pick": () => ({ ok: true, data: { llm: null, llmUnavailableReason: "writer_ranking_not_computed_yet" } }) });
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), bridge)).toMatchObject({ kind: "error", message: expect.stringContaining("writer_ranking_not_computed_yet") });
    expect(calls.some((c) => c.name === "llm.complete" || c.name === "instantly.reply.send")).toBe(false);
  });

  it("their own stop ends it; a run with no occurrence or no clock does nothing", async () => {
    const stop = world(BOOK, { "lead.followup_date.read": () => ({ ok: true, data: { owed: { kind: "stop", reason: "opted_out", reasons: ["opted_out"] } } }) });
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), stop.bridge)).toMatchObject({ kind: "done", result: { unmade: "stopped: opted_out" } });
    expect(stop.calls.some((c) => c.name === "llm.complete")).toBe(false);
    const idle = world(BOOK);
    expect(await runScript(answerLeadScriptSource(), spec({ ...REQUEST, trigger: null }), idle.bridge)).toEqual({ kind: "done", result: { unmade: "no_occurrence" } });
    expect((await runScript(answerLeadScriptSource(), spec({ ...REQUEST, now: undefined }), idle.bridge)).kind).toBe("error");
  });

  it("a person crm holds no thread for (404) is answered with no thread; any other read failure stops the run", async () => {
    const none = world(BOOK, { "crm.person.thread": () => ({ ok: false, data: { status: 404, error: "no person" } }) });
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), none.bridge)).toMatchObject({ kind: "done" });
    const down = world(BOOK, { "crm.person.thread": () => ({ ok: false, data: { status: 502, error: "down" } }) });
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), down.bridge)).toMatchObject({ kind: "error", message: expect.stringContaining("crm.person.thread failed") });
    expect(down.calls.some((c) => c.name === "llm.complete")).toBe(false);
  });

  it("answers on WhatsApp when that is where they wrote last, in bubbles", async () => {
    const { calls, bridge } = world({ ...BOOK, bookSlot: "", bookedMessage: "", message: "Hi Josh\n\nFriday works" }, {
      "crm.person.thread": () => ({ ok: true, data: { items: [{ at: "2026-11-04T13:54:00Z", kind: "message", direction: "inbound", channel: "whatsapp", text: "ok" }] } }),
      "crm.whatsapp.reach": () => ({ ok: true, data: { reachable: true } }),
      "crm.whatsapp.send": () => ({ ok: true, data: { status: "sent" } }),
    });
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), bridge)).toMatchObject({ kind: "done", result: { content: { channel: "whatsapp" } } });
    expect(calls.find((c) => c.name === "crm.whatsapp.send")!.args).toMatchObject({ body: { messages: ["Hi Josh", "Friday works"], idempotencyKey: "answer-lead:event:ev-1" } });
  });

  it("the Lead event Target script asks the Message sent Engine for the answer, with the run's own Request", async () => {
    expect(ANSWER_LEAD_OUTCOME).toBe("message_sent");
    await expect(validateSource(ANSWER_LEAD_PULL.source)).resolves.toMatchObject({ materials: ["message_sent"] });
    expect(ANSWER_LEAD_PULL.tactics.asks).toEqual(["message_sent"]);
    const seen: Array<[string, unknown]> = [];
    const bridge = (child: unknown) => async (op: string, args: unknown[]) => {
      seen.push([op, args[0]]);
      if (op === "ask") return { v: null };
      if (op === "get") return { v: child };
      return { stop: op };
    };
    const made = await runScript(ANSWER_LEAD_PULL.source, spec(REQUEST), bridge({ content: { decision: "write" } }));
    expect(made).toEqual({ kind: "done", result: { content: { answered: { decision: "write" } } } });
    expect(seen[0]).toEqual(["ask", { units: {}, request: REQUEST, recordedBy: "sender" }]);
    expect(await runScript(ANSWER_LEAD_PULL.source, spec(REQUEST), bridge({ unmade: "later: tomorrow" }))).toEqual({ kind: "done", result: { unmade: "later: tomorrow" } });
    expect(await runScript(ANSWER_LEAD_PULL.source, spec({ ...REQUEST, trigger: null }), bridge({}))).toEqual({ kind: "done", result: { unmade: "no_occurrence" } });
  });
});
