/**
 * The idempotency key of a send to the person a trigger OCCURRENCE names, shared by every workflow that answers
 * one (`ai-meeting-booking` WhatsApp + rep alert; `form-meeting-booking` reads the same rule off `resolve-form`).
 *
 * campaign-service redelivers an occurrence carrying a person or an item after a run that did not complete its
 * work (`/end-run` success=false, nothing to do, no lead), with the SAME `trigger.eventId`, re-filing the person
 * and making them due again: the queue row gets a NEW due date. A key naming the row and its due date therefore
 * changes between the run that sent and then failed and the redelivered run, and the person would be written to
 * twice. So when the run's trigger names the person it claimed (email, case-folded) the key names the occurrence;
 * a new occurrence for the same person is a new key and is answered. A run with no trigger, or whose trigger names
 * someone else (a scheduled follow-up rung, another person's occurrence), keys on the row and its due date as
 * before. Script text, appended after `main` in a Windmill rawscript (function declarations hoist).
 */
export const OCCURRENCE_SEND_KEY_FN = `
function sendKey(workflow, followup, trigger) {
  const fold = (s) => (typeof s === "string" && s.trim() !== "" ? s.trim().toLowerCase() : null);
  const t = trigger && typeof trigger === "object" ? trigger : null;
  const eventId = t && typeof t.eventId === "string" && t.eventId.trim() !== "" ? t.eventId.trim() : null;
  const claimed = fold(followup?.email);
  if (eventId && claimed !== null && fold(t.person?.email) === claimed) return workflow + ":event:" + eventId;
  return workflow + ":" + String(followup?.id) + ":" + String(followup?.dueAt ?? "");
}
`.trim();
