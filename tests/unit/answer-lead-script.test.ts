import { describe, it, expect } from "vitest";
import { runScript, validateSource } from "../../src/lib/scripts/sandbox.js";
import { answerLeadScriptSource, ANSWER_SCHEMA, ANSWER_LEAD_OUTCOME, ANSWER_LEAD_PULL, ANSWER_LEAD_CALL_OUTCOME } from "../../src/lib/scripts/answer-lead-script.js";

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
  const asked: unknown[] = [];
  const gotten: string[] = [];
  const bridge = async (op: string, args: unknown[]) => {
    if (op === "ask") {
      asked.push(args[0]);
      return { v: null };
    }
    if (op === "get") {
      gotten.push(String(args[0]));
      const child = answers[`get:${String(args[0])}`];
      return child ? { v: child({}).data } : { stop: `no Unit recorded for ${String(args[0])}` };
    }
    if (op !== "vendor") return { stop: `unexpected ${op}` };
    const name = String(args[0]);
    const a = (args[1] ?? {}) as Record<string, unknown>;
    calls.push({ name, args: a });
    const f = answers[name];
    if (!f) return { stop: `no answer recorded for ${name}` };
    return { v: f(a) };
  };
  return { calls, bridge, asked, gotten };
}

const spec = (request: Record<string, unknown>) => ({ subject: "lead-1", brand: "brand-1", day: 0, tactics: {}, request });
const REQUEST = { now: NOW, brandIds: ["brand-1"], campaignId: "camp-lead-event", offerId: "offer-1", brief: null, trigger: { leadId: "lead-1", eventId: "ev-1", person: { email: "Dr@Clinic.test" }, item: { kind: "replied" } } };
const BOOK = { decision: "write", channel: "email", replyTo: "", to: [] as string[], cc: [] as string[], bcc: [] as string[], message: "<p>Friday works.</p>", subject: "", bookSlot: SLOT, bookedMessage: "<p>You are booked for Friday, November 6 at 3:30 PM Central.</p>", nextFollowUpAt: "2026-11-05T15:00:00Z", nextFollowUpWhy: "Reminder the day before", question: "", reason: "They picked a time" };

describe("the answering script", () => {
  it("is a valid script: transpiles, evaluates, a strict schema", async () => {
    await expect(validateSource(answerLeadScriptSource())).resolves.toMatchObject({ materials: [ANSWER_LEAD_CALL_OUTCOME] });
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
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), later.bridge)).toMatchObject({ kind: "done", result: { unmade: expect.stringMatching(/^later/), decided: "done" } });
    expect(later.calls.some((c) => ["instantly.reply.send", "email.send", "crm.whatsapp.send", "crm.meeting.book"].includes(c.name))).toBe(false);
    const esc = world({ ...BOOK, decision: "escalate", message: "", bookSlot: "", bookedMessage: "", question: "What is the price?" });
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), esc.bridge)).toEqual({ kind: "done", result: { unmade: "escalate: What is the price? (sales rep alerted)", decided: "done" } });
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
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), stop.bridge)).toEqual({ kind: "done", result: { unmade: "stopped: opted_out", decided: "done" } });
    expect(stop.calls.some((c) => c.name === "llm.complete")).toBe(false);
    // Nobody owed on this campaign (or not judged yet): nothing to do now, never a refusal (MON-UNSENT-RED-1111).
    const none = world(BOOK, { "lead.followup.claim": () => ({ ok: true, data: { found: false, reason: "relationship_pending" } }) });
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), none.bridge)).toEqual({ kind: "done", result: { unmade: "nobody_due: relationship_pending", decided: "idle" } });
    // Refused by lead-service's judgment = WHO, stated as personNotAdmitted (no `decided`).
    const refused = world(BOOK, { "lead.followup.claim": () => ({ ok: true, data: { found: false, reason: "nothing_due", relationships: { refused: [{ reason: "customer" }] } } }) });
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), refused.bridge)).toEqual({ kind: "done", result: { unmade: "person_not_admitted: customer" } });
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
    const { calls, bridge } = world({ ...BOOK, channel: "whatsapp", bookSlot: "", bookedMessage: "", message: "Hi Josh\n\nFriday works" }, {
      "crm.person.thread": () => ({ ok: true, data: { items: [{ at: "2026-11-04T13:54:00Z", kind: "message", direction: "inbound", channel: "whatsapp", text: "ok" }] } }),
      "crm.whatsapp.reach": () => ({ ok: true, data: { reachable: true } }),
      "crm.whatsapp.send": () => ({ ok: true, data: { status: "sent" } }),
    });
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), bridge)).toMatchObject({ kind: "done", result: { content: { channel: "whatsapp" } } });
    expect(calls.find((c) => c.name === "crm.whatsapp.send")!.args).toMatchObject({ body: { messages: ["Hi Josh", "Friday works"], idempotencyKey: "answer-lead:event:ev-1" } });
  });

  it("on WhatsApp the writer speaks as the sending line's persona, from the line the campaign states (Paul, 2026-11-07: Sophie's line signed 'Kevin')", async () => {
    const { calls, bridge } = world({ ...BOOK, channel: "whatsapp", bookSlot: "", bookedMessage: "", message: "Hi Paul" }, {
      "crm.person.thread": () => ({ ok: true, data: { items: [{ at: "2026-11-04T13:54:00Z", kind: "message", direction: "inbound", channel: "whatsapp", text: "ok" }] } }),
      "crm.whatsapp.reach": () => ({ ok: true, data: { reachable: true, persona: { name: "Sophie", role: "AI assistant", instructions: null } } }),
      "crm.whatsapp.send": () => ({ ok: true, data: { status: "sent" } }),
    });
    await runScript(answerLeadScriptSource(), spec({ ...REQUEST, whatsappSenderPhone: "+15550002222" }), bridge);
    expect(String(calls.find((c) => c.name === "llm.complete")!.args.systemPrompt)).toContain("WHO YOU ARE: you are Sophie, AI assistant at Doc Dinners");
    expect(calls.find((c) => c.name === "crm.whatsapp.reach")!.args).toMatchObject({ body: { fromAccount: "+15550002222" } });
    expect(calls.find((c) => c.name === "crm.whatsapp.send")!.args).toMatchObject({ body: { fromAccount: "+15550002222" } });
    // No persona, no stated line: the prompt names nobody and crm-service picks the line.
    const plain = world({ ...BOOK, channel: "whatsapp", bookSlot: "", bookedMessage: "", message: "Hi" }, {
      "crm.person.thread": () => ({ ok: true, data: { items: [{ at: "2026-11-04T13:54:00Z", kind: "message", direction: "inbound", channel: "whatsapp", text: "ok" }] } }),
      "crm.whatsapp.reach": () => ({ ok: true, data: { reachable: true, persona: null } }),
      "crm.whatsapp.send": () => ({ ok: true, data: { status: "sent" } }),
    });
    await runScript(answerLeadScriptSource(), spec(REQUEST), plain.bridge);
    expect(String(plain.calls.find((c) => c.name === "llm.complete")!.args.systemPrompt)).not.toContain("WHO YOU ARE");
    expect((plain.calls.find((c) => c.name === "crm.whatsapp.send")!.args.body as Record<string, unknown>).fromAccount).toBeUndefined();
  });

  it("a positive reply or a form fill asks the Booking call Engine for the rep call first, then answers as always", async () => {
    const CALLED = { "get:booking_call": () => ({ ok: true, data: { outcome: "booking_call", content: { end: { success: true } } } }) };
    for (const sourceTriggerId of ["positive_reply_received", "form_submitted"]) {
      const w = world(BOOK, CALLED);
      const request = { ...REQUEST, trigger: { ...REQUEST.trigger, triggerId: "lead_event", sourceTriggerId } };
      const out = await runScript(answerLeadScriptSource(), spec(request), w.bridge);
      expect(out).toMatchObject({ kind: "done", result: { content: { decision: "write", booked: SLOT } } });
      expect(w.gotten).toEqual(["booking_call"]);
      // The row this run claimed is handed over: the call script claims and stops nothing.
      // The occurrence is handed as the Unit the call consumes (a reply = conversation, a form = form_submitted).
      const consumes = sourceTriggerId === "form_submitted" ? "form_submitted" : "conversation";
      expect(w.asked).toEqual([{ units: { [consumes]: { content: request.trigger, subject: { service: "lead-service", id: "lead-1" } } }, request: { ...request, claimed: { found: true, followup: { id: "row-1", email: "dr@clinic.test", phone: null, leadId: "lead-1", dueAt: NOW } } } }]);
      expect(w.calls.filter((c) => c.name === "lead.followup.claim")).toHaveLength(1);
    }
    // A campaign whose strategy keeps no call script: the answer goes out all the same.
    const none = world(BOOK, { "get:booking_call": () => ({ ok: true, data: { outcome: "booking_call", content: null, unmade: "no_script: no live script of that Engine can run on nothing" } }) });
    const request = { ...REQUEST, trigger: { ...REQUEST.trigger, triggerId: "lead_event", sourceTriggerId: "positive_reply_received" } };
    expect(await runScript(answerLeadScriptSource(), spec(request), none.bridge)).toMatchObject({ kind: "done", result: { content: { decision: "write" } } });
    // Any other fact (a visit, a plain reply, a signup) rings nobody.
    const quiet = world(BOOK);
    await runScript(answerLeadScriptSource(), spec({ ...REQUEST, trigger: { ...REQUEST.trigger, triggerId: "lead_event", sourceTriggerId: "message_received" } }), quiet.bridge);
    expect(quiet.asked).toEqual([]);
    expect(quiet.gotten).toEqual([]);
  });

  it("asks for the brand's own tools on its one LLM call (BRAND-MCP-1109), whatever the picked model", async () => {
    for (const llm of [{ provider: "anthropic", model: "opus" }, { provider: "google", model: "flash" }, { provider: "deepseek", model: "v4-flash" }]) {
      const w = world(BOOK, { "features.writer_pick": () => ({ ok: true, data: { llm } }) });
      await runScript(answerLeadScriptSource(), spec(REQUEST), w.bridge);
      const call = w.calls.filter((c) => c.name === "llm.complete");
      expect(call).toHaveLength(1);
      expect(call[0]!.args).toMatchObject({ ...llm, brandTools: { brandId: "brand-1" } });
    }
  });

  it("records how many brand tool calls the writer made, on every outcome (Chaim: a client's own 'not a true lead')", async () => {
    const TOOLS = 3;
    const answered = (draft: Record<string, unknown>) => ({ "llm.complete": () => ({ ok: true, data: { json: draft, brandToolCalls: TOOLS } }) });
    const stop = world(BOOK, answered({ ...BOOK, decision: "stop", message: "", bookSlot: "", bookedMessage: "", reason: "The client says he is not a true lead; marked him in their CRM" }));
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), stop.bridge)).toEqual({ kind: "done", result: { unmade: "stop: The client says he is not a true lead; marked him in their CRM (brand tool calls: 3)", decided: "done" } });
    const write = world(BOOK, answered(BOOK));
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), write.bridge)).toMatchObject({ kind: "done", result: { content: { decision: "write", brandToolCalls: TOOLS } } });
    const esc = world(BOOK, answered({ ...BOOK, decision: "escalate", message: "", bookSlot: "", bookedMessage: "", question: "Price?" }));
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), esc.bridge)).toEqual({ kind: "done", result: { unmade: "escalate: Price? (sales rep alerted) (brand tool calls: 3)", decided: "done" } });
    const later = world(BOOK, answered({ ...BOOK, decision: "later", message: "", bookSlot: "", bookedMessage: "", nextFollowUpWhy: "after the demo" }));
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), later.bridge)).toEqual({ kind: "done", result: { unmade: "later: after the demo (brand tool calls: 3)", decided: "done" } });
  });

  it("no server plugged (no brandToolCalls answered): the same decisions and outputs as before", async () => {
    const write = world(BOOK);
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), write.bridge)).toEqual({ kind: "done", result: { content: { decision: "write", channel: "email", booked: SLOT, inThread: true } } });
    const later = world({ ...BOOK, decision: "later", message: "", bookSlot: "", bookedMessage: "", nextFollowUpWhy: "after the demo" });
    expect(await runScript(answerLeadScriptSource(), spec(REQUEST), later.bridge)).toEqual({ kind: "done", result: { unmade: "later: after the demo", decided: "done" } });
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
    expect(await runScript(ANSWER_LEAD_PULL.source, spec(REQUEST), bridge({ unmade: "later: tomorrow", decided: "done" }))).toEqual({ kind: "done", result: { unmade: "later: tomorrow", decided: "done" } });
    expect(await runScript(ANSWER_LEAD_PULL.source, spec(REQUEST), bridge({ unmade: "nobody_due: nothing_due", decided: "idle" }))).toEqual({ kind: "done", result: { unmade: "nobody_due: nothing_due", decided: "idle" } });
    // A refusal the world gave is forwarded as it is: no `decided`, so the runner states it as a refusal.
    expect(await runScript(ANSWER_LEAD_PULL.source, spec(REQUEST), bridge({ unmade: "refused: lead_opted_out" }))).toEqual({ kind: "done", result: { unmade: "refused: lead_opted_out" } });
    expect(await runScript(ANSWER_LEAD_PULL.source, spec({ ...REQUEST, trigger: null }), bridge({}))).toEqual({ kind: "done", result: { unmade: "no_occurrence" } });
  });

  // EVERY-PERSON-ON-THE-THREAD-1109: Markthalle Luzern, 2026-11-09 (made-up addresses, the real shape). Our cold email
  // went to Thomas; his colleague Markus answered in the same thread. The writer sees Markus's email as himself and
  // answers HIM, in that thread, copying Thomas as it judges.
  describe("every person on the thread", () => {
    const COLD = { direction: "outbound", from: "kevin@mailbox.test", to: "thomas@market.test", at: "2026-11-05T08:00:00Z", subject: "Psyllium for your stalls", text: "Hi Thomas, ...", messageId: "<cold-1@mailbox.test>", participants: [{ email: "kevin@mailbox.test", role: "from" }, { email: "thomas@market.test", role: "to" }] };
    const MARKUS = { direction: "inbound", from: "markus@market.test", to: "kevin@mailbox.test", at: "2026-11-09T15:20:00Z", subject: "Re: Psyllium for your stalls", text: "Are psyllium husks grown in Switzerland?", messageId: "<markus-1@market.test>", participants: [{ email: "markus@market.test", role: "from" }, { email: "kevin@mailbox.test", role: "to" }, { email: "thomas@market.test", role: "cc" }] };
    const THOMAS_RUN = {
      "lead.followup.claim": () => ({ ok: true, data: { found: true, followup: { id: "row-t", email: "thomas@market.test", phone: null, leadId: "lead-t", dueAt: NOW } } }),
      "crm.person.thread": () => ({ ok: false, data: { status: 404, error: "no person holds email:thomas@market.test" } }),
      "instantly.conversation": () => ({ ok: true, data: { conversation: { messages: [COLD, MARKUS], threads: [{ replied: true, campaignId: "thomas-thread", lastInboundAt: MARKUS.at }] } } }),
    };
    const ANSWER = { ...BOOK, bookSlot: "", bookedMessage: "", message: "<p>Hi Markus, ...</p>", replyTo: "M2", to: ["Markus@Market.test"], cc: ["thomas@market.test", "markus@market.test", "not an address"] };

    it("shows every email with its label, who wrote it and who was on it, even when crm holds no thread", async () => {
      const w = world(ANSWER, THOMAS_RUN);
      await runScript(answerLeadScriptSource(), spec(REQUEST), w.bridge);
      const message = String(w.calls.find((c) => c.name === "llm.complete")!.args.message);
      expect(message).toContain("label M1, from kevin@mailbox.test to thomas@market.test, subject: Psyllium for your stalls: Hi Thomas");
      expect(message).toContain("THEM (email) label M2, from markus@market.test to kevin@mailbox.test cc thomas@market.test, subject: Re: Psyllium for your stalls: Are psyllium husks grown in Switzerland?");
      expect(String(w.calls.find((c) => c.name === "llm.complete")!.args.systemPrompt)).toContain("a colleague who answered in their thread is waiting for our answer too");
      const schema = w.calls.find((c) => c.name === "llm.complete")!.args.responseSchema as { properties: Record<string, { enum?: string[] }> };
      expect(schema.properties.replyTo!.enum).toEqual(["M1", "M2", ""]);
      expect(schema.properties.channel!.enum).toEqual(["email"]);
    });

    it("answers Markus in his message's thread, Thomas copied, as the writer chose", async () => {
      const w = world(ANSWER, THOMAS_RUN);
      const out = await runScript(answerLeadScriptSource(), spec(REQUEST), w.bridge);
      expect(out).toEqual({ kind: "done", result: { content: { decision: "write", channel: "email", booked: null, inThread: true, replyTo: "<markus-1@market.test>", recipients: { to: ["markus@market.test"], cc: ["thomas@market.test"], bcc: [] } } } });
      expect(w.calls.filter((c) => ["instantly.reply.send", "email.send"].includes(c.name))).toEqual([
        { name: "instantly.reply.send", args: { body: { email: "thomas@market.test", body_html: "<p>Hi Markus, ...</p>", sent_by: "automation", in_reply_to: "<markus-1@market.test>", to: ["markus@market.test"], cc: ["thomas@market.test"] } } },
      ]);
    });

    it("names nobody = the thread's default recipients; a new thread opens from their conversation's mailbox", async () => {
      const plain = world({ ...ANSWER, to: [], cc: [] }, THOMAS_RUN);
      await runScript(answerLeadScriptSource(), spec(REQUEST), plain.bridge);
      expect(plain.calls.find((c) => c.name === "instantly.reply.send")!.args).toEqual({ body: { email: "thomas@market.test", body_html: "<p>Hi Markus, ...</p>", sent_by: "automation", in_reply_to: "<markus-1@market.test>" } });
      const fresh = world({ ...ANSWER, replyTo: "", subject: "Swiss psyllium", to: [], cc: [] }, THOMAS_RUN);
      await runScript(answerLeadScriptSource(), spec(REQUEST), fresh.bridge);
      expect(fresh.calls.find((c) => c.name === "instantly.reply.send")!.args).toEqual({ body: { campaign_id: "thomas-thread", email: "thomas@market.test", body_html: "<p>Hi Markus, ...</p>", sent_by: "automation", new_thread_subject: "Swiss psyllium" } });
    });

    it("an email shown once when crm and the conversation both hold it (the conversation's copy carries everyone)", async () => {
      const w = world(ANSWER, { ...THOMAS_RUN, "crm.person.thread": () => ({ ok: true, data: { items: [
        { at: MARKUS.at, kind: "message", direction: "inbound", channel: "email", source: "sending_mailbox", from: "markus@market.test", to: "kevin@mailbox.test", text: MARKUS.text, ref: { messageId: MARKUS.messageId } },
        { at: "2026-11-09T15:25:00Z", kind: "event", channel: "web", text: "visited the pricing page" },
      ] } }) });
      await runScript(answerLeadScriptSource(), spec(REQUEST), w.bridge);
      const message = String(w.calls.find((c) => c.name === "llm.complete")!.args.message);
      expect(message.split("Are psyllium husks grown in Switzerland?").length - 1).toBe(1);
      expect(message).toContain("EVENT (web): visited the pricing page");
    });

    it("a channel that is not open, or an email not in the thread, sends nothing and fails the run", async () => {
      const wa = world({ ...ANSWER, channel: "whatsapp" }, THOMAS_RUN);
      expect(await runScript(answerLeadScriptSource(), spec(REQUEST), wa.bridge)).toMatchObject({ kind: "error", message: expect.stringContaining("not open") });
      const lost = world({ ...ANSWER, replyTo: "M9" }, THOMAS_RUN);
      expect(await runScript(answerLeadScriptSource(), spec(REQUEST), lost.bridge)).toMatchObject({ kind: "error", message: expect.stringContaining("not in the thread") });
      expect([...wa.calls, ...lost.calls].some((c) => ["instantly.reply.send", "email.send", "crm.whatsapp.send"].includes(c.name))).toBe(false);
    });

    it("a person we can reach on both channels: the writer picks, each medium's lines headed", async () => {
      const w = world({ ...ANSWER, channel: "whatsapp", message: "Hi Markus" }, { ...THOMAS_RUN,
        "lead.followup.claim": () => ({ ok: true, data: { found: true, followup: { id: "row-t", email: "thomas@market.test", phone: "+41790000000", leadId: "lead-t", dueAt: NOW } } }),
        "crm.whatsapp.reach": () => ({ ok: true, data: { reachable: true, persona: { name: "Sophie", role: "AI assistant", instructions: null } } }),
      });
      expect(await runScript(answerLeadScriptSource(), spec(REQUEST), w.bridge)).toMatchObject({ kind: "done", result: { content: { channel: "whatsapp", inThread: null } } });
      const sys = String(w.calls.find((c) => c.name === "llm.complete")!.args.systemPrompt);
      expect(sys).toContain("ON EMAIL:");
      expect(sys).toContain("ON WHATSAPP:");
      expect(sys).toContain("WHEN YOU WRITE ON WHATSAPP:\n\nWHO YOU ARE: you are Sophie");
      expect(String(w.calls.find((c) => c.name === "llm.complete")!.args.message)).toContain("THE CHANNELS OPEN: email, whatsapp");
    });
  });
});
