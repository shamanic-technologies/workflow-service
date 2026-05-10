import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  pickWorkflowDynastySignatureName,
  WORD_COUNT,
} from "../../src/lib/workflow-dynasty-signature-name.js";

function fakeSig(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

describe("pickWorkflowDynastySignatureName", () => {
  it("returns a non-empty string", () => {
    const name = pickWorkflowDynastySignatureName(fakeSig("test"), new Set());
    expect(name).toBeTruthy();
    expect(typeof name).toBe("string");
  });

  it("is deterministic for the same signature", () => {
    const sig = fakeSig("determinism-test");
    const a = pickWorkflowDynastySignatureName(sig, new Set());
    const b = pickWorkflowDynastySignatureName(sig, new Set());
    expect(a).toBe(b);
  });

  it("avoids names already in use", () => {
    const sig = fakeSig("collision-test");
    const firstPick = pickWorkflowDynastySignatureName(sig, new Set());
    const secondPick = pickWorkflowDynastySignatureName(sig, new Set([firstPick]));
    expect(secondPick).not.toBe(firstPick);
  });

  it("falls back to numeric suffix when all words are taken", () => {
    const used = new Set<string>();
    for (let i = 0; i < WORD_COUNT; i++) {
      const name = pickWorkflowDynastySignatureName(fakeSig(`exhaust-${i}`), used);
      used.add(name);
    }
    expect(used.size).toBe(WORD_COUNT);

    const name = pickWorkflowDynastySignatureName(fakeSig("overflow"), used);
    expect(name).toMatch(/-\d+$/);
  });

  it("has at least 400 unique words", () => {
    expect(WORD_COUNT).toBeGreaterThanOrEqual(400);
  });

  it("different signatures produce different names (usually)", () => {
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) {
      names.add(pickWorkflowDynastySignatureName(fakeSig(`variant-${i}`), new Set()));
    }
    expect(names.size).toBeGreaterThanOrEqual(30);
  });
});
