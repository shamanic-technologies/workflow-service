import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  pickWorkflowDynastySignatureName,
  workflowDynastySignatureNameToDisplay,
  WorkflowDynastySignatureNamePoolExhaustedError,
  IAU_SINGLE_WORD_STAR_NAMES,
  EXCLUDED_STAR_NAMES,
  STAR_NAME_ADJECTIVES,
  STAR_NAME_POOL,
  WORD_COUNT,
  TWO_WORD_NAME_COUNT,
} from "../../src/lib/workflow-dynasty-signature-name.js";
import {
  FEATURES_SERVICE_FAMILY_WORDS,
  PIPE_BIRD_WORDS,
  PATH_RIVER_WORDS,
} from "../fixtures/features-service-name-families.js";

function fakeSig(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

const IAU_LOWER = new Set(IAU_SINGLE_WORD_STAR_NAMES.map((n) => n.toLowerCase()));
const ADJ_LOWER = new Set(STAR_NAME_ADJECTIVES.map((a) => a.toLowerCase()));
const OTHER_FAMILIES = new Set(FEATURES_SERVICE_FAMILY_WORDS.map((w) => w.toLowerCase()));

function burnAllSingles(): Set<string> {
  return new Set(STAR_NAME_POOL);
}

describe("star name pool", () => {
  it("pins the IAU-CSN 2022-04-04 single-word list (427 names, unique, alphabetical)", () => {
    expect(IAU_SINGLE_WORD_STAR_NAMES).toHaveLength(427);
    expect(new Set(IAU_SINGLE_WORD_STAR_NAMES).size).toBe(427);
    expect([...IAU_SINGLE_WORD_STAR_NAMES]).toEqual([...IAU_SINGLE_WORD_STAR_NAMES].sort());
    for (const star of ["Vega", "Sirius", "Betelgeuse", "Altair", "Zubenelgenubi"]) {
      expect(IAU_SINGLE_WORD_STAR_NAMES).toContain(star);
    }
  });

  it("holds stars only: every pool name is an IAU star name", () => {
    for (const name of STAR_NAME_POOL) expect(IAU_LOWER.has(name)).toBe(true);
  });

  it("every exclusion names a real IAU star and is absent from the pool", () => {
    for (const excluded of Object.keys(EXCLUDED_STAR_NAMES)) {
      expect(IAU_SINGLE_WORD_STAR_NAMES).toContain(excluded);
      expect(STAR_NAME_POOL).not.toContain(excluded.toLowerCase());
    }
  });

  it("never collides with a features-service family (uplifting words, birds, rivers, their adjectives)", () => {
    expect(PIPE_BIRD_WORDS.length).toBeGreaterThan(0);
    expect(PATH_RIVER_WORDS.length).toBeGreaterThan(0);
    const pool = new Set(STAR_NAME_POOL);
    const collisions = [...OTHER_FAMILIES].filter((w) => pool.has(w) || ADJ_LOWER.has(w));
    expect(collisions).toEqual([]);
    // The two IAU names that sit in features-service's funnel pool today.
    expect(pool.has("polaris")).toBe(false);
    expect(pool.has("diadem")).toBe(false);
  });

  it("holds no common English word", () => {
    for (const word of ["atlas", "castor", "fang", "lich", "polis", "ran", "sham", "sarin", "skat", "mimosa", "kang"]) {
      expect(STAR_NAME_POOL).not.toContain(word);
    }
  });

  it("never offers a word of the retired mixed pool that is not a star", () => {
    for (const word of ["juniper", "heron", "obsidian", "umber", "falcon", "avalon", "tectonic", "iceberg"]) {
      expect(STAR_NAME_POOL).not.toContain(word);
    }
  });

  it("is slug-safe and large: 369 single names, all lowercase a-z", () => {
    expect(WORD_COUNT).toBe(369);
    expect(new Set(STAR_NAME_POOL).size).toBe(WORD_COUNT);
    for (const name of STAR_NAME_POOL) expect(name).toMatch(/^[a-z]+$/);
    for (const adj of ADJ_LOWER) expect(adj).toMatch(/^[a-z]+$/);
    expect(TWO_WORD_NAME_COUNT).toBe(STAR_NAME_ADJECTIVES.length * WORD_COUNT);
  });
});

describe("pickWorkflowDynastySignatureName", () => {
  it("returns a star name", () => {
    const name = pickWorkflowDynastySignatureName(fakeSig("test"), new Set());
    expect(IAU_LOWER.has(name)).toBe(true);
  });

  it("is deterministic for the same signature", () => {
    const sig = fakeSig("determinism-test");
    expect(pickWorkflowDynastySignatureName(sig, new Set())).toBe(
      pickWorkflowDynastySignatureName(sig, new Set()),
    );
  });

  it("avoids names already burned on the feature, old-pool names included", () => {
    const sig = fakeSig("collision-test");
    const firstPick = pickWorkflowDynastySignatureName(sig, new Set());
    const secondPick = pickWorkflowDynastySignatureName(sig, new Set([firstPick, "juniper", "heron"]));
    expect(secondPick).not.toBe(firstPick);
    expect(IAU_LOWER.has(secondPick)).toBe(true);
  });

  it("every single pick across many signatures is a star name", () => {
    for (let i = 0; i < 500; i++) {
      expect(IAU_LOWER.has(pickWorkflowDynastySignatureName(fakeSig(`v-${i}`), new Set()))).toBe(true);
    }
  });

  it("moves to adjective + star once every single star name is burned", () => {
    const burned = burnAllSingles();
    const name = pickWorkflowDynastySignatureName(fakeSig("overflow"), burned);
    const [adjective, star, ...rest] = name.split("-");
    expect(rest).toEqual([]);
    expect(ADJ_LOWER.has(adjective)).toBe(true);
    expect(STAR_NAME_POOL).toContain(star);
    expect(workflowDynastySignatureNameToDisplay(name)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it("skips a burned two-word name", () => {
    const burned = burnAllSingles();
    const first = pickWorkflowDynastySignatureName(fakeSig("two-word"), burned);
    burned.add(first);
    const second = pickWorkflowDynastySignatureName(fakeSig("two-word"), burned);
    expect(second).not.toBe(first);
    expect(second.split("-")).toHaveLength(2);
  });

  it("throws, never invents a name, when every star and pair is burned", () => {
    const burned = burnAllSingles();
    for (const adj of ADJ_LOWER) for (const star of STAR_NAME_POOL) burned.add(`${adj}-${star}`);
    expect(() => pickWorkflowDynastySignatureName(fakeSig("full"), burned)).toThrow(
      WorkflowDynastySignatureNamePoolExhaustedError,
    );
  });

  it("different signatures produce different names (usually)", () => {
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) {
      names.add(pickWorkflowDynastySignatureName(fakeSig(`variant-${i}`), new Set()));
    }
    expect(names.size).toBeGreaterThanOrEqual(30);
  });
});

describe("workflowDynastySignatureNameToDisplay", () => {
  it("capitalises a single name exactly as before", () => {
    expect(workflowDynastySignatureNameToDisplay("vega")).toBe("Vega");
    expect(workflowDynastySignatureNameToDisplay("obsidian")).toBe("Obsidian");
  });

  it("reads a two-word name as two capitalised words", () => {
    expect(workflowDynastySignatureNameToDisplay("bright-vega")).toBe("Bright Vega");
  });
});
