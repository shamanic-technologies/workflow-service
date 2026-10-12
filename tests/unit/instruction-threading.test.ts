import { describe, it, expect } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import type { DAG } from "../../src/lib/dag-validator.js";
import { DAG_WITH_CAMPAIGN_FOREACH } from "../helpers/fixtures.js";

/**
 * LEAK-1012: the cold-email workflows of a sales funnel ignored the campaign's
 * instruction (campaign-service `/start-run` reports it; the WhatsApp DAG maps it into
 * its writer; no stored cold-email DAG ever did). Every content-generation /generate call
 * downstream of start-run now receives it at conversion time, like the offer.
 */

type Transforms = Record<string, { type: string; expr?: string; value?: unknown }>;

function scriptTransforms(result: ReturnType<typeof dagToOpenFlow>, id: string): Transforms {
  const find = (mods: typeof result.value.modules): (typeof mods)[number] | undefined => {
    for (const m of mods) {
      if (m.id === id) return m;
      if (m.value.type === "branchone") {
        for (const b of m.value.branches) {
          const hit = find(b.modules);
          if (hit) return hit;
        }
      }
    }
    return undefined;
  };
  const mod = find(result.value.modules);
  if (!mod) throw new Error(`module ${id} not found`);
  if (mod.value.type !== "script") throw new Error(`module ${id} is ${mod.value.type}`);
  return mod.value.input_transforms as Transforms;
}

function evalBody(expr: string, results: Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line no-new-func
  return new Function("results", `return ${expr};`)(results) as Record<string, unknown>;
}

/** The production cold-email shape (sales-cold-email-outreach "azha"), trimmed to what matters. */
const AZHA_LIKE: DAG = {
  nodes: [
    { id: "gate-check", type: "http.call", config: { service: "campaign", method: "POST", path: "/gate-check" } },
    { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
    { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" } },
    { id: "check-lead", type: "condition", config: {} },
    {
      id: "email-generate",
      type: "http.call",
      config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email-v16", model: "opus" } },
      inputMapping: {
        "body.leadId": "$ref:fetch-lead.output.lead.leadId",
        "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
      },
    },
    {
      id: "email-send",
      type: "http.call",
      config: { service: "email-gateway", method: "POST", path: "/orgs/send", body: { tag: "sales-click-email" } },
      inputMapping: { "body.subject": "$ref:email-generate.output.subject" },
    },
    { id: "end-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true } } },
    { id: "end-run-no-lead", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: true } } },
  ],
  edges: [
    { from: "gate-check", to: "start-run" },
    { from: "start-run", to: "fetch-lead" },
    { from: "fetch-lead", to: "check-lead" },
    { from: "check-lead", to: "email-generate", condition: "results['fetch-lead'].found == true" },
    { from: "check-lead", to: "end-run-no-lead", condition: "results['fetch-lead'].found == false" },
    { from: "email-generate", to: "email-send" },
    { from: "email-send", to: "end-run" },
  ],
};

const RESULTS = (startRun: Record<string, unknown>) => ({
  start_run: startRun,
  fetch_lead: { found: true, lead: { leadId: "lead-1", data: { firstName: "Maggie" } } },
});

describe("instruction threading (LEAK-1012)", () => {
  it("hands the campaign's instruction to the cold-email writer", () => {
    const expr = scriptTransforms(dagToOpenFlow(AZHA_LIKE, "f"), "email_generate").body?.expr ?? "";
    expect(expr).toContain("results.start_run?.instruction");
    const body = evalBody(expr, RESULTS({ offerId: "offer-1", instruction: "Thank them, ask ONE open question." }));
    expect(body).toMatchObject({
      type: "cold-email-v16",
      model: "opus",
      leadId: "lead-1",
      offerId: "offer-1",
      instruction: "Thank them, ask ONE open question.",
      variables: { leadFirstName: "Maggie" },
    });
  });

  it("drops the key when the campaign carries no instruction (start-run answers null or nothing)", () => {
    const expr = scriptTransforms(dagToOpenFlow(AZHA_LIKE, "f"), "email_generate").body?.expr ?? "";
    for (const startRun of [{ instruction: null }, {}]) {
      const body = evalBody(expr, RESULTS(startRun));
      expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty("instruction");
      expect(body.type).toBe("cold-email-v16");
    }
  });

  it("touches no other call: the send, the serve and start-run's own predecessors stay as they were", () => {
    const result = dagToOpenFlow(AZHA_LIKE, "f");
    expect(scriptTransforms(result, "email_send").body?.expr ?? "").not.toContain("instruction");
    expect(JSON.stringify(scriptTransforms(result, "fetch_lead"))).not.toContain("instruction");
    expect(JSON.stringify(scriptTransforms(result, "gate_check"))).not.toContain("instruction");
  });

  it("leaves a DAG that maps the instruction itself alone", () => {
    const dag: DAG = {
      ...AZHA_LIKE,
      nodes: AZHA_LIKE.nodes.map((n) =>
        n.id === "email-generate"
          ? { ...n, inputMapping: { ...n.inputMapping, "body.instruction": "$ref:start-run.output.instruction" } }
          : n,
      ),
    };
    const expr = scriptTransforms(dagToOpenFlow(dag, "f"), "email_generate").body?.expr ?? "";
    expect(expr.match(/results\.start_run\?\.instruction/g)?.length).toBe(1);
    expect(expr).toContain("instruction: results.start_run?.instruction,");
  });

  it("injects nothing in a DAG with no campaign start-run", () => {
    const dag: DAG = {
      nodes: [{ id: "email-generate", type: "http.call", config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "x" } } }],
      edges: [],
    };
    expect(JSON.stringify(scriptTransforms(dagToOpenFlow(dag, "f"), "email_generate"))).not.toContain("instruction");
  });

  it("threads the instruction through a for-each body via the iter fold", () => {
    const result = dagToOpenFlow(DAG_WITH_CAMPAIGN_FOREACH, "f");
    const loop = result.value.modules.find((m) => m.id === "loop_leads");
    if (!loop || loop.value.type !== "forloopflow") throw new Error("loop not found");
    const iter = (loop.value.iterator as { type: string; expr: string }).expr;
    expect(iter).toContain("__wf_instruction: results.start_run?.instruction");
    const body = loop.value.modules.find((m) => m.id === "email_generate");
    if (!body || body.value.type !== "script") throw new Error("body not found");
    const t = body.value.input_transforms as Transforms;
    expect(t.body?.expr).toContain("flow_input.iter.value?.__wf_instruction");
  });
});
