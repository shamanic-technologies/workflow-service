import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { pickSignatureName, WORD_COUNT } from "../../src/lib/signature-words.js";

/** Generate a realistic SHA-256 hex string from a seed */
function fakeSig(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

describe("pickSignatureName", () => {
  it("returns a non-empty string", () => {
    const name = pickSignatureName(fakeSig("test"), new Set());
    expect(name).toBeTruthy();
    expect(typeof name).toBe("string");
  });

  it("is deterministic for the same signature", () => {
    const sig = fakeSig("determinism-test");
    const a = pickSignatureName(sig, new Set());
    const b = pickSignatureName(sig, new Set());
    expect(a).toBe(b);
  });

  it("avoids names already in use", () => {
    const sig = fakeSig("collision-test");
    const firstPick = pickSignatureName(sig, new Set());
    const secondPick = pickSignatureName(sig, new Set([firstPick]));
    expect(secondPick).not.toBe(firstPick);
  });

  it("falls back to numeric suffix when all words are taken", () => {
    // Exhaust the list by picking words one by one, adding each to the used set
    const usedNames = new Set<string>();
    for (let i = 0; i < WORD_COUNT; i++) {
      const name = pickSignatureName(fakeSig(`exhaust-${i}`), usedNames);
      usedNames.add(name);
    }
    expect(usedNames.size).toBe(WORD_COUNT);

    // Next pick should fall back to numeric suffix
    const name = pickSignatureName(fakeSig("overflow"), usedNames);
    expect(name).toMatch(/-\d+$/); // e.g. "sequoia-2"
  });

  it("has at least 400 unique words", () => {
    expect(WORD_COUNT).toBeGreaterThanOrEqual(400);
  });

  it("different signatures produce different names (usually)", () => {
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) {
      names.add(pickSignatureName(fakeSig(`variant-${i}`), new Set()));
    }
    // With 400+ words and 50 picks using well-distributed hashes,
    // we should get at least 30 unique names
    expect(names.size).toBeGreaterThanOrEqual(30);
  });
});
