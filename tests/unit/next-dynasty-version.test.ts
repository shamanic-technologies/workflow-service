import { describe, it, expect } from "vitest";
import { nextDynastyVersion } from "../../src/lib/workflow-lineage.js";

// An upgrade of a RE-ACTIVATED earlier version (un-retire, the script writer's roll-back) takes the dynasty's next
// number: azha v6 re-activated after v7 was rolled back upgrades to v8, never to v7 (a slug v7 already holds).
describe("nextDynastyVersion", () => {
  it("is the active version + 1 on a plain chain", () => expect(nextDynastyVersion(6, 6)).toBe(7));
  it("skips past a later deprecated version", () => expect(nextDynastyVersion(6, 7)).toBe(8));
  it("reads a missing max as the version itself", () => expect(nextDynastyVersion(3, null)).toBe(4));
});
