/**
 * The DAG of the `ai-lead-proposal|start_to_paid_client` pipe (channel "AI Lead Proposal", REACTIVE on `hot_lead`;
 * HOT-LEAD-PROPOSAL-1019, owner 2026-10-19: « Sophie me notifie à chq fois qu'une lead non client non perso nous
 * écrit avec de l'interest business, pour me proposer quoi mettre en place pour eux (sans le faire sans mon go) »).
 *
 * How the person gets here: lead-service reports a person who NEWLY became a hot lead of a brand (lead yes AND wants
 * business yes, any channel) to campaign-service's one trigger door, with `person` {email, name, phone}, `leadId`
 * when a lead of the brand owns the address, and `item` = {kind: "hot_lead", humanId, companyKey, relationKey(s),
 * leadId, name, emails, phones, lead, wantsBusiness, lastInboundAt, becameHotAt, episode}. campaign-service files the
 * person on the campaign's own lead-service queue, due now, and dispatches this workflow with the occurrence as
 * `flow_input.trigger`.
 *
 * One run asks chat-service for ONE proactive Copilot turn toward the brand's TEAM, and does nothing else: nothing is
 * sent to the person, nothing is set up (the turn has read tools only; the team says go in that thread):
 *
 *  - Only a run carrying an occurrence that names a person claims anyone (campaign-service also dispatches reactive
 *    campaigns on a schedule, with no trigger: those end idle).
 *  - WHO: the claim states `relationships: "pure_prospect"` (`ANSWERS_LEADS_ONLY_POLICY`, features-service's tactic
 *    `answers-leads-only`, required by the pipe's lead strategy `leads-only`): lead-service refuses a personal
 *    contact, a customer, team, investor... and the run ends `personNotAdmitted` (final, never redelivered); a person
 *    whose relationship is not judged yet ends idle (redelivered later). This flow never judges a relationship.
 *  - The claimed row must be the person the trigger names (email case-folded, else phone digits, else lead id);
 *    claimed someone else = their row is left alone and the run fails (redelivered).
 *  - What they wrote: their latest inbound message off crm-service's merged timeline (the relation's thread), read
 *    tolerantly: unreadable = the turn is still asked, without the quote (the Copilot reads the thread itself), logged.
 *  - The idempotency key names the FACT, never the run or the offer: lead-service fires one occurrence per active
 *    offer of the brand, so two campaigns of one brand on this pipe carry two events for one fact, and a redelivered
 *    run carries the same event. `ai-lead-proposal:hot_lead:<brand>:<human>:<company hash|->:<episode>` (lead-service's
 *    own key minus the offer); an item without them falls back to the event (`ai-lead-proposal:event:<eventId>`).
 *    chat-service answers a repeated key 200 `duplicate: true` and writes nothing again: one message per new fact.
 *  - chat-service 409 `no_copilot_user` (nobody of the brand's team ever used the Copilot) is FINAL: the row is
 *    stopped `hot_lead_no_copilot_user` and the run ends stating `delivery` refused with that code (campaign-service
 *    ends the occurrence at once, never redelivered, the code served). Any other failure fails the run (redelivered,
 *    bounded; the same key makes the retry safe).
 *  - Asked (202 accepted or 200 duplicate) = row stopped `hot_lead_proposed` (not handed: a new hot episode of the
 *    same person is a new fact), run ends `delivery: delivered`.
 *  - Cost: the Copilot turn is declared by chat-service on this run (`x-run-id`); nothing is declared here.
 */
import type { DAG } from "./dag-validator.js";
import { ANSWERS_LEADS_ONLY_POLICY, NOT_A_LEAD_REASON } from "./ai-meeting-booking-dag.js";
import { DELIVERED } from "./occurrence-delivery.js";

export const AI_LEAD_PROPOSAL_FEATURE_SLUG = "ai-lead-proposal";
export const AI_LEAD_PROPOSAL_LEG_KEY = "start_to_paid_client";
export const AI_LEAD_PROPOSAL_PIPE_ID = `${AI_LEAD_PROPOSAL_FEATURE_SLUG}|${AI_LEAD_PROPOSAL_LEG_KEY}`;

/** The `kind` chat-service's proactive turn names this fact by. */
export const PROACTIVE_TURN_KIND = "hot_lead";

/** chat-service's refusal when nobody of the org ever used the Copilot (no thread to write in). */
export const NO_COPILOT_USER_CODE = "no_copilot_user";

/** Stored on the queue row once the turn was asked: stopped, so a new hot episode of the same person is asked too. */
export const HOT_LEAD_PROPOSED_REASON = "hot_lead_proposed";

/** Stored when chat-service had nobody to write to. */
export const HOT_LEAD_NO_COPILOT_USER_REASON = "hot_lead_no_copilot_user";

export const AI_LEAD_PROPOSAL_DESCRIPTION =
  "When a lead of the brand writes to it and wants to do business (Hot Lead), asks the brand's assistant in the " +
  "Copilot to write ONE short message to the brand's own team: who the person is, what they wrote, and one concrete " +
  "proposal of what we could set up for them, ending with a request for the team's go. Nothing is sent to the person " +
  "and nothing is set up until a person of the team says go in that thread. Its claim calls lead-service POST " +
  '/orgs/campaigns/{campaignId}/followups/claim-next with relationships set to "pure_prospect", so it acts only for ' +
  "leads of the brand: a person lead-service refuses (a personal contact, a customer, team member, investor, partner, " +
  "supplier or advisor of the brand) ends the run with personNotAdmitted.";

/** Whether this run carries an occurrence naming a person: a run that does not claims nobody. Pure. */
export const PLAN_CLAIM_CODE = `
export async function main(trigger) {
  const t = trigger && typeof trigger === "object" ? trigger : null;
  const filled = (v) => typeof v === "string" && v.trim() !== "";
  const carries = Boolean(t && (filled(t.person?.email) || filled(t.person?.phone) || filled(t.leadId)));
  if (!carries) console.log("[ai-lead-proposal] this run carries no hot lead: nobody is claimed");
  return { skip: !carries };
}
`.trim();

/**
 * lead-service's claim reason when NO row of the campaign is claimable. The trigger door makes the occurrence's
 * person due on this campaign right before the dispatch (whatever follow-up date they had), so for that person it
 * means lead-service excludes them from its queue on purpose (a `sale` / booked meeting on record: a customer; a
 * thread handed to a person; a journalist), never "not due yet". Prod 2026-10-19: a client (sale on record) ended
 * `failed` and was redelivered. Now final: `personNotAdmitted {reason: "nothing_due"}`. `all_claimed` (another
 * worker holds the row, e.g. a failed run's lease) stays a failure, so the redelivery claims them once it lapses.
 */
export const QUEUE_EXCLUDED_REASON = "nothing_due";

/**
 * What the claim means for this run, and the proactive-turn request when it is the trigger's person. Outcomes:
 * `ask` | `not_admitted` | `pending` | `nobody_due` | `other_person` | `unclaimed`. Never throws on an outcome;
 * throws on a broken input (a claimed row with no id, a brand or org that is not one UUID).
 */
export const CLAIMED_CODE = `
export async function main(plan, claim, trigger, orgId, brandId) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const filled = (v) => typeof v === "string" && v.trim() !== "";
  const emailOf = (s) => (filled(s) ? s.trim().toLowerCase() : null);
  const phoneOf = (s) => {
    if (typeof s !== "string" || !/^\\s*(\\+|00)/.test(s)) return null;
    const d = s.replace(/^\\s*(\\+|00)/, "").replace(/\\D/g, "");
    return d.length >= 8 && d.length <= 15 ? "+" + d : null;
  };
  const base = { outcome: null, rowId: null, notAdmitted: null, request: null, timelineQuery: null, skipTimeline: true };
  if (plan?.skip === true) return { ...base, outcome: "nobody_due" };

  const t = trigger;
  const item = t?.item && typeof t.item === "object" ? t.item : {};
  const triggerEmail = emailOf(t?.person?.email);
  const triggerPhone = phoneOf(t?.person?.phone);
  const triggerLeadId = filled(t?.leadId) ? t.leadId : null;
  const isTriggerPerson = (e) =>
    (triggerEmail !== null && emailOf(e?.email) === triggerEmail) ||
    (triggerPhone !== null && emailOf(e?.email) === null && phoneOf(e?.phone) === triggerPhone) ||
    (triggerLeadId !== null && e?.leadId === triggerLeadId);

  if (claim?.found !== true) {
    const refused = Array.isArray(claim?.relationships?.refused) ? claim.relationships.refused : [];
    const pending = Array.isArray(claim?.relationships?.pending) ? claim.relationships.pending : [];
    const r = refused.find(isTriggerPerson);
    if (r) {
      console.log("[ai-lead-proposal] not a lead of the brand, nothing asked (" + String(r.reason) + "): " + String(r.email ?? r.phone));
      return { ...base, outcome: "not_admitted", notAdmitted: { reason: String(r.reason ?? "${NOT_A_LEAD_REASON}") } };
    }
    if (pending.some(isTriggerPerson)) {
      console.log("[ai-lead-proposal] relationship not judged yet, asked again later: " + String(triggerEmail ?? triggerPhone ?? triggerLeadId));
      return { ...base, outcome: "pending" };
    }
    // The door made them due right before this dispatch, so an EMPTY queue means lead-service keeps them off it
    // for good (a booked meeting or a sale on record: a customer; a thread handed to a person...). Final, named.
    if (claim?.reason === "${QUEUE_EXCLUDED_REASON}") {
      console.log("[ai-lead-proposal] lead-service keeps " + String(triggerEmail ?? triggerPhone ?? triggerLeadId) + " off the queue (${QUEUE_EXCLUDED_REASON}): nothing asked");
      return { ...base, outcome: "not_admitted", notAdmitted: { reason: "${QUEUE_EXCLUDED_REASON}" } };
    }
    console.error("[ai-lead-proposal] the occurrence's person was made due but nobody could be claimed (" + String(claim?.reason ?? "no reason") + ")");
    return { ...base, outcome: "unclaimed" };
  }

  const f = claim.followup ?? {};
  if (!f.id) throw new Error("[ai-lead-proposal] lead-service claimed a row without an id: " + JSON.stringify(f));
  if (!isTriggerPerson(f)) {
    console.error("[ai-lead-proposal] claimed " + String(f.email ?? f.phone) + ", not the person this occurrence names: their row is left alone");
    return { ...base, outcome: "other_person" };
  }
  if (typeof orgId !== "string" || !UUID.test(orgId)) throw new Error("[ai-lead-proposal] the run carries no org UUID: " + String(orgId));
  const brand = typeof brandId === "string" ? brandId.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (brand.length !== 1 || !UUID.test(brand[0])) throw new Error("[ai-lead-proposal] the run must carry exactly one brand UUID: " + String(brandId));

  // The fact's key: never the run, never the offer (one occurrence per offer of the brand for one fact).
  let idempotencyKey;
  const episode = Number.isInteger(item.episode) ? item.episode : null;
  if (item.kind === "hot_lead" && filled(item.humanId) && episode !== null) {
    let company = "-";
    if (filled(item.companyKey)) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.companyKey));
      company = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
    }
    idempotencyKey = "ai-lead-proposal:hot_lead:" + brand[0] + ":" + item.humanId + ":" + company + ":" + episode;
  } else if (filled(t?.eventId)) {
    idempotencyKey = "ai-lead-proposal:event:" + t.eventId;
  } else {
    throw new Error("[ai-lead-proposal] the occurrence carries neither a hot lead fact nor an eventId to key the turn on");
  }

  const firstOf = (a) => (Array.isArray(a) ? a.find(filled) ?? null : null);
  const email = emailOf(t?.person?.email) ?? emailOf(f.email) ?? emailOf(firstOf(item.emails));
  const phone = (filled(t?.person?.phone) ? t.person.phone.trim() : null) ?? (filled(f.phone) ? f.phone.trim() : null) ?? firstOf(item.phones);
  const name = (filled(t?.person?.name) ? t.person.name.trim() : null) ?? (filled(item.name) ? item.name.trim() : null);
  const leadId = triggerLeadId ?? (filled(item.leadId) ? item.leadId : null) ?? (filled(f.leadId) ? f.leadId : null);
  const lead = {};
  if (leadId) lead.leadId = leadId.slice(0, 300);
  if (email) lead.email = email.slice(0, 320);
  if (phone) lead.phone = phone.slice(0, 40);
  if (name) lead.name = name.slice(0, 300);

  // Their thread: the relation's when lead-service names it, else the person by email / phone.
  const relationKey = filled(item.relationKey) ? item.relationKey : firstOf(item.relationKeys);
  const personKey = email ? "email:" + email : phoneOf(phone) ? "phone:" + phoneOf(phone) : null;
  const timelineQuery = relationKey
    ? { brandId: brand[0], relationKey, limit: "50" }
    : personKey ? { brandId: brand[0], personKey, limit: "50" } : null;

  return {
    ...base,
    outcome: "ask",
    rowId: f.id,
    timelineQuery,
    skipTimeline: timelineQuery === null,
    lastInboundAt: filled(item.lastInboundAt) ? item.lastInboundAt : null,
    request: { kind: "${PROACTIVE_TURN_KIND}", idempotencyKey, orgId, brandId: brand[0], lead },
  };
}
`.trim();

/** The request with what they wrote last (their latest inbound message), when the thread could be read. Never throws. */
export const COMPOSE_TURN_CODE = `
export async function main(claimed, timeline) {
  const request = { ...claimed.request };
  const at = typeof claimed.lastInboundAt === "string" ? claimed.lastInboundAt : null;
  if (timeline && timeline.ok === false) {
    if (timeline.notCalled !== true && timeline.status !== 404) {
      console.error("[ai-lead-proposal] their thread could not be read (" + String(timeline.status) + "): the turn is asked without the quote, the Copilot reads it itself");
    }
    if (at) request.inbound = { at };
    return { request };
  }
  const items = Array.isArray(timeline?.items) ? timeline.items : [];
  const inbound = items
    .filter((i) => i?.kind === "message" && i.direction === "inbound" && typeof i.text === "string" && i.text.trim() !== "")
    .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  const last = inbound[inbound.length - 1];
  if (last) {
    const msg = {};
    if (typeof last.channel === "string" && last.channel) msg.channel = last.channel.slice(0, 100);
    msg.text = last.text.replace(/\\s+/g, " ").trim().slice(0, 5000);
    const when = typeof last.at === "string" && last.at ? last.at : at;
    if (when) msg.at = when.slice(0, 100);
    request.inbound = msg;
  } else if (at) {
    request.inbound = { at };
  }
  return { request };
}
`.trim();

/**
 * Reads chat-service's answer: 202/200 = asked; 409 `no_copilot_user` = a final refusal with its sentence; anything
 * else throws (the run fails, campaign-service redelivers; the same key makes the retry safe).
 */
export const CLASSIFY_ASK_CODE = `
export async function main(ask) {
  if (ask && ask.ok === false) {
    let body = null;
    try { body = JSON.parse(String(ask.error ?? "")); } catch { body = null; }
    if (ask.status === 409 && body?.error === "${NO_COPILOT_USER_CODE}") {
      const reason = typeof body.detail === "string" && body.detail ? body.detail : "${NO_COPILOT_USER_CODE}";
      console.log("[ai-lead-proposal] nobody of the brand's team uses the Copilot: nothing asked (" + reason + ")");
      return { outcome: "${NO_COPILOT_USER_CODE}", delivery: { state: "refused", code: "${NO_COPILOT_USER_CODE}", reason } };
    }
    throw new Error("[ai-lead-proposal] the proactive turn was not accepted (" + String(ask.status) + "): " + String(ask.error ?? "").slice(0, 500));
  }
  if (typeof ask?.id !== "string" || !ask.id) throw new Error("[ai-lead-proposal] chat-service answered without a turn id: " + JSON.stringify(ask));
  console.log("[ai-lead-proposal] proactive turn " + ask.id + " " + (ask.duplicate ? "already asked for this fact" : "asked") + " (" + String(ask.status) + ", " + String(ask.delivery) + ")");
  return { outcome: "asked", turnId: ask.id, duplicate: ask.duplicate === true };
}
`.trim();

const endRun = (id: string, body: Record<string, unknown>, inputMapping?: Record<string, string>) => ({
  id,
  type: "http.call" as const,
  config: { service: "campaign", method: "POST", path: "/end-run", body },
  ...(inputMapping ? { inputMapping } : {}),
});

const stopRow = (id: string, reason: string) => ({
  id,
  type: "http.call" as const,
  config: { service: "lead", method: "POST", path: "/orgs/leads/{id}/followups", body: { kind: "stopped", reason } },
  retries: 0,
  inputMapping: { "params.id": "$ref:claimed.output.rowId" },
});

const outcomeIs = (node: string, outcome: string) => `results['${node}']?.outcome == '${outcome}'`;

export const ASK = outcomeIs("claimed", "ask");
export const NOT_ADMITTED = outcomeIs("claimed", "not_admitted");
export const PENDING = outcomeIs("claimed", "pending");
export const NOBODY_DUE = outcomeIs("claimed", "nobody_due");
export const OTHER_PERSON = outcomeIs("claimed", "other_person");
export const UNCLAIMED = outcomeIs("claimed", "unclaimed");
export const ASKED = outcomeIs("classify-ask", "asked");
export const NO_COPILOT_USER = outcomeIs("classify-ask", NO_COPILOT_USER_CODE);

export function buildAiLeadProposalDag(): DAG {
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" },
      },
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      { id: "plan-claim", type: "script", config: { code: PLAN_CLAIM_CODE }, retries: 0, inputMapping: { trigger: "$ref:flow_input.trigger" } },
      // THIS campaign's own queue (campaign-service made the hot lead due on it right before the dispatch).
      // WHO: pure prospects of the brand only (`ANSWERS_LEADS_ONLY_POLICY`): lead-service refuses the rest.
      {
        id: "claim-own",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/campaigns/{campaignId}/followups/claim-next",
          body: { relationships: ANSWERS_LEADS_ONLY_POLICY },
        },
        retries: 0,
        inputMapping: { "params.campaignId": "$ref:flow_input.campaignId", skip: "$ref:plan-claim.output.skip" },
      },
      {
        id: "claimed",
        type: "script",
        config: { code: CLAIMED_CODE },
        retries: 0,
        inputMapping: {
          plan: "$ref:plan-claim.output",
          claim: "$ref:claim-own.output",
          trigger: "$ref:flow_input.trigger",
          orgId: "$ref:flow_input.orgId",
          brandId: "$ref:flow_input.brandId",
        },
      },
      { id: "check-claim", type: "condition" },
      // What they wrote: their latest inbound message. Tolerated: the Copilot reads the thread itself.
      {
        id: "person-thread",
        type: "http.call",
        config: { service: "crm", method: "GET", path: "/orgs/people/timeline", tolerateFailure: true },
        inputMapping: { query: "$ref:claimed.output.timelineQuery", skip: "$ref:claimed.output.skipTimeline" },
      },
      {
        id: "compose-turn",
        type: "script",
        config: { code: COMPOSE_TURN_CODE },
        retries: 0,
        inputMapping: { claimed: "$ref:claimed.output", timeline: "$ref:person-thread.output" },
      },
      // The one thing this workflow does: ask the brand's assistant to tell the brand's team. Idempotent on the fact.
      {
        id: "ask-copilot",
        type: "http.call",
        config: { service: "chat", method: "POST", path: "/internal/copilot/proactive-turns", tolerateFailure: true },
        retries: 0,
        inputMapping: { body: "$ref:compose-turn.output.request" },
      },
      { id: "classify-ask", type: "script", config: { code: CLASSIFY_ASK_CODE }, retries: 0, inputMapping: { ask: "$ref:ask-copilot.output" } },
      // Converges (edge from `claimed`, outside check-claim's branch) so it is a top-level branchone.
      { id: "check-asked", type: "condition" },
      stopRow("record-asked", HOT_LEAD_PROPOSED_REASON),
      stopRow("record-no-copilot-user", HOT_LEAD_NO_COPILOT_USER_REASON),
      endRun("end-run", { success: true, stopCampaign: false, delivery: DELIVERED }),
      endRun("end-run-no-copilot-user", { success: true, stopCampaign: false }, { "body.delivery": "$ref:classify-ask.output.delivery" }),
      endRun("end-run-person-not-admitted", { success: true, stopCampaign: false }, { "body.personNotAdmitted": "$ref:claimed.output.notAdmitted" }),
      endRun("end-run-pending", { success: true, stopCampaign: false, noWorkAvailable: true }),
      endRun("end-run-nobody-due", { success: true, stopCampaign: false, noWorkAvailable: true }),
      endRun("end-run-other-person", { success: false, stopCampaign: false }),
      endRun("end-run-unclaimed", { success: false, stopCampaign: false }),
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "plan-claim" },
      { from: "plan-claim", to: "claim-own" },
      { from: "claim-own", to: "claimed" },
      { from: "claimed", to: "check-claim" },
      { from: "check-claim", to: "person-thread", condition: ASK },
      { from: "check-claim", to: "end-run-person-not-admitted", condition: NOT_ADMITTED },
      { from: "check-claim", to: "end-run-pending", condition: PENDING },
      { from: "check-claim", to: "end-run-nobody-due", condition: NOBODY_DUE },
      { from: "check-claim", to: "end-run-other-person", condition: OTHER_PERSON },
      { from: "check-claim", to: "end-run-unclaimed", condition: UNCLAIMED },
      { from: "person-thread", to: "compose-turn" },
      { from: "compose-turn", to: "ask-copilot" },
      { from: "ask-copilot", to: "classify-ask" },
      { from: "classify-ask", to: "check-asked" },
      { from: "claimed", to: "check-asked" },
      { from: "check-asked", to: "record-asked", condition: ASKED },
      { from: "check-asked", to: "record-no-copilot-user", condition: NO_COPILOT_USER },
      { from: "record-asked", to: "end-run" },
      { from: "record-no-copilot-user", to: "end-run-no-copilot-user" },
    ],
    onError: "end-run-error",
  };
}
