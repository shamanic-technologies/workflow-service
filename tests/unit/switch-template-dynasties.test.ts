import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs ops script, no type declarations
import { pinnedType, statedDynasty, dropUnknownVariables } from "../../scripts/switch-template-dynasties.mjs";
import { withTemplateDynasty } from "../../src/lib/template-dynasty.js";
import type { DAG } from "../../src/lib/dag-validator.js";

const dag = JSON.parse(readFileSync(new URL("../fixtures/no-url-sequences/sales-cold-email-outreach-nobelium-v5.dag.json", import.meta.url), "utf8")) as DAG;
const gen = (d: DAG) => d.nodes.find((n) => n.config?.path === "/generate")!;

describe("switch-template-dynasties helpers", () => {
  it("reads the pinned template of a pinned DAG and of a switched one (its static base)", () => {
    const type = pinnedType(dag);
    expect(type).toBeTruthy();
    const switched = withTemplateDynasty(dag, "cold-reply-intro-offer-blind", "head-v2");
    expect(pinnedType(switched)).toBe("head-v2");
    expect(statedDynasty(switched)).toBe("cold-reply-intro-offer-blind");
    expect(statedDynasty(dag)).toBeNull();
  });

  it("drops only the variables the head neither declares nor accepts as context", () => {
    const names = Object.keys(gen(dag).inputMapping!).filter((k) => k.startsWith("body.variables.")).map((k) => k.slice("body.variables.".length));
    const keep = new Set(names.slice(1));
    const { dag: trimmed, dropped } = dropUnknownVariables(dag, keep);
    expect(dropped).toEqual([names[0]]);
    expect(gen(trimmed).inputMapping![`body.variables.${names[0]}`]).toBeUndefined();
    expect(gen(dag).inputMapping![`body.variables.${names[0]}`]).toBeDefined();
  });
});
