import { describe, it, expect } from "vitest";
import { keepForkMark } from "../../src/lib/fork-mark.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import type { DAG } from "../../src/lib/dag-validator.js";

const STEPS: DAG = { nodes: [{ id: "a", type: "wait" }], edges: [] };
const PIPE = "ai-follow-up-email|signup_to_paid_client";

describe("keepForkMark (ONE-LEG-FORKS-1020)", () => {
  it("gives a new version of a one-leg copy its predecessor's pipe, so it never takes its source's signature", () => {
    const kept = keepForkMark(STEPS, { ...STEPS, forkedForPipe: PIPE });
    expect(kept.forkedForPipe).toBe(PIPE);
    expect(computeDAGSignature(kept)).not.toBe(computeDAGSignature(STEPS));
  });

  it("leaves a DAG unchanged when the predecessor is no copy, or when the DAG states its own mark", () => {
    expect(keepForkMark(STEPS, STEPS)).toBe(STEPS);
    expect(keepForkMark(STEPS, null)).toBe(STEPS);
    const own = { ...STEPS, forkedForPipe: "x|y" };
    expect(keepForkMark(own, { ...STEPS, forkedForPipe: PIPE })).toBe(own);
  });
});
