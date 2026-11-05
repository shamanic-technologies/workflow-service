import { describe, it, expect, vi } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { STATED_NOT_TO_BRAND_CODE } from "../../src/lib/stated-not-to-brand.js";
import {
  CHANNEL_UNREACHABLE_CODES,
  RECORD_PLAN_CODE,
  WHATSAPP_REFUSAL_CODES,
  buildColdWhatsappOutreachDag,
} from "../../src/lib/cold-whatsapp-outreach-dag.js";
import {
  CHANNEL_PLAN_CODE,
  FOLLOW_UP_END_KINDS,
  FOLLOW_UP_WHATSAPP_REFUSAL_CODES,
  NO_CHANNEL_RECHECK_DAYS,
  OUTCOME_CODE as FOLLOW_UP_OUTCOME_CODE,
  buildFollowUpReactiveDag,
} from "../../src/lib/follow-up-dag.js";
import { WHATSAPP_ONLY_CHANNEL_PLAN_CODE, buildClientSatisfiedDag } from "../../src/lib/client-satisfied-dag.js";
import { buildClientCheckInDag } from "../../src/lib/client-check-in-dag.js";
import { buildBrandTeamDag } from "../../src/lib/brand-team-dag.js";
import { FOUNDER_HELLO_REFUSAL_CODES, OUTCOME_CODE as FOUNDER_OUTCOME_CODE, buildFounderHelloDag } from "../../src/lib/founder-hello-dag.js";

/**
 * DUALIST-WA-SILENCE-1104: crm-service refuses a WhatsApp send / reach `stated_not_to_brand` for a person the brand
 * stated is not someone of theirs. Every WhatsApp-sending workflow ends that person's step as a quiet skip: nothing
 * sent on any channel, no retry, no recheck as brand-side, no failed step, no unsent-answer delivery.
 */

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

const NOW = new Date().toISOString();
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();
const CODE = STATED_NOT_TO_BRAND_CODE;
const refusedSend = (code: string) => ({ ok: false, skipped: true, code, reason: "x" });
const notCalled = { ok: false, skipped: true, notCalled: true };
const sendNode = (dag: DAG, id: string) => dag.nodes.find((n) => n.id === id);

describe("the code", () => {
  it("is crm-service's literal", () => {
    expect(CODE).toBe("stated_not_to_brand");
  });
});

describe("cold WhatsApp outreach", () => {
  const record = loadMain(RECORD_PLAN_CODE);
  const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});

  it("the send reads the refusal instead of failing", () => {
    expect(WHATSAPP_REFUSAL_CODES).toContain(CODE);
    expect(sendNode(buildColdWhatsappOutreachDag(), "send-whatsapp")?.config?.skipOnRefusalCodes).toContain(CODE);
  });
  it("a first message is never released to another pipe (no email instead)", async () => {
    const spy = quiet();
    expect(CHANNEL_UNREACHABLE_CODES).not.toContain(CODE);
    const out = await record({ kind: "first", email: "a@x.com" }, refusedSend(CODE), "x");
    expect(out.action).toBe("none");
    spy.mockRestore();
  });
  it("a person a fact made due is not admitted: no delivery, row stopped, occurrence final", async () => {
    const spy = quiet();
    for (const p of [{ kind: "occurrence", rowId: "r" }, { kind: "followup", rowId: "r" }]) {
      const reach = p.kind === "followup" ? { skip: false, owed: true } : { skip: false };
      const out = await record(p, refusedSend(CODE), "x", reach, { decision: "write" });
      expect(out).toEqual({ action: "record", outcome: "not_admitted", code: CODE, notAdmitted: { reason: CODE }, body: { kind: "stopped", reason: `whatsapp_${CODE}` } });
      expect(out.delivery).toBeUndefined();
    }
    // Refused at the reach check, before any draft: the same.
    const early = await record({ kind: "occurrence", rowId: "r" }, notCalled, "x", { skip: true, code: CODE, reason: "stated" });
    expect(early).toMatchObject({ outcome: "not_admitted", notAdmitted: { reason: CODE } });
    spy.mockRestore();
  });
  it("a follow-up look hands them over, never a brand-side recheck", async () => {
    const spy = quiet();
    const out = await record({ kind: "followup", rowId: "r" }, refusedSend(CODE), "x", { skip: false }, { decision: "write", nextFollowUpAt: inDays(3) });
    expect(out).toMatchObject({ action: "record", body: { kind: "handed", reason: `whatsapp_${CODE}` } });
    spy.mockRestore();
  });
  it("every other refusal code behaves as before", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const occ = await record({ kind: "occurrence", rowId: "r" }, refusedSend("not_on_whatsapp"), "x", { skip: false });
    expect(occ).toMatchObject({ action: "record", outcome: "unreachable", body: { kind: "stopped", reason: "whatsapp_not_on_whatsapp" }, delivery: { state: "refused" } });
    const human = await record({ kind: "followup", rowId: "r" }, refusedSend("human_in_conversation"), "x", { skip: false }, { decision: "write", nextFollowUpAt: inDays(3) });
    expect(human).toMatchObject({ body: { kind: "handed", reason: "whatsapp_human_in_conversation" } });
    spy.mockRestore();
  });
});

describe("the follow-up channel (and every DAG built on it)", () => {
  const person = (over: Record<string, unknown> = {}) => ({ ok: true, entry: "claimed", rowId: "row-1", leadId: "lead-1", email: "sam@example.com", phone: "+33612345678", brandId: "b", ...over });
  const plan = { proceed: true, kind: "owed" };
  const timeline = { person: { emails: ["sam@example.com"] }, items: [] };
  const silent = () => vi.spyOn(console, "log").mockImplementation(() => {});

  it("the channel plan never falls back to email for them", async () => {
    const spy = silent();
    for (const code of [CHANNEL_PLAN_CODE, WHATSAPP_ONLY_CHANNEL_PLAN_CODE]) {
      const out = await loadMain(code)(person(), plan, { reachable: false, code: CODE, error: "stated" }, timeline);
      expect(out).toMatchObject({ channel: null, skipModel: true, notToBrand: true });
    }
    spy.mockRestore();
    // Another code still falls back to email.
    const email = await loadMain(CHANNEL_PLAN_CODE)(person(), plan, { reachable: false, code: "not_on_whatsapp" }, timeline);
    expect(email).toMatchObject({ channel: "email" });
  });

  it("the outcome: nothing sent, no delivery, a later look, a claimed occurrence not admitted", async () => {
    const outcome = loadMain(FOLLOW_UP_OUTCOME_CODE);
    const out = await outcome(person(), plan, { channel: null, skipModel: true, notToBrand: true }, { decision: undefined }, notCalled, notCalled, NOW);
    expect(out).toMatchObject({ endKind: "not_to_brand", skipRow: false, rowBody: { kind: "stopped", reason: "follow_up_stated_not_to_brand" }, skipSetDate: false, skipStop: true, delivery: null, notAdmitted: { reason: CODE } });
    expect(Date.parse(out.setDateBody.nextFollowupAt)).toBeCloseTo(Date.now() + NO_CHANNEL_RECHECK_DAYS * 86400000, -5);
    // A served person (no occurrence): no notAdmitted key at all (campaign-service refuses a null).
    const served = await outcome(person({ entry: "served" }), plan, { notToBrand: true }, null, notCalled, notCalled, NOW);
    expect(served.endKind).toBe("not_to_brand");
    expect("notAdmitted" in served).toBe(false);
  });

  it("a WhatsApp send refused for it (after the reach check) ends the same way; other WhatsApp refusals are kept as before", async () => {
    const outcome = loadMain(FOLLOW_UP_OUTCOME_CODE);
    const write = { decision: "write", channel: "whatsapp", nextFollowUpAt: inDays(4), nextFollowUpWhy: "w" };
    const out = await outcome(person(), plan, { channel: "whatsapp" }, write, refusedSend(CODE), notCalled, NOW);
    expect(out).toMatchObject({ endKind: "not_to_brand", delivery: null, notAdmitted: { reason: CODE } });
    const kept = await outcome(person(), plan, { channel: "whatsapp" }, write, refusedSend("not_on_whatsapp"), notCalled, NOW);
    expect(kept).toMatchObject({ endKind: "refused_kept", delivery: { state: "refused", code: "not_on_whatsapp" } });
    expect(FOLLOW_UP_WHATSAPP_REFUSAL_CODES).toContain(CODE);
  });

  it("every follow-up DAG has its quiet end, a normal run stating personNotAdmitted", () => {
    expect(FOLLOW_UP_END_KINDS).toContain("not_to_brand");
    for (const dag of [buildFollowUpReactiveDag({ readFigures: false }), buildClientSatisfiedDag(), buildClientCheckInDag(), buildBrandTeamDag()]) {
      const end = sendNode(dag, "end-run-not-to-brand");
      expect(end?.config?.body).toEqual({ success: true, stopCampaign: false });
      expect(end?.inputMapping).toEqual({ "body.personNotAdmitted": "$ref:outcome.output.notAdmitted" });
      expect(dag.edges).toContainEqual({ from: "check-end", to: "end-run-not-to-brand", condition: "results['outcome']?.endKind == 'not_to_brand'" });
      expect(sendNode(dag, "send-whatsapp")?.config?.skipOnRefusalCodes).toContain(CODE);
      expect(validateDAG(dag).valid).toBe(true);
    }
  });
});

describe("founder hello", () => {
  const outcome = loadMain(FOUNDER_OUTCOME_CODE);
  const person = { go: true, rowId: "row-1", leadId: "lead-1" };

  it("refused at the reach check or the send: not admitted, never a refused delivery", async () => {
    expect(FOUNDER_HELLO_REFUSAL_CODES).toContain(CODE);
    const early = await outcome(person, {}, { refused: { code: CODE, reason: "stated" } }, null, notCalled, null, null, null);
    expect(early).toEqual({ endKind: "not_admitted", notAdmitted: { reason: CODE }, skipRecord: false, rowId: "row-1", rowReason: `founder_hello_whatsapp_${CODE}` });
    const late = await outcome(person, {}, { refused: null }, { written: true }, refusedSend(CODE), null, null, null);
    expect(late).toMatchObject({ endKind: "not_admitted", notAdmitted: { reason: CODE } });
    expect(late.delivery).toBeUndefined();
  });
  it("another refusal is still a refused delivery", async () => {
    const out = await outcome(person, {}, { refused: { code: "not_on_whatsapp", reason: "x" } }, null, notCalled, null, null, null);
    expect(out).toMatchObject({ endKind: "refused", delivery: { state: "refused", code: "not_on_whatsapp" } });
  });
  it("the hello's send reads the refusal", () => {
    expect(sendNode(buildFounderHelloDag(), "send-whatsapp")?.config?.skipOnRefusalCodes).toContain(CODE);
  });
});
