import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { ANSWER_REQUESTED, answerTactics, splitAnswerLead, writerCaseFromStoredCase } from "../../src/lib/scripts/answer-lead-split.js";
import { sameJson } from "../../src/lib/scripts/replay.js";
import { callsCompletion } from "../../src/lib/scripts/writer-proof.js";
import { TO_PERSON_DOORS, writesToPerson } from "../../src/lib/scripts/vendors.js";
import { buildCompletionSource } from "../../scripts/engine-ports/llm-completion.js";

// ONE-WRITER-N-MODELS-1116-ANSWERER: the stored answerer (message_sent/dy_answer_lead v14, as production stores it) is
// cut into its writer and its sender. Same LLM answer = the same doors called with the same bodies, and the model gets
// the same prompt, byte for byte.
const STORED = readFileSync(join(__dirname, "../fixtures/answer-lead-stored-v14.js"), "utf8");
const { writer: WRITER, sender: SENDER } = splitAnswerLead(STORED);
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
async function runStored(d: Record<string, unknown>, extra = {}) {
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
async function runSplit(d: Record<string, unknown>, extra = {}) {
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

const acts = (calls: Call[]) => calls.filter((c) => c.name !== "llm.pick" && c.name !== "llm.complete").map((c) => ({ name: c.name, args: c.args }));
const llmRequest = (calls: Call[]) => {
  const c = calls.find((x) => x.name === "llm.complete")!.args;
  const { provider: _p, model: _m, ...rest } = c;
  return rest;
};

describe("the stored answerer, split into its writer and its sender", () => {
  it("both halves are valid scripts; the writer reads only what its sender hands it and asks its model", async () => {
    expect((await validateSource(WRITER)).materials.sort()).toEqual([ANSWER_REQUESTED, "llm_completion"]);
    expect((await validateSource(SENDER)).materials.sort()).toEqual(["booking_call", "message_written"]);
  });

  it("nothing that writes also sends: the writer calls no door and no LLM; the sender calls no LLM", () => {
    expect(writesToPerson(WRITER)).toBe(false);
    expect(callsCompletion(WRITER)).toBe(false);
    expect(WRITER).not.toMatch(/ctx\.vendor|door\(|must\(/);
    expect(writesToPerson(SENDER)).toBe(true);
    expect(callsCompletion(SENDER)).toBe(false);
    expect(SENDER).not.toContain("llm.pick");
    for (const name of Object.keys(TO_PERSON_DOORS)) expect(WRITER).not.toContain(`"${name}"`);
  });

  it("the prompt lives in the writer only: a prompt fix is ONE upgrade", () => {
    const stored = JSON.parse(STORED.slice(STORED.indexOf("const K = ") + "const K = ".length).trim().replace(/;\s*$/, ""));
    for (const line of [...stored.GAME, ...Object.values(stored.MEDIUM as Record<string, string[]>).flat()]) {
      const probe = String(line).slice(0, 60);
      expect(WRITER).toContain(JSON.stringify(probe).slice(1, -1));
      expect(SENDER).not.toContain(JSON.stringify(probe).slice(1, -1));
    }
    for (const marker of ["THE THREAD (oldest first)", "WHO YOU ARE: you are", "THEIR LOCAL TIME:", "THE FACTS:"]) {
      expect(WRITER).toContain(marker);
      expect(SENDER).not.toContain(marker);
    }
  });

  it("neither half names a model; the sender drops the stored LLM tactic", () => {
    const t = answerTactics({ llm: { provider: "zai", model: "glm-flash" }, asks: ["booking_call"], recorded_by: "sender", relationships: "pure_prospect" });
    expect(t.sender).toEqual({ asks: ["booking_call", "message_written"], recorded_by: "sender", relationships: "pure_prospect" });
    expect(t.writer).toEqual({ asks: ["llm_completion"], personFields: ["message", "bookedMessage", "subject"] });
    expect(WRITER).not.toMatch(/glm|opus|sonnet|haiku|gemini|gpt|kimi/i);
  });

  it("an email answer in their thread: same prompt, same doors, same bodies as the stored answerer", async () => {
    const before = await runStored(WRITE);
    const after = await runSplit(WRITE);
    expect(after.out.kind).toBe("done");
    expect(llmRequest(after.calls)).toEqual(llmRequest(before.calls));
    expect(acts(after.calls)).toEqual(acts(before.calls));
    const send = after.calls.find((c) => c.name === "instantly.reply.send")!.args.body as Record<string, unknown>;
    expect(send).toMatchObject({ email: "jay@co.test", in_reply_to: "<m1@co.test>", cc: ["boss@co.test"], body_html: "<p>Hi Jay, Tuesday 10am works.</p>" });
    // The model that wrote reaches the sender's Unit (SERVED-MODEL-1116); everything else as before.
    const b = (before.out as { result: { content: Record<string, unknown> } }).result.content;
    const a = (after.out as { result: { content: Record<string, unknown> } }).result.content;
    expect(a).toEqual({ ...b, writtenWith: { provider: "zai", model: "glm-flash", name: "GLM Flash" } });
    expect(after.calls.filter((c) => c.script === "writer")).toEqual([]);
  });

  it("they pick an open time: booked, then the confirmation, as before", async () => {
    const d = { ...WRITE, bookSlot: "2026-11-24T17:00:00Z", bookedMessage: "<p>Booked: Tuesday 10am your time.</p>" };
    const before = await runStored(d);
    const after = await runSplit(d);
    expect(acts(after.calls)).toEqual(acts(before.calls));
    expect(after.calls.map((c) => c.name)).toContain("crm.meeting.book");
  });

  it("WhatsApp, a new email thread, a refused send: same doors, same bodies", async () => {
    for (const d of [
      { ...WRITE, channel: "whatsapp", replyTo: "", cc: [], message: "Hi Jay\n\nTuesday works?" },
      { ...WRITE, replyTo: "", cc: [], subject: "Tuesday", message: "<p>Hi</p>" },
    ]) {
      const before = await runStored(d);
      const after = await runSplit(d);
      expect(acts(after.calls)).toEqual(acts(before.calls));
      expect(llmRequest(after.calls)).toEqual(llmRequest(before.calls));
    }
    const refuse = { "instantly.reply.send": () => ({ ok: false, data: { status: 409, code: "lead_opted_out", error: "opted out" } }) };
    const b = await runStored(WRITE, refuse);
    const a = await runSplit(WRITE, refuse);
    expect(acts(a.calls)).toEqual(acts(b.calls));
    expect(a.out).toEqual(b.out);
  });

  it("later, stop, escalate: the writer hands its decision back, the sender acts exactly as before", async () => {
    for (const d of [
      { ...WRITE, decision: "later", message: "", nextFollowUpWhy: "night where they are" },
      { ...WRITE, decision: "stop", reason: "not interested" },
      { ...WRITE, decision: "escalate", message: "", question: "Can you do $50?" },
    ]) {
      const before = await runStored(d);
      const after = await runSplit(d);
      expect(acts(after.calls)).toEqual(acts(before.calls));
      expect(after.out).toEqual(before.out);
    }
  });

  it("a writer that gives no usable date fails the run before anything is sent, as before", async () => {
    const d = { ...WRITE, nextFollowUpAt: "2020-01-01T00:00:00Z" };
    const before = await runStored(d);
    const after = await runSplit(d);
    expect(before.out.kind).toBe("error");
    expect(after.out.kind).not.toBe("done");
    expect(after.calls.map((c) => c.name)).not.toContain("instantly.reply.send");
  });

  it("refuses to generate when the stored code moved (an anchor gone)", () => {
    expect(() => splitAnswerLead(STORED.replace("  // 5. DECIDE once.\n", ""))).toThrow(/anchor decide/);
  });

  it("a stored answerer case becomes the writer's case: the sender replayed on its reads, the model's recorded answer as the completion", async () => {
    const before = await runStored(WRITE);
    const recorded = {
      units: {},
      request: REQUEST,
      tactics: { relationships: "pure_prospect" },
      subject: "lead-1",
      brand: "brand-1",
      day: 0,
      calls: before.calls.map((c) => ({ name: c.name, args: c.args, answer: doors(WRITE)[c.name]!(c.args) })),
      asked: {},
    };
    const c = await writerCaseFromStoredCase(SENDER, recorded, (code, sp, br) => runScript(code, sp, br as Bridge), sameJson);
    expect(c).not.toBeNull();
    expect(c!.calls).toEqual([]);
    expect(c!.subject).toBe("lead-1");
    expect(c!.asked.llm_completion).toMatchObject({ content: { answer: { json: WRITE }, llm: { provider: "zai", model: "glm-flash" } } });
    // The writer, fed that case with the recorded answer, asks the model the exact prompt production asked.
    const split = await runSplit(WRITE);
    expect(c!.units[ANSWER_REQUESTED]).toEqual({ content: (split.handedToWriter as Record<string, { content: unknown }>)[ANSWER_REQUESTED]!.content });
    // A case that never reached the model is no writer case.
    expect(await writerCaseFromStoredCase(SENDER, { ...recorded, calls: recorded.calls.filter((x) => x.name !== "llm.complete") }, (code, sp, br) => runScript(code, sp, br as Bridge), sameJson)).toBeNull();
  });
});
