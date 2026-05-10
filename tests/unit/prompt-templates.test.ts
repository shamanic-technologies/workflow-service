import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/lib/prompt-templates.js";

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt();

  it("uses cold-email as the canonical prompt type for content-generation", () => {
    // The example DAG should use "cold-email" as the prompt type, not "email" or "cold_outreach"
    expect(prompt).toContain('"type": "cold-email"');
    expect(prompt).not.toMatch(/"type":\s*"email"/);
    expect(prompt).not.toContain('"type": "cold_outreach"');
  });

  it("passes sequence array to email-gateway (not bodyHtml)", () => {
    // email-send node should reference the generated sequence array, not bodyHtml.
    // Output paths are placeholders ("<path to ...>") that the LLM resolves from
    // the live OpenAPI spec — we only assert intent is preserved.
    expect(prompt).toContain('"body.sequence"');
    expect(prompt).toMatch(/\$ref:email-generate\.output\.<[^>]*sequence[^>]*>/);
    expect(prompt).not.toMatch(/\$ref:email-generate\.output\.bodyHtml/);
  });

  it("includes required content-generation fields in the example", () => {
    // content-generation POST /generate requires type and variables
    expect(prompt).toContain("body.variables.leadEmail");
    expect(prompt).toContain("body.brandId");
    expect(prompt).toContain("body.campaignId");
    expect(prompt).toContain("body.leadId");
  });

  it("includes required email-gateway broadcast fields in the example", () => {
    // broadcast send requires recipientFirstName, recipientLastName, recipientCompany
    expect(prompt).toContain("body.recipientFirstName");
    expect(prompt).toContain("body.recipientLastName");
    expect(prompt).toContain("body.recipientCompany");
  });

  it("documents the content-generation + email send pattern", () => {
    expect(prompt).toContain("Content Generation + Email Send Pattern");
    expect(prompt).toContain('body.type` MUST be "cold-email"');
    expect(prompt).toContain("body.variables` MUST contain FLAT keys only");
    expect(prompt).toContain("variable-length");
  });

  it("forbids cost-tracking nodes in workflows", () => {
    expect(prompt).toContain("NEVER include cost-tracking nodes");
    expect(prompt).toContain("handled internally by each downstream service");
  });
});
