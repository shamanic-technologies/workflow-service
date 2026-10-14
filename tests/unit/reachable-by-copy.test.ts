import { describe, it, expect } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import { buildSourcingDag, SOURCING_DESCRIPTION } from "../../src/lib/sourcing-dag.js";
import {
  reachableByChanges,
  withReachableBy,
  reachableByOf,
  reachableByDescription,
  isReachableByCopy,
} from "../../src/lib/reachable-by-copy.js";
import type { DAG } from "../../src/lib/dag-validator.js";

describe("reachable-by copies (LEAK-1012)", () => {
  it("states reachableBy on the serve call only, valid topology, new signature, source untouched", () => {
    const src = buildSourcingDag();
    const phone = withReachableBy(src, ["phone"]);
    const serve = phone.nodes.find((n) => n.id === "serve-lead")!;
    expect((serve.config as { body?: unknown }).body).toEqual({ reachableBy: ["phone"] });
    expect(phone.nodes.filter((n) => n.id !== "serve-lead")).toEqual(src.nodes.filter((n) => n.id !== "serve-lead"));
    expect(phone.edges).toEqual(src.edges);
    expect(validateDAG(phone).valid).toBe(true);
    expect(computeDAGSignature(phone)).not.toBe(computeDAGSignature(src));
    expect(computeDAGSignature(phone)).not.toBe(computeDAGSignature(withReachableBy(src, ["email"])));
    expect((src.nodes.find((n) => n.id === "serve-lead")!.config as { body?: unknown }).body).toBeUndefined();
  });

  it("adds to an existing static body, sorts and dedupes, refuses a mapped body and unknown methods", () => {
    const d = buildSourcingDag();
    (d.nodes.find((n) => n.id === "serve-lead")!.config as Record<string, unknown>).body = { acceptedEmails: "valid_only" };
    expect(reachableByChanges(d, ["phone", "email", "phone"])).toEqual([
      { op: "add", path: "/nodes/serve-lead/config/body/reachableBy", value: ["email", "phone"] },
    ]);
    const m = buildSourcingDag();
    m.nodes.find((n) => n.id === "serve-lead")!.inputMapping = { body: "$ref:flow_input.x" };
    expect(() => reachableByChanges(m, ["phone"])).toThrow(/refusing/);
    expect(() => reachableByChanges(buildSourcingDag(), ["whatsapp"])).toThrow(/unknown contact method/);
    expect(() => reachableByChanges(buildSourcingDag(), [])).toThrow(/at least one/);
    expect(() => reachableByChanges({ nodes: [], edges: [] } as unknown as DAG, ["phone"])).toThrow(/no lead-serving node/);
  });

  it("reads back what a DAG states", () => {
    expect(reachableByOf(buildSourcingDag())).toBeNull();
    expect(reachableByOf(withReachableBy(buildSourcingDag(), ["email"]))).toEqual(["email"]);
  });

  it("says who it finds in plain words, and the marker identifies a copy", () => {
    const phone = reachableByDescription(SOURCING_DESCRIPTION, ["phone"]);
    expect(phone.startsWith(SOURCING_DESCRIPTION)).toBe(true);
    expect(phone).toMatch(/only people with a phone number \(reachable on WhatsApp\)/);
    expect(reachableByDescription(SOURCING_DESCRIPTION, ["email"])).toMatch(/only people with a deliverable email address/);
    expect(isReachableByCopy(phone)).toBe(true);
    expect(isReachableByCopy(SOURCING_DESCRIPTION)).toBe(false);
  });
});
