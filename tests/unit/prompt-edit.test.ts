import { describe, it, expect } from "vitest";
import {
  promptVariableNames,
  checkPromptVariableContract,
  repointPromptTemplate,
} from "../../src/lib/prompt-edit.js";
import type { DAG } from "../../src/lib/dag-validator.js";

const SOURCE = "Hi {{leadFirstName}}, I saw {{leadCompanyName}}. {{leadFirstName}} again.";

describe("promptVariableNames", () => {
  it("lists each {{token}} once, in first-seen order", () => {
    expect(promptVariableNames(SOURCE)).toEqual(["leadFirstName", "leadCompanyName"]);
  });
});

describe("checkPromptVariableContract", () => {
  it("accepts a reworded prompt that keeps exactly the same variables", () => {
    expect(
      checkPromptVariableContract(SOURCE, "Hello {{leadCompanyName}} team, {{leadFirstName}} here."),
    ).toBeNull();
  });

  it("refuses a dropped variable with a readable reason", () => {
    const res = checkPromptVariableContract(SOURCE, "Hi {{leadFirstName}}.");
    expect(res?.droppedVariables).toEqual(["leadCompanyName"]);
    expect(res?.addedVariables).toEqual([]);
    expect(res?.error).toContain("removes {{leadCompanyName}}");
    expect(res?.error).toContain("{{leadFirstName}}, {{leadCompanyName}}");
  });

  it("refuses an added variable the workflow does not provide", () => {
    const res = checkPromptVariableContract(SOURCE, `${SOURCE} {{leadShoeSize}}`);
    expect(res?.addedVariables).toEqual(["leadShoeSize"]);
    expect(res?.droppedVariables).toEqual([]);
    expect(res?.error).toContain("adds {{leadShoeSize}}");
  });
});

describe("repointPromptTemplate", () => {
  const dag: DAG = {
    nodes: [
      { id: "fetch", type: "http.call", config: { service: "lead", method: "POST", path: "/x" } },
      {
        id: "gen",
        type: "http.call",
        config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email-v7", model: "pro" } },
        inputMapping: { "body.variables.leadFirstName": "$ref:fetch.output.firstName" },
      },
      {
        id: "gen-mapped",
        type: "http.call",
        config: { service: "content-generation", method: "POST", path: "/generate" },
        inputMapping: { "body.type": "cold-email-v7" },
      },
    ],
    edges: [{ from: "fetch", to: "gen" }, { from: "gen", to: "gen-mapped" }],
  };

  it("repoints every literal spelling of the type and leaves the source DAG untouched", () => {
    const out = repointPromptTemplate(dag, "cold-email-v7", "cold-email-v9");
    expect((out.nodes[1].config.body as Record<string, unknown>).type).toBe("cold-email-v9");
    expect((out.nodes[1].config.body as Record<string, unknown>).model).toBe("pro");
    expect(out.nodes[2].inputMapping?.["body.type"]).toBe("cold-email-v9");
    expect((dag.nodes[1].config.body as Record<string, unknown>).type).toBe("cold-email-v7");
    expect(out.edges).toEqual(dag.edges);
  });

  it("throws when nothing renders the type", () => {
    expect(() => repointPromptTemplate(dag, "other", "x")).toThrow(/renders template "other"/);
  });
});
