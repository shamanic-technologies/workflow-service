/**
 * TRIGGER-RIGHT-MOMENT-1016 (owner 2026-10-16: « C'est quoi ce followup pété, alors qu'il ne nous a pas répondu ??? »,
 * « tu prends en compte la timezone du client ????? »). A trigger (Signup Not Paid In 24 Hours) made a WhatsApp due at
 * 08:27 the person's time; the owner had typed six messages to them at 00:07-00:21 their time, unanswered. The writer
 * saw it but was told an occurrence must write. Replayed here from the stored compose input (anonymised fixture).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  COMPOSE_MESSAGE_PROMPT_CODE,
  FINALIZE_MESSAGE_CODE,
  MESSAGE_RESPONSE_SCHEMA,
  REACH_PLAN_CODE,
  REACH_VERDICT_CODE,
  RECORD_PLAN_CODE,
  WHATSAPP_FOLLOW_UP_STOPPED_REASON,
  WHATSAPP_OCCURRENCE_SENT_REASON,
} from "../../src/lib/cold-whatsapp-outreach-dag.js";
import { COMPOSE_FOLLOW_UP_CODE } from "../../src/lib/follow-up-dag.js";
import {
  EMAIL_MEDIUM,
  LOCAL_TIME_FN,
  WHATSAPP_MEDIUM,
  localTimeStrategy,
  nextDateStrategy,
  rightMomentStrategy,
} from "../../src/lib/right-moment.js";

type Fn = (...args: unknown[]) => Promise<Record<string, unknown>>;
const loadMain = (code: string): Fn =>
  new Function(code.replace(/^export async function main/m, "async function main") + "\nreturn main;")() as Fn;
const localTimeLines = new Function(LOCAL_TIME_FN + "\nreturn localTimeLines;")() as (now: string, clues: unknown) => string[];

const fixture = JSON.parse(readFileSync(new URL("../fixtures/trigger-right-moment-occurrence.json", import.meta.url), "utf8")) as {
  args: Record<string, unknown>;
};
const a = fixture.args as Record<string, any>;
const compose = () =>
  loadMain(COMPOSE_MESSAGE_PROMPT_CODE)(
    a.person, a.instruction, a.offer, a.brand, a.rep, a.facts, a.history, a.currentDate, a.occurrence, a.triggerType, a.who, { skip: false, owed: false },
  );
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

describe("a trigger-made WhatsApp judges the right moment and their local time (replay of the 2026-10-16 case)", () => {
  it("the model may answer later, and is given the right-moment game and their local time", async () => {
    expect(MESSAGE_RESPONSE_SCHEMA.properties.decision.enum).toEqual(["write", "later", "stop"]);
    expect(MESSAGE_RESPONSE_SCHEMA.properties.decision.description).not.toMatch(/Only a follow-up look may be later/);

    const out = await compose();
    const system = out.systemPrompt as string;
    const message = out.message as string;
    expect(system).toContain(rightMomentStrategy(WHATSAPP_MEDIUM));
    expect(system).toContain(localTimeStrategy(WHATSAPP_MEDIUM));
    expect(system).toContain(nextDateStrategy(WHATSAPP_MEDIUM));
    expect(system).toContain("If you choose later, nothing is sent, the message stays owed");
    expect(system).not.toContain("Set decision to write and leave nextFollowUpAt");
    // Their local time: no timezone stated, so the clue (a US +1 585 number) is given and UTC is never assumed.
    expect(message).toContain("THEIR LOCAL TIME:\nTheir timezone is not stated. Clues: phone +15855550123");
    // The thread that makes it NOT the right moment is in front of the model: we wrote last, they have not answered.
    expect(message).toContain("THE CONVERSATION STOPPED HERE: OWNER wrote last, 2026-10-16");
    expect(system + message).not.toMatch(/[–—]/);
  });

  it("later sends nothing and keeps the person owed on this campaign's queue at the model's date", async () => {
    const at = inDays(1);
    const fin = await loadMain(FINALIZE_MESSAGE_CODE)(
      { json: { decision: "later", message: "", reason: "We wrote last overnight, they have not answered.", nextFollowUpAt: at, nextFollowUpWhy: "Their afternoon." } },
      a.person, "c-1", { skip: false, owed: false }, { eventId: a.occurrence.eventId, person: a.occurrence.person },
    );
    expect(fin).toMatchObject({ skipSend: true, decision: "later", sendBody: null, nextFollowUpAt: new Date(at).toISOString() });
    const rec = await loadMain(RECORD_PLAN_CODE)(a.person, { notCalled: true }, a.currentDate, { skip: false }, fin);
    // A decision that sends nothing states no delivery; the row is re-scheduled, never handed or dropped.
    expect(rec).toEqual({ action: "record", outcome: "later", body: { kind: "scheduled", dueAt: new Date(at).toISOString() } });

    const stop = await loadMain(FINALIZE_MESSAGE_CODE)({ json: { decision: "stop", message: "", reason: "They asked us to stop." } }, a.person, "c-1", { skip: false }, {});
    expect(await loadMain(RECORD_PLAN_CODE)(a.person, { notCalled: true }, a.currentDate, { skip: false }, stop))
      .toEqual({ action: "record", outcome: "stopped", body: { kind: "stopped", reason: WHATSAPP_FOLLOW_UP_STOPPED_REASON } });
  });

  it("a written occurrence message is still the one message: no next date, the row handed", async () => {
    const trigger = { eventId: a.occurrence.eventId, person: a.occurrence.person };
    const fin = await loadMain(FINALIZE_MESSAGE_CODE)({ json: { decision: "write", message: "Hi Noah", nextFollowUpAt: "" } }, a.person, "c-1", { skip: false }, trigger);
    expect(fin).not.toHaveProperty("nextFollowUpAt");
    expect(fin.idempotencyKey).toBe(`cold-whatsapp-outreach:event:${a.occurrence.eventId}`);
  });
});

describe("the deferred look: a row this campaign never wrote to is still owed", () => {
  const person = { kind: "followup", step: 2, rowId: "row-1", email: "noah@example-health.com", phone: "+15855550123", brandId: "b-1", dueAt: "2026-10-17T17:00:00Z", lead: {} };
  const thread = {
    person: { phones: ["+15855550123"] },
    items: [
      { kind: "message", direction: "inbound", source: "matrix", at: "2026-10-15T22:22:00Z", text: "what will the to and from look like" },
      { kind: "message", direction: "outbound", source: "matrix", at: "2026-10-16T04:21:00Z", text: "The from and cc would be..." },
    ],
  };

  it("is never handed over on their earlier message: the model judges the moment again", async () => {
    const reach = await loadMain(REACH_PLAN_CODE)(person, thread, { sends: [] }, "c-1");
    expect(reach).toMatchObject({ skip: false, owed: true, skipIfReplied: false });
    // A real follow-up (this campaign wrote first, they answered after) is still handed over.
    const followed = await loadMain(REACH_PLAN_CODE)(person, thread, { sends: [{ campaignId: "c-1", status: "sent", sentAt: "2026-10-15T10:00:00Z" }] }, "c-1");
    expect(followed).toMatchObject({ skip: true, code: "person_replied" });
    // crm-service refusing the reach keeps the flag, so the record treats it as the occurrence's message.
    const refused = await loadMain(REACH_VERDICT_CODE)(reach, { reachable: false, code: "not_on_whatsapp" });
    expect(refused).toMatchObject({ skip: true, owed: true });
  });

  it("the prompt says it was deferred, and a written one is the occurrence's one message", async () => {
    const out = await loadMain(COMPOSE_MESSAGE_PROMPT_CODE)(
      { ...a.person, ...person, lead: a.person.lead }, a.instruction, a.offer, a.brand, a.rep, a.facts, a.history, a.currentDate,
      { answering: false, skipTriggerRead: true }, { notCalled: true }, a.who, { skip: false, owed: true },
    );
    expect(out.systemPrompt as string).toContain("this is the ONE message this fact gets");
    expect(out.systemPrompt as string).not.toContain("THIS IS A FOLLOW-UP LOOK");
    expect(out.message as string).toContain("An earlier look judged it was not the right moment");

    const reach = { skip: false, owed: true, skipIfReplied: false };
    const fin = await loadMain(FINALIZE_MESSAGE_CODE)({ json: { decision: "write", message: "Hi Noah" } }, person, "c-1", reach, undefined);
    expect(fin).toMatchObject({ decision: "write", skipSend: false });
    expect(fin).not.toHaveProperty("nextFollowUpAt");
    expect(await loadMain(RECORD_PLAN_CODE)(person, { ok: true }, "2026-10-17", reach, fin))
      .toEqual({ action: "record", outcome: "sent", body: { kind: "handed", reason: WHATSAPP_OCCURRENCE_SENT_REASON }, delivery: { state: "delivered" } });
  });
});

describe("their local time", () => {
  it("a stated timezone gives the exact local time", () => {
    expect(localTimeLines("2026-10-16T12:27:00Z", { timezone: "America/New_York" })).toEqual(["Their local time now: Friday 08:27 (America/New_York)."]);
  });

  it("no timezone: the clues, or 'unknown', never UTC silently", () => {
    expect(localTimeLines("2026-10-16T12:27:00Z", { phone: "+15855550123", city: "Rochester", country: "United States" })[0])
      .toBe("Their timezone is not stated. Clues: phone +15855550123; Rochester, United States. Work out their local time from them (now is 2026-10-16T12:27:00.000Z in UTC).");
    expect(localTimeLines("2026-10-16T12:27:00Z", { timezone: "GMT+1" })[0]).toContain("timezone as stated: GMT+1");
    expect(localTimeLines("2026-10-16T12:27:00Z", {})[0]).toContain("Their timezone is unknown");
    expect(localTimeLines("2026-10-16T12:27:00Z", {})[0]).toContain("never assume UTC");
  });

  it("the follow-up channel (email and WhatsApp, occurrence runs included) gets the same local time", async () => {
    const compose = loadMain(COMPOSE_FOLLOW_UP_CODE);
    const who = { lines: ["x"], threadLines: [], strategy: "WHO" };
    for (const [channel, medium] of [[{ channel: "email", email: "n@x.com", why: "" }, EMAIL_MEDIUM], [{ channel: "whatsapp", phone: "+15855550123", why: "" }, WHATSAPP_MEDIUM]] as const) {
      const out = await compose(
        { timezone: "America/New_York", lead: {} }, channel, { name: "Offer" }, { brand: { name: "Brand" } }, { exact: [] }, {}, { notCalled: true }, "",
        { answering: false, skipTriggerRead: true }, { notCalled: true }, null, "2026-10-16T12:27:00Z", "2026-10-16", who,
      );
      expect(out.systemPrompt as string).toContain(localTimeStrategy(medium));
      expect(out.message as string).toContain("THEIR LOCAL TIME:\nTheir local time now: Friday 08:27 (America/New_York).");
    }
  });
});
