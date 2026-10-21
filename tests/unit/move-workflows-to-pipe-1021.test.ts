import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs ops script, no type declarations
import { MOVES, legPlan } from "../../scripts/move-workflows-to-pipe-1021.mjs";

type Move = { dynasty: string; fromLeg: string; toLeg: string; templateDynasty: string; reason: string };
const moves = MOVES as Move[];
const azha = moves.find((m) => m.dynasty.endsWith("-azha"))!;
const row = (legKey: string, state: string, workflowDynastySlug = azha.dynasty) => ({ workflowDynastySlug, legKey, state });

describe("move-workflows-to-pipe-1021 (TPL-DYNASTY-1021-WF2)", () => {
  it("moves a dynasty active on its old leg only", () => {
    expect(legPlan([row(azha.fromLeg, "active"), row(azha.fromLeg, "active", "other")], azha)).toEqual({ kind: "move" });
  });

  it("is done once the dynasty is active on its new leg only (re-run = no write)", () => {
    expect(legPlan([row(azha.fromLeg, "deprecated"), row(azha.toLeg, "active")], azha)).toEqual({ kind: "done" });
  });

  it("refuses rather than guesses: on no leg, or on two legs", () => {
    expect(legPlan([row(azha.fromLeg, "deprecated")], azha).kind).toBe("refused");
    expect(legPlan([row(azha.fromLeg, "active"), row(azha.toLeg, "active")], azha).kind).toBe("refused");
  });

  it("every move leaves one leg for the other, writes with a template dynasty of its NEW pipe, and states why", () => {
    for (const m of moves) {
      expect(m.fromLeg).not.toBe(m.toLeg);
      const prefix = m.toLeg === "lead_found_to_website_visit" ? "cold-click-" : "cold-reply-";
      expect(m.templateDynasty.startsWith(prefix)).toBe(true);
      expect(m.reason.length).toBeGreaterThan(20);
    }
  });

  it("writes legs only through features-service's API and merges through the reversible merge route", () => {
    const src = readFileSync(new URL("../../scripts/move-workflows-to-pipe-1021.mjs", import.meta.url), "utf8");
    expect(src).toContain('"/internal/workflow-leg-assignments"');
    expect(src).toContain("/merge`");
    expect(src).not.toMatch(/psql|UPDATE |INSERT /);
  });
});
