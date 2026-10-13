import { describe, it, expect } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import type { DAG } from "../../src/types.js";
// @ts-expect-error — plain .mjs ops script, no type declarations
import { withCatchAll, copyDescription, isCopy, pickSources, judgmentState, contentModel, ACCEPTED_EMAILS, PIPE_ID } from "../../scripts/fork-catch-all-copies.mjs";

function sourceDag(model = "flash"): DAG {
  return {
    nodes: [
      { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" }, retries: 0 },
      { id: "email-generate", type: "http.call", config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email-v53", model } } },
      { id: "email-send", type: "http.call", config: { service: "email-gateway", method: "POST", path: "/orgs/send" } },
    ],
    edges: [{ from: "fetch-lead", to: "email-generate" }, { from: "email-generate", to: "email-send" }],
  } as DAG;
}

describe("catch-all copies", () => {
  it("changes only the serving node, adds the static acceptedEmails, new signature, valid topology", () => {
    const src = sourceDag();
    const copy = withCatchAll(src) as DAG;
    expect(copy.nodes[0].config.body).toEqual({ acceptedEmails: ACCEPTED_EMAILS });
    expect(ACCEPTED_EMAILS).toBe("valid_and_catch_all");
    expect(copy.nodes.slice(1)).toEqual(src.nodes.slice(1));
    expect(copy.edges).toEqual(src.edges);
    expect(computeDAGSignature(copy)).not.toBe(computeDAGSignature(src));
    expect(validateDAG(copy).valid).toBe(true);
    expect((src.nodes[0].config as { body?: unknown }).body).toBeUndefined();
  });

  it("keeps a body the serving node already states and refuses a dynamic body", () => {
    const d = sourceDag();
    (d.nodes[0].config as Record<string, unknown>).body = { x: 1 };
    expect(withCatchAll(d).nodes[0].config.body).toEqual({ x: 1, acceptedEmails: ACCEPTED_EMAILS });
    const e = sourceDag();
    (e.nodes[0] as Record<string, unknown>).inputMapping = { body: "$ref:flow_input.b" };
    expect(() => withCatchAll(e)).toThrow(/refusing/);
    expect(() => withCatchAll({ nodes: [], edges: [] } as unknown as DAG)).toThrow(/no lead-serving node/);
  });

  it("says so plainly in the description and marks a copy", () => {
    const d = copyDescription("Anonymous B2B email.");
    expect(d.startsWith("Anonymous B2B email. ")).toBe(true);
    expect(d).toMatch(/AND to catch-all addresses/);
    expect(d).not.toMatch(/[–—]/);
    expect(isCopy(d)).toBe(true);
    expect(isCopy("Anonymous B2B email.")).toBe(false);
  });

  it("picks the first N active, selectable, non-copy, non-banned-model rows in rank order", () => {
    const act = { assignment: "active", selectable: true };
    const rows = [
      { id: "a", ...act },
      { id: "b", assignment: "deprecated", selectable: false },
      { id: "c", ...act },
      { id: "d", ...act },
      { id: "e", ...act },
      { id: "f", ...act },
    ];
    const models: Record<string, string> = { a: "flash", c: "haiku", d: "pro", e: "haiku-5-5", f: "opus" };
    const r = pickSources(rows, 3, (id: string) => models[id], (id: string) => id === "d");
    expect(r.picked).toEqual(["a", "e", "f"]);
    expect(r.skipped.map((s: string[]) => s[0])).toEqual(["b", "c", "d"]);
    expect(PIPE_ID).toBe("sales-cold-email-outreach|lead_found_to_conversation");
  });

  it("reads the judgment on the current version only", () => {
    const v = [
      { workflowDynastySlug: "x", version: 1, versionActive: true, follows: true },
      { workflowDynastySlug: "y", version: 1, versionActive: true, follows: false },
    ];
    expect(judgmentState(v, ["x", "y", "z"])).toEqual({ pending: ["z"], no: ["y"] });
    expect(contentModel(sourceDag("glm-pro"))).toBe("glm-pro");
  });
});
