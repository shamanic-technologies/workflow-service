import type { ScriptPickReader, ServedPick } from "../../src/lib/scripts/engine.js";

/**
 * A stand-in for features-service's Rating (`GET /internal/script-pick`) in tests: it ranks the candidates in the order
 * they were asked, or by `scores` (highest first) when given. Every call is recorded so a test can read what was asked.
 */
export function fakeScriptPick(scores: Record<string, number> = {}): ScriptPickReader & { calls: Array<{ outcome: string; dynasties: string[] }> } {
  const calls: Array<{ outcome: string; dynasties: string[] }> = [];
  const reader = async (outcome: string, dynasties: string[]): Promise<ServedPick> => {
    calls.push({ outcome, dynasties });
    const order = dynasties
      .map((d, i) => ({ d, i, s: scores[d.slice(d.indexOf("/") + 1)] ?? 0 }))
      .sort((a, b) => b.s - a.s || a.i - b.i);
    return { scriptDynasty: order[0]?.d ?? null, basis: "value_per_dollar", candidates: order.map((o) => ({ scriptDynasty: o.d, runs: 0, score: o.s })) };
  };
  return Object.assign(reader, { calls });
}
