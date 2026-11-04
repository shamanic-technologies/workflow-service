import { describe, expect, it } from "vitest";
import { COMPOSE_FOLLOW_UP_CODE, FOLLOW_UP_RESPONSE_SCHEMA, TEAM_DECIDES_STRATEGY } from "../../src/lib/follow-up-dag.js";
import { COMPOSE_CLIENT_CHECK_IN_CODE } from "../../src/lib/client-check-in-dag.js";
import { COMPOSE_BRAND_TEAM_CODE } from "../../src/lib/brand-team-dag.js";

// ZARINA-WRITER-INVENTED-1104: a paying client asked for "the details and options on how to move forward"; the writer
// answered as the owner with a plan, an invented account status and a yes to her sample idea, instead of escalating.
describe("what only the team decides", () => {
  it("every lead and client writer is told to escalate the team's calls", () => {
    for (const code of [COMPOSE_FOLLOW_UP_CODE, COMPOSE_CLIENT_CHECK_IN_CODE]) {
      expect(code).toContain(JSON.stringify(TEAM_DECIDES_STRATEGY));
      expect(code).toContain("or what only the team decides");
    }
    expect(TEAM_DECIDES_STRATEGY).toMatch(/options for their account/);
    expect(TEAM_DECIDES_STRATEGY).not.toMatch(/[–—]/);
  });

  it("the writer answering the brand's own team is not told to hand its own calls back", () => {
    expect(COMPOSE_BRAND_TEAM_CODE).not.toContain("WHAT ONLY THE TEAM DECIDES");
    expect(COMPOSE_BRAND_TEAM_CODE).not.toContain("or what only the team decides");
  });

  it("the line that licensed answering a request with our own plan is gone", () => {
    expect(COMPOSE_FOLLOW_UP_CODE).not.toContain("that is what this message is about");
    expect(COMPOSE_FOLLOW_UP_CODE).not.toContain("say why in their own numbers");
  });

  it("a figure is copied as written and no account status is invented", () => {
    expect(COMPOSE_FOLLOW_UP_CODE).toContain("never recomputed, converted, split or added up");
    expect(COMPOSE_FOLLOW_UP_CODE).toContain("where their account or their work with us stands");
    expect(FOLLOW_UP_RESPONSE_SCHEMA.properties.decision.enum).toContain("escalate");
  });
});
