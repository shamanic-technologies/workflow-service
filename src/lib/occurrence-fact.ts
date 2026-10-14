/**
 * WHY A RUN WRITES NOW: the trigger OCCURRENCE a run answers, read the same way by every writer that answers one
 * (FACT-NOT-FOLLOWED-1014, owner 2026-10-14: « une campagne qui écrit dès qu'il y a un signup non suivi d'un paid
 * client dans les 30 min »).
 *
 * campaign-service hands a run dispatched for an occurrence `flow_input.trigger`
 * (`{ eventId, triggerId, leadId, item, person: { email, name, phone, crmContact } }`), after filing the person on
 * the unit and making them due on its own follow-up queue. WHAT the fact is lives at features-service, where the
 * trigger TYPE is declared (`GET /internal/catalogue/triggers/{id}`: label, one-line description, the step it
 * starts from, its kind and params, e.g. a `delay` `{afterStep, minutes, unlessStep}`). The writer reads the type
 * and puts it in front of the model as "WHY WE WRITE NOW", rendered generically: any trigger, any kind, any params,
 * never a branch per trigger.
 *
 *  - `occurrence` (`OCCURRENCE_PLAN_CODE`): what the run carries. `answering` = the run answers an occurrence (it
 *    has an event id), `skipTriggerRead` = there is no trigger type to read (the read node is then not called).
 *  - `trigger-type` (`triggerTypeNode`): the declared type. A read: retried; any failure fails the run loud (a
 *    writer never writes blind), and campaign-service redelivers the occurrence.
 *  - `WHY_NOW_FN`: script text appended after a compose script's `main` (function declarations hoist), turning the
 *    two into plain lines. Nothing to say (no trigger) = no lines.
 */
import type { DAGNode } from "./dag-validator.js";

/** Reads the run's trigger (and the campaign's instruction, which decides whether figures are read at all). */
export const OCCURRENCE_PLAN_CODE = `
export async function main(trigger, instruction, reactive) {
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const t = trigger && typeof trigger === "object" ? trigger : null;
  const eventId = s(t?.eventId);
  const triggerId = s(t?.triggerId);
  const p = t?.person && typeof t.person === "object" ? t.person : null;
  const hasInstruction = s(instruction) !== null;
  return {
    answering: eventId !== null,
    eventId,
    triggerId,
    skipTriggerRead: triggerId === null,
    hasInstruction,
    skipFigures: !hasInstruction,
    // Only a unit campaign-service SAYS is proactive (\`/start-run\` \`reactive: false\`) may be served a new lead.
    // Reactive, or unknown (null: no leg, catalogue unreadable; absent: an older campaign-service), never buys a
    // stranger: a reactive unit answers the people its trigger made due, nobody else.
    serveNewLead: eventId === null && reactive === false,
    person: p ? { email: s(p.email)?.toLowerCase() ?? null, name: s(p.name), phone: s(p.phone) } : null,
  };
}
`.trim();

export const occurrencePlanNode = (): DAGNode => ({
  id: "occurrence",
  type: "script",
  config: { code: OCCURRENCE_PLAN_CODE },
  retries: 0,
  inputMapping: {
    trigger: "$ref:flow_input.trigger",
    instruction: "$ref:start-run.output.instruction",
    reactive: "$ref:start-run.output.reactive",
  },
});

/** features-service's declaration of the trigger type the run answers; not called when the run carries none. */
export const triggerTypeNode = (): DAGNode => ({
  id: "trigger-type",
  type: "http.call",
  config: { service: "features", method: "GET", path: "/internal/catalogue/triggers/{id}" },
  // A read: safe to retry across a sibling being redeployed.
  retries: 2,
  inputMapping: {
    "params.id": "$ref:occurrence.output.triggerId",
    skip: "$ref:occurrence.output.skipTriggerRead",
  },
});

/**
 * `whyNowLines(occurrence, triggerType, claimedEmail, nowIso)`: the fact, as plain lines for the model. Empty when the
 * run answers no occurrence. Throws when the run answers a trigger whose declaration did not come back.
 */
export const WHY_NOW_FN = `
function whyNowLines(occurrence, triggerType, claimedEmail, nowIso) {
  if (!occurrence || occurrence.skipTriggerRead === true || !occurrence.triggerId) return [];
  const t = triggerType && typeof triggerType === "object" && triggerType.notCalled !== true ? triggerType : null;
  if (!t || typeof t.name !== "string") throw new Error("why-now: the trigger " + occurrence.triggerId + " this run answers was not read; nothing is written blind");
  const fold = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim().toLowerCase() : null);
  const params = t.params && typeof t.params === "object" ? Object.entries(t.params) : [];
  const lines = ["Trigger: " + t.name + (typeof t.line === "string" && t.line.trim() ? ": " + t.line.trim() : "")];
  if (typeof t.fromStepName === "string" && t.fromStepName.trim()) lines.push("It starts when the person reaches: " + t.fromStepName.trim());
  if (params.length) lines.push("Its settings: " + params.map(([k, v]) => k + " = " + (typeof v === "string" ? v : JSON.stringify(v))).join(", "));
  const named = fold(occurrence.person?.email);
  if (named && named === fold(claimedEmail)) {
    lines.push("It fired for THIS person just now (" + String(nowIso) + ").");
  } else {
    lines.push("This person is owed a message because of this same trigger.");
  }
  return lines;
}
`.trim();

/** The strategy the writer follows when a fact made the message due: a game to adapt, never a canned reply. */
export const WHY_NOW_STRATEGY =
  "WHY WE WRITE NOW names the fact that made this message due: what this person did with us, and, when its settings " +
  "name a step they have not reached since, what they have not done yet (and how long we waited). Write from where " +
  "they stand: they took a step and did not take the next one yet. Make the next step easy: answer the doubt that most " +
  "likely stopped them, from the FACTS and what we sell, and offer ONE clear, easy next step, with no pressure. Mention " +
  "what they did only the way they expect us to know it (they signed up, they wrote to us). Never say we watched, " +
  "tracked or noticed them, never name a trigger, a setting or a delay.";
