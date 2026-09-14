import { describe, it, expect } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import { validateTemplateContracts } from "../../src/lib/validate-template-contracts.js";
import type { DAG } from "../../src/types.js";
// @ts-expect-error — plain .mjs ops script, no type declarations
import {
  withLandingPage,
  hasLandingPage,
  deriveLeadRoot,
  deriveAnchor,
  findGenerateNode,
  LANDING_VARIABLE,
  TEMPLATE_SUFFIX,
  NO_LANDING_PAGE,
  MIN_USABLE_CHARS,
  MAX_CONTENT_CHARS,
  RESOLVE_URL_CODE,
  LANDING_CONTENT_CODE,
  TEMPLATE_ANCHOR,
  TEMPLATE_BLOCK,
  LANDING_VARIABLE_DESCRIPTION,
  buildForkedTemplate,
  hasLandingBlock,
} from "../../scripts/fork-dynasty-with-landing-page.mjs";

/**
 * Shaped after the three live heads this script targets. `extra` is what makes
 * them differ: ballad routes through a `brand-profile`, lithium adds a second
 * predecessor (`brands-fetch`) into the generate node, azalea has neither — and
 * the splice has to land in the same place in all three.
 */
function coldEmailDag(opts: {
  template: string;
  leadNode?: string;
  extraPredecessor?: boolean;
  viaBrandProfile?: boolean;
}): DAG {
  const lead = opts.leadNode ?? "fetch-lead";
  const leadRoot = `${lead}.output.lead`;

  const nodes: DAG["nodes"] = [
    { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
    { id: lead, type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" } },
    { id: "check-lead", type: "condition", config: {} },
    {
      id: "brand-extract-fields",
      type: "http.call",
      config: { service: "brand", method: "POST", path: "/orgs/brands/extract-fields" },
    },
    {
      id: "email-generate",
      type: "http.call",
      config: {
        service: "content-generation",
        method: "POST",
        path: "/generate",
        body: { type: opts.template, model: "pro" },
      },
      retries: 0,
      inputMapping: {
        "body.leadId": `$ref:${leadRoot}.leadId`,
        "body.variables.leadFirstName": `$ref:${leadRoot}.data.firstName`,
        "body.variables.leadCompanyName": `$ref:${leadRoot}.data.organization.name`,
        "body.variables.leadCompanyWebsiteUrl": `$ref:${leadRoot}.data.organization.websiteUrl`,
        "body.variables.brandExtractedFields": "$ref:brand-extract-fields.output.fields",
      },
    },
    { id: "email-send", type: "http.call", config: { service: "email-gateway", method: "POST", path: "/send" } },
    { id: "end-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run" } },
  ];

  const edges: DAG["edges"] = [
    { from: "start-run", to: lead },
    { from: lead, to: "check-lead" },
    { from: "email-generate", to: "email-send" },
    { from: "email-send", to: "end-run" },
  ];

  if (opts.viaBrandProfile) {
    nodes.push({
      id: "brand-profile",
      type: "http.call",
      config: { service: "brand", method: "GET", path: "/internal/brands/{brandId}" },
    });
    edges.push(
      { from: "check-lead", to: "brand-profile", condition: "results['fetch-lead'].found == true" },
      { from: "brand-profile", to: "brand-extract-fields" },
    );
  } else {
    edges.push({ from: "check-lead", to: "brand-extract-fields", condition: "results['fetch-lead'].found == true" });
  }

  edges.push({ from: "brand-extract-fields", to: "email-generate" });

  if (opts.extraPredecessor) {
    nodes.push({
      id: "brands-fetch",
      type: "http.call",
      config: { service: "brand", method: "GET", path: "/orgs/brands" },
    });
    edges.push(
      { from: "check-lead", to: "brands-fetch", condition: "results['fetch-lead'].found == true" },
      { from: "brands-fetch", to: "email-generate" },
    );
  }

  return { nodes, edges };
}

const HEADS = [
  { name: "ballad", dag: () => coldEmailDag({ template: "cold-email-v39", viaBrandProfile: true }) },
  { name: "azalea", dag: () => coldEmailDag({ template: "blind-discovery-email-v9" }) },
  { name: "lithium", dag: () => coldEmailDag({ template: "blind-discovery-email-v26", extraPredecessor: true }) },
];

describe("fork-dynasty-with-landing-page", () => {
  describe.each(HEADS)("$name", ({ dag: build }) => {
    it("produces a DAG the validator accepts", () => {
      const result = validateDAG(withLandingPage(build()));
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it("splices the three nodes between the brand fields and the generate call", () => {
      const forked = withLandingPage(build());
      const ids = forked.nodes.map((n: { id: string }) => n.id);

      expect(ids).toContain("resolve-landing-url");
      expect(ids).toContain("scrape-landing");
      expect(ids).toContain("landing-content");

      const edge = (from: string, to: string) =>
        forked.edges.some((e: { from: string; to: string }) => e.from === from && e.to === to);

      expect(edge("brand-extract-fields", "resolve-landing-url")).toBe(true);
      expect(edge("resolve-landing-url", "scrape-landing")).toBe(true);
      expect(edge("scrape-landing", "landing-content")).toBe(true);
      expect(edge("landing-content", "email-generate")).toBe(true);
      // The edge it replaced must be gone, or the generate call runs before the
      // scrape has produced anything and the variable is empty on every lead.
      expect(edge("brand-extract-fields", "email-generate")).toBe(false);
    });

    it("leaves every other predecessor of the generate call wired as it was", () => {
      const source = build();
      const forked = withLandingPage(source);

      const others = source.edges.filter(
        (e) => e.to === "email-generate" && e.from !== "brand-extract-fields",
      );
      for (const e of others) {
        expect(
          forked.edges.some((f: { from: string; to: string }) => f.from === e.from && f.to === e.to),
        ).toBe(true);
      }
    });

    it("repoints the generate call at the forked template and maps the variable", () => {
      const source = build();
      const forked = withLandingPage(source);
      const before = findGenerateNode(source);
      const after = findGenerateNode(forked);

      expect(after.config.body.type).toBe(`${before.config.body.type}${TEMPLATE_SUFFIX}`);
      expect(after.config.body.model).toBe("pro");
      expect(after.inputMapping[`body.variables.${LANDING_VARIABLE}`]).toBe(
        "$ref:landing-content.output.value",
      );
    });

    it("keeps every variable the source already mapped", () => {
      const source = build();
      const forked = withLandingPage(source);
      for (const [key, ref] of Object.entries(findGenerateNode(source).inputMapping)) {
        expect(findGenerateNode(forked).inputMapping[key]).toBe(ref);
      }
    });

    it("changes the signature, so the write forks rather than updating in place", () => {
      const source = build();
      expect(computeDAGSignature(withLandingPage(source))).not.toBe(computeDAGSignature(source));
    });

    it("is refused a second time rather than doubling the chain", () => {
      const forked = withLandingPage(build());
      expect(hasLandingPage(forked)).toBe(true);
      expect(() => withLandingPage(forked)).toThrow(/already carries/);
    });
  });

  describe("derivation from the DAG's own wiring", () => {
    it("reads the lead root off the generate node rather than assuming a node name", () => {
      const dag = coldEmailDag({ template: "cold-email-v39", leadNode: "pull-next-lead" });
      expect(deriveLeadRoot(findGenerateNode(dag))).toBe("pull-next-lead.output.lead");

      const forked = withLandingPage(dag);
      const resolve = forked.nodes.find((n: { id: string }) => n.id === "resolve-landing-url");
      expect(resolve.inputMapping).toEqual({
        websiteUrl: "$ref:pull-next-lead.output.lead.data.organization.websiteUrl",
        primaryDomain: "$ref:pull-next-lead.output.lead.data.organization.primaryDomain",
        email: "$ref:pull-next-lead.output.lead.email",
      });
    });

    it("reads the splice point off the brandExtractedFields mapping", () => {
      const dag = coldEmailDag({ template: "cold-email-v39" });
      expect(deriveAnchor(findGenerateNode(dag))).toBe("brand-extract-fields");
    });

    it("refuses a DAG with no content-generation call", () => {
      const dag = coldEmailDag({ template: "cold-email-v39" });
      dag.nodes = dag.nodes.filter((n) => n.id !== "email-generate");
      expect(() => withLandingPage(dag)).toThrow(/no content-generation/);
    });

    it("refuses a DAG whose generate call states no lead organization ref", () => {
      const dag = coldEmailDag({ template: "cold-email-v39" });
      const gen = findGenerateNode(dag);
      gen.inputMapping = { "body.variables.brandExtractedFields": "$ref:brand-extract-fields.output.fields" };
      expect(() => withLandingPage(dag)).toThrow(/lead root cannot be derived/);
    });

    it("refuses a DAG whose generate call maps no brand fields", () => {
      const dag = coldEmailDag({ template: "cold-email-v39" });
      const gen = findGenerateNode(dag);
      delete gen.inputMapping["body.variables.brandExtractedFields"];
      expect(() => withLandingPage(dag)).toThrow(/splice point cannot be derived/);
    });
  });

  describe("the scrape node", () => {
    const forked = withLandingPage(coldEmailDag({ template: "cold-email-v39" }));
    const scrape = forked.nodes.find((n: { id: string }) => n.id === "scrape-landing");

    it("calls scraping /scrape in raw-fetch mode", () => {
      expect(scrape.config.service).toBe("scraping");
      expect(scrape.config.method).toBe("POST");
      expect(scrape.config.path).toBe("/scrape");
      // enrich:true is the endpoint's default and reruns an LLM extraction of
      // company facts lead-service has already served. This arm wants the page.
      expect(scrape.config.body.enrich).toBe(false);
    });

    it("tolerates its own failure, so an unreachable site cannot kill the run", () => {
      expect(scrape.config.tolerateFailure).toBe(true);
    });

    it("reads the page off the field the endpoint actually returns", () => {
      expect(scrape.inputMapping["body.url"]).toBe("$ref:resolve-landing-url.output.url");
      const content = forked.nodes.find((n: { id: string }) => n.id === "landing-content");
      expect(content.inputMapping.rawMarkdown).toBe("$ref:scrape-landing.output.result.rawMarkdown");
    });
  });

  describe("the inline scripts", () => {
    it("both export main, which is the only shape Windmill rawscript runs", () => {
      expect(RESOLVE_URL_CODE).toContain("export async function main(");
      expect(LANDING_CONTENT_CODE).toContain("export async function main(");
    });

    it("carries the thresholds into the code it stores", () => {
      expect(LANDING_CONTENT_CODE).toContain(String(MIN_USABLE_CHARS));
      expect(LANDING_CONTENT_CODE).toContain(String(MAX_CONTENT_CHARS));
      expect(LANDING_CONTENT_CODE).toContain(JSON.stringify(NO_LANDING_PAGE));
    });
  });

  describe("template contracts", () => {
    it("declares the landing variable to the forked template, alongside the ones already sent", () => {
      const forked = withLandingPage(coldEmailDag({ template: "cold-email-v39" })) as DAG;
      const templates = new Map([
        [
          "cold-email-v39-landing",
          {
            id: "t1",
            type: "cold-email-v39-landing",
            prompt: "…{{landingPageContent}}",
            variables: [
              { name: "leadFirstName", description: "" },
              { name: "leadCompanyName", description: "" },
              { name: "leadCompanyWebsiteUrl", description: "" },
              { name: "brandExtractedFields", description: "" },
              { name: LANDING_VARIABLE, description: "the lead's landing page, or a sentence saying there is none" },
            ],
            contextVariables: [],
          },
        ],
      ]);

      const result = validateTemplateContracts(forked, templates as never);
      expect(result.issues).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.templateRefs[0].templateType).toBe("cold-email-v39-landing");
      expect(result.templateRefs[0].variablesProvided).toContain(LANDING_VARIABLE);
    });

    it("reports the landing variable as ignored when the template does not declare it", () => {
      const forked = withLandingPage(coldEmailDag({ template: "cold-email-v39" })) as DAG;
      const templates = new Map([
        [
          "cold-email-v39-landing",
          { id: "t1", type: "cold-email-v39-landing", prompt: "…", variables: [], contextVariables: [] },
        ],
      ]);

      const result = validateTemplateContracts(forked, templates as never);
      expect(
        result.issues.some((i) => i.field === LANDING_VARIABLE && i.severity === "warning"),
      ).toBe(true);
    });
  });

  describe("the forked prompt template", () => {
    /** Shaped after the three live sources: a `## Prospect` list ending in the tech stack. */
    function sourceTemplate(type: string) {
      return {
        type,
        prompt:
          "Write a cold email.\n\n## Prospect\n" +
          "- Name: {{leadFirstName}} {{leadLastName}}\n" +
          "- Company: {{leadCompanyName}}\n" +
          TEMPLATE_ANCHOR +
          "\n## Brand Intelligence\n{{brandExtractedFields}}\n",
        variables: [
          { name: "leadFirstName", description: "" },
          { name: "leadLastName", description: "" },
          { name: "leadCompanyName", description: "" },
          { name: "leadCompanyTechStack", description: "" },
          { name: "brandExtractedFields", description: "" },
        ],
      };
    }

    it("is the source plus the block, and nothing else", () => {
      const source = sourceTemplate("cold-email-v39");
      const fork = buildForkedTemplate(source);

      expect(fork.type).toBe(`cold-email-v39${TEMPLATE_SUFFIX}`);
      expect(fork.prompt).toBe(source.prompt.replace(TEMPLATE_ANCHOR, TEMPLATE_ANCHOR + TEMPLATE_BLOCK));
      // Removing the block must give the source back byte for byte — anything
      // else means the splice rewrote part of the prompt it was only meant to
      // extend, which would change the control arm as well as the treatment.
      expect(fork.prompt.replace(TEMPLATE_BLOCK, "")).toBe(source.prompt);
    });

    it("splices the block into the prospect section, ahead of the brand section", () => {
      const fork = buildForkedTemplate(sourceTemplate("cold-email-v39"));
      expect(fork.prompt.indexOf("{{leadCompanyTechStack}}")).toBeLessThan(
        fork.prompt.indexOf(`{{${LANDING_VARIABLE}}}`),
      );
      expect(fork.prompt.indexOf(`{{${LANDING_VARIABLE}}}`)).toBeLessThan(
        fork.prompt.indexOf("{{brandExtractedFields}}"),
      );
    });

    it("declares the new variable and keeps the ones the source declared", () => {
      const source = sourceTemplate("cold-email-v39");
      const fork = buildForkedTemplate(source);
      const names = fork.variables.map((v: { name: string }) => v.name);

      expect(names).toEqual([...source.variables.map((v) => v.name), LANDING_VARIABLE]);
      expect(
        fork.variables.find((v: { name: string }) => v.name === LANDING_VARIABLE).description,
      ).toBe(LANDING_VARIABLE_DESCRIPTION);
    });

    it("keeps the declared set equal to the tokens the body states", () => {
      const fork = buildForkedTemplate(sourceTemplate("cold-email-v39"));
      const tokens = new Set([...fork.prompt.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
      const declared = new Set(fork.variables.map((v: { name: string }) => v.name));
      expect([...tokens].sort()).toEqual([...declared].sort());
    });

    it("refuses a source that does not state the anchor exactly once", () => {
      const none = sourceTemplate("cold-email-v39");
      none.prompt = none.prompt.replace(TEMPLATE_ANCHOR, "");
      expect(() => buildForkedTemplate(none)).toThrow(/anchor 0 times/);

      const twice = sourceTemplate("cold-email-v39");
      twice.prompt = twice.prompt.replace(TEMPLATE_ANCHOR, TEMPLATE_ANCHOR + TEMPLATE_ANCHOR);
      expect(() => buildForkedTemplate(twice)).toThrow(/anchor 2 times/);
    });

    it("refuses to fork a template that already carries the block", () => {
      const fork = buildForkedTemplate(sourceTemplate("cold-email-v39"));
      expect(hasLandingBlock(fork.prompt)).toBe(true);
      expect(() => buildForkedTemplate(fork)).toThrow(/already carries/);
    });

    it("refuses a source whose declared set does not match its own body", () => {
      const source = sourceTemplate("cold-email-v39");
      source.variables = source.variables.filter((v) => v.name !== "leadCompanyName");
      expect(() => buildForkedTemplate(source)).toThrow(/variable contract/);
    });

    it("does not tell the model to hide that it read the page", () => {
      // An earlier draft did, which works against the only reason to pay for the
      // scrape. Pinned so a later edit cannot quietly put it back.
      expect(TEMPLATE_BLOCK).not.toMatch(/do not mention/i);
      expect(TEMPLATE_BLOCK).not.toMatch(/do not quote/i);
      expect(TEMPLATE_BLOCK).toContain(`{{${LANDING_VARIABLE}}}`);
    });

    it("carries no em dash, which is the copywriting tell this fleet bans", () => {
      expect(TEMPLATE_BLOCK).not.toContain("\u2014");
    });
  });
});
