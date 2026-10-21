import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs ops script, no type declarations
import { planHead, READ_ALL_CLIENT_INFO, NAMES_THE_CLIENT, withSpacing } from "../../scripts/template-dynasty-heads-1021.mjs";
// @ts-expect-error — plain .mjs ops script, no type declarations
import { SPACING_BLOCK } from "../../scripts/upgrade-no-url-sequences.mjs";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/no-url-sequences/${name}`, import.meta.url), "utf8"));
const tokens = (p: string) => [...new Set([...p.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();

describe("TPL-DYNASTY-1021-WF head fixes", () => {
  it("b. Named Free Offer reads all the client's info, give lists included, names the client, and is spaced", () => {
    const src = fixture("blind-discovery-email-v39.json");
    const p = planHead("cold-reply-free-offer-named", src.prompt);
    expect(p).toContain(READ_ALL_CLIENT_INFO);
    expect(p).toContain(NAMES_THE_CLIENT);
    expect(p).not.toMatch(/never reveal the client name/);
    expect(p).toContain(SPACING_BLOCK);
    expect(p).not.toMatch(/Stripe|Sarah Chen|Apollo|72%/);
    expect(tokens(p)).toEqual(tokens(src.prompt));
    expect(planHead("cold-reply-free-offer-named", p)).toBeNull();
  });

  it("c. Contrarian Opener (named) states that the email names the client, with the client's own variable", () => {
    const src = fixture("cold-email.json");
    for (const slug of ["cold-click-contrarian-opener-named", "cold-reply-contrarian-opener-named"]) {
      const p = planHead(slug, src.prompt);
      expect(p).toContain("## The client is named");
      expect(p).not.toContain("Keeping the client anonymous");
      expect(p).toContain(SPACING_BLOCK);
      expect(tokens(p)).toEqual(tokens(src.prompt));
    }
  });

  it("a dynasty whose signature rules out a greeting gets the spacing rule without the greeting line; an idle dynasty is untouched", () => {
    const src = fixture("cold-email-v40.json");
    const stack = planHead("cold-click-recommendation-stack-named", src.prompt);
    expect(stack).toContain(SPACING_BLOCK);
    expect(stack).not.toContain("stays alone on its own line");
    expect(planHead("cold-reply-pain-question-blind", src.prompt)).toBeNull();
  });

  it("spacing goes in once, before the input section, for any other head", () => {
    const src = fixture("cold-email-v40.json");
    const p = withSpacing(src.prompt);
    expect(p.indexOf(SPACING_BLOCK)).toBeLessThan(p.lastIndexOf("\n---\n"));
    expect(withSpacing(p)).toBe(p);
  });
});
