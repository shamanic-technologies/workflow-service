import { describe, it, expect } from "vitest";
import { applyDagPatch, DagPatchError } from "../../src/lib/dag-patch.js";

const DAG = {
  nodes: [
    { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
    { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next", body: { sourceType: "apollo" } } },
  ],
  edges: [{ from: "start-run", to: "fetch-lead" }],
};

describe("applyDagPatch", () => {
  it("adds a key on a node named by id and leaves everything else identical", () => {
    const out = applyDagPatch(DAG, [{ op: "add", path: "/nodes/fetch-lead/config/body/acceptedEmails", value: "valid_and_catch_all" }]);
    expect(out.nodes[1].config.body).toEqual({ sourceType: "apollo", acceptedEmails: "valid_and_catch_all" });
    expect(out.nodes[0]).toEqual(DAG.nodes[0]);
    expect(out.edges).toEqual(DAG.edges);
  });

  it("never mutates the source", () => {
    const before = JSON.stringify(DAG);
    applyDagPatch(DAG, [{ op: "replace", path: "/nodes/1/config/body/sourceType", value: "x" }, { op: "remove", path: "/edges/0" }]);
    expect(JSON.stringify(DAG)).toBe(before);
  });

  it("numeric segment is the array index", () => {
    const out = applyDagPatch(DAG, [{ op: "replace", path: "/nodes/0/config/path", value: "/x" }]);
    expect(out.nodes[0].config.path).toBe("/x");
  });

  it("appends to an array with -", () => {
    const out = applyDagPatch(DAG, [{ op: "add", path: "/edges/-", value: { from: "a", to: "b" } }]);
    expect(out.edges).toHaveLength(2);
  });

  it("test passes on equal value and refuses on a different one, naming the change", () => {
    expect(() => applyDagPatch(DAG, [{ op: "test", path: "/nodes/fetch-lead/config/body", value: { sourceType: "apollo" } }])).not.toThrow();
    try {
      applyDagPatch(DAG, [
        { op: "add", path: "/nodes/fetch-lead/config/body/a", value: 1 },
        { op: "test", path: "/nodes/fetch-lead/config/path", value: "/other" },
      ]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DagPatchError);
      expect((e as DagPatchError).operationIndex).toBe(1);
    }
  });

  it("refuses an unknown node id, a missing replace target, a missing parent, and the root", () => {
    expect(() => applyDagPatch(DAG, [{ op: "add", path: "/nodes/nope/config/x", value: 1 }])).toThrow(/no node with id "nope"/);
    expect(() => applyDagPatch(DAG, [{ op: "replace", path: "/nodes/fetch-lead/config/missing", value: 1 }])).toThrow(/does not exist/);
    expect(() => applyDagPatch(DAG, [{ op: "add", path: "/nodes/fetch-lead/config/a/b", value: 1 }])).toThrow(/does not exist/);
    expect(() => applyDagPatch(DAG, [{ op: "remove", path: "" }])).toThrow(/whole DAG/);
    expect(() => applyDagPatch(DAG, [{ op: "remove", path: "/edges/5" }])).toThrow(/out of range/);
  });

  it("decodes ~1 and ~0 in segments", () => {
    const out = applyDagPatch({ nodes: [], edges: [], m: { "a/b": 1, "c~d": 2 } }, [
      { op: "replace", path: "/m/a~1b", value: 3 },
      { op: "remove", path: "/m/c~0d" },
    ]);
    expect(out.m).toEqual({ "a/b": 3 });
  });
});
