import { describe, it, expect } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import { validateTemplateContracts } from "../../src/lib/validate-template-contracts.js";
import type { DAG } from "../../src/types.js";
// @ts-expect-error — plain .mjs ops script, no type declarations
import { TEMPLATE_TYPE, TEMPLATE_PROMPT, MODEL, LEG_KEY, DEFAULT_SOURCE_DYNASTY, SPEC, buildTemplate, withYcClickColdEmail } from "../../scripts/fork-yc-cold-email-click.mjs";
// @ts-expect-error — plain .mjs ops script, no type declarations
import { templateTokens, findGenerateNode, SPEC as REPLY_SPEC } from "../../scripts/fork-yc-cold-email.mjs";

/** cold-email-v35's nine variables, in its stored order. */
const TOKENS = [
  "leadFirstName", "leadLastName", "leadTitle", "leadCompanyName", "leadCompanyIndustry",
  "leadCompanySize", "brandProfile", "brandExtractedFields", "brandWebsiteUrl",
];
const V35 = { type: "cold-email-v35", variables: TOKENS.map((name) => ({ name, description: `the ${name}` })) };

/** Shaped after the rampart head: the content call maps every v35 token plus recipient context. */
function sourceDag(): DAG {
  const mapping: Record<string, string> = { "body.leadId": "$ref:fetch-lead.output.lead.leadId" };
  for (const t of [...TOKENS, "leadCity"]) mapping[`body.variables.${t}`] = `$ref:fetch-lead.output.lead.data.${t}`;
  return {
    nodes: [
      { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" } },
      {
        id: "email-generate",
        type: "http.call",
        config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email-v53", model: "flash" } },
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

describe("the YC website-visit sequence (owner-approved, 2026-10-05)", () => {
  it("ships the owner's text: the click is the only ask, exact link last, no dash, v35's nine tokens", () => {
    expect(TEMPLATE_TYPE).toBe("yc-cold-email-click-v1");
    expect(LEG_KEY).toBe("start_to_website_visit");
    expect(DEFAULT_SOURCE_DYNASTY).toBe("sales-cold-email-outreach-rampart");
    expect(TEMPLATE_PROMPT.startsWith("You're writing a 3-email cold sequence on behalf of a client.")).toBe(true);
    expect(TEMPLATE_PROMPT).toContain("Every email has one goal: the prospect clicks the client's link.");
    expect(TEMPLATE_PROMPT).toContain("Never ask for a meeting, a call, a demo or a reply. The only ask is the click.");
    expect(TEMPLATE_PROMPT).toContain("Never shorten it to the domain. It sits alone on its own line, as the last line of every email.");
    expect(TEMPLATE_PROMPT.endsWith("Output: the three emails, ready to send. Nothing else.")).toBe(true);
    expect(TEMPLATE_PROMPT).not.toMatch(/[–—]/);
    expect([...templateTokens(TEMPLATE_PROMPT)].sort()).toEqual([...TOKENS].sort());
  });

  it("declares exactly the body's tokens, described by v35, and refuses an undescribed one", () => {
    const t = buildTemplate(V35);
    expect(t.type).toBe(TEMPLATE_TYPE);
    expect(t.prompt).toBe(TEMPLATE_PROMPT);
    expect(t.variables.map((v: { name: string }) => v.name).sort()).toEqual([...TOKENS].sort());
    expect(t.variables.every((v: { name: string; description: string }) => v.description === `the ${v.name}`)).toBe(true);
    const missing = { ...V35, variables: V35.variables.filter((v) => v.name !== "brandWebsiteUrl") };
    expect(() => buildTemplate(missing)).toThrow(/no description for "\{\{brandWebsiteUrl\}\}"/);
  });

  it("changes only the content call's template; the model stays rampart's flash (Gemini 3.5 Flash-Lite)", () => {
    const src = sourceDag();
    const fork = withYcClickColdEmail(src);
    expect(MODEL).toBe("flash");
    expect(findGenerateNode(fork).config.body).toEqual({ type: TEMPLATE_TYPE, model: "flash" });
    expect(findGenerateNode(src).config.body.type).toBe("cold-email-v53");
    expect(fork.edges).toEqual(src.edges);
    expect(fork.nodes.filter((n: { id: string }) => n.id !== "email-generate"))
      .toEqual(src.nodes.filter((n) => n.id !== "email-generate"));
    expect(findGenerateNode(fork).inputMapping).toEqual(findGenerateNode(src).inputMapping);
    expect(validateDAG(fork).valid).toBe(true);
    expect(computeDAGSignature(fork)).not.toBe(computeDAGSignature(src));
  });

  it("satisfies the template contract it stores", () => {
    const t = buildTemplate(V35);
    const result = validateTemplateContracts(
      withYcClickColdEmail(sourceDag()),
      new Map([[TEMPLATE_TYPE, { ...t, contextVariables: [{ name: "leadCity", description: "city" }] }]]),
    );
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("refuses a source that does not map the client link", () => {
    const src = sourceDag();
    delete findGenerateNode(src).inputMapping["body.variables.brandWebsiteUrl"];
    expect(() => withYcClickColdEmail(src)).toThrow(/brandWebsiteUrl/);
  });

  it("leaves the reply twin's spec as it shipped", () => {
    expect(REPLY_SPEC.templateType).toBe("yc-cold-email-v1");
    expect(REPLY_SPEC.legKey).toBe("start_to_conversation");
    expect(REPLY_SPEC.model).toBe("glm-pro");
    expect(SPEC.templateType).not.toBe(REPLY_SPEC.templateType);
  });
});
