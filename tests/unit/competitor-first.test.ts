import { describe, expect, it } from "vitest";
import { COMPETITOR_FIRST_STRATEGY, COMPOSE_FOLLOW_UP_CODE } from "../../src/lib/follow-up-dag.js";
import { COMPOSE_CLIENT_CHECK_IN_CODE } from "../../src/lib/client-check-in-dag.js";
import { COMPOSE_BRAND_TEAM_CODE } from "../../src/lib/brand-team-dag.js";

// COMPETITOR-FIRST-1105: a lead wrote he was testing another vendor "and getting good success"; the owner wants the
// writer to learn whether it fully works for them (cost per result, what is missing) before any pitch.
describe("when they already use someone else", () => {
  it("every lead and client writer plays the strategy", () => {
    for (const code of [COMPOSE_FOLLOW_UP_CODE, COMPOSE_CLIENT_CHECK_IN_CODE]) {
      expect(code).toContain(JSON.stringify(COMPETITOR_FIRST_STRATEGY));
    }
  });

  it("the writer answering the brand's own team does not", () => {
    expect(COMPOSE_BRAND_TEAM_CODE).not.toContain("WHEN THEY ALREADY USE SOMEONE ELSE");
  });

  it("is a strategy, not a rule keyed on a vendor, and is never forced on someone who named no one", () => {
    expect(COMPETITOR_FIRST_STRATEGY).toMatch(/what one result costs them there/);
    expect(COMPETITOR_FIRST_STRATEGY).toMatch(/what they miss with it/);
    expect(COMPETITOR_FIRST_STRATEGY).toMatch(/never ask who they use/);
    expect(COMPETITOR_FIRST_STRATEGY).toMatch(/own it in one plain sentence/);
    expect(COMPETITOR_FIRST_STRATEGY).not.toMatch(/explee/i);
    expect(COMPETITOR_FIRST_STRATEGY).not.toMatch(/[–—]/);
  });
});
