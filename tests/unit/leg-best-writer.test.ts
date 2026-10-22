import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { DAG } from "../../src/lib/dag-validator.js";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { withTemplateDynasty, TEMPLATE_HEAD_NODE_ID, TEMPLATE_HEAD_TYPE_REF, templateDynastyOf, followsTemplateDynasty } from "../../src/lib/template-dynasty.js";
import {
  withLegBestWriter,
  writesWithLegBest,
  WRITER_PICK_NODE_ID,
  WRITER_PLAN_NODE_ID,
  WRITER_PLAN_CODE,
  LEG_BEST_MODEL_REF,
  LEG_BEST_TEMPLATE_DYNASTY_REF,
  freeUnstatedWriter,
  freeGeneratedWriter,
} from "../../src/lib/leg-best-writer.js";
// @ts-expect-error: plain .mjs ops script
import { freedDescription, FREED_SENTENCE, markedForPipe } from "../../scripts/free-writers-1022.mjs";
import { summarizeContentGeneration } from "../../src/lib/content-generation-summary.js";
import { extractTemplateRefs } from "../../src/lib/validate-template-contracts.js";
import { contentRefsOf } from "../../src/lib/deprecated-content.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";

const nobelium = JSON.parse(readFileSync(new URL("../fixtures/no-url-sequences/sales-cold-email-outreach-nobelium-v5.dag.json", import.meta.url), "utf8")) as DAG;
const gen = (d: DAG) => d.nodes.find((n) => n.config?.service === "content-generation" && n.config?.path === "/generate")!;

async function runPlan(pick: unknown) {
  const src = WRITER_PLAN_CODE.replace("export async function main", "return async function main");
  const main = new Function(src)() as (p: unknown) => Promise<Record<string, unknown>>;
  return main(pick);
}

const servedPick = {
  featureSlug: "sales-cold-email-outreach",
  legKey: "lead_found_to_conversation",
  pipeId: "sales-cold-email-outreach|lead_found_to_conversation",
  strategyId: null,
  computedAt: "2026-10-22T15:00:00Z",
  template: { templateDynastySlug: "cold-reply-free-offer-blind", head: "blind-discovery-email-v47-spaced", name: "Free offer", place: 1, costPerOutcomeUsd: null, explorePriceUsd: 0, isMature: false, spentUsd: 0, outcomes: 0 },
  templateUnavailableReason: null,
  llm: { model: "opus", provider: "anthropic", modelKey: "claude-opus-5-5", label: "Claude Opus 5.5", place: 1, costPerOutcomeUsd: null, explorePriceUsd: 43, isMature: false, spentUsd: 12, outcomes: 0 },
  llmUnavailableReason: null,
};

describe("BEST-TPL-LLM-1022 withLegBestWriter", () => {
  const freed = withLegBestWriter(nobelium);

  it("reads the leg's pick, then the picked dynasty's head, right before the content call", () => {
    const pick = freed.nodes.find((n) => n.id === WRITER_PICK_NODE_ID)!;
    expect(pick.config).toEqual({ service: "features", method: "GET", path: "/internal/writer-pick" });
    expect(pick.inputMapping).toEqual({ "query.workflowSlug": "$ref:flow_input.workflowSlug", "query.campaignId": "$ref:flow_input.campaignId" });
    const head = freed.nodes.find((n) => n.id === TEMPLATE_HEAD_NODE_ID)!;
    expect(head.config).toEqual({ service: "content-generation", method: "GET", path: "/internal/template-dynasties/{slug}/head" });
    expect(head.inputMapping).toEqual({ "params.slug": LEG_BEST_TEMPLATE_DYNASTY_REF });
    // Every former input of the content call now runs into the pick.
    expect(freed.edges.filter((e) => e.to === WRITER_PICK_NODE_ID).map((e) => e.from).sort()).toEqual(["brand-extract-fields", "brands-fetch"]);
    expect(freed.edges).toEqual(expect.arrayContaining([
      { from: WRITER_PICK_NODE_ID, to: WRITER_PLAN_NODE_ID },
      { from: WRITER_PLAN_NODE_ID, to: TEMPLATE_HEAD_NODE_ID },
      { from: TEMPLATE_HEAD_NODE_ID, to: gen(freed).id },
    ]));
    expect(freed.edges.filter((e) => e.to === gen(freed).id)).toEqual([{ from: TEMPLATE_HEAD_NODE_ID, to: gen(freed).id }]);
    expect(validateDAG(freed).valid).toBe(true);
    expect(writesWithLegBest(freed)).toBe(true);
    expect(writesWithLegBest(nobelium)).toBe(false);
  });

  it("the content call states no template and no model: both come from the pick at run time", () => {
    const body = gen(freed).config!.body as Record<string, unknown>;
    expect(body.type).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect(gen(freed).inputMapping!["body.type"]).toBe(TEMPLATE_HEAD_TYPE_REF);
    expect(gen(freed).inputMapping!["body.model"]).toBe(LEG_BEST_MODEL_REF);
    expect(followsTemplateDynasty(gen(freed))).toBe(true);
    // Every variable mapping the workflow had is kept: content-generation ignores what a template does not declare.
    for (const [k, v] of Object.entries(gen(nobelium).inputMapping ?? {})) if (k.startsWith("body.variables.")) expect(gen(freed).inputMapping![k]).toBe(v);
  });

  it("nothing reads a template or a model off it: no label, no contract check, no deprecated refusal", () => {
    expect(summarizeContentGeneration(freed)).toEqual({ contentModel: null, contentPromptType: null, contentTemplateDynasty: null, writesWithLegBest: true });
    expect(templateDynastyOf(freed)).toBeNull();
    expect(extractTemplateRefs(freed)).toEqual([]);
    expect(contentRefsOf(freed)).toEqual([{ nodeId: gen(freed).id, promptType: null, model: null }]);
  });

  it("compiles to a flow passing the picked dynasty to the head read and the picked LLM to the content call", () => {
    const flow = JSON.stringify(dagToOpenFlow(freed, "x").value);
    expect(flow).toContain("writer_pick");
    expect(flow).toContain("results.writer_plan");
    expect(flow).toContain("flow_input.workflowSlug");
  });

  it("is idempotent, and a DAG already following a template dynasty frees to the SAME DAG", () => {
    expect(withLegBestWriter(freed)).toEqual(freed);
    const dynastyFollowing = withTemplateDynasty(nobelium, "cold-reply-intro-offer-blind", "blind-discovery-email-v21-no-url-spaced");
    expect(withLegBestWriter(dynastyFollowing)).toEqual(freed);
  });

  it("two workflows that differed only by template and model become one signature (the merge case)", () => {
    const other = structuredClone(nobelium);
    const b = gen(other).config!.body as Record<string, unknown>;
    b.type = "cold-email-v61";
    b.model = "flash";
    expect(computeDAGSignature(other)).not.toBe(computeDAGSignature(nobelium));
    expect(computeDAGSignature(withLegBestWriter(other))).toBe(computeDAGSignature(freed));
  });

  it("refuses a DAG with no or several content calls", () => {
    const none: DAG = { nodes: nobelium.nodes.filter((n) => n.id !== gen(nobelium).id), edges: nobelium.edges.filter((e) => e.to !== gen(nobelium).id && e.from !== gen(nobelium).id) };
    expect(() => withLegBestWriter(none)).toThrow(/exactly one/);
    const two: DAG = { ...nobelium, nodes: [...nobelium.nodes, { ...gen(nobelium), id: "generate-2" }] };
    expect(() => withLegBestWriter(two)).toThrow(/exactly one/);
  });
});

describe("BEST-TPL-LLM-1022 writer-plan", () => {
  it("passes the served template dynasty and LLM alias on", async () => {
    await expect(runPlan(servedPick)).resolves.toEqual({
      templateDynastySlug: "cold-reply-free-offer-blind",
      model: "opus",
      provider: "anthropic",
      legKey: "lead_found_to_conversation",
      strategyId: null,
    });
  });

  it("a pick with no template throws with features-service's reason: nothing is written", async () => {
    await expect(runPlan({ ...servedPick, template: null, templateUnavailableReason: "ranking_not_computed_yet" })).rejects.toThrow(/no template.*ranking_not_computed_yet/);
  });

  it("a pick with no LLM (a strategy excluding every one) throws: never a fallback the strategy may exclude", async () => {
    await expect(runPlan({ ...servedPick, llm: null, llmUnavailableReason: "strategy_allows_none" })).rejects.toThrow(/no LLM.*strategy_allows_none/);
  });
});

describe("BEST-TPL-LLM-1022 write paths", () => {
  const unstated = structuredClone(nobelium);
  delete (gen(unstated).config!.body as Record<string, unknown>).type;
  delete (gen(unstated).config!.body as Record<string, unknown>).model;

  it("a client DAG whose content call names no template is stored freed (the MCP creates one that way)", () => {
    expect(writesWithLegBest(freeUnstatedWriter(unstated))).toBe(true);
    expect(freeUnstatedWriter(unstated)).toEqual(withLegBestWriter(nobelium));
  });

  it("a client DAG stating a template is stored as written; a freed one stays freed", () => {
    expect(freeUnstatedWriter(nobelium)).toBe(nobelium);
    const freed = withLegBestWriter(nobelium);
    expect(freeUnstatedWriter(freed)).toBe(freed);
  });

  it("a generated DAG is always freed; a DAG with no content call is untouched", () => {
    expect(writesWithLegBest(freeGeneratedWriter(nobelium))).toBe(true);
    const none: DAG = { nodes: [{ id: "a", type: "wait", config: { seconds: 1 } }], edges: [] };
    expect(freeGeneratedWriter(none)).toBe(none);
    expect(freeUnstatedWriter(none)).toBe(none);
  });

  it("a root content call gets a root pick", () => {
    const root: DAG = { nodes: [{ ...gen(nobelium), inputMapping: {} }], edges: [] };
    const freed = withLegBestWriter(root);
    expect(freed.edges.filter((e) => e.to === WRITER_PICK_NODE_ID)).toEqual([]);
    expect(validateDAG(freed).valid).toBe(true);
  });
});

describe("BEST-TPL-LLM-1022 fleet upgrade (scripts/free-writers-1022.mjs)", () => {
  it("states the new rule once in the upgraded version's description", () => {
    expect(freedDescription("Cold email, three steps.")).toBe(`Cold email, three steps. ${FREED_SENTENCE}`);
    expect(freedDescription(freedDescription("Cold email."))).toBe(`Cold email. ${FREED_SENTENCE}`);
    expect(freedDescription(null)).toBe(FREED_SENTENCE);
  });

  it("every live shape upgrades to a valid freed DAG: a pinned one and a dynasty-following one land on the same DAG", () => {
    const following = withTemplateDynasty(nobelium, "cold-reply-intro-offer-blind", "blind-discovery-email-v21-no-url-spaced");
    for (const live of [nobelium, following]) {
      const freed = withLegBestWriter(live);
      expect(validateDAG(freed).valid).toBe(true);
      expect(computeDAGSignature(freed)).toBe(computeDAGSignature(withLegBestWriter(nobelium)));
    }
  });
});

describe("BEST-TPL-LLM-1022 same steps on two pipes", () => {
  it("a freed DAG twin of another pipe's states its own pipe, so its signature differs; an already marked one is kept", () => {
    const freed = withLegBestWriter(nobelium);
    const marked = markedForPipe(freed, "sales-cold-email-outreach|lead_found_to_conversation");
    expect(marked.forkedForPipe).toBe("sales-cold-email-outreach|lead_found_to_conversation");
    expect(computeDAGSignature(marked)).not.toBe(computeDAGSignature(freed));
    expect(markedForPipe(marked, "other|leg")).toBe(marked);
    expect(validateDAG(marked).valid).toBe(true);
  });
});
