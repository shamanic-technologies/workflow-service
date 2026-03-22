import { describe, it, expect } from "vitest";
import { buildSystemPrompt, DAG_GENERATION_TOOL } from "../../src/lib/prompt-templates.js";

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt();

  it("uses cold-email as the canonical prompt type for content-generation", () => {
    // The example DAG should use "cold-email" as the prompt type, not "email" or "cold_outreach"
    expect(prompt).toContain('"type": "cold-email"');
    expect(prompt).not.toMatch(/"type":\s*"email"/);
    expect(prompt).not.toContain('"type": "cold_outreach"');
  });

  it("passes sequence array to email-gateway (not bodyHtml)", () => {
    // email-send node should reference sequence, not bodyHtml
    expect(prompt).toContain("$ref:email-generate.output.sequence");
    expect(prompt).not.toContain("$ref:email-generate.output.bodyHtml");
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

  it("includes discovery workflow documentation with campaign-service endpoints", () => {
    expect(prompt).toContain("/campaigns/{campaignId}/discovered-outlets");
    expect(prompt).toContain("/campaigns/{campaignId}/discovered-journalists");
  });

  it("includes outlet discovery example DAG with send-discovered-outlets step", () => {
    expect(prompt).toContain('"id": "discover-outlets"');
    expect(prompt).toContain('"id": "send-discovered-outlets"');
    expect(prompt).toContain("body.outlets");
    expect(prompt).toContain("$ref:discover-outlets.output.outlets");
  });

  it("documents discovery workflow channel as database", () => {
    expect(prompt).toContain('channel is "database"');
  });
});

describe("DAG_GENERATION_TOOL", () => {
  const schema = DAG_GENERATION_TOOL.input_schema;

  it("includes outlets and journalists in category enum", () => {
    const categoryEnum = schema.properties.category.enum;
    expect(categoryEnum).toContain("outlets");
    expect(categoryEnum).toContain("journalists");
  });

  it("includes database in channel enum", () => {
    const channelEnum = schema.properties.channel.enum;
    expect(channelEnum).toContain("database");
  });

  it("includes discovery in audienceType enum", () => {
    const audienceEnum = schema.properties.audienceType.enum;
    expect(audienceEnum).toContain("discovery");
  });
});
