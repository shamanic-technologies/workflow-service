/**
 * SOPHIE-WA-1016 (owner 2026-10-16): a brand owner linked a dedicated assistant WhatsApp number with its own persona
 * ("Sophie, AI assistant"). The signup welcome, the follow-ups and the auto-replies sent from it must be written AS
 * that persona, not as the owner imitating his own voice; the hand-over alert still reaches the sales rep. crm-service
 * states the persona of the account that will send on `POST /orgs/whatsapp/reach`, and refuses with
 * `automation_not_allowed` when the brand lets automation write from no linked account.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRAND_SIDE_RECHECK_DAYS,
  BRAND_SIDE_REFUSAL_CODES,
  COMPOSE_MESSAGE_PROMPT_CODE,
  REACH_VERDICT_CODE,
  RECORD_PLAN_CODE,
  WHATSAPP_OCCURRENCE_SENT_REASON,
  WHATSAPP_REFUSAL_CODES,
  buildColdWhatsappOutreachDag,
} from "../../src/lib/cold-whatsapp-outreach-dag.js";
import {
  CHANNEL_PLAN_CODE,
  COMPOSE_FOLLOW_UP_CODE,
  FOLLOW_UP_WHATSAPP_REFUSAL_CODES,
  buildFollowUpReactiveDag,
} from "../../src/lib/follow-up-dag.js";
import {
  COMPOSE_REPLY_PROMPT_CODE,
  SENDER_REACH_PLAN_CODE,
  buildAiMeetingBookingDag,
  needsSenderPersona,
} from "../../src/lib/ai-meeting-booking-dag.js";
import { followUpArgs, replyArgs } from "../fixtures/sender-persona-args.js";

type Fn = (...args: unknown[]) => Promise<Record<string, any>>;
const loadMain = (code: string): Fn =>
  new Function(code.replace(/^export async function main/m, "async function main") + "\nreturn main;")() as Fn;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

const SOPHIE = { name: "Sophie", role: "AI assistant", instructions: "Warm and brief. Say you are the AI assistant of the team when asked." };
const a = fixture("trigger-right-moment-occurrence.json").args as Record<string, any>;
const composeWhatsapp = (reach: unknown, history: unknown = a.history) =>
  loadMain(COMPOSE_MESSAGE_PROMPT_CODE)(a.person, a.instruction, a.offer, a.brand, a.rep, a.facts, history, a.currentDate, a.occurrence, a.triggerType, a.who, reach);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("no persona on the sending account: every prompt is the one of before, byte for byte", () => {
  it("the WhatsApp welcome / follow-up writer (cold-whatsapp-outreach)", async () => {
    const golden = fixture("sender-persona-golden-cold-whatsapp.json");
    expect(await composeWhatsapp({ skip: false, owed: false })).toEqual(golden);
    expect(await composeWhatsapp({ skip: false, owed: false, persona: null })).toEqual(golden);
    // A persona with no name is none.
    expect(await composeWhatsapp({ skip: false, owed: false, persona: { name: " ", role: "x" } })).toEqual(golden);
  });

  it("the follow-up channel on WhatsApp", async () => {
    const golden = fixture("sender-persona-golden-follow-up.json");
    expect(await loadMain(COMPOSE_FOLLOW_UP_CODE)(...followUpArgs())).toEqual(golden);
    expect(await loadMain(COMPOSE_FOLLOW_UP_CODE)(...followUpArgs({ persona: null }))).toEqual(golden);
  });

  it("the conversation responder answering on WhatsApp", async () => {
    const golden = fixture("sender-persona-golden-reply.json");
    expect(await loadMain(COMPOSE_REPLY_PROMPT_CODE)(...replyArgs())).toEqual(golden);
    expect(await loadMain(COMPOSE_REPLY_PROMPT_CODE)(...replyArgs({ reachable: true, persona: null }))).toEqual(golden);
  });

  it("still fails loud with no owner voice to imitate", async () => {
    await expect(composeWhatsapp({ skip: false }, { ...a.history, voiceLines: [] })).rejects.toThrow(/owner's voice/);
  });
});

describe("a persona on the sending account: the writer speaks as it", () => {
  it("cold-whatsapp-outreach: the reach check's persona reaches the writer, who speaks as Sophie with no owner voice", async () => {
    const verdict = await loadMain(REACH_VERDICT_CODE)({ skip: false, code: null, owed: false }, { reachable: true, to: "+33600000000", fromAccount: "@sophie", persona: SOPHIE });
    expect(verdict.persona).toEqual(SOPHIE);
    const out = await composeWhatsapp(verdict, { ...a.history, voiceLines: [] });
    const system = Object.values(out.variables as Record<string, string>).join("\n");
    expect(system).toContain("You are Sophie, AI assistant at ");
    expect(system).toContain("never say or imply you are a human");
    expect(system).toContain(SOPHIE.instructions);
    expect(system).not.toContain("would type it himself");
    expect(system).not.toMatch(/HOW .* WRITES: learn it from HIS OWN MESSAGES/);
    expect(out.message as string).not.toContain("HIS OWN MESSAGES");
    expect(system + out.message).not.toMatch(/[–—]/);
  });

  it("the follow-up channel: the persona travels on the WhatsApp channel plan and is spoken in the prompt", async () => {
    const plan = await loadMain(CHANNEL_PLAN_CODE)({ brandId: "b", phone: "+15855550123" }, { proceed: true }, { reachable: true, to: "+15855550123", persona: SOPHIE }, { items: [] });
    expect(plan).toMatchObject({ channel: "whatsapp", persona: SOPHIE });
    const out = await loadMain(COMPOSE_FOLLOW_UP_CODE)(...followUpArgs({ persona: plan.persona }));
    expect(out.systemPrompt).toContain("WHO YOU ARE: you are Sophie, AI assistant at Brand");
    expect(out.systemPrompt).toContain(SOPHIE.instructions);
    // Email never speaks as a WhatsApp persona.
    const email = await loadMain(COMPOSE_FOLLOW_UP_CODE)(...followUpArgs({ channel: "email", email: "n@x.com", persona: SOPHIE }));
    expect(email.systemPrompt).not.toContain("Sophie");
  });

  it("the auto-reply with a persona never carries the \"not a bot\" line, and speaks as Sophie", async () => {
    const out = await loadMain(COMPOSE_REPLY_PROMPT_CODE)(...replyArgs({ reachable: true, persona: SOPHIE }));
    const all = (out.systemPrompt as string) + (out.message as string);
    expect(all).not.toContain("You are not a bot");
    expect(all).not.toContain("not a bot");
    expect(out.systemPrompt).toContain("You are Sophie, AI assistant");
    expect(out.message).toContain("Write it as a chat message from you, Sophie");
    expect(out.message).toContain(SOPHIE.instructions);
  });

  it("the auto-reply asks crm-service who sends only on WhatsApp, by the person the send names", async () => {
    const plan = loadMain(SENDER_REACH_PLAN_CODE);
    expect(await plan({ brandId: "b", email: "x@y.com", phone: "+1" }, { replyChannel: "whatsapp" })).toEqual({ skip: false, body: { brandId: "b", email: "x@y.com" } });
    expect(await plan({ brandId: "b", email: null, phone: "+15855550123" }, { replyChannel: "whatsapp" })).toEqual({ skip: false, body: { brandId: "b", phone: "+15855550123" } });
    expect(await plan({ brandId: "b", email: "x@y.com" }, { replyChannel: "email" })).toEqual({ skip: true, body: {} });
    const dag = buildAiMeetingBookingDag({ provider: "anthropic", model: "opus" } as never);
    expect(needsSenderPersona(dag)).toBe(false);
    expect(needsSenderPersona({ ...dag, nodes: dag.nodes.filter((n) => n.id !== "sender-reach") })).toBe(true);
    // The rep alert still goes to the brand's sales rep: unchanged.
    expect(dag.nodes.find((n) => n.id === "alert-rep")).toBeDefined();
  });
});

describe("automation_not_allowed is a brand-side refusal, never a failed run", () => {
  it("is a named refusal of every WhatsApp send, and brand-side", () => {
    expect(WHATSAPP_REFUSAL_CODES).toContain("automation_not_allowed");
    expect(BRAND_SIDE_REFUSAL_CODES).toContain("automation_not_allowed");
    expect(FOLLOW_UP_WHATSAPP_REFUSAL_CODES).toContain("automation_not_allowed");
    const send = buildColdWhatsappOutreachDag().nodes.find((n) => n.id === "send-whatsapp");
    expect((send?.config as { skipOnRefusalCodes: string[] }).skipOnRefusalCodes).toContain("automation_not_allowed");
    const fu = buildFollowUpReactiveDag({ readFigures: false } as never).nodes.find((n) => (n.config as { skipOnRefusalCodes?: string[] })?.skipOnRefusalCodes?.includes("person_replied"));
    expect((fu?.config as { skipOnRefusalCodes: string[] }).skipOnRefusalCodes).toContain("automation_not_allowed");
  });

  it("a follow-up look keeps the person: at the model's date (send refused), or a recheck later (reach refused)", async () => {
    const record = loadMain(RECORD_PLAN_CODE);
    const person = { kind: "followup", rowId: "r", email: "x@y.com" };
    const at = "2026-10-20T10:00:00.000Z";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sendRefused = await record(person, { skipped: true, code: "automation_not_allowed", refusal: "No account allows automation." }, "2026-10-16", { skip: false }, { decision: "write", nextFollowUpAt: at });
    expect(sendRefused).toMatchObject({ action: "record", outcome: "deferred", code: "automation_not_allowed", body: { kind: "scheduled", dueAt: at } });
    expect(sendRefused.delivery).toMatchObject({ state: "refused", code: "automation_not_allowed" });

    const verdict = await loadMain(REACH_VERDICT_CODE)({ skip: false, owed: false }, { reachable: false, code: "automation_not_allowed", error: "No account allows automation." });
    expect(verdict).toMatchObject({ skip: true, code: "automation_not_allowed" });
    const reachRefused = await record(person, { ok: false, skipped: true, notCalled: true }, "2026-10-16", verdict, { skipSend: true });
    expect(reachRefused).toMatchObject({
      action: "record",
      outcome: "deferred",
      body: { kind: "scheduled", dueAt: new Date(Date.parse("2026-10-16T12:00:00.000Z") + BRAND_SIDE_RECHECK_DAYS * 86400000).toISOString() },
    });
  });

  it("an occurrence or a first message ends cleanly with the refusal stated, never handed as sent", async () => {
    const record = loadMain(RECORD_PLAN_CODE);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = { skipped: true, code: "automation_not_allowed", refusal: "No account allows automation." };
    const occ = await record({ kind: "occurrence", rowId: "r", email: "x@y.com" }, refused, "2026-10-16", { skip: false }, { decision: "write" });
    expect(occ).toMatchObject({ action: "record", outcome: "unreachable", body: { kind: "stopped", reason: "whatsapp_automation_not_allowed" } });
    expect(occ.body.reason).not.toBe(WHATSAPP_OCCURRENCE_SENT_REASON);
    expect(occ.delivery).toMatchObject({ state: "refused", code: "automation_not_allowed" });
    const first = await record({ kind: "first", email: "x@y.com" }, refused, "2026-10-16", { skip: false }, { decision: "write", nextFollowUpAt: "2026-10-20T10:00:00.000Z" });
    expect(first).toMatchObject({ action: "none", outcome: "unreachable", code: "automation_not_allowed" });
  });
});
