/**
 * MON-WA-FOUNDER-HELLO-1126: the founder hello's sender (`whatsapp_message_sent/dy_founder_hello`) threw « the
 * occurrence's person was made due but nobody could be claimed » whenever lead-service's claim answered `found: false`,
 * whatever its `reason`, so a person simply held elsewhere read as a failed script on Monitoring (prod 2026-11-26,
 * Shakeeb: the run that claimed him at 03:50 died in a deploy 8 s later; its one-hour lease, and the person's one next
 * date it moved to the lease's end, held him; the redelivery at 04:21 found nobody and failed).
 *
 * lead-service names why nobody came back (`reason`): `all_claimed` = another worker holds the row (its lease ends
 * within the hour; a worker that died leaves the person due again then) = an UNFINISHED look, `again` (on an
 * occurrence: nothing stated about the person, the occurrence is redelivered); `nothing_due` = the person's one next
 * date is in the future (someone of the brand wrote them, or a dead claim's lease holds it) = nothing to send now,
 * `decided: idle` (redelivered, bounded). Any other reason, or none, still throws, naming it. Anchored edits of the
 * STORED code; a moved anchor = nothing generated.
 */
const MARK = "MON-WA-FOUNDER-HELLO-1126";
const PICK_ANCHOR = `    if (claim?.found !== true) return nobody("unclaimed");`;
const OUTCOME_ANCHOR = `  if (person?.go !== true) return { endKind: person?.end ?? "nobody_due", skipRecord: true, rowId: null, rowReason: null };`;
const END_ANCHOR = `  if (outcome.endKind === "unclaimed") throw new Error("founder-hello: the occurrence's person was made due but nobody could be claimed");`;

const PICK = `    // ${MARK}: lead-service's reason for nobody rides to the end.
    if (claim?.found !== true) return { ...nobody("unclaimed"), claimReason: typeof claim?.reason === "string" ? claim.reason : null };`;
const OUTCOME = `  if (person?.go !== true) return { endKind: person?.end ?? "nobody_due", skipRecord: true, rowId: null, rowReason: null, claimReason: person?.claimReason ?? null };`;
const END = `  if (outcome.endKind === "unclaimed") {
    // ${MARK}: a person held elsewhere is a look to make again, never a failed script.
    if (outcome.claimReason === "all_claimed") return { unmade: "all_claimed: another run holds this person's row; its lease ends within the hour, the occurrence is asked again", again: true };
    if (outcome.claimReason === "nothing_due") return { unmade: "nothing_due: lead-service holds this person's one next date in the future; nothing to send now", decided: "idle" };
    throw new Error("founder-hello: the occurrence's person was made due but nobody could be claimed (" + String(outcome.claimReason ?? "no reason") + ")");
  }`;

/** The three anchored edits, in order (the catalogue's `replace` op applies them to the stored code in ONE upgrade). */
export const FOUNDER_HELLO_CLAIM_EDITS = [
  { from: PICK_ANCHOR, to: PICK },
  { from: OUTCOME_ANCHOR, to: OUTCOME },
  { from: END_ANCHOR, to: END },
] as const;

export function addFounderHelloClaimReason(code: string): string {
  if (code.includes(MARK)) throw new Error("founder hello claim: already in the code");
  for (const { from } of FOUNDER_HELLO_CLAIM_EDITS) {
    if (code.split(from).length !== 2) throw new Error("founder hello claim: an anchor is not found exactly once: " + from.trim().slice(0, 60));
  }
  return FOUNDER_HELLO_CLAIM_EDITS.reduce((c, { from, to }) => c.replace(from, () => to), code);
}

export const FOUNDER_HELLO_CLAIM_MARK = MARK;
export const FOUNDER_HELLO_SENDER = { outcome: "whatsapp_message_sent", dynasty: "dy_founder_hello" } as const;
