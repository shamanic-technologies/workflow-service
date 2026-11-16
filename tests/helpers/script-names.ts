import type { NameDynasties } from "../../src/lib/scripts/script-names.js";

/** A namer for tests: a fresh readable name per dynasty, never a model call. */
export function testNamer(): NameDynasties {
  let n = 0;
  return async (_outcome, toName) => new Map(toName.map((d) => [d.dynasty, `Test script ${String.fromCharCode(97 + (n++ % 26))}${n}`]));
}
