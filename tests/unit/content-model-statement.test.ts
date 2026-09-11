import { describe, it, expect } from "vitest";
import {
  applyStatedContentModel,
  statesContentModel,
  CONTENT_GENERATION_DEFAULT_MODEL,
} from "../../src/lib/content-model-statement.js";
import type { DAG } from "../../src/lib/dag-validator.js";
import { summarizeContentGeneration } from "../../src/lib/content-generation-summary.js";

function generateNode(
  overrides: Partial<DAG["nodes"][number]> = {},
  body: Record<string, unknown> = { type: "cold-email", variables: {} },
): DAG["nodes"][number] {
  return {
    id: "generate-email",
    type: "http.call",
    config: { service: "content-generation", path: "/generate", method: "POST", body },
    ...overrides,
  } as DAG["nodes"][number];
}

function dagOf(...nodes: DAG["nodes"]): DAG {
  return { nodes, edges: [] } as unknown as DAG;
}

describe("applyStatedContentModel", () => {
  it("states the default model on a /generate node that names none", () => {
    const before = dagOf(generateNode());
    const { dag, plans, changed } = applyStatedContentModel(before);

    expect(changed).toBe(true);
    expect(plans).toEqual([{ nodeId: "generate-email", action: "add", model: "pro" }]);
    expect((dag.nodes[0].config?.body as Record<string, unknown>).model).toBe(
      CONTENT_GENERATION_DEFAULT_MODEL,
    );
    // Nothing else moved, and the input DAG is untouched.
    expect((dag.nodes[0].config?.body as Record<string, unknown>).type).toBe("cold-email");
    expect((before.nodes[0].config?.body as Record<string, unknown>).model).toBeUndefined();
  });

  it("leaves a node that already states a model byte-identical", () => {
    const before = dagOf(
      generateNode({}, { type: "cold-email", model: "deepseek-pro", variables: {} }),
    );
    const { dag, plans, changed } = applyStatedContentModel(before);

    expect(changed).toBe(false);
    expect(plans).toEqual([
      { nodeId: "generate-email", action: "already-stated", model: "deepseek-pro" },
    ]);
    expect(JSON.stringify(dag)).toBe(JSON.stringify(before));
  });

  it("leaves a node whose model is produced at run time by a $ref untouched", () => {
    const before = dagOf(
      generateNode({ inputMapping: { "body.model": "$ref:pick-model.output.model" } }),
    );
    const { dag, plans, changed } = applyStatedContentModel(before);

    expect(changed).toBe(false);
    expect(plans[0]).toMatchObject({ nodeId: "generate-email", action: "skip" });
    expect(JSON.stringify(dag)).toBe(JSON.stringify(before));
  });

  it("leaves a node whose whole body comes from an inputMapping untouched", () => {
    const before = dagOf(generateNode({ inputMapping: { body: "$ref:build-body.output" } }));
    const { dag, plans, changed } = applyStatedContentModel(before);

    expect(changed).toBe(false);
    expect(plans[0]).toMatchObject({ action: "skip" });
    expect(JSON.stringify(dag)).toBe(JSON.stringify(before));
  });

  it("honours a literal model supplied through inputMapping", () => {
    const before = dagOf(generateNode({ inputMapping: { "body.model": "flash" } }));
    const { plans, changed } = applyStatedContentModel(before);

    expect(changed).toBe(false);
    expect(plans).toEqual([{ nodeId: "generate-email", action: "already-stated", model: "flash" }]);
  });

  it("ignores nodes that are not the content-generation /generate call", () => {
    const before = dagOf(
      {
        id: "send",
        type: "http.call",
        config: { service: "email-gateway", path: "/send", method: "POST", body: {} },
      } as unknown as DAG["nodes"][number],
      generateNode({ id: "score" }, { type: "cold-email" }),
    );
    const { plans } = applyStatedContentModel(before);

    expect(plans.map((p) => p.nodeId)).toEqual(["score"]);
  });

  it("is idempotent — a second pass adds nothing", () => {
    const first = applyStatedContentModel(dagOf(generateNode()));
    const second = applyStatedContentModel(first.dag);

    expect(second.changed).toBe(false);
    expect(JSON.stringify(second.dag)).toBe(JSON.stringify(first.dag));
  });

  it("makes the read-side summary state the model it runs on", () => {
    const before = dagOf(generateNode());
    expect(summarizeContentGeneration(before).contentModel).toBeNull();

    const { dag } = applyStatedContentModel(before);
    expect(summarizeContentGeneration(dag).contentModel).toBe("pro");
  });

  it("statesContentModel reports only a DAG whose every content call names one", () => {
    expect(statesContentModel(dagOf(generateNode()))).toBe(false);
    expect(
      statesContentModel(dagOf(generateNode({}, { type: "cold-email", model: "pro" }))),
    ).toBe(true);
    // No content call at all is not a DAG that states a model.
    expect(statesContentModel(dagOf())).toBe(false);
  });
});
