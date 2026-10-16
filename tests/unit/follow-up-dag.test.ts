import { describe, it, expect } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import {
  CHANNEL_PLAN_CODE,
  COMPOSE_FOLLOW_UP_CODE,
  FINALIZE_FOLLOW_UP_CODE,
  FOLLOW_UP_END_KINDS,
  NO_CHANNEL_RECHECK_DAYS,
  OUTCOME_CODE,
  QUEUED_FOLLOW_UP_GAP_DAYS,
  READ_STATE_CODE,
  RESOLVE_CLAIMED_PERSON_CODE,
  RESOLVE_SERVED_PERSON_CODE,
  SET_NEXT_DATE,
  buildFollowUpProactiveDag,
  buildFollowUpReactiveDag,
} from "../../src/lib/follow-up-dag.js";

/**
 * MULTICHANNEL-FOLLOWUP-1016 (owner 2026-10-16): the follow-up channel writes on the best channel of the Unibox
 * (WhatsApp when reachable, else email in their last thread), never when a message is already queued, and every run
 * that reached a person leaves their next follow-up date on lead-service.
 */
function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

const NOW = new Date().toISOString();
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();
const person = (over: Record<string, unknown> = {}) => ({
  ok: true,
  entry: "claimed",
  rowId: "row-1",
  leadId: "lead-1",
  email: "sam@example.com",
  phone: null,
  brandId: "brand-1",
  lead: { firstName: "Sam" },
  timezone: "Europe/Paris",
  sendKey: "follow-up:event:ev-1",
  eventId: "ev-1",
  ...over,
});

const DAGS: Array<[string, DAG]> = [
  ["proactive", buildFollowUpProactiveDag()],
  ["reactive", buildFollowUpReactiveDag({ readFigures: false })],
  ["reactive + figures", buildFollowUpReactiveDag({ readFigures: true })],
];

describe("the DAGs", () => {
  for (const [name, dag] of DAGS) {
    it(`${name}: valid, converts, ONE condition, an end-run per end kind, no trigger-door scheduling`, () => {
      expect(validateDAG(dag).errors).toEqual([]);
      expect(() => dagToOpenFlow(dag, `follow-up-${name}`)).not.toThrow();
      expect(dag.nodes.filter((n) => n.type === "condition").map((n) => n.id)).toEqual(["check-end"]);
      for (const kind of FOLLOW_UP_END_KINDS) {
        const id = `end-run-${kind.replace(/_/g, "-")}`;
        expect(dag.nodes.some((n) => n.id === id)).toBe(true);
        expect(dag.edges).toContainEqual({ from: "check-end", to: id, condition: `results['outcome']?.endKind == '${kind}'` });
      }
      expect(dag.nodes.some((n) => (n.config as { path?: string })?.path === "/internal/trigger-events")).toBe(false);
      // The date lives on lead-service, written after the sends.
      const setDate = dag.nodes.find((n) => n.id === "set-next-date");
      expect(setDate?.config).toMatchObject({ service: "lead", method: SET_NEXT_DATE.method, path: SET_NEXT_DATE.path });
      const order = dag.edges.map((e) => `${e.from}>${e.to}`);
      expect(order).toContain("send-email>outcome");
      expect(order).toContain("outcome>set-next-date");
    });
  }

  it("the proactive DAG ends a no-lead run on a literal stopCampaign (the converter decides exhaustion)", () => {
    const dag = buildFollowUpProactiveDag();
    expect(dag.nodes.find((n) => n.id === "end-run-no-lead")?.config).toMatchObject({ body: { success: true, stopCampaign: true } });
  });

  it("only the figures variant reads figures, and the reactive ones read the occurrence", () => {
    expect(buildFollowUpReactiveDag({ readFigures: true }).nodes.some((n) => n.id === "read-figures")).toBe(true);
    expect(buildFollowUpReactiveDag({ readFigures: false }).nodes.some((n) => n.id === "read-figures")).toBe(false);
    expect(buildFollowUpProactiveDag().nodes.some((n) => n.id === "occurrence")).toBe(false);
  });

  it("the prompt itself carries no em or en dash (the model copies its style)", () => {
    expect(COMPOSE_FOLLOW_UP_CODE).not.toMatch(/[–—]/);
  });
});

describe("who the run is for", () => {
  it("served: a WhatsApp-only lead (phone, no email) is a person; nobody served = no_lead", async () => {
    const main = loadMain(RESOLVE_SERVED_PERSON_CODE);
    const out = await main({ found: true, lead: { leadCampaignId: "row-9", leadId: "l-9", email: null, phone: "+33 6 12 34 56 78", brandIds: ["b"] } }, "camp", "run-1");
    expect(out).toMatchObject({ ok: true, email: null, phone: "+33612345678", rowId: "row-9", sendKey: "follow-up:camp:row-9:run-1" });
    expect(await main({ found: false }, "camp", "run-1")).toMatchObject({ ok: false, endKind: "no_lead" });
  });

  it("claimed: keyed on the occurrence when it names them (email, phone, or leadId); someone else = other_person", async () => {
    const main = loadMain(RESOLVE_CLAIMED_PERSON_CODE);
    const claim = { found: true, followup: { id: "row-1", leadId: "lead-1", email: "Sam@Example.com", brandId: "b", dueAt: "2026-10-16T10:00:00Z" } };
    const detail = { leadDetail: { lead: { timezone: "UTC" } } };
    expect(await main(claim, detail, { eventId: "ev-1", person: { email: "sam@example.com" } })).toMatchObject({ ok: true, sendKey: "follow-up:event:ev-1" });
    expect(await main(claim, detail, { eventId: "ev-2", leadId: "lead-1" })).toMatchObject({ ok: true, sendKey: "follow-up:event:ev-2" });
    expect(await main(claim, detail, { eventId: "ev-3", person: { email: "other@example.com" } })).toMatchObject({ ok: false, endKind: "other_person" });
    expect(await main(claim, detail, { eventId: "ev-4", leadId: "lead-2" })).toMatchObject({ ok: false, endKind: "other_person" });
    expect(await main(claim, detail, null)).toMatchObject({ ok: true, sendKey: "follow-up:row-1:2026-10-16T10:00:00Z" });
    const phoneOnly = { found: true, followup: { id: "row-2", email: null, phone: "+44 7700 900123", brandId: "b" } };
    expect(await main(phoneOnly, detail, { eventId: "ev-5", person: { phone: "+447700900123" } })).toMatchObject({ ok: true, email: null, phone: "+447700900123", sendKey: "follow-up:event:ev-5" });
    expect(await main({ found: false }, null, null)).toMatchObject({ ok: false, endKind: "idle" });
    expect(await main({ found: false }, null, { eventId: "ev-6" })).toMatchObject({ ok: false, endKind: "unclaimed" });
  });
});

describe("lead-service's follow-up state", () => {
  const main = loadMain(READ_STATE_CODE);
  const answer = (owed: Record<string, unknown>, queued: Record<string, unknown> = {}) => ({
    followupDate: { nextFollowupAt: NOW, basis: "default" },
    queued: { any: false, emailSequence: false, followups: [], inDueStock: false, ...queued },
    owed: { owed: owed.kind === "owed", retryAfter: null, reason: null, reasons: [], relationshipTags: [], ...owed },
  });
  it("owed: the writer runs (its own claimed row is not a queued message)", async () => {
    const own = { leadCampaignId: "row-1", campaignId: "c", dueAt: NOW, claimedAt: NOW };
    expect(await main(person(), answer({ kind: "owed" }, { any: true, followups: [own] }), NOW)).toMatchObject({ proceed: true });
  });
  it("stop: nothing written, no date", async () => {
    expect(await main(person(), answer({ kind: "stop", reason: "customer", reasons: ["customer"] }), NOW)).toMatchObject({ proceed: false, kind: "stop" });
  });
  it("not yet: nothing written, the date moves to retryAfter (never in the past)", async () => {
    const out = await main(person(), answer({ kind: "not_yet", reason: "relationship_not_judged", reasons: ["relationship_not_judged"], retryAfter: inDays(2) }), NOW);
    expect(out).toMatchObject({ proceed: false, kind: "not_yet" });
    expect(Date.parse(out.nextFollowUpAt)).toBeGreaterThan(Date.now() + 86400000);
  });
  it("a follow-up queued by another campaign: nothing written, no model, the date moves past it", async () => {
    const at = inDays(1);
    const other = { leadCampaignId: "row-other", campaignId: "c2", dueAt: at, claimedAt: null };
    const out = await main(person(), answer({ kind: "owed" }, { any: true, followups: [other] }), NOW);
    expect(out).toMatchObject({ proceed: false, kind: "queued" });
    expect(Date.parse(out.nextFollowUpAt)).toBe(Date.parse(at) + QUEUED_FOLLOW_UP_GAP_DAYS * 86400000);
  });
  it("a queued email sequence step: nothing written, lead-service's later date kept", async () => {
    const later = inDays(20);
    const a = answer({ kind: "owed" }, { any: true, emailSequence: true });
    a.followupDate.nextFollowupAt = later;
    expect(await main(person(), a, NOW)).toMatchObject({ proceed: false, kind: "queued", nextFollowUpAt: later });
  });
  it("a lead event is answered through engagement (a positive reply, a live conversation), never through an owner stop", async () => {
    const replied = answer({ kind: "stop", reason: "positive_reply", reasons: ["positive_reply", "in_conversation"] });
    expect(await main(person(), replied, NOW)).toMatchObject({ proceed: true });
    expect(await main(person({ entry: "served" }), replied, NOW)).toMatchObject({ proceed: false, kind: "stop" });
    const optedOut = answer({ kind: "stop", reason: "opted_out", reasons: ["opted_out", "positive_reply"] });
    expect(await main(person(), optedOut, NOW)).toMatchObject({ proceed: false, kind: "stop", reason: "opted_out" });
    const unresolved = answer({ kind: "stop", reason: "meeting_booked", reasons: ["meeting_booked", "identity_unresolved"] });
    expect(await main(person(), unresolved, NOW)).toMatchObject({ proceed: false, kind: "not_yet", reason: "identity_unresolved" });
    const sequence = answer({ kind: "not_yet", reason: "in_conversation", reasons: ["in_conversation", "sequence_running"], retryAfter: inDays(2) });
    expect(await main(person(), sequence, NOW)).toMatchObject({ proceed: false, kind: "queued" });
  });
  it("an answer with no kind fails loud", async () => {
    await expect(main(person(), {}, NOW)).rejects.toThrow(/no follow-up kind/);
  });
});

describe("the channel is chosen before the model, never by it", () => {
  const main = loadMain(CHANNEL_PLAN_CODE);
  const plan = { proceed: true };
  const timeline = (channel: string) => ({ person: { emails: ["sam@example.com"] }, items: [{ kind: "message", direction: "inbound", channel, source: "matrix", text: "hi" }] });
  it("WhatsApp when the brand's WhatsApp reaches them, even when they last wrote by email", async () => {
    const out = await main(person(), plan, { reachable: true, to: "+33612345678", fromAccount: "+33100000000", phoneSource: "crm:matrix" }, timeline("email"));
    expect(out).toMatchObject({ channel: "whatsapp", phone: "+33612345678", fromAccount: "+33100000000", skipModel: false });
  });
  it("email when WhatsApp cannot reach them and an address is known (the thread's own counts)", async () => {
    const out = await main(person({ email: null, phone: "+33612345678" }), plan, { reachable: false, code: "not_on_whatsapp", error: "x" }, timeline("linkedin"));
    expect(out).toMatchObject({ channel: "email", email: "sam@example.com", skipModel: false });
    expect(out.why).toContain("linkedin");
  });
  it("no route: nothing drafted", async () => {
    const out = await main(person({ email: null, phone: "+33612345678" }), plan, { reachable: false, code: "not_on_whatsapp", error: "x" }, { person: { emails: [] }, items: [] });
    expect(out).toMatchObject({ channel: null, skipModel: true, noChannel: true });
  });
  it("an unanswered reach check fails loud", async () => {
    await expect(main(person(), plan, { ok: false, status: 500 }, timeline("email"))).rejects.toThrow(/reach check/);
  });
});

describe("finalize holds the model to its contract before the send", () => {
  const main = loadMain(FINALIZE_FOLLOW_UP_CODE);
  const wa = { channel: "whatsapp", skipModel: false, email: null, phone: "+33612345678", fromAccount: "+331" };
  const em = { channel: "email", skipModel: false, email: "sam@example.com", phone: null };
  const draft = (json: Record<string, unknown>) => ({ json: { subject: "", bodyHtml: "", message: "", nextFollowUpAt: inDays(3), nextFollowUpWhy: "w", reason: "r", ...json } });
  it("WhatsApp: plain text, dashes rewritten, never a null field in the body, email skipped", async () => {
    const out = await main(draft({ decision: "write", message: "Hi Sam — the price is 10–20 a seat." }), person({ email: null, phone: "+33612345678" }), wa);
    expect(out).toMatchObject({ decision: "write", channel: "whatsapp", skipWhatsapp: false, skipEmail: true });
    expect(out.whatsappBody).toEqual({ brandId: "brand-1", text: "Hi Sam, the price is 10-20 a seat.", idempotencyKey: "follow-up:event:ev-1", phone: "+33612345678", fromAccount: "+331" });
  });
  it("email: subject + body, WhatsApp skipped", async () => {
    const out = await main(draft({ decision: "write", subject: "Your price", bodyHtml: "<p>Here it is.</p>" }), person(), em);
    expect(out).toMatchObject({ decision: "write", channel: "email", to: "sam@example.com", skipEmail: false, skipWhatsapp: true, idempotencyKey: "follow-up:event:ev-1" });
  });
  it("later keeps the model's date and sends nothing; a past date throws before any send", async () => {
    expect(await main(draft({ decision: "later" }), person(), em)).toMatchObject({ decision: "later", skipEmail: true, skipWhatsapp: true });
    await expect(main(draft({ decision: "write", message: "x", nextFollowUpAt: "2020-01-01T00:00:00Z" }), person(), wa)).rejects.toThrow(/not in the future/);
  });
  it("an empty write throws", async () => {
    await expect(main(draft({ decision: "write" }), person(), wa)).rejects.toThrow(/empty message/);
  });
});

describe("every run that reached a person leaves a next date, except a stop", () => {
  const main = loadMain(OUTCOME_CODE);
  const plan = { proceed: true, kind: "owed" };
  const em = { channel: "email", skipModel: false };
  const AT = inDays(4);
  const write = (channel: string) => ({ decision: "write", channel, nextFollowUpAt: AT, nextFollowUpWhy: "waits for a price" });
  const notCalled = { ok: false, skipped: true, notCalled: true };

  it("sent: delivered, date set, queue row closed", async () => {
    const out = await main(person(), plan, em, write("email"), notCalled, { success: true }, NOW);
    expect(out).toMatchObject({ endKind: "sent", skipSetDate: false, skipStop: true, skipRow: false, delivery: { state: "delivered" } });
    expect(out.setDateBody).toEqual({ nextFollowupAt: AT, reason: "waits for a price", sent: { channel: "email" } });
  });
  it("later, queued, not yet, no channel: a date each", async () => {
    expect((await main(person(), plan, em, { decision: "later", nextFollowUpAt: inDays(2), nextFollowUpWhy: "w" }, notCalled, notCalled, NOW)).skipSetDate).toBe(false);
    expect(await main(person(), { proceed: false, kind: "queued", nextFollowUpAt: inDays(5), nextFollowUpWhy: "q" }, null, null, notCalled, notCalled, NOW)).toMatchObject({ endKind: "queued", skipSetDate: false });
    expect(await main(person(), { proceed: false, kind: "not_yet", nextFollowUpAt: inDays(1), nextFollowUpWhy: "n" }, null, null, notCalled, notCalled, NOW)).toMatchObject({ endKind: "not_yet", skipSetDate: false });
    const none = await main(person(), plan, { skipModel: true, noChannel: true, why: "no route" }, { decision: "none" }, notCalled, notCalled, NOW);
    expect(none).toMatchObject({ endKind: "no_channel", skipSetDate: false });
    expect(Date.parse(none.setDateBody.nextFollowupAt)).toBeCloseTo(Date.now() + NO_CHANNEL_RECHECK_DAYS * 86400000, -5);
  });
  it("a stop (their words, or a final email refusal) ends the chain on lead-service, no date", async () => {
    const stopped = await main(person(), plan, em, { decision: "stop", reason: "please stop" }, notCalled, notCalled, NOW);
    expect(stopped).toMatchObject({ endKind: "stopped", skipSetDate: true, skipStop: false });
    expect(stopped.stopBody).toEqual({ stop: { reason: "Their own words: please stop" } });
    const refused = { ok: false, skipped: true, code: "lead_opted_out", reason: "opted out" };
    expect(await main(person(), plan, em, write("email"), notCalled, refused, NOW)).toMatchObject({ endKind: "refused_final", skipStop: false, skipSetDate: true });
  });
  it("a passing email refusal or any WhatsApp refusal keeps the person at the model's date", async () => {
    const passing = { ok: false, skipped: true, code: "recent_brand_contact", reason: "x" };
    expect(await main(person(), plan, em, write("email"), notCalled, passing, NOW)).toMatchObject({ endKind: "refused_kept", skipSetDate: false });
    const waRefused = { ok: false, skipped: true, code: "not_on_whatsapp", reason: "x" };
    expect(await main(person(), plan, { channel: "whatsapp" }, write("whatsapp"), waRefused, notCalled, NOW)).toMatchObject({ endKind: "refused_kept", skipSetDate: false });
  });
  it("lead-service's stop writes nothing; a served person has no queue row", async () => {
    expect(await main(person(), { proceed: false, kind: "stop" }, null, null, notCalled, notCalled, NOW)).toMatchObject({ endKind: "not_owed", skipSetDate: true, skipStop: true });
    expect((await main(person({ entry: "served" }), plan, em, write("email"), notCalled, { success: true }, NOW)).skipRow).toBe(true);
  });
  it("nobody: the person's own end kind, nothing written", async () => {
    expect(await main({ ok: false, endKind: "idle" }, null, null, null, notCalled, notCalled, NOW)).toMatchObject({ endKind: "idle", skipSetDate: true, skipStop: true, skipRow: true });
  });
});
