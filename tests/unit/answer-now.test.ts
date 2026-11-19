import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANSWER_NOW_EDITS,
  ANSWER_NOW_LOCAL_TIME_EDIT,
  ANSWER_NOW_MEETING_EDIT,
  ANSWER_NOW_NEXT_DATE_EDIT,
  CLOCK_WAIT_PATTERN,
  answerNowCase,
  answerNowSource,
} from "../../src/lib/scripts/answer-now.js";
import { EMAIL_MEDIUM, WHATSAPP_MEDIUM, localTimeStrategy, nextDateStrategy } from "../../src/lib/right-moment.js";
import { NEW_FACT_STRATEGY } from "../../src/lib/answering-strategies.js";

// ANSWER-NOW-1119: the stored versions that held the clock rule (snapshots of production sources). Each must come out
// of `answerNowSource` with no clock-wait instruction left; the shared prompt text must say the same as the edits.
const STORED = [
  "tests/fixtures/answer-lead-stored-v14.js",
  "tests/fixtures/follow-up-due-stored-v8.js",
  "tests/fixtures/brand-team-stored-v3.js",
  "tests/fixtures/client-check-in-stored-v3.js",
];

describe("ANSWER-NOW-1119: no writer waits for a sensible hour", () => {
  it("the shared prompt text holds no clock-wait instruction, for every medium", () => {
    for (const m of [EMAIL_MEDIUM, WHATSAPP_MEDIUM]) {
      expect(localTimeStrategy(m)).not.toMatch(CLOCK_WAIT_PATTERN);
      expect(nextDateStrategy(m)).not.toMatch(CLOCK_WAIT_PATTERN);
    }
    expect(NEW_FACT_STRATEGY).not.toMatch(CLOCK_WAIT_PATTERN);
  });

  it("the shared prompt text says exactly what the stored scripts are upgraded to", () => {
    expect(localTimeStrategy(EMAIL_MEDIUM)).toContain(ANSWER_NOW_LOCAL_TIME_EDIT[1]);
    expect(localTimeStrategy(WHATSAPP_MEDIUM)).toContain(ANSWER_NOW_LOCAL_TIME_EDIT[1]);
    expect(nextDateStrategy(EMAIL_MEDIUM)).toContain(ANSWER_NOW_NEXT_DATE_EDIT[1]);
    expect(NEW_FACT_STRATEGY).toContain(ANSWER_NOW_MEETING_EDIT[1]);
  });

  it("keeps the rest of the game: how long to wait between follow-ups, and any timing stated", () => {
    const next = nextDateStrategy(EMAIL_MEDIUM);
    expect(next).toContain("wait longer, weeks or months");
    expect(next).toContain("anything they or we said about timing (honour it exactly)");
    expect(localTimeStrategy(EMAIL_MEDIUM)).toContain("never assume UTC");
  });

  for (const path of STORED) {
    it(`upgrades ${path} with no clock-wait instruction left`, () => {
      const code = readFileSync(path, "utf8");
      expect(code).toMatch(CLOCK_WAIT_PATTERN);
      const out = answerNowSource(code);
      expect(out).not.toMatch(CLOCK_WAIT_PATTERN);
      expect(out).toContain(ANSWER_NOW_LOCAL_TIME_EDIT[1]);
      // Nothing but the three edits moved.
      let expected = code;
      for (const [before, after] of ANSWER_NOW_EDITS) expected = expected.split(before).join(after);
      expect(out).toBe(expected);
    });
  }

  it("refuses a source that already answers now, or that holds no licence to wait", () => {
    const code = readFileSync(STORED[0]!, "utf8");
    expect(() => answerNowSource(answerNowSource(code))).toThrow(/already answers now/);
    expect(() => answerNowSource("export default function run() { return null; }")).toThrow(/not there/);
  });

  it("refuses a source where a clock-wait instruction would survive the edits", () => {
    const code = readFileSync(STORED[0]!, "utf8") + "\n// Write only at a sensible hour.";
    expect(() => answerNowSource(code)).toThrow(/clock-wait instruction is left/);
  });

  it("restates a recorded case's prompt and keeps the model's recorded answer", () => {
    const c = {
      id: "c1",
      calls: [
        { name: "llm.complete", args: { systemPrompt: `x ${ANSWER_NOW_LOCAL_TIME_EDIT[0]} y ${ANSWER_NOW_NEXT_DATE_EDIT[0]}` }, answer: { json: { reason: "not a sensible hour to write" } } },
      ],
    };
    const r = answerNowCase(c);
    expect("case" in r).toBe(true);
    const out = (r as { case: typeof c }).case;
    expect(out.calls[0]!.args.systemPrompt).toBe(`x ${ANSWER_NOW_LOCAL_TIME_EDIT[1]} y ${ANSWER_NOW_NEXT_DATE_EDIT[1]}`);
    expect(out.calls[0]!.answer).toEqual(c.calls[0]!.answer);
    expect(answerNowCase(out)).toEqual({ excluded: "already restated" });
  });
});
