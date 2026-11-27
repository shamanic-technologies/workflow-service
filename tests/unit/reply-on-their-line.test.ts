import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readMaterials, validateSource } from "../../src/lib/scripts/sandbox.js";
import { SCRIPT_VENDORS, TO_PERSON_DOORS, writesToPerson } from "../../src/lib/scripts/vendors.js";
import {
  CONVERSATION_REACH_DOOR,
  CONVERSATION_SEND_DOOR,
  LOOK_AGAIN_DAYS,
  REPLY_ON_THEIR_LINE_ANCHORS,
  WAITS_ON_THEIR_LINE_REASON,
  addChatAppToWriter,
  addReplyOnTheirLine,
  plansEmail,
} from "../../src/lib/scripts/reply-on-their-line.js";

// LEAD-REPLY-CHANNEL-1127: the four live senders built on the follow-up channel plan (and the three writer halves), byte
// for byte as production stored them on 2026-11-27, upgraded to answer a waiting message in the conversation it came
// in, or not at all. Proven on each dynasty's recorded cases by scripts/prove-reply-on-their-line.mjs.
const read = (dir: string) => Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
const SENDERS = read(join(__dirname, "../fixtures/stored-scripts/reply-on-their-line"));
const WRITERS = read(join(__dirname, "../fixtures/stored-scripts/reply-on-their-line-writers"));

/** The upgraded code's plain-JS steps, evaluated as the sandbox would: helpers + channel plan + outcome. */
function stepsOf(code: string) {
  const piece = (from: string, name: string) => {
    const a = code.indexOf(from);
    const b = code.indexOf("\n})();\n", a);
    if (a < 0 || b < 0) throw new Error("no " + name);
    return code.slice(a, b + "\n})();\n".length);
  };
  const helpersAt = code.indexOf("// LEAD-REPLY-CHANNEL-1127: the thread");
  const helpers = helpersAt < 0 ? "function threadCounts() {} function conversationSendBody() {}\n" : code.slice(helpersAt, code.indexOf(REPLY_ON_THEIR_LINE_ANCHORS.planStep));
  const src =
    helpers +
    piece(REPLY_ON_THEIR_LINE_ANCHORS.planStep, "channel plan") +
    piece("const step_outcome = (function () {", "outcome") +
    "return { threadCounts, conversationSendBody, step_channel_plan, step_outcome };";
  return new Function(src)() as {
    threadCounts: (h: unknown, t: unknown) => any;
    conversationSendBody: (w: unknown, p: unknown) => any;
    step_channel_plan: (p: unknown, s: unknown, r: unknown, t: unknown, c?: unknown) => any;
    step_outcome: (...a: unknown[]) => any;
  };
}

const person = { ok: true, entry: "claimed", email: "lead@example.com", phone: "+16475550100", brandId: "b1", rowId: "r1" };
const plan = { proceed: true, kind: "owed" };
const NOW = "2026-11-26T22:36:00.000Z";
const msg = (at: string, direction: "inbound" | "outbound", channel: string, extra: Record<string, unknown> = {}) => ({
  at, kind: "message", source: channel === "email" ? "gmail" : "matrix", channel, direction, text: "hello " + at, from: null, to: [], ref: {}, ...extra,
});
const tg = { conversationId: "c-telegram" };
const wa = { conversationId: "c-whatsapp" };
const reachable = { reachable: true, to: "+16475550100", fromAccount: "+33600000002", persona: { name: "Sophie", role: "AI assistant" } };
const notCalled = { ok: false, skipped: true, notCalled: true };
const sepehrThread = {
  items: [
    ...Array.from({ length: 9 }, (_, i) => msg(`2026-11-03T10:0${i}:00Z`, "outbound", "telegram", { ref: tg })),
    msg("2026-11-03T11:00:00Z", "inbound", "telegram", { ref: tg }),
    { at: "2026-11-26T22:30:00Z", kind: "event", source: "posthog", channel: "web", direction: null, text: "visited" },
  ],
};
const personalRefusal = {
  reachable: false,
  code: "automation_not_allowed",
  error: "The conversation is on the brand's Telegram account +33600000001, a personal line: automated messages never go out from it.",
  conversation: { conversationId: "c-telegram", channel: "telegram" },
  fromAccount: { account: "+33600000001", accountType: "personal_human", persona: null },
};

describe.each(Object.keys(SENDERS))("addReplyOnTheirLine on %s", (name) => {
  const stored = SENDERS[name]!;
  const next = addReplyOnTheirLine(stored);
  const s = stepsOf(next);
  const old = stepsOf(stored);
  const emails = plansEmail(stored);

  it("keeps every stored line but the edited ones (the edit only adds)", () => {
    const A = REPLY_ON_THEIR_LINE_ANCHORS;
    const edited = [A.planMain, A.planCall, A.sendWhatsapp].map((l) => l.trimEnd());
    const lines = new Set(next.split("\n"));
    for (const l of stored.split("\n")) {
      if (edited.some((e) => l.startsWith(e)) || l.includes("THE CHANNEL is WhatsApp: the message continues")) continue;
      expect(lines.has(l), l).toBe(true);
    }
  });

  it("is a valid source on doors the catalogue allows, reading the same materials, and refuses a second edit", async () => {
    await expect(validateSource(next)).resolves.toBeDefined();
    expect(readMaterials(next)).toEqual(readMaterials(stored));
    for (const d of [CONVERSATION_REACH_DOOR, CONVERSATION_SEND_DOOR]) expect((SCRIPT_VENDORS as readonly string[]).includes(d)).toBe(true);
    expect(TO_PERSON_DOORS[CONVERSATION_SEND_DOOR]).toBeDefined();
    expect(writesToPerson(next)).toBe(true);
    expect(() => addReplyOnTheirLine(next)).toThrow(/already/);
  });

  it("asks the conversation reach before the plan, and sends into the conversation when the plan names one", () => {
    const reachAt = next.indexOf(`"${CONVERSATION_REACH_DOOR}"`);
    const planAt = next.indexOf("  results.channel_plan = step_channel_plan(");
    expect(reachAt).toBeGreaterThan(0);
    expect(planAt).toBeGreaterThan(reachAt);
    expect(next).toContain("(results.person_thread), (results.conversation_reach));");
    expect(next).toMatch(/results\.send_whatsapp = results\.channel_plan\?\.conversationId\n\s+\? callStep\(ctx, "crm\.conversation\.send"/);
  });

  it("AC2: their Telegram message to a personal account waits on us = nothing on any other app, crm's why said, next date set", () => {
    const c = s.step_channel_plan(person, plan, reachable, sepehrThread, personalRefusal);
    expect(c).toMatchObject({ channel: null, skipModel: true, heldOnTheirLine: true, waitingOn: "telegram" });
    expect(c.why).toMatch(/automation_not_allowed/);
    expect(c.why).toMatch(/personal line/);
    expect(c.why).toMatch(/never moved to another app or line/);
    const o = s.step_outcome(person, plan, c, null, null, null, NOW);
    expect(o.endKind).toBe("later");
    expect(o.delivery).toBeNull();
    expect(o.skipSetDate).toBe(false);
    expect(o.setDateBody.nextFollowupAt).toBe(new Date(Date.parse(NOW) + LOOK_AGAIN_DAYS * 86400000).toISOString());
    expect(o.setDateBody.reason).toMatch(/telegram/i);
    expect(o.rowBody).toEqual({ kind: "stopped", reason: WAITS_ON_THEIR_LINE_REASON });
    // Before: the brand's WhatsApp reached him, so the answer went out on WhatsApp from the AI line.
    expect(old.step_channel_plan(person, plan, reachable, sepehrThread)).toMatchObject({ channel: "whatsapp", fromAccount: "+33600000002" });
  });

  it("AC1: their message in a conversation automation may write in = the answer goes into THAT conversation, from ITS account", () => {
    const t = { items: [msg("2026-11-20T10:00:00Z", "outbound", "telegram", { ref: tg }), msg("2026-11-21T10:00:00Z", "inbound", "telegram", { ref: tg })] };
    const conv = { reachable: true, conversation: { conversationId: "c-telegram", channel: "telegram", phone: null }, fromAccount: { account: "+33600000009", accountType: "pro_ai", persona: { name: "Sophie", role: "AI assistant", instructions: null } } };
    const c = s.step_channel_plan(person, plan, reachable, t, conv);
    expect(c).toMatchObject({ channel: "whatsapp", skipModel: false, conversationId: "c-telegram", fromAccount: "+33600000009", app: "Telegram", persona: { name: "Sophie" } });
    const body = s.conversationSendBody({ brandId: "b1", messages: ["Hi", "Sure"], idempotencyKey: "k1", fromAccount: "+33600000002", phone: "+1", email: "x@y.z", replyToEventId: "$e" }, c);
    expect(body).toEqual({ brandId: "b1", conversationId: "c-telegram", idempotencyKey: "k1", messages: ["Hi", "Sure"], replyToEventId: "$e" });
  });

  it("AC1 on WhatsApp: a message to the AI line is answered from that line; a WhatsApp app is never relabelled", () => {
    const t = { items: [msg("2026-11-21T10:00:00Z", "inbound", "whatsapp", { ref: wa })] };
    const conv = { reachable: true, conversation: { conversationId: "c-whatsapp", channel: "whatsapp", phone: "+16475550100" }, fromAccount: { account: "+33600000002", accountType: "pro_ai", persona: null } };
    const c = s.step_channel_plan(person, plan, reachable, t, conv);
    expect(c).toMatchObject({ channel: "whatsapp", conversationId: "c-whatsapp", fromAccount: "+33600000002", phone: "+16475550100" });
    expect(c.app).toBeUndefined();
  });

  it("AC2 on WhatsApp: a message to a personal or human line = nothing from the AI line", () => {
    const t = { items: [msg("2026-11-21T10:00:00Z", "inbound", "whatsapp", { ref: wa })] };
    const c = s.step_channel_plan(person, plan, reachable, t, { reachable: false, code: "human_in_conversation", error: "typed by hand", conversation: null, fromAccount: null });
    expect(c).toMatchObject({ channel: null, heldOnTheirLine: true });
  });

  it("a conversation reach that did not answer fails loud; the brand's statement still wins", () => {
    const t = { items: [msg("2026-11-21T10:00:00Z", "inbound", "telegram", { ref: tg })] };
    expect(() => s.step_channel_plan(person, plan, reachable, t, notCalled)).toThrow(/did not answer/);
    expect(s.step_channel_plan(person, plan, reachable, t, { reachable: false, code: "stated_not_to_brand", error: "x" })).toMatchObject({ notToBrand: true });
  });

  it("their email waiting on us continues that email thread when the sender emails, never moved to WhatsApp", () => {
    const t = { items: [msg("2026-11-20T10:00:00Z", "outbound", "whatsapp", { ref: wa }), msg("2026-11-21T10:00:00Z", "inbound", "email", { from: "Lead <Lead@Example.com>" })] };
    const c = s.step_channel_plan(person, plan, reachable, t, notCalled);
    if (emails) expect(c).toMatchObject({ channel: "email", skipModel: false, email: "lead@example.com" });
    else expect(c).toMatchObject({ channel: null, heldOnTheirLine: true, waitingOn: "email" });
  });

  it("a message waiting with no conversation to answer in (a Copilot chat, an unknown source) gets nothing elsewhere", () => {
    const t = { items: [{ ...msg("2026-11-21T10:00:00Z", "inbound", "chat"), source: "copilot" }] };
    expect(s.step_channel_plan(person, plan, reachable, t, notCalled)).toMatchObject({ channel: null, heldOnTheirLine: true, waitingOn: "chat" });
  });

  it("nothing of theirs waits on us (our message is last, or no message): the stored choice, byte for byte", () => {
    const answered = { items: [msg("2026-11-03T11:00:00Z", "inbound", "telegram", { ref: tg }), msg("2026-11-04T09:00:00Z", "outbound", "email")] };
    for (const t of [answered, { items: [] }, { ok: false, status: 404 }]) {
      for (const r of [reachable, { reachable: false, code: "not_on_whatsapp", error: "x" }]) {
        expect(s.step_channel_plan(person, plan, r, t, notCalled)).toEqual(old.step_channel_plan(person, plan, r, t));
      }
    }
  });

  it("the writer's counts are read off the thread it reads", () => {
    const h = s.threadCounts({ lines: [], omitted: 0, ourMessages: 0, lastOursAt: null, lastTheirsAt: null, unreadable: [] }, sepehrThread);
    expect(h).toMatchObject({ ourMessages: 9, lastOursAt: "2026-11-03T10:08:00Z", lastTheirsAt: "2026-11-03T11:00:00Z" });
    const unread = { lines: [], ourMessages: 2, lastOursAt: "x", lastTheirsAt: null };
    expect(s.threadCounts(unread, { ok: false, status: 404 })).toBe(unread);
  });
});

describe.each(Object.keys(WRITERS))("addChatAppToWriter on %s", (name) => {
  const stored = WRITERS[name]!;
  const next = addChatAppToWriter(stored);
  it("names the conversation's app, and reads byte for byte when the plan names none (WhatsApp)", async () => {
    await expect(validateSource(next)).resolves.toBeDefined();
    expect(readMaterials(next)).toEqual(readMaterials(stored));
    const line = (code: string, channel: Record<string, unknown>) => {
      const a = code.indexOf('"THE CHANNEL is ');
      const b = code.indexOf("in the language", a);
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return new Function("channel", "return " + code.slice(a, b) + 'in the language"')(channel);
    };
    expect(line(next, {})).toBe(line(stored, {}));
    expect(line(next, { app: "Telegram" })).toBe("THE CHANNEL is Telegram: the message continues our Telegram conversation with them, from the same account, in the language");
    expect(() => addChatAppToWriter(next)).toThrow();
  });
});

it("refuses a code whose anchor moved", () => {
  expect(() => addReplyOnTheirLine("export default function run() {}")).toThrow(/channel plan/);
});
