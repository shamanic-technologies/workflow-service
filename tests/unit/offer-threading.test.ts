import { describe, it, expect } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import type { DAG } from "../../src/lib/dag-validator.js";
import { DAG_WITH_CAMPAIGN_FOREACH } from "../helpers/fixtures.js";

type Transforms = Record<string, { type: string; expr?: string; value?: unknown }>;

function scriptTransforms(result: ReturnType<typeof dagToOpenFlow>, id: string): Transforms {
  const mod = result.value.modules.find((m) => m.id === id);
  if (!mod) throw new Error(`module ${id} not found`);
  if (mod.value.type !== "script") throw new Error(`module ${id} is ${mod.value.type}`);
  return mod.value.input_transforms as Transforms;
}

/** The failing shape: campaign chassis with a brand extract-fields step. */
const DAG_WITH_EXTRACT_FIELDS: DAG = {
  nodes: [
    {
      id: "gate-check",
      type: "http.call",
      config: { service: "campaign", method: "POST", path: "/gate-check" },
    },
    {
      id: "start-run",
      type: "http.call",
      config: { service: "campaign", method: "POST", path: "/start-run" },
    },
    {
      id: "brand-extract-fields",
      type: "http.call",
      config: {
        service: "brand",
        method: "POST",
        path: "/orgs/brands/extract-fields",
        body: { fields: [{ key: "companyOverview", description: "Overview" }] },
      },
    },
    {
      id: "email-generate",
      type: "http.call",
      config: { service: "content-generation", method: "POST", path: "/generate" },
    },
    {
      id: "email-send",
      type: "http.call",
      config: { service: "email-gateway", method: "POST", path: "/send", body: { subject: "hi" } },
    },
  ],
  edges: [
    { from: "gate-check", to: "start-run" },
    { from: "start-run", to: "brand-extract-fields" },
    { from: "brand-extract-fields", to: "email-generate" },
    { from: "email-generate", to: "email-send" },
  ],
};

/** Same extract-fields step with NO campaign start-run node (non-campaign DAG). */
const DAG_EXTRACT_NO_START_RUN: DAG = {
  nodes: [
    {
      id: "brand-extract-fields",
      type: "http.call",
      config: {
        service: "brand",
        method: "POST",
        path: "/orgs/brands/extract-fields",
        body: { fields: [] },
      },
    },
  ],
  edges: [],
};

/** A node whose own mapping already states the offer must not be overwritten. */
const DAG_WITH_EXPLICIT_OFFER_MAPPING: DAG = {
  nodes: [
    {
      id: "start-run",
      type: "http.call",
      config: { service: "campaign", method: "POST", path: "/start-run" },
    },
    {
      id: "brand-extract-fields",
      type: "http.call",
      config: {
        service: "brand",
        method: "POST",
        path: "/orgs/brands/extract-fields",
        body: { fields: [] },
      },
      inputMapping: { "body.offerId": "$ref:start-run.output.offerId" },
    },
  ],
  edges: [{ from: "start-run", to: "brand-extract-fields" }],
};

describe("offer threading (SEVERAL_OFFERS)", () => {
  it("names the campaign's offer in the extract-fields request body", () => {
    const result = dagToOpenFlow(DAG_WITH_EXTRACT_FIELDS, "f");
    const t = scriptTransforms(result, "brand_extract_fields");
    const body = t.body;
    expect(body?.type).toBe("javascript");
    expect(body?.expr).toContain("results.start_run?.offerId");
    // static fields survive the merge
    expect(body?.expr).toContain("companyOverview");
  });

  it("names the campaign's offer in the content-generation request body", () => {
    const result = dagToOpenFlow(DAG_WITH_EXTRACT_FIELDS, "f");
    const t = scriptTransforms(result, "email_generate");
    expect(t.body?.expr).toContain("results.start_run?.offerId");
  });

  it("does not touch bodies of other downstream calls", () => {
    const result = dagToOpenFlow(DAG_WITH_EXTRACT_FIELDS, "f");
    // email-gateway /send: body stays static
    const send = scriptTransforms(result, "email_send");
    expect(send.body?.type).toBe("static");
    // lead /buffer/next — add one to prove scoping is by callee, not position
    const dag: DAG = {
      nodes: [
        ...DAG_WITH_EXTRACT_FIELDS.nodes,
        {
          id: "fetch-lead",
          type: "http.call",
          config: { service: "lead", method: "POST", path: "/buffer/next", body: { limit: 1 } },
        },
      ],
      edges: [...DAG_WITH_EXTRACT_FIELDS.edges, { from: "start-run", to: "fetch-lead" }],
    };
    const t = scriptTransforms(dagToOpenFlow(dag, "f"), "fetch_lead");
    expect(t.body?.type).toBe("static");
  });

  it("injects nothing at or before start-run (gate-check)", () => {
    const result = dagToOpenFlow(DAG_WITH_EXTRACT_FIELDS, "f");
    const t = scriptTransforms(result, "gate_check");
    expect(t.body).toBeUndefined();
  });

  it("injects nothing when the DAG has no campaign start-run node", () => {
    const result = dagToOpenFlow(DAG_EXTRACT_NO_START_RUN, "f");
    const t = scriptTransforms(result, "brand_extract_fields");
    expect(t.body?.type).toBe("static");
    expect(JSON.stringify(t.body?.value)).not.toContain("offerId");
  });

  it("leaves a node whose own mapping already states body.offerId alone", () => {
    const result = dagToOpenFlow(DAG_WITH_EXPLICIT_OFFER_MAPPING, "f");
    const t = scriptTransforms(result, "brand_extract_fields");
    expect(t.body?.type).toBe("javascript");
    expect(t.body?.expr).toContain("results.start_run?.offerId");
    // the mapping's own conversion, not a second injection
    expect((t.body?.expr ?? "").match(/results\.start_run\?\.offerId/g)?.length).toBe(1);
  });

  it("threads the offer through a for-each body via the iter fold", () => {
    const result = dagToOpenFlow(DAG_WITH_CAMPAIGN_FOREACH, "f");
    const loop = result.value.modules.find((m) => m.id === "loop_leads");
    if (!loop || loop.value.type !== "forloopflow") throw new Error("loop not found");
    const iter = (loop.value.iterator as { type: string; expr: string }).expr;
    expect(iter).toContain("__wf_offer_id: results.start_run?.offerId");
    const body = loop.value.modules.find((m) => m.id === "email_generate");
    if (!body || body.value.type !== "script") throw new Error("body not found");
    const t = body.value.input_transforms as Transforms;
    expect(t.body?.expr).toContain("flow_input.iter.value?.__wf_offer_id");
  });
});
