import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { sameJson } from "../../src/lib/scripts/replay.js";
import {
  ANSWER_CHECK_ANCHOR,
  ANSWER_CHECK_DOOR,
  ANSWER_CHECK_TACTIC,
  addAnswerCheck,
  answerCheckTactics,
  compareAnswerCheckOnCase,
  type AnswerCase,
  type RecordedCall,
} from "../../src/lib/scripts/answer-check-before-write.js";

// ANSWER-CHECK-BEFORE-WRITE-1124: the lead answerer's sender as production stores it (v16), and its upgrade asking the
// email send's own check before its writer where the email can only leave through email.send.
const STORED = readFileSync(join(__dirname, "../fixtures/stored-scripts/message_sent__dy_answer_lead.v16.ts.txt"), "utf8");
const NEXT = addAnswerCheck(STORED);
const NOW = "2026-11-24T15:00:00.000Z";
const TACTICS = { asks: ["booking_call", "message_written"], recorded_by: "sender", relationships: "pure_prospect" };
const ON = answerCheckTactics(TACTICS);

type Answer = { ok: boolean; data: Record<string, unknown> };
type Doors = Record<string, (a: Record<string, unknown>) => Answer>;
const ok = (data: Record<string, unknown> = {}) => () => ({ ok: true, data });

/** A person with an address, no email of theirs in any thread, no conversation: the email can only be email.send. */
function doors(extra: Doors = {}, row: Record<string, unknown> = {}): Doors {
  return {
    "lead.followup.claim": ok({ found: true, followup: { id: "row-1", email: "Jay@Co.test", leadId: "lead-1", dueAt: NOW, ...row } }),
    "lead.followup_date.read": ok({ owed: { kind: "owed", reasons: [] } }),
    "lead.detail": ok({ leadDetail: { lead: { firstName: "Jay", lastName: "Worley", leadId: "lead-1", timezone: "America/Denver" } } }),
    "crm.person.thread": ok({ items: [] }),
    "instantly.conversation": ok({ conversation: { threads: [], messages: [] } }),
    "brand.profile": ok({ brand: { name: "Acme" } }),
    "brand.offer.economics": ok({ name: "Meetings" }),
    "brand.offer.answers": ok({ answers: [] }),
    "brand.offer.fields": ok({ fields: {} }),
    "voice.read": ok({ content: "OUR VOICE" }),
    "brand.sales_rep": () => ({ ok: false, data: { status: 404, error: "none" } }),
    "crm.whatsapp.reach": ok({ reachable: true }),
    "crm.whatsapp.send": ok({ status: "sent" }),
    "instantly.reply.send": ok({ status: "sent" }),
    "email.send": ok({ status: "sent" }),
    [ANSWER_CHECK_DOOR]: ok({ sendable: true }),
    "lead.followup_date.set": ok(),
    "lead.followup.record": ok(),
    ...extra,
  };
}
/** The same person with an email of theirs in a replied conversation: the email leaves through the reply door. */
const REPLIED: Doors = {
  "instantly.conversation": ok({
    conversation: {
      threads: [{ replied: true, campaignId: "camp-cold", lastInboundAt: "2026-11-23T10:00:00Z" }],
      messages: [{ at: "2026-11-23T10:00:00Z", direction: "inbound", subject: "Re: hello", text: "Tell me more", messageId: "<m1@co.test>", from: "jay@co.test", to: "kevin@box.test" }],
    },
  }),
};
const REQUEST = { now: NOW, brandIds: ["brand-1"], campaignId: "camp-1", offerId: "offer-1", brief: "Book meetings.", trigger: { leadId: "lead-1", eventId: "ev-1", person: { email: "jay@co.test" }, item: { kind: "reply" } } };
const WRITE = (over: Record<string, unknown> = {}) => ({ content: { decision: "write", channel: "email", replyTo: "", to: [], cc: [], bcc: [], message: "<p>Hi Jay</p>", subject: "Hello", bookSlot: "", bookedMessage: "", nextFollowUpAt: "2026-11-27T16:00:00Z", nextFollowUpWhy: "next look", ...over } });

type Call = { kind: "vendor" | "ask"; name: string; args: Record<string, unknown> };
async function run(code: string, tactics: Record<string, unknown>, d: Doors, written: Record<string, unknown> = WRITE(), request: Record<string, unknown> = REQUEST) {
  const calls: Call[] = [];
  const bridge: Bridge = async (op, args) => {
    if (op.startsWith("storage.")) return { v: null };
    if (op === "vendor") {
      const name = String(args[0]);
      calls.push({ kind: "vendor", name, args: (args[1] ?? {}) as Record<string, unknown> });
      const door = d[name];
      return door ? { v: door((args[1] ?? {}) as Record<string, unknown>) } : { stop: `no door ${name}` };
    }
    if (op === "ask") {
      calls.push({ kind: "ask", name: "ask", args: args[0] as Record<string, unknown> });
      return { v: null };
    }
    if (op === "get" && args[0] === "message_written") return { v: { id: "w", outcome: "message_written", subject: "", ageDays: 0, ...written } };
    return { stop: `unexpected ${op} ${String(args[0])}` };
  };
  const out = await runScript(code, { subject: "lead-1", brand: "brand-1", day: 0, tactics, request }, bridge);
  return { out, calls, names: calls.map((c) => c.name) };
}
const openOf = (calls: Call[]) => (calls.find((c) => c.kind === "ask")!.args as any).units.answer_requested.content.open as string[];

describe("ANSWER-CHECK-BEFORE-WRITE-1124", () => {
  it("one anchored edit: a valid script calling the check; a moved anchor or a second pass generates nothing", async () => {
    expect(STORED.split(ANSWER_CHECK_ANCHOR)).toHaveLength(2);
    const v = await validateSource(NEXT);
    expect(NEXT).toContain(`door("${ANSWER_CHECK_DOOR}"`);
    expect(v.materials).toEqual((await validateSource(STORED)).materials);
    expect(NEXT.length - STORED.length).toBeGreaterThan(0);
    expect(() => addAnswerCheck(NEXT)).toThrow(/already/);
    expect(() => addAnswerCheck(STORED.replace(ANSWER_CHECK_ANCHOR, "  if (email) open.push('email');\n"))).toThrow(/nowhere/);
    expect(ON[ANSWER_CHECK_TACTIC]).toBe(true);
  });

  it("tactic absent: the run byte for byte, whichever door the email leaves through", async () => {
    for (const d of [doors(), doors(REPLIED)]) {
      const before = await run(STORED, TACTICS, d);
      const after = await run(NEXT, TACTICS, d);
      expect(after.calls).toEqual(before.calls);
      expect(after.out).toEqual(before.out);
      expect(after.names).not.toContain(ANSWER_CHECK_DOOR);
    }
  });

  it("tactic on, the email leaves through the reply door: no check asked, the very same run", async () => {
    const written = WRITE({ replyTo: "M1" });
    const before = await run(STORED, TACTICS, doors(REPLIED), written);
    const after = await run(NEXT, ON, doors(REPLIED), written);
    expect(before.names).toContain("instantly.reply.send");
    expect(after.calls).toEqual(before.calls);
    expect(after.out).toEqual(before.out);
  });

  it("tactic on, the email can only be email.send: the check is asked for the person's own address before the writer, then the same run", async () => {
    const before = await run(STORED, TACTICS, doors());
    const after = await run(NEXT, ON, doors());
    expect(after.out).toEqual(before.out);
    expect(after.out).toMatchObject({ kind: "done", result: { content: { decision: "write", channel: "email" } } });
    const check = after.calls.find((c) => c.name === ANSWER_CHECK_DOOR)!;
    expect(check.args).toEqual({ body: { type: "broadcast", followUp: true, to: "jay@co.test" } });
    expect(after.names.indexOf(ANSWER_CHECK_DOOR)).toBeLessThan(after.names.indexOf("ask"));
    expect(after.calls.filter((c) => c.name !== ANSWER_CHECK_DOOR)).toEqual(before.calls);
    expect((after.calls.find((c) => c.name === "email.send")!.args as any).body.to).toBe("jay@co.test");
  });

  const REFUSED: Doors = { [ANSWER_CHECK_DOOR]: () => ({ ok: false, data: { error: "the address is not verified", status: 409, code: "email_not_verified", body: {} } }) };

  it("refused, nothing else open: no writer asked, nothing sent, the stored no-channel end", async () => {
    const r = await run(NEXT, ON, doors(REFUSED));
    expect(r.names).not.toContain("ask");
    expect(r.names).not.toContain("email.send");
    expect(r.out).toEqual({ kind: "done", result: { unmade: "no_channel" } });
    const tail = r.calls.slice(-2);
    expect(tail[0]).toMatchObject({ name: "lead.followup_date.set", args: { body: { nextFollowupAt: "2026-12-24T15:00:00.000Z", reason: "No way to write to them yet" } } });
    expect(tail[1]).toMatchObject({ name: "lead.followup.record", args: { body: { kind: "stopped", reason: "follow_up_no_channel" } } });
    // The very end a person with no address and no reachable WhatsApp takes in the stored code.
    const nobody = { ...REQUEST, trigger: { ...REQUEST.trigger, person: {} } };
    const stored = await run(STORED, TACTICS, doors({}, { email: null }), WRITE(), nobody);
    expect(stored.out).toEqual(r.out);
    expect(stored.calls.slice(-2)).toEqual(tail);
  });

  it("refused, WhatsApp still open: the run goes on with email not offered", async () => {
    const d = doors(REFUSED, { phone: "+15551234567" });
    const r = await run(NEXT, ON, d, WRITE({ channel: "whatsapp", message: "Hi Jay" }));
    expect(openOf(r.calls)).toEqual(["whatsapp"]);
    expect(r.names).toContain("crm.whatsapp.send");
    expect(r.names).not.toContain("email.send");
    expect(r.out).toMatchObject({ kind: "done", result: { content: { decision: "write", channel: "whatsapp" } } });
    // A pass leaves both offered, as stored.
    expect(openOf((await run(NEXT, ON, doors({}, { phone: "+15551234567" }))).calls)).toEqual(["email", "whatsapp"]);
  });

  it("a check that does not answer (no named refusal) fails the run, as the send's own failure does", async () => {
    const r = await run(NEXT, ON, doors({ [ANSWER_CHECK_DOOR]: () => ({ ok: false, data: { error: "email-gateway-service answered 502", status: 502, code: null, body: {} } }) }));
    expect(r.out.kind).toBe("error");
    expect(JSON.stringify(r.out)).toContain("email.send_check failed");
    expect(r.names).not.toContain("ask");
  });

  describe("the proof on a recorded run", () => {
    /** A recorded run of the stored code on these doors, as production keeps it. */
    async function record(d: Doors, written = WRITE()): Promise<AnswerCase> {
      const r = await run(STORED, TACTICS, d, written);
      const calls: RecordedCall[] = r.calls.filter((c) => c.kind === "vendor").map((c) => ({ name: c.name, args: c.args, answer: d[c.name]!(c.args) }));
      return { id: "run-1", request: REQUEST, tactics: {}, subject: "lead-1", brand: "brand-1", day: 0, calls, asked: {} };
    }
    const compare = (c: AnswerCase, tactics: Record<string, unknown>, written = WRITE()) => compareAnswerCheckOnCase(STORED, NEXT, c, tactics, runScript as never, sameJson, async () => written);

    it("a send that went out through email.send = the same run plus the check; through the reply door = the same run", async () => {
      expect(await compare(await record(doors()), ON)).toMatchObject({ kind: "passed", same: true, diff: null });
      const reply = WRITE({ replyTo: "M1" });
      expect(await compare(await record(doors(REPLIED), reply), ON, reply)).toMatchObject({ kind: "unchecked", same: true });
      expect(await compare(await record(doors()), TACTICS)).toMatchObject({ kind: "unchecked", same: true });
    });

    it("a send the record shows refused = no writer, no send, the no-channel end", async () => {
      const refusedSend = doors({ "email.send": () => ({ ok: false, data: { error: "not verified", status: 409, code: "email_not_verified", body: {} } }) });
      const r = await compare(await record(refusedSend), ON);
      expect(r).toMatchObject({ kind: "refused", same: true });
      expect(r.old.steps.some((s) => s.kind === "ask")).toBe(true);
      expect(r.next.steps.some((s) => s.kind === "ask")).toBe(false);
    });

    it("an upgrade that asks the check where the reply door answers is caught", async () => {
      const broken = NEXT.replace(" && n === 0 && !threads.some(function (t) { return t.replied === true && s(t.campaignId); })", "");
      expect(broken).not.toBe(NEXT);
      const reply = WRITE({ replyTo: "M1" });
      const r = await compareAnswerCheckOnCase(STORED, broken, await record(doors(REPLIED), reply), ON, runScript as never, sameJson, async () => reply);
      expect(r).toMatchObject({ same: false, diff: "the check was asked on a run that answers through the reply door" });
    });

    it("a record the stored code does not replay is unfit, never a pass", async () => {
      const c = await record(doors());
      expect(await compare({ ...c, calls: c.calls.filter((x) => x.name !== "lead.detail") }, ON)).toMatchObject({ kind: "unfit", same: false });
    });
  });
});
