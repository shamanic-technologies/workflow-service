import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScript, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { sameJson } from "../../src/lib/scripts/replay.js";
import {
  FOLLOW_UP_ANCHORS,
  FOLLOW_UP_PERSON_FIELDS,
  FOLLOW_UP_REQUESTED,
  compareFollowUpOnCase,
  followUpTactics,
  followUpWriterCase,
  splitFollowUp,
  type StoredFollowUpCase,
} from "../../src/lib/scripts/follow-up-split.js";
import { asksCompletion, isPairWriter, valuesAt } from "../../src/lib/scripts/writer-proof.js";
import { TO_PERSON_DOORS, writesToPerson } from "../../src/lib/scripts/vendors.js";

// WRITER-SENDER-SPLIT-1118: the stored lead follow-up (lead_interested/dy_follow_up_due v8, as production stores it)
// is cut into its writer and its sender. Same model answer = the same doors called with the same bodies, in the same
// order, the model asked the same request, and the same end.
const STORED = readFileSync(join(__dirname, "../fixtures/follow-up-due-stored-v8.js"), "utf8");
const HALVES = splitFollowUp(STORED);
const NOW = "2026-11-17T15:00:00.000Z";
const REQUEST = { now: NOW, campaignId: "camp-1", runId: "run-1", brandIds: ["brand-1"], offerId: "offer-1", brief: "Book meetings with founders." };

type Answer = { ok: boolean; data: Record<string, unknown> };
const ok = (data: Record<string, unknown>): Answer => ({ ok: true, data });
const DOORS: Record<string, Answer> = {
  "lead.serve": ok({ found: true, lead: { leadCampaignId: "row-1", leadId: "lead-1", brandIds: ["brand-1"], email: "jay@co.test", data: { firstName: "Jay", lastName: "Worley", timezone: "America/Denver" } } }),
  "lead.followup_date.read": ok({ owed: { kind: "owed", reasons: [] }, followupDate: { nextFollowupAt: "2026-11-16T15:00:00.000Z" }, queued: {} }),
  "crm.person.thread": ok({ items: [{ at: "2026-11-10T15:00:00Z", kind: "message", direction: "outbound", channel: "email", text: "Hello Jay", messageId: "<m1@co.test>" }], person: { emails: ["jay@co.test"] }, factFeed: { settled: true } }),
  "crm.whatsapp.reach": ok({ reachable: false, code: "no_phone" }),
  "brand.offer.economics": ok({ name: "Meetings", bookingUrl: "https://book.test/acme" }),
  "brand.profile": ok({ brand: { name: "Acme" } }),
  "brand.offer.answers": ok({ answers: [{ question: "Price?", answer: "$100 per meeting" }] }),
  "brand.offer.fields": ok({ fields: {} }),
  "brand.fields": ok({ fields: {} }),
  "lead.history": ok({ events: [{ type: "delivery", milestone: "sent", channel: "email", at: "2026-11-10T15:00:00Z" }], sources: [] }),
  "lead.relationship": ok({}),
  "voice.read": ok({ content: "OUR VOICE" }),
  "email.send": ok({ success: true, status: "sent" }),
  "crm.whatsapp.send": ok({ status: "sent" }),
  "lead.followup_date.set": ok({}),
  "lead.followup.record": ok({}),
};
const draft = (over: Record<string, unknown>) => ({ decision: "write", subject: "", bodyHtml: "", message: "", nextFollowUpAt: "2026-11-24T15:00:00.000Z", nextFollowUpWhy: "a week later", reason: "due", question: "", ...over });
const EMAIL = draft({ subject: "Quick follow-up", bodyHtml: "<p>Hi Jay — a quick note.</p>" });

/** A recorded case, as production keeps one: the stored code run once on these doors, every call and its answer kept. */
async function record(model: Record<string, unknown> | null, doors: Record<string, Answer> = DOORS, request: Record<string, unknown> = REQUEST): Promise<StoredFollowUpCase> {
  const calls: StoredFollowUpCase["calls"] = [];
  const completion = model ? { id: "c", outcome: "llm_completion", subject: "lead-1", ageDays: 0, content: { answer: { json: model }, llm: { provider: "zai", model: "glm-flash" } } } : undefined;
  const bridge: Bridge = async (op, args) => {
    if (op === "vendor") {
      const name = String(args[0]);
      const answer = doors[name];
      if (!answer) return { stop: `no door ${name}` };
      calls.push({ name, args: JSON.parse(JSON.stringify(args[1] ?? null)), answer });
      return { v: answer };
    }
    if (op === "ask") return { v: null };
    if (op === "get") return completion ? { v: completion } : { stop: "no completion" };
    return { v: null };
  };
  const spec = { subject: null, brand: "brand-1", day: 0, tactics: {}, request };
  const out = await runScript(STORED, spec, bridge);
  if (out.kind === "stopped") throw new Error(`the fixture case stopped: ${out.reason}`);
  return { units: {}, request, tactics: {}, subject: null, brand: "brand-1", day: 0, calls, asked: completion ? { llm_completion: completion } : {} };
}
const compare = (c: StoredFollowUpCase) => compareFollowUpOnCase(STORED, HALVES, c, runScript as never, sameJson);
const names = (steps: Array<{ kind: string; name: string }>) => steps.map((s) => (s.kind === "ask" ? "ASK " : "") + s.name);

describe("splitFollowUp: the cut", () => {
  it("moves exactly the prompt, the voiced prompt, the completion and the decision to the writer; the sender calls no model", () => {
    for (const line of [FOLLOW_UP_ANCHORS.compose, FOLLOW_UP_ANCHORS.voiced, FOLLOW_UP_ANCHORS.draft, FOLLOW_UP_ANCHORS.finalize]) {
      expect(HALVES.writer.split(line).length - 1, line).toBe(1);
      expect(HALVES.sender.includes(line), line).toBe(false);
    }
    expect(HALVES.sender).toContain('ctx.get("message_written")');
    expect(HALVES.sender).toContain(`${FOLLOW_UP_REQUESTED}: { content:`);
    // The sender still reads the voice, at its place, skipped exactly when nothing is written.
    expect(HALVES.sender).toContain('callStep(ctx, "voice.read"');
    expect(HALVES.sender).toContain("skip: (results.channel_plan?.skipModel === true) }, 2);");
    // The writer acts on nobody: its run body calls no door.
    const writerRun = HALVES.writer.slice(HALVES.writer.indexOf("export default function run("), HALVES.writer.indexOf("function askCompletion("));
    expect([...writerRun.matchAll(/callStep\(ctx, "([a-z_.]+)"/g)].map((m) => m[1])).toEqual(["llm_completion"]);
    // Everything else of the stored code is in the sender, untouched.
    const before = STORED.slice(0, STORED.indexOf(FOLLOW_UP_ANCHORS.compose));
    const after = STORED.slice(STORED.indexOf(FOLLOW_UP_ANCHORS.finalize) + FOLLOW_UP_ANCHORS.finalize.length);
    expect(HALVES.sender.startsWith(before)).toBe(true);
    expect(HALVES.sender.endsWith(after)).toBe(true);
  });

  it("generates nothing when an anchor moved, or when the code is already split", () => {
    expect(() => splitFollowUp(STORED.replace(FOLLOW_UP_ANCHORS.finalize, "  results.finalize = somethingElse();\n"))).toThrow(/anchor finalize is found 0 times/);
    expect(() => splitFollowUp(STORED.replace(FOLLOW_UP_ANCHORS.voiced, "  results.other = 1;\n" + FOLLOW_UP_ANCHORS.voiced))).toThrow(/not contiguous/);
    expect(() => splitFollowUp(HALVES.sender)).toThrow(/found 0 times/);
  });

  it("states the tactics of each half: the sender asks its writer and no model, the writer asks its model and names what a person reads", () => {
    const t = followUpTactics({ asks: ["llm_completion"], channel: "ai-follow-up-email", recorded_by: "sender" });
    expect(t.sender).toEqual({ channel: "ai-follow-up-email", recorded_by: "sender", asks: ["message_written"] });
    expect(t.writer).toEqual({ asks: ["llm_completion"], personFields: FOLLOW_UP_PERSON_FIELDS });
    expect(asksCompletion({ tactics: t.sender } as never)).toBe(false);
    expect(isPairWriter({ tactics: t.writer, code: HALVES.writer } as never)).toBe(true);
    // The sender still sends to a person through the same doors.
    expect(writesToPerson(HALVES.sender)).toBe(true);
    expect(Object.keys(TO_PERSON_DOORS)).toEqual(expect.arrayContaining(["email.send", "crm.whatsapp.send"]));
  });
});

describe("the halves do what the stored code did, on the same record and the same model answer", () => {
  it("an email follow-up: same doors, same bodies, same recipient, same idempotency key, same prompt asked", async () => {
    const c = await record(EMAIL);
    const r = await compare(c);
    expect(r.diff).toBeNull();
    expect(names(r.split.steps)).toEqual(names(r.stored.steps));
    expect(names(r.split.steps)).toEqual([
      "lead.serve", "lead.followup_date.read", "crm.person.thread", "crm.whatsapp.reach", "brand.offer.economics", "brand.profile", "brand.offer.answers", "brand.offer.fields",
      "brand.fields", "lead.history", "lead.relationship", "voice.read", "ASK llm_completion", "email.send", "lead.followup_date.set",
    ]);
    const send = r.split.steps.find((s) => s.name === "email.send")!.args as { body: Record<string, unknown> };
    expect(send.body).toMatchObject({ to: "jay@co.test", subject: "Quick follow-up", idempotencyKey: "follow-up:camp-1:row-1:run-1", sequence: [{ step: 1, bodyHtml: "<p>Hi Jay, a quick note.</p>", daysSinceLastStep: 0 }] });
    expect(send).toEqual(r.stored.steps.find((s) => s.name === "email.send")!.args);
    // The model is asked the stored request, byte for byte (the brief, the voice and the thread included).
    expect(r.split.steps.find((s) => s.kind === "ask")!.args).toEqual(r.stored.steps.find((s) => s.kind === "ask")!.args);
    expect(JSON.stringify(r.split.steps.find((s) => s.kind === "ask")!.args)).toContain("Book meetings with founders.");
    expect(r.split.end).toEqual(r.stored.end);
    expect(r.wrote).toBe(true);
  });

  it("a WhatsApp follow-up in several bubbles: the same message body and line", async () => {
    const doors = { ...DOORS, "crm.whatsapp.reach": ok({ reachable: true, to: "+15551234567", fromAccount: "acct-1", persona: { name: "Sophie", role: "AI assistant" } }) };
    const c = await record(draft({ message: "Hi Jay\n\nStill keen on Tuesday?" }), doors);
    const r = await compare(c);
    expect(r.diff).toBeNull();
    expect(names(r.split.steps)).toContain("crm.whatsapp.send");
    expect(names(r.split.steps)).not.toContain("email.send");
    expect(r.split.steps.find((s) => s.name === "crm.whatsapp.send")!.args).toEqual(r.stored.steps.find((s) => s.name === "crm.whatsapp.send")!.args);
  });

  it("later, stop, escalate, cannot_write: nothing is sent, the same date or stop is stored, no Unit is made", async () => {
    for (const d of [draft({ decision: "later", reason: "evening where Jay is" }), draft({ decision: "stop", reason: "they said no", nextFollowUpAt: "" }), draft({ decision: "escalate", question: "Do you integrate with SAP?" }), draft({ decision: "cannot_write", reason: "no offer facts" })]) {
      const c = await record(d);
      const r = await compare(c);
      expect(r.diff, String(d.decision)).toBeNull();
      expect(names(r.split.steps).some((n) => n === "email.send"), String(d.decision)).toBe(false);
      expect(r.wrote, String(d.decision)).toBe(false);
      expect(r.handed, String(d.decision)).not.toBeNull();
    }
  });

  it("nobody served, or not owed yet: no writer is asked, as no model was", async () => {
    for (const doors of [{ ...DOORS, "lead.serve": ok({ found: false, reason: "lead_followup_none_due" }) }, { ...DOORS, "lead.followup_date.read": ok({ owed: { kind: "not_yet", reason: "in_conversation", retryAfter: "2026-11-20T15:00:00.000Z" }, followupDate: {}, queued: {} }) }]) {
      const c = await record(null, doors);
      const r = await compare(c);
      expect(r.diff).toBeNull();
      expect(r.handed).toBeNull();
      expect(r.split.steps.some((s) => s.kind === "ask")).toBe(false);
      expect(r.split.steps.some((s) => s.name === "voice.read")).toBe(false);
    }
  });

  it("a draft the stored code refused (write with an empty body) is refused the same: nothing is sent", async () => {
    const c = await record(draft({ subject: "Hi", bodyHtml: "" }));
    const r = await compare(c);
    expect(r.diff).toBeNull();
    expect(r.stored.end).toMatchObject({ kind: "error" });
    expect((r.stored.end as { message: string }).message).toMatch(/empty subject or body/);
    expect(r.split.end).toMatchObject({ kind: "stopped" });
    expect(names(r.split.steps)).not.toContain("email.send");
  });

  it("a difference is found: a sender that changes one byte of what is sent does not compare equal", async () => {
    const c = await record(EMAIL);
    const tampered = { ...HALVES, sender: HALVES.sender.replace('"tag":"follow-up"', '"tag":"follow-up-2"') };
    expect(tampered.sender).not.toBe(HALVES.sender);
    const r = await compareFollowUpOnCase(STORED, tampered, c, runScript as never, sameJson);
    expect(r.same).toBe(false);
    expect(r.diff).toMatch(/email\.send: not the same request/);
  });
});

describe("the writer's own case and Unit", () => {
  it("is made of what the sender handed and the model's recorded answer; its Unit carries what a person reads", async () => {
    const c = await record(EMAIL);
    const r = await compare(c);
    const wc = followUpWriterCase(c, r.handed!);
    expect(Object.keys(wc.units)).toEqual([FOLLOW_UP_REQUESTED]);
    expect(wc.subject).toBe("lead-1");
    expect(wc.calls).toEqual([]);
    expect(wc.asked.llm_completion).toEqual(c.asked.llm_completion);
    // The writer alone on its case makes the message, on the lead, with the person-facing fields the proofs judge.
    const out = await runScript(HALVES.writer, { subject: wc.subject, brand: wc.brand, day: 0, tactics: {}, request: null }, async (op, args) => {
      if (op === "get") return { v: String(args[0]) === FOLLOW_UP_REQUESTED ? { id: "h", outcome: FOLLOW_UP_REQUESTED, subject: "lead-1", ageDays: 0, content: (wc.units[FOLLOW_UP_REQUESTED] as { content: unknown }).content } : wc.asked.llm_completion };
      if (op === "ask") return { v: null };
      return { stop: `the writer asked ${op}` };
    });
    expect(out.kind).toBe("done");
    const result = (out as { result: { content: Record<string, unknown>; subject: unknown } }).result;
    expect(result.subject).toEqual({ service: "lead-service", id: "lead-1" });
    expect(result.content).toMatchObject({ decision: "write", channel: "email", to: "jay@co.test", subject: "Quick follow-up" });
    const read = FOLLOW_UP_PERSON_FIELDS.flatMap((p) => valuesAt(result.content, p));
    expect(read).toEqual(["Quick follow-up", "<p>Hi Jay, a quick note.</p>"]);
  });
});
