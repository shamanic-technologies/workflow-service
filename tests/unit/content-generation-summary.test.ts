import { describe, it, expect } from "vitest";
import { summarizeContentGeneration } from "../../src/lib/content-generation-summary.js";
import type { DAG } from "../../src/lib/dag-validator.js";

function dagWith(nodes: DAG["nodes"]): DAG {
  return { nodes, edges: [] };
}

describe("summarizeContentGeneration", () => {
  it("reads model and type off config.body of the content-generation node", () => {
    const dag = dagWith([
      { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/buffer/next" } },
      {
        id: "generate",
        type: "http.call",
        config: {
          service: "content-generation",
          method: "POST",
          path: "/generate",
          body: { type: "cold-email", model: "deepseek-pro", variables: {} },
        },
      },
    ] as unknown as DAG["nodes"]);

    expect(summarizeContentGeneration(dag)).toEqual({
      contentModel: "deepseek-pro",
      contentPromptType: "cold-email",
    });
  });

  it("prefers a literal inputMapping override over the static body", () => {
    const dag = dagWith([
      {
        id: "generate",
        type: "http.call",
        config: {
          service: "content-generation",
          method: "POST",
          path: "/generate",
          body: { type: "cold-email", model: "flash" },
        },
        inputMapping: { "body.model": "fable" },
      },
    ] as unknown as DAG["nodes"]);

    expect(summarizeContentGeneration(dag).contentModel).toBe("fable");
  });

  it("states null for a value produced at run time by another node", () => {
    const dag = dagWith([
      {
        id: "generate",
        type: "http.call",
        config: {
          service: "content-generation",
          method: "POST",
          path: "/generate",
          body: { type: "cold-email", model: "flash" },
        },
        inputMapping: { "body.model": "$ref:pick-model.output.model" },
      },
    ] as unknown as DAG["nodes"]);

    expect(summarizeContentGeneration(dag)).toEqual({
      contentModel: null,
      contentPromptType: "cold-email",
    });
  });

  it("states null when the workflow makes no content-generation call", () => {
    const dag = dagWith([
      { id: "send", type: "http.call", config: { service: "email-gateway", method: "POST", path: "/send" } },
    ] as unknown as DAG["nodes"]);

    expect(summarizeContentGeneration(dag)).toEqual({
      contentModel: null,
      contentPromptType: null,
    });
  });

  it("states null for a field the content call omits", () => {
    const dag = dagWith([
      {
        id: "generate",
        type: "http.call",
        config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email" } },
      },
    ] as unknown as DAG["nodes"]);

    expect(summarizeContentGeneration(dag)).toEqual({
      contentModel: null,
      contentPromptType: "cold-email",
    });
  });

  it("states null when two content calls disagree, rather than guessing one", () => {
    const dag = dagWith([
      {
        id: "generate-a",
        type: "http.call",
        config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email", model: "flash" } },
      },
      {
        id: "generate-b",
        type: "http.call",
        config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email", model: "fable" } },
      },
    ] as unknown as DAG["nodes"]);

    expect(summarizeContentGeneration(dag)).toEqual({
      contentModel: null,
      contentPromptType: "cold-email",
    });
  });

  it("ignores a /generate call to another service", () => {
    const dag = dagWith([
      {
        id: "generate",
        type: "http.call",
        config: { service: "chat", method: "POST", path: "/generate", body: { type: "cold-email", model: "flash" } },
      },
    ] as unknown as DAG["nodes"]);

    expect(summarizeContentGeneration(dag)).toEqual({ contentModel: null, contentPromptType: null });
  });

  it("tolerates a missing or empty dag", () => {
    expect(summarizeContentGeneration(null)).toEqual({ contentModel: null, contentPromptType: null });
    expect(summarizeContentGeneration({ nodes: [], edges: [] })).toEqual({
      contentModel: null,
      contentPromptType: null,
    });
  });
});
