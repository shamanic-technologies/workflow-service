import { describe, it, expect } from "vitest";
import { rowsUsingContent, scopeToLeg } from "../../src/lib/retire-by-content.js";
import { withTemplateDynasty } from "../../src/lib/template-dynasty.js";
import type { DAG } from "../../src/lib/dag-validator.js";

const dag = (type: string, model?: string) => ({
  nodes: [{ id: "email-generate", type: "http.call", config: { service: "content-generation", path: "/generate", method: "POST", body: { type, ...(model ? { model } : {}) } } }],
  edges: [],
});
const row = (id: string, d: unknown, status = "active", workflowDynastyStatus = "active") => ({ id, dag: d, status, workflowDynastyStatus });

describe("rowsUsingContent (TEMPLATE-MODEL-STATUS-1019)", () => {
  const rows = [
    row("a", dag("cold-email-v59", "pro")),
    row("b", dag("cold-email-v59", "glm-pro")),
    row("c", dag("blind-discovery-email-v33", "pro")),
    row("d", dag("cold-email-v59", "pro"), "deprecated"),
    row("e", dag("cold-email-v59", "pro"), "active", "deprecated"),
    row("f", { nodes: [], edges: [] }),
  ];

  it("matches the runnable workflows rendering a template, never a stopped one", () => {
    expect(rowsUsingContent(rows, { promptType: "cold-email-v59" }).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("matches the runnable workflows writing with a model", () => {
    expect(rowsUsingContent(rows, { model: "pro" }).map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("matches nothing for a template no workflow renders", () => {
    expect(rowsUsingContent(rows, { promptType: "cold-email-v1" })).toEqual([]);
  });

  it("never retires a workflow following its template dynasty for a deprecated version, pinned ones still are (TPL-DYNASTY-1021-WF3)", () => {
    const start = { nodes: [{ id: "start", type: "http.call", config: { service: "campaign", path: "/start-run", method: "POST" } }, ...dag("cold-email-v59", "pro").nodes], edges: [{ from: "start", to: "email-generate" }] };
    const following = row("g", withTemplateDynasty(start as unknown as DAG, "cold-email", "cold-email-v59"));
    const pinned = row("h", start);
    expect(rowsUsingContent([following, pinned], { promptType: "cold-email-v59" }).map((r) => r.id)).toEqual(["h"]);
    expect(rowsUsingContent([following, pinned], { model: "pro" }).map((r) => r.id)).toEqual(["g", "h"]);
  });
});

describe("scopeToLeg (RETIRE-BY-CONTENT-PER-LEG-1023)", () => {
  const a = (workflowDynastySlug: string, legKey: string, state: "active" | "deprecated" = "active") => ({
    featureSlug: "sales-cold-email-outreach", legKey, workflowDynastySlug, state, decidedBy: "x", decidedAt: "2026-10-23T00:00:00Z", note: null,
  });
  const m = (slug: string) => ({ workflowDynastySlug: slug });

  it("keeps only dynasties active on the leg, each with its legs; one also on another leg is kept apart", () => {
    const out = scopeToLeg([m("keel"), m("ballad"), m("both"), m("old"), m("none")], "lead_found_to_website_visit", [
      a("keel", "lead_found_to_website_visit"),
      a("ballad", "lead_found_to_conversation"),
      a("both", "lead_found_to_website_visit"),
      a("both", "lead_found_to_conversation"),
      a("old", "lead_found_to_website_visit", "deprecated"),
    ]);
    expect(out.onLeg).toEqual([{ row: m("keel"), legKeys: ["lead_found_to_website_visit"] }]);
    expect(out.alsoOnOtherLegs).toEqual([{ row: m("both"), legKeys: ["lead_found_to_conversation", "lead_found_to_website_visit"] }]);
  });
});
