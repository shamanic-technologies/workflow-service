import { describe, it, expect } from "vitest";
import {
  extractTemplateRefs,
  validateTemplateContracts,
} from "../../src/lib/validate-template-contracts.js";
import type { DAG } from "../../src/lib/dag-validator.js";
import type { PromptTemplate } from "../../src/lib/content-generation-client.js";

const COLD_EMAIL_TEMPLATE: PromptTemplate = {
  id: "e371bd39-b974-43ab-a761-b9717f3e3c42",
  type: "cold-email",
  prompt: "Write a cold email for {{leadFirstName}} at {{leadCompanyName}}...",
  variables: [
    "leadFirstName",
    "leadLastName",
    "leadTitle",
    "leadCompanyName",
    "leadCompanyIndustry",
    "clientCompanyName",
    "brandProfile",
  ],
  createdAt: "2026-03-12T15:06:04.002Z",
  updatedAt: "2026-03-17T08:02:50.277Z",
};

describe("extractTemplateRefs", () => {
  it("extracts template type and variables from http.call content-generation node", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "email-generate",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "cold-email",
            "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
            "body.variables.leadLastName": "$ref:fetch-lead.output.lead.data.lastName",
            "body.variables.brandProfile": "$ref:brand-profile.output.profile",
          },
        },
      ],
      edges: [],
    };

    const refs = extractTemplateRefs(dag);
    expect(refs).toHaveLength(1);
    expect(refs[0].nodeId).toBe("email-generate");
    expect(refs[0].templateType).toBe("cold-email");
    expect(refs[0].variablesProvided).toEqual(
      expect.arrayContaining(["leadFirstName", "leadLastName", "brandProfile"]),
    );
  });

  it("ignores non-content-generation http.call nodes", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
          inputMapping: { "body.type": "cold-email" },
        },
      ],
      edges: [],
    };

    const refs = extractTemplateRefs(dag);
    expect(refs).toHaveLength(0);
  });

  it("ignores http.call to content-generation with non-/generate path", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "stats",
          type: "http.call",
          config: { service: "content-generation", method: "GET", path: "/stats" },
        },
      ],
      edges: [],
    };

    const refs = extractTemplateRefs(dag);
    expect(refs).toHaveLength(0);
  });

  it("skips nodes where body.type is a $ref (dynamic template type)", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "email-generate",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "$ref:flow_input.templateType",
            "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
          },
        },
      ],
      edges: [],
    };

    const refs = extractTemplateRefs(dag);
    expect(refs).toHaveLength(0);
  });

  it("extracts template type from config.body.type when body.type is not in inputMapping", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "gen",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email" } },
          inputMapping: {
            "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
          },
        },
      ],
      edges: [],
    };

    const refs = extractTemplateRefs(dag);
    expect(refs).toHaveLength(1);
    expect(refs[0].templateType).toBe("cold-email");
  });

  it("ignores legacy content-generation node type", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "gen",
          type: "content-generation",
          config: { contentType: "cold-email" },
          inputMapping: {
            "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
          },
        },
      ],
      edges: [],
    };

    const refs = extractTemplateRefs(dag);
    expect(refs).toHaveLength(0);
  });

  it("handles multiple content-generation nodes in one DAG", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "email-gen",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "cold-email",
            "body.variables.leadFirstName": "$ref:lead.output.firstName",
          },
        },
        {
          id: "linkedin-gen",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "linkedin-dm",
            "body.variables.leadFirstName": "$ref:lead.output.firstName",
            "body.variables.leadTitle": "$ref:lead.output.title",
          },
        },
      ],
      edges: [],
    };

    const refs = extractTemplateRefs(dag);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.templateType)).toEqual(["cold-email", "linkedin-dm"]);
  });
});

describe("validateTemplateContracts", () => {
  it("returns valid when all variables match", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "email-generate",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "cold-email",
            "body.variables.leadFirstName": "$ref:lead.output.firstName",
            "body.variables.leadLastName": "$ref:lead.output.lastName",
            "body.variables.leadTitle": "$ref:lead.output.title",
            "body.variables.leadCompanyName": "$ref:lead.output.orgName",
            "body.variables.leadCompanyIndustry": "$ref:lead.output.industry",
            "body.variables.clientCompanyName": "$ref:brand.output.name",
            "body.variables.brandProfile": "$ref:brand.output.profile",
          },
        },
      ],
      edges: [],
    };

    const templates = new Map([["cold-email", COLD_EMAIL_TEMPLATE]]);
    const result = validateTemplateContracts(dag, templates);

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.templateRefs).toHaveLength(1);
  });

  it("detects missing required variable (error)", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "email-generate",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "cold-email",
            "body.variables.leadFirstName": "$ref:lead.output.firstName",
            // Missing: leadLastName, leadTitle, leadCompanyName, leadCompanyIndustry, clientCompanyName, brandProfile
          },
        },
      ],
      edges: [],
    };

    const templates = new Map([["cold-email", COLD_EMAIL_TEMPLATE]]);
    const result = validateTemplateContracts(dag, templates);

    expect(result.valid).toBe(false);
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors.length).toBe(6); // 7 declared - 1 provided = 6 missing
    expect(errors.map((e) => e.field)).toContain("clientCompanyName");
    expect(errors.map((e) => e.field)).toContain("brandProfile");
  });

  it("detects extra variable not in template (warning)", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "email-generate",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "cold-email",
            "body.variables.leadFirstName": "$ref:lead.output.firstName",
            "body.variables.leadLastName": "$ref:lead.output.lastName",
            "body.variables.leadTitle": "$ref:lead.output.title",
            "body.variables.leadCompanyName": "$ref:lead.output.orgName",
            "body.variables.leadCompanyIndustry": "$ref:lead.output.industry",
            "body.variables.clientCompanyName": "$ref:brand.output.name",
            "body.variables.brandProfile": "$ref:brand.output.profile",
            "body.variables.targetUrl": "https://example.com",
            "body.variables.callToAction": "click here",
          },
        },
      ],
      edges: [],
    };

    const templates = new Map([["cold-email", COLD_EMAIL_TEMPLATE]]);
    const result = validateTemplateContracts(dag, templates);

    // Extra vars are warnings, not errors → still valid
    expect(result.valid).toBe(true);
    const warnings = result.issues.filter((i) => i.severity === "warning");
    expect(warnings.length).toBe(2);
    expect(warnings.map((w) => w.field)).toContain("targetUrl");
    expect(warnings.map((w) => w.field)).toContain("callToAction");
  });

  it("warns when template is not found in content-generation", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "email-generate",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "unknown-template",
            "body.variables.foo": "bar",
          },
        },
      ],
      edges: [],
    };

    const templates = new Map<string, PromptTemplate>();
    const result = validateTemplateContracts(dag, templates);

    // Template not found → warning, not error (could be org-specific prompt)
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("warning");
    expect(result.issues[0].reason).toContain("not found");
  });

  it("reproduces the Headwaters bug: brandProfile provided but clientCompanyName missing", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "email-generate",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "cold-email",
            "body.variables.leadTitle": "$ref:fetch-lead.output.lead.data.title",
            "body.variables.targetUrl": "https://pressbeat.io",
            "body.variables.brandProfile": "$ref:brand-profile.output",
            "body.variables.callToAction": "click to visit PressBean.io",
            "body.variables.leadLastName": "$ref:fetch-lead.output.lead.data.lastName",
            "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
            "body.variables.leadCompanyName": "$ref:fetch-lead.output.lead.data.organizationName",
            "body.variables.leadCompanyIndustry": "$ref:fetch-lead.output.lead.data.organizationIndustry",
          },
        },
      ],
      edges: [],
    };

    const templates = new Map([["cold-email", COLD_EMAIL_TEMPLATE]]);
    const result = validateTemplateContracts(dag, templates);

    // clientCompanyName is missing → error
    expect(result.valid).toBe(false);
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("clientCompanyName");

    // targetUrl and callToAction are extra → warnings
    const warnings = result.issues.filter((i) => i.severity === "warning");
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.field)).toContain("targetUrl");
    expect(warnings.map((w) => w.field)).toContain("callToAction");
  });

  it("returns empty result for DAG with no content-generation nodes", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
        },
      ],
      edges: [],
    };

    const templates = new Map<string, PromptTemplate>();
    const result = validateTemplateContracts(dag, templates);

    expect(result.valid).toBe(true);
    expect(result.templateRefs).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
  });
});
