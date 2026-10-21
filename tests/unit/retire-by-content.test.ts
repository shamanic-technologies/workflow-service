import { describe, it, expect } from "vitest";
import { rowsUsingContent } from "../../src/lib/retire-by-content.js";
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
