/**
 * CLIENT CHECK-IN (CLIENT-CHECKIN-ON-LEAD-EVENT-1024). Owner Kevin, 2026-10-24: « A chaque event de l'Unibox pour un
 * client actuel (non perso) une campagne réactive se déclenche pour se demander si ça lui écrit pour un check-in ou
 * l'accompagner pour avoir plus de valeur avec le service ».
 *
 * The follow-up channel's reactive DAG (`follow-up-dag.ts`), for a CURRENT CLIENT of the brand instead of a lead:
 *  - WHO: the claim states `relationships: CURRENT_CLIENTS_POLICY` (features-service's tactic "Current clients only"
 *    reads that literal; the strategy that requires it is the pipe's play). lead-service judges and refuses everyone
 *    else (prospects, personal contacts, the brand's team, staff); a refused person named by the run's occurrence
 *    ends the run `personNotAdmitted` (final), a person lead-service cannot judge yet ends idle (redelivered).
 *  - The follow-up STATE: lead-service's prospect stops (a customer, a booked meeting, a positive reply, not a pure
 *    prospect, not the brand's lead, never emailed) are what a client IS, never a reason to stay silent here. Only
 *    their own stops hold: team member, opted out, do not contact, unsubscribed, bounced.
 *  - THE GAME: a check-in or one concrete way to get more value from what they already pay for, or a later date.
 *    Everything else (the whole Unibox thread read first, the channel chosen before the model, the right moment,
 *    their local time, the persona of the sending account, the next date stated after every run) is the follow-up's.
 */
import type { DAG } from "./dag-validator.js";
import { FOLLOW_UP_FEATURE_SLUG, RESOLVE_CLAIMED_PERSON_CODE, buildFollowUpReactiveDag, composeFollowUpCode, type FollowUpAudience, type FollowUpGame } from "./follow-up-dag.js";

/** The pipe: Lead event (any fact about a person) heads it; a current client reloading is the paid client outcome. */
export const CLIENT_CHECK_IN_LEG_KEY = "start_to_paid_client";
export const CLIENT_CHECK_IN_PIPE_ID = `${FOLLOW_UP_FEATURE_SLUG}|${CLIENT_CHECK_IN_LEG_KEY}`;

/** lead-service's claim policy "current clients only" (paid the brand, professional customer, never personal or team). */
export const CURRENT_CLIENTS_POLICY = "current_client";

/** lead-service's claim reason when no row is claimable: for the occurrence's person, kept off the queue on purpose. */
export const QUEUE_EXCLUDED_REASON = "nothing_due";

/** Follow-up state reasons that only say WHAT a client is: never a stop on this pipe. */
export const CLIENT_EXPECTED_REASONS = [
  "customer",
  "meeting_attended",
  "meeting_booked",
  "positive_reply",
  "not_pure_prospect",
  "not_brand_lead",
  "not_contacted",
  "no_action_toward_us",
  "disqualified",
  "in_conversation",
  "relationship_not_judged",
  "same_person_question_open",
] as const;

export const CLIENT_CHECK_IN_DESCRIPTION =
  "Answers every event of a current client of the brand (someone who paid the brand, never a personal contact, a prospect or the brand's own team): it reads their whole thread and either writes now, on WhatsApp when the brand reaches them there or else by email in their last thread, with a short check-in or one concrete way to get more from the service, or sets a later follow-up date and writes nothing. Its follow-up claim states current clients only.";

/**
 * The claim read of a reactive follow-up whose claim states a relationship policy (a client here, a lead on the Lead
 * follow-up, `lead-follow-up-leads-dag.ts`): a person lead-service refuses or keeps off the queue ends the run final,
 * named; one it cannot judge yet ends idle. Everyone else is the follow-up's own resolve, unchanged. `noun` names who
 * the pipe answers in the logs; `defaultReason` is stated when a refusal carries none.
 */
export function admissionResolveCode(o: { tag: string; noun: string; defaultReason: string }): string {
  return (
    RESOLVE_CLAIMED_PERSON_CODE.replace("export async function main(claim, detail, trigger)", "async function resolveClaimed(claim, detail, trigger)") +
    `

export async function main(claim, detail, trigger) {
  if (claim?.found !== true) {
    const t = trigger && typeof trigger === "object" ? trigger : null;
    const fold = (s) => (typeof s === "string" && s.trim() !== "" ? s.trim().toLowerCase() : null);
    const email = fold(t?.person?.email);
    const digits = phoneDigits(t?.person?.phone ?? null);
    const leadId = t && typeof t.leadId === "string" && t.leadId.trim() ? t.leadId.trim() : null;
    const isTheirs = (e) =>
      (email !== null && fold(e?.email) === email) ||
      (digits !== "" && fold(e?.email) === null && phoneDigits(e?.phone ?? null) === digits) ||
      (leadId !== null && e?.leadId === leadId);
    const refused = Array.isArray(claim?.relationships?.refused) ? claim.relationships.refused : [];
    const pending = Array.isArray(claim?.relationships?.pending) ? claim.relationships.pending : [];
    const r = refused.find(isTheirs);
    if (r) {
      console.log("[${o.tag}] not ${o.noun} of the brand (" + String(r.reason) + "): nothing written");
      return { ok: false, why: "not ${o.noun}", endKind: "not_admitted", notAdmitted: { reason: String(r.reason ?? "${o.defaultReason}") } };
    }
    if (pending.some(isTheirs)) {
      console.log("[${o.tag}] lead-service cannot say yet whether they are ${o.noun}: asked again later");
      return { ok: false, why: "relationship pending", endKind: "pending" };
    }
    if (t && (email || digits || leadId) && claim?.reason === "${QUEUE_EXCLUDED_REASON}") {
      console.log("[${o.tag}] lead-service keeps them off the queue (${QUEUE_EXCLUDED_REASON}): nothing written");
      return { ok: false, why: "kept off the queue", endKind: "not_admitted", notAdmitted: { reason: "${QUEUE_EXCLUDED_REASON}" } };
    }
  }
  return resolveClaimed(claim, detail, trigger);
}
`
  );
}

export const RESOLVE_CLIENT_CODE = admissionResolveCode({ tag: "client-check-in", noun: "a current client", defaultReason: "not_a_current_client" });

/**
 * lead-service's follow-up state for a CLIENT: their own stops hold (team, opted out, do not contact, unsubscribed,
 * bounced: nothing written, no date); a queued email step waits for it; everything that only says they are a client
 * is read as owed. Anything else lead-service names is a stop (an unknown reason is never a yes).
 */
export const READ_CLIENT_STATE_CODE = `
export async function main(person, state, nowIso) {
  if (person?.ok !== true) return { proceed: false, kind: "none", skip: true };
  const owed = state?.owed;
  const kind = owed?.kind;
  if (kind !== "owed" && kind !== "stop" && kind !== "not_yet") {
    throw new Error("follow-up-state: lead-service answered no follow-up kind: " + JSON.stringify(state).slice(0, 300));
  }
  if (!state.followupDate || typeof state.followupDate !== "object" || !state.queued || typeof state.queued !== "object") {
    throw new Error("follow-up-state: lead-service answered no date or queue: " + JSON.stringify(state).slice(0, 300));
  }
  const now = Date.parse(String(nowIso));
  const currentNext = Date.parse(String(state.followupDate.nextFollowupAt ?? ""));
  const reasons = Array.isArray(owed.reasons) ? owed.reasons : [];
  const EXPECTED = ${JSON.stringify(CLIENT_EXPECTED_REASONS)};
  const left = kind === "owed" ? [] : reasons.filter((r) => !EXPECTED.includes(r));
  if (kind !== "owed" && reasons.length === 0) {
    throw new Error("follow-up-state: lead-service said " + kind + " without naming a reason");
  }
  const sequence = left.length > 0 && left.every((r) => r === "sequence_running");
  if (left.length > 0 && !sequence) {
    console.log("[client-check-in] lead-service says stop (" + left.join(", ") + "): nothing written, no next date");
    return { proceed: false, kind: "stop", reason: left[0], skip: true };
  }
  const q = state.queued;
  const others = (Array.isArray(q.followups) ? q.followups : []).filter((f) => f && f.leadCampaignId !== person.rowId && Number.isFinite(Date.parse(String(f.dueAt))));
  if (sequence || q.emailSequence === true || others.length > 0) {
    const lastDue = others.reduce((m, f) => Math.max(m, Date.parse(String(f.dueAt))), now);
    const after = lastDue + 3 * 86400000;
    const next = new Date(Number.isFinite(currentNext) && currentNext > after ? currentNext : after).toISOString();
    const what = sequence || q.emailSequence === true
      ? "a step of their email sequence is still queued"
      : others.length + " follow-up(s) already owed to them by another campaign, the last due " + new Date(lastDue).toISOString();
    console.log("[client-check-in] " + what + ": nothing written, next look at " + next);
    return { proceed: false, kind: "queued", reason: what, skip: true, nextFollowUpAt: next, nextFollowUpWhy: "Already queued: " + what };
  }
  return { proceed: true, kind: "owed", reason: null, skip: false };
}
`.trim();

/** THE GAME for a current client: four prompt lines (JS string literals of the generated script). */
const line = (text: string) => `    ${JSON.stringify(text)},\n`;
export const CLIENT_CHECK_IN_GAME: FollowUpGame = {
  occurrenceItem: true,
  intro:
    '    "You look after ONE current client of " + brandName + ": they already pay us. Something just happened with them, and you decide whether to write to them now or WHEN we next look at them. The thread below is everything that passed between us on every channel, our automatic messages and our transactional emails included.",\n',
  game: line(
    "THE GAME. A client stays and grows when the service keeps bringing them value: more meetings, people who fit them better, a result they have not noticed yet, a reload before their credit runs dry so nothing stops. Write only when ONE of those is real for them NOW, read from the thread, the events and the facts: a short check-in on what they wanted to get, or one concrete way to get more from what they already use. Never sell them what they already have, never a generic \"how is it going\", never a reminder of an earlier message. End with ONE easy question they can answer in a line. When the event needs nothing from us, or we wrote recently and they have not answered, choose later.",
  ),
  read: line(
    "Read the thread like the person on our side who knows them. A client who just asked us something (their message, or the form or event that brought this run, is the last word and nobody on our side answered it) is waiting for us right now: write NOW, on any day, since they are there. Answer it when the FACTS hold the answer; when they do not, ask the ONE question that lets us help them (what their offer or listing shows, what they already tried), never a holding line and never a promise. Never repeat what one of our messages or transactional emails already told them.",
  ),
  stop: line(
    "STOP only on the client's OWN words asking us to stop writing to them, unsubscribe or never write again. Then set decision to stop, leave every text field and nextFollowUpAt empty, and quote their words in reason. A complaint, a \"not now\" or a quiet stretch is NOT a stop: answer what they said, or choose later. Silence is never a reason to stop.",
  ),
};

export const COMPOSE_CLIENT_CHECK_IN_CODE = composeFollowUpCode(CLIENT_CHECK_IN_GAME);

export const CLIENT_CHECK_IN_AUDIENCE: FollowUpAudience = {
  claimBody: { relationships: CURRENT_CLIENTS_POLICY },
  resolveClaimedCode: RESOLVE_CLIENT_CODE,
  readStateCode: READ_CLIENT_STATE_CODE,
  composeCode: COMPOSE_CLIENT_CHECK_IN_CODE,
  claimEnds: [
    // Not a current client: final, campaign-service records the occurrence skipped and never redelivers it.
    { kind: "not_admitted", body: { success: true, stopCampaign: false }, inputMapping: { "body.personNotAdmitted": "$ref:resolve-person.output.notAdmitted" } },
    // lead-service cannot say yet: idle, the occurrence is redelivered later.
    { kind: "pending", body: { success: true, stopCampaign: false, noWorkAvailable: true } },
  ],
};

/** The DAG; the seed creates it on its pipe as its own dynasty, and upgrades it in place. */
export function buildClientCheckInDag(): DAG {
  return buildFollowUpReactiveDag({ readFigures: false, audience: CLIENT_CHECK_IN_AUDIENCE });
}

/** A stored DAG is a client check-in when its claim states the current clients policy (never told by description). */
export function isClientCheckInDag(dag: unknown): boolean {
  const nodes = (dag as { nodes?: Array<{ id?: string; config?: { body?: { relationships?: unknown } } }> } | null)?.nodes;
  return Array.isArray(nodes) && nodes.some((n) => n.id === "claim-followup" && n.config?.body?.relationships === CURRENT_CLIENTS_POLICY);
}
