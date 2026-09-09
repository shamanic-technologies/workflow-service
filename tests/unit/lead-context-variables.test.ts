import { describe, it, expect } from "vitest";
import type { DAG } from "../../src/lib/dag-validator.js";
import {
  LEAD_CONTEXT_PATHS,
  planLeadContextVariables,
  applyLeadContextVariables,
} from "../../src/lib/lead-context-variables.js";
import { validateWorkflowEndpoints } from "../../src/lib/validate-workflow-endpoints.js";

/**
 * A cut-down mirror of lead-service's served `POST /orgs/buffer/next` response:
 * the canonical lead under `lead.data`, the employer NESTED under
 * `lead.data.organization`. Deliberately PARTIAL — it declares no `seniority`
 * and no `organization.foundedYear`, so a name the served shape cannot satisfy
 * is exercised rather than assumed away.
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
          currentTitle: { type: "string" },
          headline: { type: "string" },
          timezone: { type: "string" },
          subdepartments: { type: "array", nullable: true, items: { type: "string" } },
          employmentHistory: { type: "array", items: { type: "object" } },
          organization: { $ref: "#/components/schemas/OrganizationView" },
        },
      },
      OrganizationView: {
        type: "object",
        properties: {
          name: { type: "string" },
          industry: { type: "string" },
          keywords: { type: "array", items: { type: "string" } },
          estimatedNumEmployees: { type: "number" },
          latestFundingRoundDate: { type: "string", nullable: true },
        },
      },
    },
  },
};

const specs = new Map<string, Record<string, unknown>>([["lead", LEAD_SPEC]]);

/** What content-generation publishes as `contextVariables`, read live in prod. */
const PUBLISHED = [
  "leadFirstName",
  "leadLastName",
  "leadTitle",
  "leadHeadline",
  "leadTimezone",
  "leadSeniority",
  "leadEmploymentHistory",
  "leadCompanyName",
  "leadCompanyIndustry",
  "leadCompanyKeywords",
  "leadCompanySize",
  "leadCompanyFoundedYear",
];

function dagWith(generateMapping: Record<string, string>): DAG {
  return {
    nodes: [
      {
        id: "fetch-lead",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/buffer/next" },
      },
      {
        id: "brand-profile",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/internal/brands/{brandId}" },
      },
      {
        id: "email-generate",
        type: "http.call",
        config: {
          service: "content-generation",
          method: "POST",
          path: "/generate",
          body: { type: "cold-email" },
        },
        inputMapping: generateMapping,
      },
    ],
    edges: [
      { from: "fetch-lead", to: "email-generate" },
      { from: "brand-profile", to: "email-generate" },
    ],
  };
}

/** What a prod head carries today: five lead facts and a brand mapping. */
const EXISTING = {
  "body.leadId": "$ref:fetch-lead.output.lead.leadId",
  "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
  "body.variables.leadLastName": "$ref:fetch-lead.output.lead.data.lastName",
  "body.variables.leadTitle": "$ref:fetch-lead.output.lead.data.currentTitle",
  "body.variables.leadCompanyName": "$ref:fetch-lead.output.lead.data.organization.name",
  "body.variables.leadCompanyIndustry": "$ref:fetch-lead.output.lead.data.organization.industry",
  "body.variables.brandProfile": "$ref:brand-profile.output.brand",
};

describe("planLeadContextVariables", () => {
  it("adds every published name the served lead shape resolves, and no other", () => {
    const plan = planLeadContextVariables(dagWith({ ...EXISTING }), specs, PUBLISHED);

    expect(Object.fromEntries(plan.additions.map((a) => [a.key, a.ref]))).toEqual({
      "body.variables.leadHeadline": "$ref:fetch-lead.output.lead.data.headline",
      "body.variables.leadTimezone": "$ref:fetch-lead.output.lead.data.timezone",
      "body.variables.leadEmploymentHistory":
        "$ref:fetch-lead.output.lead.data.employmentHistory",
      "body.variables.leadCompanyKeywords":
        "$ref:fetch-lead.output.lead.data.organization.keywords",
      "body.variables.leadCompanySize":
        "$ref:fetch-lead.output.lead.data.organization.estimatedNumEmployees",
    });
  });

  it("maps the two names content-generation v0.34.0 added to its context list", () => {
    const plan = planLeadContextVariables(dagWith({ ...EXISTING }), specs, [
      "leadSubdepartments",
      "leadCompanyLatestFundingRoundDate",
    ]);

    expect(plan.skipped).toEqual([]);
    expect(Object.fromEntries(plan.additions.map((a) => [a.key, a.ref]))).toEqual({
      "body.variables.leadSubdepartments":
        "$ref:fetch-lead.output.lead.data.subdepartments",
      "body.variables.leadCompanyLatestFundingRoundDate":
        "$ref:fetch-lead.output.lead.data.organization.latestFundingRoundDate",
    });
  });

  it("reports a name the served shape cannot satisfy instead of mapping it", () => {
    const plan = planLeadContextVariables(dagWith({ ...EXISTING }), specs, PUBLISHED);

    expect(plan.skipped.map((s) => [s.variable, s.reason])).toEqual([
      ["leadSeniority", "path-does-not-resolve"],
      ["leadCompanyFoundedYear", "path-does-not-resolve"],
    ]);
    expect(plan.additions.map((a) => a.variable)).not.toContain("leadSeniority");
  });

  it("reports a published name this repo knows no path for", () => {
    const plan = planLeadContextVariables(dagWith({ ...EXISTING }), specs, [
      "leadFavouriteColour",
    ]);

    expect(plan.additions).toEqual([]);
    expect(plan.skipped).toEqual([
      { nodeId: "email-generate", variable: "leadFavouriteColour", reason: "unknown-name" },
    ]);
  });

  it("never rewrites a variable the workflow already maps, however it is mapped", () => {
    const pinned = {
      ...EXISTING,
      "body.variables.leadHeadline": "$ref:fetch-lead.output.lead.data.currentTitle",
    };
    const plan = planLeadContextVariables(dagWith(pinned), specs, PUBLISHED);

    expect(plan.additions.map((a) => a.variable)).not.toContain("leadHeadline");
  });

  it("touches no mapping that is not a body.variables key", () => {
    const { dag } = applyLeadContextVariables(dagWith({ ...EXISTING }), specs, PUBLISHED);
    const node = dag.nodes.find((n) => n.id === "email-generate")!;

    expect(node.inputMapping!["body.leadId"]).toBe("$ref:fetch-lead.output.lead.leadId");
    expect(node.inputMapping!["body.variables.brandProfile"]).toBe(
      "$ref:brand-profile.output.brand",
    );
    expect(node.config!.body).toEqual({ type: "cold-email" });
  });

  it("derives the lead root from the DAG's own refs, not from a hardcoded path", () => {
    // Same served shape, a workflow that reaches it through a different node id
    // and reads only the organization — the root is still found.
    const dag = dagWith({});
    dag.nodes[0].id = "lead_fetch";
    dag.nodes[2].inputMapping = {
      "body.variables.leadCompanyName": "$ref:lead_fetch.output.lead.data.organization.name",
    };

    const plan = planLeadContextVariables(dag, specs, ["leadFirstName"]);

    expect(plan.additions).toEqual([
      {
        nodeId: "email-generate",
        variable: "leadFirstName",
        key: "body.variables.leadFirstName",
        ref: "$ref:lead_fetch.output.lead.data.firstName",
      },
    ]);
  });

  it("maps nothing when no ref points at the lead node", () => {
    const plan = planLeadContextVariables(
      dagWith({ "body.variables.brandProfile": "$ref:brand-profile.output.brand" }),
      specs,
      PUBLISHED,
    );

    expect(plan.additions).toEqual([]);
    expect(plan.skipped.every((s) => s.reason === "no-lead-root")).toBe(true);
  });

  it("maps nothing when the lead spec is unavailable", () => {
    const plan = planLeadContextVariables(dagWith({ ...EXISTING }), new Map(), PUBLISHED);

    expect(plan).toEqual({ additions: [], skipped: [] });
  });
});

describe("applyLeadContextVariables", () => {
  it("is idempotent — a second pass finds nothing left to add", () => {
    const first = applyLeadContextVariables(dagWith({ ...EXISTING }), specs, PUBLISHED);
    expect(first.changed).toBe(true);

    const second = applyLeadContextVariables(first.dag, specs, PUBLISHED);
    expect(second.changed).toBe(false);
    expect(second.plan.additions).toEqual([]);
    expect(second.dag).toBe(first.dag);
  });

  it("leaves the source DAG untouched", () => {
    const original = dagWith({ ...EXISTING });
    const snapshot = structuredClone(original);
    applyLeadContextVariables(original, specs, PUBLISHED);

    expect(original).toEqual(snapshot);
  });

  it("produces a DAG the endpoint validator raises no error on", () => {
    const { dag } = applyLeadContextVariables(dagWith({ ...EXISTING }), specs, PUBLISHED);
    const result = validateWorkflowEndpoints(dag, specs);

    // The brand node's spec is absent from `specs`, which is skipped rather than
    // judged; only the lead refs this module writes are under test here.
    const leadIssues = result.fieldIssues.filter(
      (i) => i.severity === "error" && i.nodeId === "email-generate",
    );
    expect(leadIssues).toEqual([]);
  });
});

describe("LEAD_CONTEXT_PATHS", () => {
  it("names only lead facts — the person flat, the employer nested", () => {
    for (const [name, path] of Object.entries(LEAD_CONTEXT_PATHS)) {
      expect(name.startsWith("lead")).toBe(true);
      if (name.startsWith("leadCompany")) {
        expect(path.startsWith("organization.")).toBe(true);
      } else {
        expect(path).not.toContain("organization.");
      }
    }
  });
});
