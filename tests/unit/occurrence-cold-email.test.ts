import { describe, it, expect } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import type { DAG } from "../../src/lib/dag-validator.js";

/**
 * Regression: LEAD-NAMED-SERVE-1015 (staff org 06ffd332, 2026-10-15). A ⚡ Lead occurrence ran the cold email
 * unit of a trigger-headed funnel: the run never named the person to lead-service's serve, and nothing it ended
 * on told campaign-service what became of that person. At conversion, a run whose `flow_input.trigger` names a
 * lead now states `delivery` on the end-run after the send, and reads every sender refusal as final for that
 * person. A run no occurrence carries is byte-identical to before.
 */

type Transform = { type: string; value?: unknown; expr?: string };
type Module = { id: string; value: { type: string; input_transforms?: Record<string, Transform>; branches?: Array<{ modules: Module[] }>; modules?: Module[]; default?: Module[] } };

function coldEmailDag(): DAG {
  return {
    nodes: [
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" } },
      { id: "check-lead", type: "condition", config: {} },
      { id: "email-generate", type: "http.call", config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email-v30" } } },
      { id: "email-send", type: "http.call", config: { service: "email-gateway", method: "POST", path: "/orgs/send", body: { type: "broadcast" } }, retries: 0 },
      { id: "end-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: false } } },
      { id: "end-run-no-lead", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: true } } },
    ],
    edges: [
      { from: "start-run", to: "fetch-lead" },
      { from: "fetch-lead", to: "check-lead" },
      { from: "check-lead", to: "email-generate", condition: "results['fetch-lead'].found == true" },
      { from: "email-generate", to: "email-send" },
      { from: "email-send", to: "end-run" },
      { from: "check-lead", to: "end-run-no-lead", condition: "results['fetch-lead'].found == false" },
    ],
  } as DAG;
}

function allModules(mods: Module[]): Module[] {
  return mods.flatMap((m) => [
    m,
    ...allModules(m.value.modules ?? []),
    ...allModules(m.value.default ?? []),
    ...(m.value.branches ?? []).flatMap((b) => allModules(b.modules)),
  ]);
}

function transform(dag: DAG, moduleId: string, key: string): Transform {
  const flow = dagToOpenFlow(dag, "occurrence cold email");
  const mod = allModules(flow.value.modules as unknown as Module[]).find((m) => m.id === moduleId);
  const t = mod?.value.input_transforms?.[key];
  if (!t) throw new Error(`${moduleId}.${key} not found`);
  return t;
}

/** Evaluates a compiled transform the way Windmill does, then serialises it like http-call. */
function sent(t: Transform, flowInput: Record<string, unknown>, results: Record<string, unknown> = {}): unknown {
  if (t.type === "static") return JSON.parse(JSON.stringify(t.value));
  return JSON.parse(JSON.stringify(new Function("results", "flow_input", `return (${t.expr});`)(results, flowInput)));
}

const occurrence = { trigger: { eventId: "ev-1", triggerId: "lead_found", leadId: "lead-1", person: { email: "a+tag@distribute.you" } } };
const refusal = {
  ok: false,
  skipped: true,
  status: 409,
  code: "email_not_verified",
  reason: "The address could not be verified.",
  delivery: { state: "refused", code: "email_not_verified", reason: "The address could not be verified." },
};

describe("a cold email run answering an occurrence states what became of the person", () => {
  it("sent: the end-run after the send says delivered", () => {
    expect(sent(transform(coldEmailDag(), "end_run", "body"), occurrence, { email_send: { ok: true, success: true } })).toEqual({
      success: true,
      stopCampaign: false,
      delivery: { state: "delivered" },
    });
  });

  it("refused: the end-run carries the sender's refusal verbatim", () => {
    expect(sent(transform(coldEmailDag(), "end_run", "body"), occurrence, { email_send: refusal })).toEqual({
      success: true,
      stopCampaign: false,
      delivery: { state: "refused", code: "email_not_verified", reason: "The address could not be verified." },
    });
  });

  it("every refusal the sender names is read (final), not thrown and redelivered", () => {
    expect(sent(transform(coldEmailDag(), "email_send", "skipOnRefusalCodes"), occurrence)).toEqual([
      "recent_brand_contact",
      "lead_opted_out",
      "*",
    ]);
  });

  it("a run no occurrence carries is unchanged: no delivery, the closed refusal list", () => {
    expect(sent(transform(coldEmailDag(), "end_run", "body"), {}, { email_send: { ok: true } })).toEqual({
      success: true,
      stopCampaign: false,
    });
    expect(sent(transform(coldEmailDag(), "end_run", "body"), {}, { email_send: refusal })).toEqual({
      success: true,
      stopCampaign: false,
    });
    expect(sent(transform(coldEmailDag(), "email_send", "skipOnRefusalCodes"), {})).toEqual(["recent_brand_contact", "lead_opted_out"]);
  });

  it("a DAG that maps delivery itself keeps its own", () => {
    const dag = coldEmailDag();
    dag.nodes = dag.nodes.map((n) => (n.id === "end-run" ? { ...n, inputMapping: { "body.delivery": "$ref:email-send.output.delivery" } } : n));
    expect(sent(transform(dag, "end_run", "body"), occurrence, { email_send: refusal })).toMatchObject({
      delivery: { state: "refused", code: "email_not_verified" },
    });
  });

  it("the serve names the person the occurrence names, and nothing on a run no occurrence carries", () => {
    const t = transform(coldEmailDag(), "fetch_lead", "body");
    expect(sent(t, occurrence)).toEqual({ namedLead: { leadId: "lead-1", triggerEventId: "ev-1" } });
    expect(sent(t, {})).toEqual({});
  });

  it("a serve stating a population is left alone", () => {
    const dag = coldEmailDag();
    dag.nodes = dag.nodes.map((n) => (n.id === "fetch-lead" ? { ...n, config: { ...n.config, body: { population: "contacted_pure_prospects" } } } : n));
    expect(sent(transform(dag, "fetch_lead", "body"), occurrence)).toEqual({ population: "contacted_pure_prospects" });
  });

  it("a final empty named serve ends the occurrence as refused, lead-service's words verbatim", () => {
    const body = sent(transform(coldEmailDag(), "end_run_no_lead", "body"), occurrence, {
      fetch_lead: {
        found: false,
        reason: "named_lead_unwritable",
        message: "We only know this person's email address: no name or company was found, so we cannot write them a real email.",
        final: true,
      },
    });
    expect(body).toMatchObject({
      success: true,
      stopCampaign: false,
      delivery: {
        state: "refused",
        code: "named_lead_unwritable",
        reason: "We only know this person's email address: no name or company was found, so we cannot write them a real email.",
      },
    });
  });

  it("a named serve that must wait ends idle (redelivered), a timed-out one too, with no delivery", () => {
    for (const reason of ["credit_insufficient", "serve_timed_out", "named_lead_sender_unreadable"]) {
      expect(
        sent(transform(coldEmailDag(), "end_run_no_lead", "body"), occurrence, { fetch_lead: { found: false, reason, final: false } }),
      ).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
    }
  });

  it("an audience serve's empty answer is unchanged (no delivery, timed out = normal run)", () => {
    expect(sent(transform(coldEmailDag(), "end_run_no_lead", "body"), {}, { fetch_lead: { found: false, reason: "serve_timed_out" } })).toEqual({
      success: true,
      stopCampaign: false,
      noWorkAvailable: false,
    });
    expect(sent(transform(coldEmailDag(), "end_run_no_lead", "body"), {}, { fetch_lead: { found: false, reason: "audience_exhausted" } })).toEqual({
      success: true,
      stopCampaign: true,
      noWorkAvailable: false,
    });
  });
});
