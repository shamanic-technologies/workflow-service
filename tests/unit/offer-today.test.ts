import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OFFER_TODAY_EDITS, OFFER_TODAY_FACT_EDIT, OFFER_TODAY_THREAD_EDIT, offerTodayCase, offerTodaySource } from "../../src/lib/scripts/offer-today.js";

// MATCH25-COLD-1114: our August cold email promised "we match your first $25 in credits"; billing ended the match for
// new accounts on 2026-10-29, and on 2026-11-13 the follow-up writer repeated it to Matt, because its prompt let the
// thread state our offer ("a figure we gave stays that figure").
describe("the follow-up writer reads our offer only as the FACTS state it today", () => {
  const generator = readFileSync(new URL("../../scripts/engine-ports/follow-up-steps.ts", import.meta.url), "utf8");

  it("the generator states the offer-today fact line and no longer licenses a figure from the thread", () => {
    expect(generator).toContain(OFFER_TODAY_FACT_EDIT[1]);
    expect(generator).toContain(OFFER_TODAY_THREAD_EDIT[1]);
    expect(generator).not.toContain(OFFER_TODAY_THREAD_EDIT[0]);
  });

  it("no edit text holds a double quote or a backslash (identical in a script source and a rendered prompt)", () => {
    for (const [before, after] of OFFER_TODAY_EDITS) {
      expect(before + after).not.toMatch(/["\\]/);
    }
  });

  it("restates a stored source once, and refuses one already restated or in an unknown form", () => {
    const lead = `a\n"${OFFER_TODAY_FACT_EDIT[0]} Never invent."\n"Everything stands ${OFFER_TODAY_THREAD_EDIT[0]}."`;
    const out = offerTodaySource(lead);
    expect(out).toContain(OFFER_TODAY_FACT_EDIT[1]);
    expect(out).toContain(OFFER_TODAY_THREAD_EDIT[1]);
    expect(() => offerTodaySource(out)).toThrow(/already/);
    expect(() => offerTodaySource("no fact line")).toThrow(/fact line/);
    // A client game has the fact line and no lead thread line: restated all the same.
    const client = `"${OFFER_TODAY_FACT_EDIT[0]} Never invent."`;
    expect(offerTodaySource(client)).toContain(OFFER_TODAY_FACT_EDIT[1]);
  });

  it("restates a recorded writer request and leaves a case whose writer never ran unchanged", () => {
    const written = { id: "c1", calls: [{ name: "llm.complete", args: { systemPrompt: `x ${OFFER_TODAY_FACT_EDIT[0]} y` }, answer: { content: "Hi" } }] };
    const r = offerTodayCase(written);
    expect("case" in r && (r.case.calls[0]!.args.systemPrompt as string)).toBe(`x ${OFFER_TODAY_FACT_EDIT[1]} y`);
    expect("case" in r && r.case.calls[0]!.answer).toEqual({ content: "Hi" });
    const idle = { id: "c2", calls: [{ name: "lead.serve", args: {} }] };
    expect(offerTodayCase(idle)).toEqual({ case: idle });
    expect(offerTodayCase("case" in r ? r.case : null)).toEqual({ excluded: "already restated" });
  });
});
