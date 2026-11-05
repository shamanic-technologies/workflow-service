import { describe, it, expect } from "vitest";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { endRunBodyOf } from "../../src/lib/scripts/engine-runner.js";
import { portDag } from "../../scripts/engine-ports/dag-port.js";
import { CLIENT_WHATSAPP, FOLLOW_UP_DUE } from "../../scripts/engine-ports/follow-up.js";
import { endAsCampaignReadsIt } from "../../scripts/engine-ports/prove-dag-port.js";
import type { DAG } from "../../src/lib/dag-validator.js";

// MIGRATE-1105 S4b: the generic DAG port, on a fictional DAG (real cases live in script_cases, never in git).
const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const end = (id: string, body: Record<string, unknown>, inputMapping?: Record<string, string>) => ({
  id,
  type: "http.call" as const,
  config: { service: "campaign", method: "POST", path: "/end-run", body },
  ...(inputMapping ? { inputMapping } : {}),
});

const DAG_FIXTURE: DAG = {
  nodes: [
    { id: "gate-check", type: "http.call", config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" } },
    { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
    {
      id: "now",
      type: "script",
      config: { code: "export async function main() {\n  return { now: new Date().toISOString(), ms: Date.now() };\n}" },
      retries: 0,
    },
    {
      id: "plan",
      type: "script",
      config: {
        code:
          "export async function main(offerId, nowIso) {\n  const inner = async (x) => x;\n  const id = await inner(offerId);\n  return { skip: !id, id, at: nowIso };\n}\n" +
          "function helper() { return 1; }",
      },
      inputMapping: { offerId: "$ref:start-run.output.offerId", nowIso: "$ref:now.output.now" },
      retries: 0,
    },
    {
      id: "state",
      type: "http.call",
      config: { service: "lead", method: "GET", path: "/orgs/leads/{id}/followup-date", tolerateFailure: true },
      inputMapping: { "params.id": "$ref:plan.output.id", "query.brandId": "$ref:flow_input.brandId", skip: "$ref:plan.output.skip" },
      retries: 2,
    },
    {
      id: "send",
      type: "http.call",
      config: { service: "crm", method: "POST", path: "/orgs/whatsapp/messages", skipOnRefusalCodes: ["not_on_whatsapp"] },
      inputMapping: { "body.text": "$ref:plan.output.at", "body.brandId": "$ref:flow_input.brandId" },
      retries: 0,
    },
    {
      id: "outcome",
      type: "script",
      config: { code: "export async function main(state, send) {\n  function helper() { return 2; }\n  return { kind: send?.skipped ? 'refused' : state?.ok === false ? 'unread' : 'sent', delivery: send?.delivery ?? null, h: helper() };\n}" },
      inputMapping: { state: "$ref:state.output", send: "$ref:send.output" },
      retries: 0,
    },
    { id: "check-end", type: "condition" },
    end("end-run-sent", { success: true, stopCampaign: false }),
    end("end-run-refused", { success: true, stopCampaign: false }, { "body.delivery": "$ref:outcome.output.delivery" }),
    end("end-run-unread", { success: true, stopCampaign: false, noWorkAvailable: true }),
    end("end-run-error", { success: false, stopCampaign: false }),
  ],
  edges: [
    { from: "gate-check", to: "start-run" },
    { from: "start-run", to: "now" },
    { from: "now", to: "plan" },
    { from: "plan", to: "state" },
    { from: "state", to: "send" },
    { from: "send", to: "outcome" },
    { from: "outcome", to: "check-end" },
    { from: "check-end", to: "end-run-sent", condition: "results['outcome']?.kind == 'sent'" },
    { from: "check-end", to: "end-run-refused", condition: "results['outcome']?.kind == 'refused'" },
    { from: "check-end", to: "end-run-unread", condition: "results['outcome']?.kind == 'unread'" },
  ],
  onError: "end-run-error",
};

const now = "2026-11-06T09:00:00.000Z";
const request = { now, campaignId: "camp-1", offerId: "offer-1", runId: "run-1", brandIds: ["brand-1"] };

describe("the generic DAG port", () => {
  const src = portDag(DAG_FIXTURE, { title: "Fixture" });

  it("is a valid script: every step in its own closure, synchronous, no material", async () => {
    const v = await validateSource(src);
    expect(v.materials).toEqual([]);
  });

  it("runs the steps in order on their doors, with the run's clock, and states a normal run as made... only on an occurrence", async () => {
    const c: ReplayCase = {
      id: "sent",
      units: {},
      request,
      calls: [
        { name: "lead.followup_date.read", args: { params: { id: "offer-1" }, query: { brandId: "brand-1" } }, answer: ok({ owed: {} }) },
        { name: "crm.whatsapp.send", args: { body: { text: now, brandId: "brand-1" } }, answer: ok({ id: "m1" }) },
      ],
      // No occurrence: a normal run that made nothing for the ledger is stated as an unfinished look (a normal run).
      expect: { end: { success: true, stopCampaign: false } },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("reads a named refusal as the old step did and states it as unmade with the producer's code and words", async () => {
    const c: ReplayCase = {
      id: "refused",
      units: {},
      request: { ...request, trigger: { leadId: "lead-1", eventId: "ev-1" } },
      calls: [
        { name: "lead.followup_date.read", answer: { ok: false, data: { error: "down", status: 503, code: null, body: {} } } },
        { name: "crm.whatsapp.send", answer: { ok: false, data: { error: "no", status: 422, code: "not_on_whatsapp", body: { code: "not_on_whatsapp", details: "Not on WhatsApp." } } } },
      ],
      expect: { end: { success: true, stopCampaign: false, delivery: { state: "refused", code: "not_on_whatsapp", reason: "Not on WhatsApp." } } },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("retries a failing call its step retried, then fails the run", async () => {
    const tolerant = portDag({ ...DAG_FIXTURE, nodes: DAG_FIXTURE.nodes.map((n) => (n.id === "state" ? { ...n, config: { ...n.config, tolerateFailure: false } } : n)) }, { title: "Fixture" });
    const down = { ok: false, data: { error: "down", status: 503, code: null, body: {} } };
    const c: ReplayCase = {
      id: "failed",
      units: {},
      request,
      calls: [
        { name: "lead.followup_date.read", answer: down },
        { name: "lead.followup_date.read", answer: down },
        { name: "lead.followup_date.read", answer: down },
      ],
      expect: { fails: "GET lead/orgs/leads/{id}/followup-date failed (503)" },
    };
    expect((await replayCase(tolerant, c)).diffs).toEqual([]);
  });

  it("skips a call its plan skipped, and an idle end is nothing made", async () => {
    const c: ReplayCase = {
      id: "idle",
      units: {},
      request: { ...request, offerId: null },
      calls: [{ name: "crm.whatsapp.send", answer: ok({}) }],
      expect: { end: { success: true, stopCampaign: false, noWorkAvailable: true } },
    };
    // `state` skipped (no offer) answers the old step's notCalled (`ok: false`): the outcome reads it unread, idle.
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("refuses a step that reaches out on its own", () => {
    const bad: DAG = { ...DAG_FIXTURE, nodes: DAG_FIXTURE.nodes.map((n) => (n.id === "plan" ? { ...n, config: { code: "export async function main() { return await fetch('x'); }" } } : n)) };
    expect(() => portDag(bad, { title: "x" })).toThrow(/calls fetch itself/);
  });

  it("refuses a call no door serves", () => {
    const bad: DAG = { ...DAG_FIXTURE, nodes: DAG_FIXTURE.nodes.map((n) => (n.id === "send" ? { ...n, config: { service: "nowhere", method: "POST", path: "/x" } } : n)) };
    expect(() => portDag(bad, { title: "x" })).toThrow(/has no door/);
  });
});

describe("an old end as campaign-service reads it", () => {
  it("drops delivery with no occurrence, and reads a stated not-admitted as idle there", () => {
    expect(endAsCampaignReadsIt({ success: true, stopCampaign: false, delivery: { state: "refused", code: "x", reason: "y" } }, false)).toEqual({ success: true, stopCampaign: false });
    expect(endAsCampaignReadsIt({ success: true, stopCampaign: false, personNotAdmitted: { reason: "r" } }, false)).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
  });
  it("reads a success with no delivery on an occurrence as delivered, as the runner states a made Unit", () => {
    const e = endAsCampaignReadsIt({ success: true, stopCampaign: false }, true);
    expect(e).toEqual(endRunBodyOf({ status: "made", error: null }, true));
  });
});

describe("the follow-up ports", () => {
  it("are valid scripts needing no material (the Rating offers them only on their channel)", async () => {
    for (const p of [FOLLOW_UP_DUE, CLIENT_WHATSAPP]) {
      const v = await validateSource(p.build());
      expect(v.materials).toEqual([]);
      expect(p.tactics.channel).toBeTruthy();
    }
  });
  it("leave the ledger steps to the runner", () => {
    for (const p of [FOLLOW_UP_DUE, CLIENT_WHATSAPP]) {
      const src = p.build();
      expect(src).toContain("// pipe_of_run: the Engine runner's (left out)");
      expect(src).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
