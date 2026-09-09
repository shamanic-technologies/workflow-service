import { describe, it, expect } from "vitest";
import type { DAG } from "../../src/lib/dag-validator.js";
import {
  planLeadContextMapping,
  applyLeadContextMapping,
} from "../../src/lib/lead-context-mapping.js";
import { validateWorkflowEndpoints } from "../../src/lib/validate-workflow-endpoints.js";

/**
 * A cut-down mirror of lead-service's served `POST /orgs/buffer/next` response:
 * the canonical lead under `lead.data`, the employer NESTED under
 * `lead.data.organization`, the job title as `currentTitle`, and the head count
 * as `estimatedNumEmployees`. Everything the seven broken workflows referenced
 * — a flat `organization<Field>`, a bare `title` — is deliberately absent.
 */
const LEAD_SPEC: Record<string, unknown> = {
  paths: {
    "/orgs/buffer/next": {
      post: {
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BufferNextResponse" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      BufferNextResponse: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          lead: { $ref: "#/components/schemas/Lead" },
        },
      },
      Lead: {
        type: "object",
        properties: {
          leadId: { type: "string" },
          email: { type: "string" },
          data: { $ref: "#/components/schemas/FullLead" },
        },
      },
      FullLead: {
        type: "object",
        properties: {
          firstName: { type: "string" },
          lastName: { type: "string" },
          headline: { type: "string" },
          currentTitle: { type: "string" },
          timezone: { type: "string" },
          organization: { $ref: "#/components/schemas/OrganizationView" },
        },
      },
      OrganizationView: {
        type: "object",
        properties: {
          name: { type: "string" },
          industry: { type: "string" },
          keywords: { type: "array", items: { type: "string" } },
          technologyNames: { type: "array", items: { type: "string" } },
          shortDescription: { type: "string" },
          latestFundingStage: { type: "string" },
          estimatedNumEmployees: { type: "number" },
        },
      },
    },
  },
};

const specs = new Map<string, Record<string, unknown>>([["lead", LEAD_SPEC]]);

function dagWith(generateMapping: Record<string, string>): DAG {
  return {
    nodes: [
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
          body: { type: "blind-discovery-email-v8" },
        },
        inputMapping: generateMapping,
      },
    ],
    edges: [{ from: "fetch-lead", to: "email-generate" }],
  };
}

/** The exact eight leaves the seven prod workflows carried. */
const BROKEN = {
  "body.variables.leadTitle": "$ref:fetch-lead.output.lead.data.title",
  "body.variables.leadCompanyName": "$ref:fetch-lead.output.lead.data.organizationName",
  "body.variables.leadCompanySize": "$ref:fetch-lead.output.lead.data.organizationSize",
  "body.variables.leadCompanyIndustry": "$ref:fetch-lead.output.lead.data.organizationIndustry",
  "body.variables.leadCompanyKeywords": "$ref:fetch-lead.output.lead.data.organizationKeywords",
  "body.variables.leadCompanyTechStack":
    "$ref:fetch-lead.output.lead.data.organizationTechnologyNames",
  "body.variables.leadCompanyDescription":
    "$ref:fetch-lead.output.lead.data.organizationShortDescription",
  "body.variables.leadCompanyFundingStage":
    "$ref:fetch-lead.output.lead.data.organizationLatestFundingStage",
};

const REPAIRED = {
  "body.variables.leadTitle": "$ref:fetch-lead.output.lead.data.currentTitle",
  "body.variables.leadCompanyName": "$ref:fetch-lead.output.lead.data.organization.name",
  "body.variables.leadCompanySize":
    "$ref:fetch-lead.output.lead.data.organization.estimatedNumEmployees",
  "body.variables.leadCompanyIndustry": "$ref:fetch-lead.output.lead.data.organization.industry",
  "body.variables.leadCompanyKeywords": "$ref:fetch-lead.output.lead.data.organization.keywords",
  "body.variables.leadCompanyTechStack":
    "$ref:fetch-lead.output.lead.data.organization.technologyNames",
  "body.variables.leadCompanyDescription":
    "$ref:fetch-lead.output.lead.data.organization.shortDescription",
  "body.variables.leadCompanyFundingStage":
    "$ref:fetch-lead.output.lead.data.organization.latestFundingStage",
};

describe("planLeadContextMapping", () => {
  it("repairs every flattened organization ref and the bare title", () => {
    const plan = planLeadContextMapping(dagWith({ ...BROKEN }), specs);

    expect(plan.unresolved).toEqual([]);
    expect(
      Object.fromEntries(plan.rewrites.map((r) => [r.key, r.to])),
    ).toEqual(REPAIRED);
  });

  it("leaves a ref that already resolves alone", () => {
    const plan = planLeadContextMapping(
      dagWith({
        "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
        "body.variables.leadCompanyName": "$ref:fetch-lead.output.lead.data.organization.name",
      }),
      specs,
    );

    expect(plan).toEqual({ rewrites: [], unresolved: [] });
  });

  it("reports a leaf no candidate resolves instead of guessing a path", () => {
    // lead-service serves no `organizationMascot`, and neither would
    // `organization.mascot` — emitting a $ref the fetch node never returns is
    // worse than the empty string it would replace.
    const plan = planLeadContextMapping(
      dagWith({ "body.variables.x": "$ref:fetch-lead.output.lead.data.organizationMascot" }),
      specs,
    );

    expect(plan.rewrites).toEqual([]);
    expect(plan.unresolved).toEqual([
      {
        nodeId: "email-generate",
        key: "body.variables.x",
        ref: "$ref:fetch-lead.output.lead.data.organizationMascot",
        tried: ["lead.data.organization.mascot"],
      },
    ]);
  });

  it("plans nothing when the lead spec is unavailable", () => {
    expect(planLeadContextMapping(dagWith({ ...BROKEN }), new Map())).toEqual({
      rewrites: [],
      unresolved: [],
    });
  });

  it("matches a producer whose ref is written with underscores", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "fetch-lead",
          type: "http.call",
          config: { service: "lead", method: "POST", path: "/orgs/buffer/next" },
        },
        {
          id: "email-send",
          type: "http.call",
          config: { service: "email-gateway", method: "POST", path: "/orgs/send" },
          inputMapping: {
            "body.recipientCompany": "$ref:fetch_lead.output.lead.data.organizationName",
          },
        },
      ],
      edges: [{ from: "fetch-lead", to: "email-send" }],
    };

    expect(planLeadContextMapping(dag, specs).rewrites).toEqual([
      {
        nodeId: "email-send",
        key: "body.recipientCompany",
        from: "$ref:fetch_lead.output.lead.data.organizationName",
        to: "$ref:fetch_lead.output.lead.data.organization.name",
      },
    ]);
  });
});

describe("applyLeadContextMapping", () => {
  it("changes only the broken refs and leaves the prompt type and model untouched", () => {
    const before = dagWith({
      ...BROKEN,
      "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
      "body.variables.currentDate": "$ref:flow_input.currentDate",
    });
    (before.nodes[1].config as Record<string, unknown>).body = {
      type: "blind-discovery-email-v8",
      model: "deepseek-pro",
    };

    const { dag, changed } = applyLeadContextMapping(before, specs);

    expect(changed).toBe(true);
    expect(dag.nodes[1].inputMapping).toEqual({
      ...REPAIRED,
      "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
      "body.variables.currentDate": "$ref:flow_input.currentDate",
    });
    expect(dag.nodes[1].config?.body).toEqual({
      type: "blind-discovery-email-v8",
      model: "deepseek-pro",
    });
    // The input is not mutated — the caller keeps a usable "before".
    expect(before.nodes[1].inputMapping?.["body.variables.leadCompanyName"]).toBe(
      BROKEN["body.variables.leadCompanyName"],
    );
  });

  it("is idempotent — a repaired DAG is returned unchanged", () => {
    const { dag: once } = applyLeadContextMapping(dagWith({ ...BROKEN }), specs);
    const { dag: twice, changed } = applyLeadContextMapping(once, specs);

    expect(changed).toBe(false);
    expect(twice).toBe(once);
  });
});

describe("the broken-ref class cannot be stored again", () => {
  // validateWorkflowEndpoints is the layer every write path runs through
  // (validateClientDag), so a DAG carrying one of these refs is rejected at the
  // write rather than rendering an empty string at run time. This is the guard;
  // the repair above only cleans up what was stored before it existed.
  it("rejects a flattened organization ref and a bare title as errors", () => {
    const result = validateWorkflowEndpoints(dagWith({ ...BROKEN }), specs);

    expect(result.valid).toBe(false);
    const errors = result.fieldIssues.filter((i) => i.severity === "error");
    expect(errors.map((e) => e.field).sort()).toEqual([
      "lead.data.organizationIndustry",
      "lead.data.organizationKeywords",
      "lead.data.organizationLatestFundingStage",
      "lead.data.organizationName",
      "lead.data.organizationShortDescription",
      "lead.data.organizationSize",
      "lead.data.organizationTechnologyNames",
      "lead.data.title",
    ]);
  });

  it("accepts the repaired DAG", () => {
    const { dag } = applyLeadContextMapping(dagWith({ ...BROKEN }), specs);
    const result = validateWorkflowEndpoints(dag, specs);
    // Only the lead spec is supplied here, so content-generation is reported as
    // an unknown endpoint; what matters is that no lead $ref remains an error.
    expect(result.fieldIssues.filter((i) => i.severity === "error")).toEqual([]);
  });
});
