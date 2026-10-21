import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { DAG } from "../../src/lib/dag-validator.js";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { withTemplateDynasty, templateDynastyOf, TEMPLATE_HEAD_NODE_ID, TEMPLATE_HEAD_TYPE_REF } from "../../src/lib/template-dynasty.js";
import { summarizeContentGeneration } from "../../src/lib/content-generation-summary.js";
import { extractTemplateRefs } from "../../src/lib/validate-template-contracts.js";
import { contentRefsOf } from "../../src/lib/deprecated-content.js";
import { writerOf, findPipeDuplicate, type PipeDuplicateDeps } from "../../src/lib/pipe-duplicate.js";
import type { Workflow } from "../../src/db/schema.js";
import type { TemplateDynasty } from "../../src/lib/content-generation-client.js";

const nobelium = JSON.parse(readFileSync(new URL("../fixtures/no-url-sequences/sales-cold-email-outreach-nobelium-v5.dag.json", import.meta.url), "utf8")) as DAG;
const gen = (d: DAG) => d.nodes.find((n) => n.config?.service === "content-generation" && n.config?.path === "/generate")!;

describe("TPL-DYNASTY-1021-WF withTemplateDynasty", () => {
  const switched = withTemplateDynasty(nobelium, "cold-reply-intro-offer-blind", "blind-discovery-email-v21-no-url-spaced");

  it("reads the dynasty head right before the content call, and the call sends the head's type", () => {
    const head = switched.nodes.find((n) => n.id === TEMPLATE_HEAD_NODE_ID)!;
    expect(head.config).toEqual({ service: "content-generation", method: "GET", path: "/internal/template-dynasties/{slug}/head", params: { slug: "cold-reply-intro-offer-blind" } });
    expect(switched.edges).toContainEqual({ from: TEMPLATE_HEAD_NODE_ID, to: gen(switched).id });
    // Both former inputs of the content call (brand-extract-fields, brands-fetch) now run into the head read.
    expect(switched.edges.filter((e) => e.to === TEMPLATE_HEAD_NODE_ID).map((e) => e.from).sort()).toEqual(["brand-extract-fields", "brands-fetch"]);
    expect(switched.edges.filter((e) => e.to === gen(switched).id)).toEqual([{ from: TEMPLATE_HEAD_NODE_ID, to: gen(switched).id }]);
    expect(gen(switched).inputMapping!["body.type"]).toBe(TEMPLATE_HEAD_TYPE_REF);
    expect(validateDAG(switched).valid).toBe(true);
    expect(templateDynastyOf(switched)).toBe("cold-reply-intro-offer-blind");
  });

  it("compiles to a flow whose content call reads the head's type at run time", () => {
    const flow = JSON.stringify(dagToOpenFlow(switched, "x").value);
    expect(flow).toContain("template_head");
    expect(flow).toContain("results.template_head");
  });

  it("keeps the head it was written against as the static base readers and validators check", () => {
    expect(summarizeContentGeneration(switched)).toMatchObject({ contentPromptType: "blind-discovery-email-v21-no-url-spaced", contentTemplateDynasty: "cold-reply-intro-offer-blind" });
    expect(extractTemplateRefs(switched).map((r) => r.templateType)).toEqual(["blind-discovery-email-v21-no-url-spaced"]);
    expect(contentRefsOf(switched)[0].promptType).toBe("blind-discovery-email-v21-no-url-spaced");
  });

  it("is idempotent: re-pointing never splices twice", () => {
    const again = withTemplateDynasty(switched, "cold-reply-intro-offer-blind", "blind-discovery-email-v99");
    expect(again.nodes.filter((n) => n.id === TEMPLATE_HEAD_NODE_ID)).toHaveLength(1);
    expect(again.edges).toEqual(switched.edges);
    expect((gen(again).config!.body as Record<string, unknown>).type).toBe("blind-discovery-email-v99");
  });

  it("a pinned DAG names no dynasty", () => {
    expect(templateDynastyOf(nobelium)).toBeNull();
    expect(summarizeContentGeneration(nobelium).contentTemplateDynasty).toBeNull();
  });
});

describe("TPL-DYNASTY-1021-WF duplicate on a pipe", () => {
  const pinnedType = (gen(nobelium).config!.body as Record<string, unknown>).type as string;
  const dynasties: TemplateDynasty[] = [
    { slug: "cold-reply-intro-offer-blind", name: "", description: "", signature: "", identity: "blind", featureSlug: "f", legKey: "lead_found_to_conversation", head: "v2", versions: [{ type: pinnedType, position: 1 }, { type: "v2", position: 2 }] },
  ];
  const pinned = nobelium;
  const model = (gen(pinned).config!.body as Record<string, unknown>).model as string;
  const row = (slug: string, dag: DAG) => ({ workflowDynastySlug: slug, workflowSlug: `${slug}-v3`, dag }) as unknown as Workflow;
  const deps = (rows: Workflow[]): PipeDuplicateDeps => ({
    listAssignments: async () => rows.map((r) => ({ featureSlug: "f", legKey: "lead_found_to_conversation", workflowDynastySlug: r.workflowDynastySlug, state: "active" as const, decidedBy: "x", decidedAt: "x", note: null })),
    listTemplateDynasties: async () => dynasties,
    loadExecutable: async (_f, slugs) => rows.filter((r) => slugs.includes(r.workflowDynastySlug)),
  });

  it("resolves a pinned template to the pipe dynasty holding it, and a switched DAG to its stated dynasty", () => {
    expect(writerOf(pinned, dynasties)).toEqual({ templateDynasty: "cold-reply-intro-offer-blind", model });
    expect(writerOf(withTemplateDynasty(pinned, "other-dyn", "x"), dynasties)?.templateDynasty).toBe("other-dyn");
  });

  it("refuses a second dynasty with the same template dynasty and model on the pipe, naming the twin", async () => {
    const twin = row("sales-cold-email-outreach-twin", withTemplateDynasty(pinned, "cold-reply-intro-offer-blind", "v2"));
    const dup = await findPipeDuplicate({ featureSlug: "f", legKeys: ["lead_found_to_conversation"], dag: pinned }, deps([twin]));
    expect(dup).toMatchObject({ twinDynastySlug: "sales-cold-email-outreach-twin", templateDynasty: "cold-reply-intro-offer-blind", model });
  });

  it("lets through another model, its own lineage, and another leg", async () => {
    const otherModel = structuredClone(pinned);
    (gen(otherModel).config!.body as Record<string, unknown>).model = "some-other-model";
    const twin = row("sales-cold-email-outreach-twin", pinned);
    expect(await findPipeDuplicate({ featureSlug: "f", legKeys: ["lead_found_to_conversation"], dag: otherModel }, deps([twin]))).toBeNull();
    expect(await findPipeDuplicate({ featureSlug: "f", legKeys: ["lead_found_to_conversation"], dag: pinned, ownDynastySlug: "sales-cold-email-outreach-twin" }, deps([twin]))).toBeNull();
    expect(await findPipeDuplicate({ featureSlug: "f", legKeys: ["lead_found_to_website_visit"], dag: pinned }, deps([twin]))).toBeNull();
  });

  it("costs no read for a DAG that writes no email", async () => {
    const throwing: PipeDuplicateDeps = { listAssignments: async () => { throw new Error("read"); }, listTemplateDynasties: async () => { throw new Error("read"); }, loadExecutable: async () => [] };
    expect(await findPipeDuplicate({ featureSlug: "f", legKeys: ["x"], dag: { nodes: [], edges: [] } }, throwing)).toBeNull();
  });
});
