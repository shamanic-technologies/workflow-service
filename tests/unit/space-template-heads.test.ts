import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs ops script, no type declarations
import { SPACED_TARGETS, GREETING_LINE, buildSpacedTemplate } from "../../scripts/space-template-heads.mjs";
// @ts-expect-error — plain .mjs ops script, no type declarations
import { SPACING_BLOCK } from "../../scripts/upgrade-no-url-sequences.mjs";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/no-url-sequences/${name}`, import.meta.url), "utf8"));
const tokens = (prompt: string) => [...new Set([...prompt.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();

describe("TPL-DYNASTY-1021-WF 4a: Blind Free Offer spaced head", () => {
  const source = fixture("blind-discovery-email-v47.json");
  const target = SPACED_TARGETS.find((t: { sourceType: string }) => t.sourceType === "blind-discovery-email-v47");
  const built = buildSpacedTemplate(source, target.anchor, target.neutralEdits);

  it("names the spaced twin after its source", () => {
    expect(built.type).toBe("blind-discovery-email-v47-spaced");
  });

  it("states short spaced paragraphs in every email and the greeting alone on its line, before the opening-line section", () => {
    expect(built.prompt).toContain(SPACING_BLOCK);
    expect(built.prompt).toContain(GREETING_LINE);
    expect(built.prompt.indexOf(SPACING_BLOCK)).toBeLessThan(built.prompt.indexOf("## Opening line (Email 1 only)"));
  });

  it("changes nothing else: the source text, neutralised, minus the inserted block", () => {
    let expected = source.prompt;
    for (const [from, to] of target.neutralEdits) expected = expected.replace(from, to);
    expect(built.prompt.replace(`\n${SPACING_BLOCK}\n\n${GREETING_LINE}\n`, "")).toBe(expected);
    expect(built.variables).toEqual(source.variables);
    expect(built.variables.map((v: { name: string }) => v.name).sort()).toEqual(tokens(built.prompt));
  });

  it("quotes no company, person or figure the neutrality check refused", () => {
    expect(built.prompt).not.toMatch(/Stripe|Sarah Chen|Apollo|72%|2,400|AI Act/);
  });

  it("adds no em or en dash", () => {
    expect(SPACING_BLOCK + GREETING_LINE + target.neutralEdits.map((e: string[]) => e[1]).join("")).not.toMatch(/[—–]/);
  });

  it("refuses a source already carrying the block, so it is never stacked twice", () => {
    expect(() => buildSpacedTemplate(built, target.anchor, [])).toThrow(/already carries/);
  });

  it("targets mebsuta and azalea only (the two Blind Free Offer workflows on that text)", () => {
    expect(target.dynasties).toEqual(["sales-cold-email-outreach-mebsuta", "sales-cold-email-outreach-azalea"]);
  });
});
