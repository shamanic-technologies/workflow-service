import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchPromptTemplate = vi.fn();
const fetchModelStatuses = vi.fn();
vi.mock("../../src/lib/content-generation-client.js", () => ({
  fetchPromptTemplate: (...a: unknown[]) => fetchPromptTemplate(...a),
  fetchModelStatuses: (...a: unknown[]) => fetchModelStatuses(...a),
}));

import { findDeprecatedContent, contentRefsOf } from "../../src/lib/deprecated-content.js";
import type { DAG } from "../../src/lib/dag-validator.js";

const dag = (type: string, model: string): DAG =>
  ({
    nodes: [
      { id: "start", type: "http.call", config: { service: "campaign", path: "/start-run", method: "POST" } },
      { id: "email-generate", type: "http.call", config: { service: "content-generation", path: "/generate", method: "POST", body: { type, model } } },
    ],
    edges: [{ from: "start", to: "email-generate" }],
  }) as unknown as DAG;

describe("findDeprecatedContent (TEMPLATE-MODEL-STATUS-1019)", () => {
  beforeEach(() => {
    fetchPromptTemplate.mockReset();
    fetchModelStatuses.mockReset();
  });

  it("refuses a deprecated template and a deprecated model, naming each", async () => {
    fetchPromptTemplate.mockResolvedValue({ type: "cold-email-v59", status: "deprecated" });
    fetchModelStatuses.mockResolvedValue(new Map([["pro", "deprecated"], ["opus", "active"]]));
    const issues = await findDeprecatedContent(dag("cold-email-v59", "pro"));
    expect(issues.map((i) => [i.field, i.value])).toEqual([["body.type", "cold-email-v59"], ["body.model", "pro"]]);
  });

  it("accepts active ones and a template stored before the status existed", async () => {
    fetchPromptTemplate.mockResolvedValue({ type: "cold-email-v59" });
    fetchModelStatuses.mockResolvedValue(new Map([["pro", "active"]]));
    expect(await findDeprecatedContent(dag("cold-email-v59", "pro"))).toEqual([]);
  });

  it("skips (never blocks every write) when content-generation cannot be read", async () => {
    fetchPromptTemplate.mockRejectedValue(new Error("down"));
    expect(await findDeprecatedContent(dag("cold-email-v59", "pro"))).toEqual([]);
  });

  it("reads only the content call's literals", () => {
    expect(contentRefsOf(dag("cold-email-v59", "pro"))).toEqual([{ nodeId: "email-generate", promptType: "cold-email-v59", model: "pro" }]);
  });
});
