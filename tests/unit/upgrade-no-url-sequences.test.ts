import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validateDAG } from "../../src/lib/dag-validator.js";
import type { DAG } from "../../src/types.js";
// @ts-expect-error — plain .mjs ops script, no type declarations
import { TARGETS, NO_LINKS_BLOCK, SPACING_BLOCK, buildNobeliumTemplate, buildBalladTemplate, retemplateDag } from "../../scripts/upgrade-no-url-sequences.mjs";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/no-url-sequences/${name}`, import.meta.url), "utf8"));
const tokens = (prompt: string) => [...new Set([...prompt.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();

describe("WF-NOBELIUM-BALLAD-UPGRADE-1019 templates", () => {
  const nobelium = buildNobeliumTemplate(fixture("blind-discovery-email-v33.json"));
  const ballad = buildBalladTemplate(fixture("cold-email-v59.json"));

  it("names the new types after their source", () => {
    expect(nobelium.type).toBe("blind-discovery-email-v33-no-url");
    expect(ballad.type).toBe("cold-email-v59-no-url-spaced");
  });

  it("states no link in EVERY email and short spaced paragraphs in EVERY email, in both templates", () => {
    for (const t of [nobelium, ballad]) {
      expect(t.prompt).toContain(NO_LINKS_BLOCK);
      expect(t.prompt).toContain(SPACING_BLOCK);
      expect(t.prompt).toContain("email 1 AND for each follow-up");
      expect(t.prompt).toContain("email 1 AND each follow-up");
    }
  });

  it("removes every instruction and input that licensed a URL", () => {
    expect(nobelium.prompt).not.toMatch(/clickDestinationUrl|destination URL|\{\{brands\}\}/);
    expect(ballad.prompt).not.toMatch(/2-4 sentences/);
  });

  it("declares exactly the {{variables}} its body uses", () => {
    for (const t of [nobelium, ballad]) {
      expect(t.variables.map((v: { name: string }) => v.name).sort()).toEqual(tokens(t.prompt));
    }
  });

  it("adds no em or en dash and no retired offer claim", () => {
    // The sources name the two dashes once, in the line that bans them; what this ship adds carries none.
    for (const block of [NO_LINKS_BLOCK, SPACING_BLOCK]) expect(block).not.toMatch(/[–—]/);
    for (const t of [nobelium, ballad]) {
      expect(t.prompt.match(/[–—]/g)?.length).toBe(2);
      expect(t.prompt).not.toMatch(/\$1\/day|free budget|per hot lead/i);
    }
  });

  it("refuses a source template whose anchors drifted, never half-edits it", () => {
    expect(() => buildNobeliumTemplate({ type: "x", prompt: "nothing", variables: [] })).toThrow(/anchor not found/);
    expect(() => buildBalladTemplate({ type: "x", prompt: "nothing", variables: [] })).toThrow(/anchor not found/);
  });
});

describe("WF-NOBELIUM-BALLAD-UPGRADE-1019 DAGs", () => {
  it("repoints only the content call, and drops Nobelium's brands mapping", () => {
    const [nob, bal] = TARGETS;
    const nobDag = fixture("sales-cold-email-outreach-nobelium-v5.dag.json");
    const out = retemplateDag(nobDag, nob.sourceType, "blind-discovery-email-v33-no-url", nob.dropVariables) as DAG;
    const gen = out.nodes.find((n) => n.id === "email-generate")!;
    expect((gen.config as any).body).toEqual({ type: "blind-discovery-email-v33-no-url", model: "glm-pro" });
    expect(gen.inputMapping).not.toHaveProperty("body.variables.brands");
    expect(Object.keys(gen.inputMapping!).length).toBe(Object.keys(nobDag.nodes.find((n: any) => n.id === "email-generate").inputMapping).length - 1);
    expect(out.edges).toEqual(nobDag.edges);
    expect(validateDAG(out).valid).toBe(true);

    const balDag = fixture("sales-cold-email-outreach-ballad-v6.dag.json");
    const outB = retemplateDag(balDag, bal.sourceType, "cold-email-v59-no-url-spaced", bal.dropVariables) as DAG;
    const genB = outB.nodes.find((n) => n.id === "email-generate")!;
    expect((genB.config as any).body).toEqual({ type: "cold-email-v59-no-url-spaced", model: "pro" });
    expect(genB.inputMapping).toEqual(balDag.nodes.find((n: any) => n.id === "email-generate").inputMapping);
    expect(validateDAG(outB).valid).toBe(true);
  });

  it("refuses a DAG whose content call is on another template", () => {
    const dag = fixture("sales-cold-email-outreach-ballad-v6.dag.json");
    expect(() => retemplateDag(dag, "cold-email-v12", "x", [])).toThrow(/expected cold-email-v12/);
  });

  it("descriptions state the no-link and spacing rules (features-service judges tactics on them)", () => {
    for (const t of TARGETS) {
      expect(t.description).toContain("No email of the sequence, the first one or a follow-up, carries a link");
      expect(t.description).toContain("short paragraphs");
      expect(t.description).not.toMatch(/[–—]/);
    }
  });
});
