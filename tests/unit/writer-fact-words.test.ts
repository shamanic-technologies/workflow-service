import { describe, it, expect } from "vitest";
import { COMPOSE_REPLY_PROMPT_CODE, REPLY_RESPONSE_SCHEMA } from "../../src/lib/ai-meeting-booking-dag.js";

// WRITER-FACT-WORDS-1108: Dr. Evans (Doc Dinners) asked "are you doing the talks or am I?"; the writer answered
// "their doctors give the talks" (and the version before it, "the doctor gives the talk"), citing a fact that only
// says "we handle the venue booking, targeted ads, and follow-ups". The fix is in what the writer SEES and returns,
// never a check on its output.
describe("a fact says its words and nothing more (WRITER-FACT-WORDS-1108)", () => {
  it("tells the writer a detail no fact's words say has no answer, however likely it seems", () => {
    expect(COMPOSE_REPLY_PROMPT_CODE).toContain("Each fact says its own words and nothing more.");
    expect(COMPOSE_REPLY_PROMPT_CODE).toContain("find the words in a fact that say it");
    expect(COMPOSE_REPLY_PROMPT_CODE).toContain("never fill it in from how such offers usually work");
  });

  it("has the writer copy the words of the facts that say each answer", () => {
    const item = REPLY_RESPONSE_SCHEMA.properties.answers.items;
    expect(item.required).toContain("quote");
    expect(item.properties.quote.type).toBe("string");
    expect(item.properties.quote.description).toContain("exact words of the cited facts");
    expect(JSON.stringify(REPLY_RESPONSE_SCHEMA)).not.toMatch(/[–—]/);
  });
});
