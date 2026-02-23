import { describe, it, expect } from "vitest";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import { VALID_LINEAR_DAG, DAG_WITH_TRANSACTIONAL_EMAIL_SEND } from "../helpers/fixtures.js";

describe("computeDAGSignature", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    const sig = computeDAGSignature(VALID_LINEAR_DAG);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic — same DAG produces same hash", () => {
    const a = computeDAGSignature(VALID_LINEAR_DAG);
    const b = computeDAGSignature(VALID_LINEAR_DAG);
    expect(a).toBe(b);
  });

  it("is key-order independent", () => {
    const dag1 = { nodes: [{ id: "a", type: "b" }], edges: [] };
    const dag2 = { edges: [], nodes: [{ type: "b", id: "a" }] };
    expect(computeDAGSignature(dag1)).toBe(computeDAGSignature(dag2));
  });

  it("different DAGs produce different hashes", () => {
    const sigA = computeDAGSignature(VALID_LINEAR_DAG);
    const sigB = computeDAGSignature(DAG_WITH_TRANSACTIONAL_EMAIL_SEND);
    expect(sigA).not.toBe(sigB);
  });

  it("changing a single config value changes the hash", () => {
    const dagA = { nodes: [{ id: "a", type: "http.call", config: { path: "/v1" } }], edges: [] };
    const dagB = { nodes: [{ id: "a", type: "http.call", config: { path: "/v2" } }], edges: [] };
    expect(computeDAGSignature(dagA)).not.toBe(computeDAGSignature(dagB));
  });

  it("preserves array element order (different order = different hash)", () => {
    const dagA = { nodes: [{ id: "a", type: "x" }, { id: "b", type: "y" }], edges: [] };
    const dagB = { nodes: [{ id: "b", type: "y" }, { id: "a", type: "x" }], edges: [] };
    expect(computeDAGSignature(dagA)).not.toBe(computeDAGSignature(dagB));
  });

  it("handles nested objects deterministically", () => {
    const dag1 = {
      nodes: [{ id: "a", type: "http.call", config: { body: { z: 1, a: 2 } } }],
      edges: [],
    };
    const dag2 = {
      nodes: [{ id: "a", type: "http.call", config: { body: { a: 2, z: 1 } } }],
      edges: [],
    };
    expect(computeDAGSignature(dag1)).toBe(computeDAGSignature(dag2));
  });
});
