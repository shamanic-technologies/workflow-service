import { describe, it, expect } from "vitest";
import { buildInputTransforms } from "../../src/lib/input-mapping.js";

describe("buildInputTransforms", () => {
  it("translates $ref:node.output.field to javascript transform", () => {
    const result = buildInputTransforms(undefined, {
      leadData: "$ref:lead-search.output.lead",
    });

    expect(result.leadData).toEqual({
      type: "javascript",
      expr: "results.lead_search.lead",
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

  it("handles nested output paths", () => {
    const result = buildInputTransforms(undefined, {
      email: "$ref:lead-search.output.lead.email",
    });

    expect(result.email).toEqual({
      type: "javascript",
      expr: "results.lead_search.lead.email",
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

  it("adds config as static transform", () => {
    const result = buildInputTransforms(
      { source: "apollo", limit: 10 },
      undefined
    );

    expect(result.config).toEqual({
      type: "static",
      value: { source: "apollo", limit: 10 },
    });
  });

  it("combines config and inputMapping", () => {
    const result = buildInputTransforms(
      { contentType: "cold-email" },
      { leadData: "$ref:lead-search.output.lead" }
    );

    expect(result.config).toBeDefined();
    expect(result.leadData).toBeDefined();
  });

  it("returns empty object for no inputs", () => {
    const result = buildInputTransforms(undefined, undefined);
    expect(result).toEqual({});
  });
});
