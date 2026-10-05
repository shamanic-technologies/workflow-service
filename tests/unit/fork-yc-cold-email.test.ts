import { describe, it, expect } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import { validateTemplateContracts } from "../../src/lib/validate-template-contracts.js";
import type { DAG } from "../../src/types.js";
// @ts-expect-error — plain .mjs ops script, no type declarations
import {
  TEMPLATE_TYPE,
  TEMPLATE_PROMPT,
  MODEL,
  LEG_KEY,
  templateTokens,
  buildTemplate,
  withYcColdEmail,
  findGenerateNode,
  otherAssignmentsMoved,
} from "../../scripts/fork-yc-cold-email.mjs";

/** cold-email-v33's fourteen variables, in its stored order. */
const TOKENS = [
  "leadFirstName", "leadLastName", "leadTitle", "leadHeadline", "leadCompanyName", "leadCompanyIndustry",
  "leadCompanySize", "leadCompanyFundingStage", "leadCompanyDescription", "leadCompanyKeywords",
  "leadCompanyTechStack", "clientName", "clientWebsite", "brandExtractedFields",
];

const V33 = { type: "cold-email-v33", variables: TOKENS.map((name) => ({ name, description: `the ${name}` })) };

/** Shaped after the osprey head: the content call maps every v33 token plus recipient context. */
function sourceDag(): DAG {
  const mapping: Record<string, string> = { "body.leadId": "$ref:fetch-lead.output.lead.leadId" };
  for (const t of [...TOKENS, "leadCity"]) mapping[`body.variables.${t}`] = `$ref:fetch-lead.output.lead.data.${t}`;
  return {
    nodes: [
      { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" } },
      {
        id: "email-generate",
        type: "http.call",
        config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email-v55", model: "flash" } },
        inputMapping: mapping,
      },
      { id: "email-send", type: "http.call", config: { service: "email-gateway", method: "POST", path: "/orgs/send" } },
    ],
    edges: [
      { from: "fetch-lead", to: "email-generate" },
      { from: "email-generate", to: "email-send" },
    ],
  } as DAG;
}

describe("the YC cold-email sequence (owner-approved, 2026-10-05)", () => {
  it("ships the owner's text: three sentences, no meeting ask, no dash, v33's fourteen tokens", () => {
    expect(TEMPLATE_TYPE).toBe("yc-cold-email-v1");
    expect(TEMPLATE_PROMPT.startsWith("You're writing a 3-email cold sequence on behalf of a client.")).toBe(true);
    expect(TEMPLATE_PROMPT).toContain("## Email 1: three sentences");
    expect(TEMPLATE_PROMPT).toContain("Never ask for a meeting, a call or a demo. Let them escalate.");
    expect(TEMPLATE_PROMPT).toContain("No em dashes, no en dashes.");
    expect(TEMPLATE_PROMPT.endsWith("Output: the three emails, ready to send. Nothing else.")).toBe(true);
    expect(TEMPLATE_PROMPT).not.toMatch(/[–—]/);
    expect(TEMPLATE_PROMPT).not.toContain("{{currentDate}}");
    expect(templateTokens(TEMPLATE_PROMPT)).toEqual(TOKENS);
  });

  it("declares exactly the body's tokens, described by v33, and refuses an undescribed one", () => {
    const t = buildTemplate(V33);
    expect(t.type).toBe(TEMPLATE_TYPE);
    expect(t.prompt).toBe(TEMPLATE_PROMPT);
    expect(t.variables.map((v: { name: string }) => v.name)).toEqual(TOKENS);
    const missing = { ...V33, variables: V33.variables.filter((v) => v.name !== "clientWebsite") };
    expect(() => buildTemplate(missing)).toThrow(/no description for "\{\{clientWebsite\}\}"/);
    const blank = { ...V33, variables: V33.variables.map((v) => ({ ...v, description: " " })) };
    expect(() => buildTemplate(blank)).toThrow(/no description/);
  });

  it("forks only the content call onto the new template and GLM Pro", () => {
    const src = sourceDag();
    const fork = withYcColdEmail(src);
    expect(MODEL).toBe("glm-pro");
    expect(findGenerateNode(fork).config.body).toEqual({ type: TEMPLATE_TYPE, model: MODEL });
    expect(findGenerateNode(src).config.body.type).toBe("cold-email-v55");
    expect(fork.edges).toEqual(src.edges);
    expect(fork.nodes.filter((n: { id: string }) => n.id !== "email-generate"))
      .toEqual(src.nodes.filter((n) => n.id !== "email-generate"));
    expect(findGenerateNode(fork).inputMapping).toEqual(findGenerateNode(src).inputMapping);
    expect(validateDAG(fork).valid).toBe(true);
    expect(computeDAGSignature(fork)).not.toBe(computeDAGSignature(src));
  });

  it("satisfies the template contract it stores", () => {
    const t = buildTemplate(V33);
    const result = validateTemplateContracts(
      withYcColdEmail(sourceDag()),
      new Map([[TEMPLATE_TYPE, { ...t, contextVariables: [{ name: "leadCity", description: "city" }] }]]),
    );
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("refuses a blind source, whose content call maps no client name or website", () => {
    const src = sourceDag();
    delete findGenerateNode(src).inputMapping["body.variables.clientName"];
    delete findGenerateNode(src).inputMapping["body.variables.clientWebsite"];
    expect(() => withYcColdEmail(src)).toThrow(/clientName.*clientWebsite/);
  });
});

describe("the leg write touches only the new dynasty", () => {
  const row = (slug: string, state = "active") => ({
    featureSlug: "sales-cold-email-outreach", legKey: LEG_KEY, workflowDynastySlug: slug,
    state, decidedBy: "seed", decidedAt: "2026-09-27T11:01:44Z", note: null,
  });
  const before = [row("a"), row("b", "deprecated")];

  it("reports nothing when only the new dynasty was added", () => {
    expect(otherAssignmentsMoved(before, [...before, row("new")], "new")).toEqual([]);
  });

  it("reports any other row that changed, vanished or appeared", () => {
    const key = (s: string) => `sales-cold-email-outreach|${LEG_KEY}|${s}`;
    expect(otherAssignmentsMoved(before, [row("a"), row("b"), row("new")], "new")).toEqual([key("b")]);
    expect(otherAssignmentsMoved(before, [row("a"), row("new")], "new")).toEqual([key("b")]);
    expect(otherAssignmentsMoved(before, [...before, row("c"), row("new")], "new")).toEqual([key("c")]);
  });
});
