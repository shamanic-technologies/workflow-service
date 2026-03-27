import { describe, it, expect } from "vitest";
import { buildInputTransforms } from "../../src/lib/input-mapping.js";

describe("buildInputTransforms", () => {
  it("translates $ref:node.output.field to javascript transform", () => {
    const result = buildInputTransforms(undefined, {
      leadData: "$ref:lead-search.output.lead",
    });

    expect(result.leadData).toEqual({
      type: "javascript",
      expr: "results.lead_search?.lead",
    });
  });

  it("translates $ref:flow_input.field to javascript transform", () => {
    const result = buildInputTransforms(undefined, {
      brandIntel: "$ref:flow_input.brandIntel",
    });

    expect(result.brandIntel).toEqual({
      type: "javascript",
      expr: "flow_input.brandIntel",
    });
  });

  it("handles nested output paths with optional chaining", () => {
    const result = buildInputTransforms(undefined, {
      email: "$ref:lead-search.output.lead.email",
    });

    expect(result.email).toEqual({
      type: "javascript",
      expr: "results.lead_search?.lead?.email",
    });
  });

  it("uses optional chaining for deeply nested output paths", () => {
    const result = buildInputTransforms(undefined, {
      email: "$ref:fetch-lead.output.lead.data.email",
    });

    expect(result.email).toEqual({
      type: "javascript",
      expr: "results.fetch_lead?.lead?.data?.email",
    });
  });

  it("does not use optional chaining for single-level output paths", () => {
    const result = buildInputTransforms(undefined, {
      runId: "$ref:start-run.output.runId",
    });

    expect(result.runId).toEqual({
      type: "javascript",
      expr: "results.start_run?.runId",
    });
  });

  it("treats non-$ref strings as static values", () => {
    const result = buildInputTransforms(undefined, {
      channel: "email",
    });

    expect(result.channel).toEqual({
      type: "static",
      value: "email",
    });
  });

  it("spreads config entries as individual static transforms", () => {
    const result = buildInputTransforms(
      { source: "apollo", limit: 10 },
      undefined
    );

    expect(result.source).toEqual({ type: "static", value: "apollo" });
    expect(result.limit).toEqual({ type: "static", value: 10 });
    expect(result.config).toBeUndefined();
  });

  it("combines config and inputMapping as individual transforms", () => {
    const result = buildInputTransforms(
      { contentType: "cold-email" },
      { leadData: "$ref:lead-search.output.lead" }
    );

    expect(result.contentType).toEqual({
      type: "static",
      value: "cold-email",
    });
    expect(result.leadData).toEqual({
      type: "javascript",
      expr: "results.lead_search?.lead",
    });
    expect(result.config).toBeUndefined();
  });

  it("translates $ref:flow_input (whole object) to javascript transform", () => {
    const result = buildInputTransforms(undefined, {
      body: "$ref:flow_input",
    });

    expect(result.body).toEqual({
      type: "javascript",
      expr: "flow_input",
    });
  });

  it("returns empty object for no inputs", () => {
    const result = buildInputTransforms(undefined, undefined);
    expect(result).toEqual({});
  });

  it("collapses dot-notation keys into a nested object expression", () => {
    const result = buildInputTransforms(undefined, {
      "body.campaignId": "$ref:flow_input.campaignId",
      "body.orgId": "$ref:flow_input.orgId",
    });

    // Should NOT have flat dot-notation keys
    expect(result["body.campaignId"]).toBeUndefined();
    expect(result["body.orgId"]).toBeUndefined();

    // Should have a single body transform with a JavaScript expression
    expect(result.body).toBeDefined();
    expect(result.body.type).toBe("javascript");
    expect(result.body.expr).toContain("flow_input.campaignId");
    expect(result.body.expr).toContain("flow_input.orgId");
  });

  it("merges dot-notation keys with static config base", () => {
    const result = buildInputTransforms(
      { body: { tag: "cold-email", type: "broadcast" } },
      { "body.to": "$ref:start-run.output.email" },
    );

    expect(result.body).toBeDefined();
    expect(result.body.type).toBe("javascript");
    // Should spread the static base and add the dynamic field
    expect(result.body.expr).toContain('"cold-email"');
    expect(result.body.expr).toContain("results.start_run?.email");
  });

  it("merges deeply nested dot-notation with static nested object", () => {
    const result = buildInputTransforms(
      { body: { metadata: { source: "test" } } },
      { "body.metadata.generationId": "$ref:gen.output.id" },
    );

    expect(result.body).toBeDefined();
    expect(result.body.type).toBe("javascript");
    // Should spread the static metadata and add the dynamic field
    expect(result.body.expr).toContain('"source"');
    expect(result.body.expr).toContain("results.gen?.id");
  });

  it("regression: does not replace scalar config with collapsed object", () => {
    const result = buildInputTransforms(
      { path: "/runs/:id/costs", service: "runs", method: "POST" },
      { "path.id": "$ref:start-run.output.runId" },
    );

    // path should remain the scalar string — NOT be replaced by { id: expr }
    expect(result.path).toEqual({ type: "static", value: "/runs/:id/costs" });
    // The dot-notation key should be preserved as-is since root is scalar
    expect(result["path.id"]).toBeDefined();
    expect(result["path.id"].type).toBe("javascript");
    expect(result["path.id"].expr).toContain("results.start_run?.runId");
  });

  it("uses bracket notation for numeric path segments", () => {
    const result = buildInputTransforms(undefined, {
      brand: "$ref:brand-profile.output.brands.0",
    });

    expect(result.brand).toEqual({
      type: "javascript",
      expr: 'results.brand_profile?.brands?.["0"]',
    });

    // Verify the expression is valid JavaScript
    expect(() => new Function("results", `return ${result.brand.expr!}`)).not.toThrow();
  });

  it("uses bracket notation for numeric segments in deep paths", () => {
    const result = buildInputTransforms(undefined, {
      name: "$ref:brand-profile.output.brands.0.name",
    });

    expect(result.name).toEqual({
      type: "javascript",
      expr: 'results.brand_profile?.brands?.["0"]?.name',
    });

    expect(() => new Function("results", `return ${result.name.expr!}`)).not.toThrow();
  });

  it("regression: numeric index in collapsed body expression produces valid JS", () => {
    const result = buildInputTransforms(
      { body: { type: "pr-cold-email-v2" } },
      {
        "body.variables.brandProfile": "$ref:brand-profile.output.brands.0",
        "body.variables.companyName": "$ref:brand-profile.output.brands.0.name",
      },
    );

    expect(result.body).toBeDefined();
    expect(result.body.type).toBe("javascript");
    // The collapsed expression must be valid JavaScript
    expect(() => new Function("results", "flow_input", `return ${result.body.expr!}`)).not.toThrow();
    expect(result.body.expr).toContain('?.["0"]');
  });

  it("regression: body.variables.* $ref expressions coalesce to empty string", () => {
    const result = buildInputTransforms(
      { body: { type: "cold-email" } },
      {
        "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
        "body.variables.clientCompanyOverview": "$ref:brand-profile.output.profile.companyOverview",
        "body.brandId": "$ref:start-run.output.brandId",
      },
    );

    expect(result.body).toBeDefined();
    expect(result.body.type).toBe("javascript");

    // body.variables.* expressions should coalesce undefined to ""
    expect(result.body.expr).toContain('results.fetch_lead?.lead?.data?.firstName ?? ""');
    expect(result.body.expr).toContain('results.brand_profile?.profile?.companyOverview ?? ""');

    // Non-variables $ref should NOT coalesce
    expect(result.body.expr).toMatch(/results\.start_run\?\.brandId(?!\s*\?\?)/);

    // Expression should be valid JavaScript
    expect(() => new Function("results", "flow_input", `return ${result.body.expr!}`)).not.toThrow();

    // When upstream returns undefined, variables should be "" not undefined
    const fn = new Function("results", "flow_input", `return ${result.body.expr!}`);
    const output = fn({}, {});
    expect(output.variables.leadFirstName).toBe("");
    expect(output.variables.clientCompanyOverview).toBe("");
  });

  it("leaves non-dot-notation keys untouched", () => {
    const result = buildInputTransforms(
      { service: "stripe", method: "GET" },
      { "body.field": "$ref:flow_input.data" },
    );

    // Non-dot keys should remain as-is
    expect(result.service).toEqual({ type: "static", value: "stripe" });
    expect(result.method).toEqual({ type: "static", value: "GET" });
    // Dot key should be collapsed
    expect(result.body).toBeDefined();
    expect(result.body.type).toBe("javascript");
  });
});
