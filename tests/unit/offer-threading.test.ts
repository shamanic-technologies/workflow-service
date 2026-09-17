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

/**
 * The regression this file exists for. #431 added `body.offerId` to an
 * ALREADY-collapsed transform map and re-collapsed it; on that second pass the
 * root `body` is a javascript transform, so there was no static base to spread
 * and the compiled body became `({offerId: ...})` — tag, type, recipient and
 * every `body.variables.*` silently discarded, on every campaign in the fleet.
 */
const DAG_FULL_CONTENT_GENERATION: DAG = {
  nodes: [
    {
      id: "start-run",
      type: "http.call",
      config: { service: "campaign", method: "POST", path: "/start-run" },
    },
    {
      id: "fetch-lead",
      type: "http.call",
      config: { service: "lead", method: "POST", path: "/orgs/buffer/next" },
    },
    {
      id: "email-generate",
      type: "http.call",
      config: {
        service: "content-generation",
        method: "POST",
        path: "/generate",
        body: {
          type: "cold-email-v27",
          model: "pro",
          tag: "cold-email",
          variables: { tone: "direct" },
          metadata: { source: "workflow" },
        },
      },
      inputMapping: {
        "body.leadId": "$ref:fetch-lead.output.lead.id",
        "body.recipient": "$ref:fetch-lead.output.lead.data.email",
        "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
        "body.variables.leadCompanyName":
          "$ref:fetch-lead.output.lead.data.organization.name",
        "body.metadata.emailGenerationId": "$ref:fetch-lead.output.lead.id",
      },
    },
  ],
  edges: [
    { from: "start-run", to: "fetch-lead" },
    { from: "fetch-lead", to: "email-generate" },
  ],
};

describe("offer threading preserves the whole request body", () => {
  it("keeps every static field, every mapped field and every variable beside offerId", () => {
    const result = dagToOpenFlow(DAG_FULL_CONTENT_GENERATION, "f");
    const expr = scriptTransforms(result, "email_generate").body?.expr ?? "";

    // the injected offer
    expect(expr).toContain("offerId: results.start_run?.offerId");

    // the static base, spread whole
    expect(expr).toContain('"type":"cold-email-v27"');
    expect(expr).toContain('"model":"pro"');
    expect(expr).toContain('"tag":"cold-email"');

    // direct mapped fields
    expect(expr).toContain("leadId: results.fetch_lead?.lead?.id");
    expect(expr).toContain("recipient: results.fetch_lead?.lead?.data?.email");

    // nested groups keep their own static base AND their mapped children
    expect(expr).toContain('"tone":"direct"');
    expect(expr).toContain("leadFirstName: results.fetch_lead?.lead?.data?.firstName");
    expect(expr).toContain(
      "leadCompanyName: results.fetch_lead?.lead?.data?.organization?.name",
    );
    expect(expr).toContain('"source":"workflow"');
    expect(expr).toContain("emailGenerationId: results.fetch_lead?.lead?.id");

    // and it is one object expression, not a body replaced by the injected key
    expect(expr).not.toBe("({offerId: results.start_run?.offerId})");
  });

  it("compiles to a body that evaluates to the full object", () => {
    const result = dagToOpenFlow(DAG_FULL_CONTENT_GENERATION, "f");
    const expr = scriptTransforms(result, "email_generate").body?.expr ?? "";
    const results = {
      start_run: { offerId: "offer-1" },
      fetch_lead: {
        lead: {
          id: "lead-1",
          data: { email: "a@b.co", firstName: "Ada", organization: { name: "Acme" } },
        },
      },
    };
    // eslint-disable-next-line no-new-func
    const body = new Function("results", `return ${expr};`)(results) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      type: "cold-email-v27",
      model: "pro",
      tag: "cold-email",
      leadId: "lead-1",
      recipient: "a@b.co",
      offerId: "offer-1",
      variables: { tone: "direct", leadFirstName: "Ada", leadCompanyName: "Acme" },
      metadata: { source: "workflow", emailGenerationId: "lead-1" },
    });
  });

  it("drops the key entirely when the campaign reports no offer", () => {
    const result = dagToOpenFlow(DAG_FULL_CONTENT_GENERATION, "f");
    const expr = scriptTransforms(result, "email_generate").body?.expr ?? "";
    const results = {
      start_run: {},
      fetch_lead: { lead: { id: "l", data: { email: "a@b.co" } } },
    };
    // eslint-disable-next-line no-new-func
    const body = new Function("results", `return ${expr};`)(results) as Record<
      string,
      unknown
    >;
    expect(body.offerId).toBeUndefined();
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty("offerId");
    expect(body.type).toBe("cold-email-v27");
  });
});
