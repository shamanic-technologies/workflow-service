/**
 * CLAIMED entry: the person the run's trigger OCCURRENCE names, stated on the claim so lead-service hands THEIR row
 * (CLAIM-OCCURRENCE-PERSON-1025). Without it the claim handed the campaign's oldest due row: in a burst of occurrences
 * every run claimed someone else, ended `other_person`, failed and left that row leased for an hour (Lead Follow-up
 * f1ab54e3, 2026-10-24). Every claiming workflow states it (ai-meeting-booking too, MEETING-BOOKING-STUCK-ITEM-1027).
 * No occurrence, or one naming nobody = null: the claim is the queue's, oldest first.
 */
export const CLAIM_PERSON_CODE = `
export async function main(trigger) {
  const t = trigger && typeof trigger === "object" ? trigger : null;
  const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const p = t?.person && typeof t.person === "object" ? t.person : {};
  const person = { email: str(p.email), phone: str(p.phone), leadId: str(t?.leadId) };
  return { person: person.email || person.phone || person.leadId ? person : null };
}
`.trim();
