import { describe, it, expect } from "vitest";
import { rowsUsingContent } from "../../src/lib/retire-by-content.js";

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
});
