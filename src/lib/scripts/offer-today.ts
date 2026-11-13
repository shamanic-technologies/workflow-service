/**
 * MATCH25-COLD-1114: an offer a prospect reads is the offer a signup gets TODAY.
 *
 * 2026-11-13 our follow-up writer told Matt "Your first $25 in credits is matched". Billing ended every match for new
 * accounts on 2026-10-29 (OFFER-RESET-1029: new accounts are `prepaid_at_cost`, a $5 advance repaid by the first
 * payment). The words came from the THREAD: our August cold email had promised "we match your first $25 in credits",
 * and the writer's prompt said "You state only what the FACTS, the FIGURES, the INSTRUCTION or the thread say" and
 * "Everything we already told them in the thread stands (... a figure we gave stays that figure)". So the thread was a
 * licensed source for an offer that has ended: 13 follow-ups written on 2026-11-10 repeated it.
 *
 * The fix is the writer's INPUT, never a check on its output (the writer is trusted): the fact line now says what our
 * offer is (only what the FACTS state today, an earlier message may name an ended one), and the "figure we gave"
 * licence is narrowed to figures about THEM. Every dynasty built from `follow-up-steps.ts` carries the fact line, so
 * each is UPGRADED (owner rule: an upgrade carrying its cases restated, `upgrade-with-cases`).
 *
 * Every text here holds no double quote and no backslash: identical in the script source and in the rendered prompt.
 */

/** The writer's fact line, opening sentence (every follow-up game). */
export const OFFER_TODAY_FACT_EDIT = [
  "You state only what the FACTS, the FIGURES, the INSTRUCTION or the thread say.",
  "You state only what the FACTS, the FIGURES, the INSTRUCTION or the thread say. What they get from us (a price, free or matched credits, a discount, a trial, a guarantee, any term of signing up) is only what the FACTS state today: an earlier message of ours may name an offer that has ended, so a term the thread holds and the FACTS do not is never repeated.",
] as const;

/** The lead follow-up's thread line: a figure we gave about THEM stands, never an offer term. */
export const OFFER_TODAY_THREAD_EDIT = [
  "(a buyer we said is not worth it for them stays out, a figure we gave stays that figure)",
  "(a buyer we said is not worth it for them stays out, a figure we gave about their business stays that figure)",
] as const;

export const OFFER_TODAY_EDITS: ReadonlyArray<readonly [string, string]> = [OFFER_TODAY_FACT_EDIT, OFFER_TODAY_THREAD_EDIT];

function countOf(text: string, part: string): number {
  return text.split(part).length - 1;
}

/**
 * The next version's source from the active one's. The fact line must be there exactly once; the thread line is the
 * lead game's only (0 or 1). Throws on a source in neither form, or already restated.
 */
export function offerTodaySource(code: string): string {
  const [factBefore, factAfter] = OFFER_TODAY_FACT_EDIT;
  if (countOf(code, factAfter) > 0) throw new Error("script source: already states the offer-today fact line");
  if (countOf(code, factBefore) !== 1) throw new Error(`script source: expected the fact line once, found ${countOf(code, factBefore)}`);
  let out = code.split(factBefore).join(factAfter);
  const [threadBefore, threadAfter] = OFFER_TODAY_THREAD_EDIT;
  const n = countOf(out, threadBefore);
  if (n > 1) throw new Error(`script source: expected the thread line at most once, found ${n}`);
  out = out.split(threadBefore).join(threadAfter);
  return out;
}

/**
 * A recorded case under the rule: every recorded string that held the old lines (the writer's prompt) restated, the
 * recorded answers untouched (the edits' texts never appear in a model answer). A case whose writer never ran is
 * returned as is. `{excluded}` when the case holds a line in an unexpected count.
 */
export function offerTodayCase<C>(c: C): { case: C } | { excluded: string } {
  const text = JSON.stringify(c);
  if (OFFER_TODAY_EDITS.some(([, after]) => countOf(text, after) > 0)) return { excluded: "already restated" };
  let out = text;
  for (const [before, after] of OFFER_TODAY_EDITS) out = out.split(before).join(after);
  return { case: JSON.parse(out) as C };
}
