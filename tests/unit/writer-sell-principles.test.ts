import { describe, it, expect } from "vitest";
import {
  buildAiMeetingBookingDag,
  composeReplyPromptCode,
  COMPOSE_REPLY_PROMPT_CODE,
  needsSellPrinciples,
  SELL_PRINCIPLES,
  storedWriterStyle,
  WRITER_STYLES,
  writerStyleOf,
  DESCRIPTION,
  PERSONALITY_DESCRIPTION,
} from "../../src/lib/ai-meeting-booking-dag.js";
import { descriptionProblem } from "../../src/lib/plain-description.js";


const OPTS = { provider: "anthropic", model: "opus", omitTemperature: true } as const;
const writerCode = (dag: { nodes: Array<{ id: string; config?: Record<string, unknown> }> }) =>
  dag.nodes.find((n) => n.id === "compose-prompt")?.config?.code as string;

// WRITER-SELL-PRINCIPLE-1108 (owner 2026-11-08): the writer plays grand principles, never a per-case rule, and its
// personality is a COMPETING dynasty the pipe A/B tests, never a line in the shared principles.
describe("the lead-answering writer sells (WRITER-SELL-PRINCIPLE-1108)", () => {
  it("states the owner's four principles, the biggest certain step first, never a smallest step", () => {
    const text = SELL_PRINCIPLES.join("\n");
    expect(text).toContain("BIGGEST step you judge they will accept with certainty");
    expect(text).toContain("worth more than what they will eventually pay");
    expect(text).toContain("what our client accepts to do or give for free");
    expect(text).toContain("Hormozi");
    expect(text).toMatch(/scarcity, urgency, bonuses, guarantees/);
    expect(text).toContain("never invent a guarantee, a bonus, a deadline, a scarcity or a number");
    expect(text).toContain("The shortest sentences you can. The most airy structure");
    expect(text).not.toMatch(/smallest/i);
    expect(text).not.toMatch(/[–—]/);
    for (const style of Object.values(WRITER_STYLES)) expect(style.join(" ")).not.toMatch(/[–—]/);
  });

  it("keeps the personality out of the shared principles: plain carries none, the personality style carries it", () => {
    expect(COMPOSE_REPLY_PROMPT_CODE).toBe(composeReplyPromptCode("plain"));
    expect(COMPOSE_REPLY_PROMPT_CODE).not.toContain("You have a personality");
    expect(composeReplyPromptCode("personality")).toContain("You have a personality");
    expect(composeReplyPromptCode("personality")).toContain("dare to be contrarian");
    // Only the style differs: the principles bind both.
    for (const style of ["plain", "personality"] as const) expect(composeReplyPromptCode(style)).toContain("HOW YOU SELL");
  });

  it("builds each style as its own DAG, and reads a stored dynasty's style back so an upgrade keeps it", () => {
    const plain = buildAiMeetingBookingDag(OPTS);
    const personality = buildAiMeetingBookingDag({ ...OPTS, writerStyle: "personality" });
    expect(writerStyleOf(writerCode(plain))).toBe("plain");
    expect(writerStyleOf(writerCode(personality))).toBe("personality");
    expect(storedWriterStyle(plain)).toBe("plain");
    expect(storedWriterStyle(personality)).toBe("personality");
    // An OLDER personality writer (any other code holding the style line) is still read as personality.
    const older = { nodes: [{ id: "compose-prompt", config: { code: "// v1\n" + writerCode(personality) } }] };
    expect(storedWriterStyle(older)).toBe("personality");
    expect(JSON.stringify(plain)).not.toBe(JSON.stringify(personality));
  });

  it("calls a stored writer still holding the question licence stale, and the current one of either style current", () => {
    const stale = { nodes: [{ id: "compose-prompt", config: { code: "WHAT YOU MUST DO WHEN A REPLY IS OWED\n1. ANSWER THE QUESTION THEY ASKED." } }] };
    expect(needsSellPrinciples(stale)).toBe(true);
    expect(needsSellPrinciples(buildAiMeetingBookingDag(OPTS))).toBe(false);
    expect(needsSellPrinciples(buildAiMeetingBookingDag({ ...OPTS, writerStyle: "personality" }))).toBe(false);
    expect(needsSellPrinciples({ nodes: [] })).toBe(false);
  });

  it("describes both dynasties in plain words, the personality one telling itself apart", () => {
    expect(descriptionProblem(DESCRIPTION)).toBeNull();
    expect(descriptionProblem(PERSONALITY_DESCRIPTION)).toBeNull();
    expect(PERSONALITY_DESCRIPTION).toContain("contrarian");
    expect(DESCRIPTION).toContain("Leads only (pure_prospect)");
    expect(PERSONALITY_DESCRIPTION).toContain("Leads only (pure_prospect)");
  });
});
