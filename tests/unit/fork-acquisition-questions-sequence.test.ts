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
  templateTokens,
  buildTemplate,
  withAcquisitionQuestions,
  findGenerateNode,
} from "../../scripts/fork-acquisition-questions-sequence.mjs";

const TOKENS = [
  "currentDate", "leadFirstName", "leadLastName", "leadHeadline", "leadCompanyName", "leadCompanyIndustry",
  "leadCompanySize", "leadCompanyDescription", "leadCompanyKeywords", "brandExtractedFields",
];

/** v26 as content-generation serves it (v15 stores empty descriptions): more tokens than the new body states. */
const V26 = {
  type: "blind-discovery-email-v26",
  variables: [...TOKENS, "leadCompanyTechStack"].map((name) => ({ name, description: `the ${name}` })),
};

/** Shaped after the lithium head: the content call maps every v26 token plus the recipient context. */
function sourceDag(): DAG {
  const mapping: Record<string, string> = { "body.leadId": "$ref:fetch-lead.output.lead.leadId" };
  for (const t of [...TOKENS, "leadCompanyTechStack", "brands", "leadCity"]) mapping[`body.variables.${t}`] = `$ref:fetch-lead.output.lead.data.${t}`;
  return {
    nodes: [
      { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" } },
      {
        id: "email-generate",
        type: "http.call",
        config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "blind-discovery-email-v33", model: "glm-pro" } },
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

describe("the acquisition-questions sequence (owner-approved, 2026-10-03)", () => {
  it("ships the owner's text as is: the two questions, the honesty rules, no dash", () => {
    expect(TEMPLATE_TYPE).toBe("acquisition-questions-email-v1");
    expect(TEMPLATE_PROMPT).toContain("If I sent you 10 people for [specific service], what would you charge per person?");
    expect(TEMPLATE_PROMPT).toContain("The volume is a HYPOTHETICAL. Never claim you have a group, a list, or people waiting.");
    expect(TEMPLATE_PROMPT).toContain("Never name the client's product or brand, or its URL, in this sequence.");
    // Owner amendment: v15's TRUE blind variant, no brands data in the prompt at all.
    expect(TEMPLATE_PROMPT).toContain("## Brand Intelligence (internal only, never reveal the client name or URL)");
    expect(TEMPLATE_PROMPT).not.toContain("{{brands}}");
    expect(TEMPLATE_PROMPT).toContain("Never use an em dash or en dash.");
    expect(TEMPLATE_PROMPT).not.toMatch(/[–—]/);
    expect(templateTokens(TEMPLATE_PROMPT)).toEqual(TOKENS);
  });

  it("declares exactly the body's tokens, described by v26, and refuses an undescribed one", () => {
    const t = buildTemplate(V26);
    expect(t.type).toBe(TEMPLATE_TYPE);
    expect(t.variables.map((v: { name: string }) => v.name)).toEqual(TOKENS);
    expect(t.variables[0]).toEqual({ name: "currentDate", description: "the currentDate" });
    const missing = { ...V26, variables: V26.variables.filter((v) => v.name !== "leadHeadline") };
    expect(() => buildTemplate(missing)).toThrow(/no description for "\{\{leadHeadline\}\}"/);
    // v15's stored shape: every name, every description empty.
    const blank = { ...V26, variables: V26.variables.map((v) => ({ ...v, description: "" })) };
    expect(() => buildTemplate(blank)).toThrow(/no description/);
  });

  it("forks only the content call onto the new template and GLM-5.3", () => {
    const src = sourceDag();
    const fork = withAcquisitionQuestions(src);
    expect(findGenerateNode(fork).config.body).toEqual({ type: TEMPLATE_TYPE, model: MODEL });
    expect(MODEL).toBe("glm-pro");
    expect(findGenerateNode(src).config.body.type).toBe("blind-discovery-email-v33");
    expect(fork.edges).toEqual(src.edges);
    expect(findGenerateNode(fork).inputMapping).toEqual(findGenerateNode(src).inputMapping);
    expect(validateDAG(fork).valid).toBe(true);
    expect(computeDAGSignature(fork)).not.toBe(computeDAGSignature(src));
  });

  it("satisfies the template contract it stores (extra mapped facts are context, never errors)", () => {
    const t = buildTemplate(V26);
    const result = validateTemplateContracts(
      withAcquisitionQuestions(sourceDag()),
      new Map([[TEMPLATE_TYPE, { ...t, contextVariables: [{ name: "leadCity", description: "city" }] }]]),
    );
    expect(result.valid).toBe(true);
    // The source still maps brands; the template no longer reads it, which is a warning, never an error.
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("refuses a source whose content call leaves a token unmapped", () => {
    const src = sourceDag();
    delete findGenerateNode(src).inputMapping["body.variables.leadHeadline"];
    expect(() => withAcquisitionQuestions(src)).toThrow(/leadHeadline/);
  });
});
