/**
 * CLAIMED entry: the person the run's trigger OCCURRENCE names, stated on the claim so lead-service hands THEIR row
 * (CLAIM-OCCURRENCE-PERSON-1025). Without it the claim handed the campaign's oldest due row: in a burst of occurrences
 * every run claimed someone else, ended `other_person`, failed and left that row leased for an hour (Lead Follow-up
 * f1ab54e3, 2026-10-24). Every claiming workflow states it (ai-meeting-booking too, MEETING-BOOKING-STUCK-ITEM-1027).
 * No occurrence = null: the claim is the queue's, oldest first. An occurrence naming NOBODY = null + `skipClaim`: a
 * workflow mapping it onto its claim's `skip` claims nobody (the follow-up family, OCCURRENCE-NAMES-NOBODY-1029: a
 * nameless hot lead claimed Olive's row and Sophie reasoned on another person's inbound message).
 */
export const CLAIM_PERSON_CODE = `
export async function main(trigger) {
  const t = trigger && typeof trigger === "object" ? trigger : null;
  const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const p = t?.person && typeof t.person === "object" ? t.person : {};
  const person = { email: str(p.email), phone: str(p.phone), leadId: str(t?.leadId) };
  const named = !!(person.email || person.phone || person.leadId);
  // An OCCURRENCE (it carries an eventId) that names nobody must claim nobody: with no person the claim hands out the
  // queue's next due row, and that row's person was then answered with this occurrence's facts (OCCURRENCE-NAMES-NOBODY-1029).
  const occurrence = !!(t && typeof t.eventId === "string" && t.eventId.trim());
  return { person: named ? person : null, skipClaim: occurrence && !named };
}
`.trim();
