/**
 * THE FOLLOW-UP CHANNEL (MULTICHANNEL-FOLLOWUP-1016). Owner Kevin, 2026-10-16: « un channel followup, qui prend le
 * canal le plus pertinent dispo sur l'unibox et followup. Très différent du cold email. » Every lead of a brand (not a
 * client, not a personal contact) is followed up forever, until their own words say no, they unsubscribe, are
 * disqualified, or pay.
 *
 * The channel's slug stays `ai-follow-up-email` (features-service): its three live dynasties are UPGRADED to this
 * DAG, never forked (owner rule). It runs on two kinds of legs:
 *  - PROACTIVE (`served`): a daily campaign whose Lead Sourcing pipe states the "Lead follow-up due" population
 *    (`sourcing-dag.ts`): lead-service hands the brand's leads whose next follow-up date has passed, and this pipe's
 *    own `POST /orgs/buffer/next` hands them here one per run.
 *  - REACTIVE (`claimed`): a trigger occurrence (⚡ Lead event: any fact about a lead, whatever the channel; or an older
 *    trigger a live campaign still starts on) files the person on this campaign's own lead-service queue; the run
 *    claims them.
 *
 * One run, one person, in a straight line (every node skip-gated by the plan before it, ONE condition at the end that
 * picks the end-run, so no container is ever nested in a branch, which the converter drops):
 *  1. lead-service's follow-up state (`FOLLOW_UP_STATE`): still owed a follow-up, their next date, and whether a
 *     message to them is already QUEUED on any channel. Not owed (client, personal, opted out, disqualified, their
 *     word) = nothing written, the chain ends. Not yet = nothing written, the date moves to lead-service's own retry.
 *     Something queued = nothing written, no model spend, the date moves past the queued message.
 *  2. Everything the writer needs: the whole Unibox thread (crm-service, every channel), who they are to the brand,
 *     what we sent and what they did (lead-service history), the client's facts, the figures an instruction asks for.
 *  3. THE CHANNEL is decided before the model writes, and never by the model: WhatsApp when the brand's WhatsApp can
 *     reach them (crm-service reach check, nothing sent), else email when we hold an address (a reply in their last
 *     email thread, from the mailbox that wrote to them), else none (no route can write to them: nothing is drafted,
 *     the date moves out and the run says why). LinkedIn and Telegram threads are READ, never written: no send route
 *     exists for them yet.
 *  4. The model (Opus via chat-service) plays THE RIGHT MOMENT game (`right-moment.ts`): write now, or later at a date
 *     it chooses from the thread, or stop on the person's own words.
 *  5. The send: crm-service WhatsApp (from the account that already talks with them) or email-gateway broadcast with
 *     `followUp: true` (the brand's latest thread with them, its mailbox, Gmail included). Named refusals are read.
 *  6. EVERY run that reached a person leaves their next follow-up date on lead-service (`SET_NEXT_DATE`), the date's
 *     only store; only a stop (their word, or a refusal that means they opted out) ends the chain instead.
 *
 * No em dash or en dash ever reaches the person: the prompt bans them and `finalize` rewrites any that slip through.
 */
import { withClientCommsVoice } from "./client-comms.js";
import { withLegBestLlm } from "./leg-best-writer.js";
import { withMessageWrittenDeclaration } from "./message-written-outcome.js";
import type { DAG, DAGNode } from "./dag-validator.js";
import { CHAT_STEP_MAX_TOKENS, CRM_WHATSAPP_SEND, GATHER_FACTS_CODE } from "./ai-meeting-booking-dag.js";
import { PERSON_THREAD_NODE_ID, PERSON_THREAD_QUERY_NODE_ID, relationshipReadNode, whoTheyAreNode } from "./person-relationship.js";
import { WHY_NOW_FN, WHY_NOW_STRATEGY, occurrencePlanNode, triggerTypeNode } from "./occurrence-fact.js";
import { SENDER_PERSONA_FN } from "./sender-persona.js";
import { BUBBLE_SEND_FN, whatsappBubblesStrategy } from "./whatsapp-bubbles.js";
import {
  EMAIL_MEDIUM,
  FOLLOW_UP_SEND_REFUSAL_CODES,
  LOCAL_TIME_FN,
  NEXT_DATE_FN,
  NEXT_DATE_SCHEMA_PROPERTIES,
  PASSING_REFUSAL_CODES,
  WHATSAPP_MEDIUM,
  localTimeStrategy,
  nextDateStrategy,
  rightMomentStrategy,
} from "./right-moment.js";

/** features-service's channel slug (named "Follow-up" to the owner; the slug predates the multichannel version). */
export const FOLLOW_UP_FEATURE_SLUG = "ai-follow-up-email";

/** The proactive leg: a lead whose follow-up date passed (Lead found) gets followed up (Conversation). */
export const FOLLOW_UP_PROACTIVE_LEG_KEY = "lead_found_to_conversation";

/** The model the message and the date are written with, through chat-service. Always-thinking: no temperature. */
export const FOLLOW_UP_LLM = { provider: "anthropic", model: "opus" } as const;

/**
 * lead-service's per-person follow-up state (LEAD-FOLLOWUP-DATE-1016): owed or not, the next date, what is queued.
 * `{id}` is the lead row id every lead-service person route takes.
 */
export const FOLLOW_UP_STATE = { method: "GET", path: "/orgs/leads/{id}/followup-date" } as const;

/**
 * lead-service verdict reasons that say the person ENGAGED (a reply, a booking, a live conversation): on a run
 * answering a lead event they are what the writer judges, never a reason to stay silent.
 */
export const ENGAGEMENT_REASONS = ["positive_reply", "meeting_booked", "meeting_attended", "in_conversation"] as const;

/** Verdict reasons that only wait (who they are is not resolved yet, a sequence step is queued): never a stop. */
export const WAIT_REASONS = ["sequence_running", "relationship_not_judged", "same_person_question_open", "identity_unresolved"] as const;

/** lead-service's write of the next follow-up date (or of a stop on the person's own words). */
export const SET_NEXT_DATE = { method: "PUT", path: "/orgs/leads/{id}/followup-date" } as const;

/** A queued message is left to go out: the next look comes this long after it, unless lead-service's date is later. */
export const QUEUED_FOLLOW_UP_GAP_DAYS = 3;

/** No route can write to them (no WhatsApp reach, no email): looked at again this long after, never dropped. */
export const NO_CHANNEL_RECHECK_DAYS = 30;

/** The channels the follow-up writes on, each with the one transport that sends it. */
export const FOLLOW_UP_CHANNELS = ["whatsapp", "email"] as const;

/** crm-service's WhatsApp refusals, read as outcomes (the person stays followed up, another channel next time). */
export const FOLLOW_UP_WHATSAPP_REFUSAL_CODES = [
  "whatsapp_not_linked",
  "whatsapp_not_connected",
  "no_phone_known",
  "not_on_whatsapp",
  "person_replied",
  "automation_not_allowed",
  "human_in_conversation",
] as const;

/** Email refusals that mean the person is out for good (opted out, not a prospect): the chain stops. */
export const FINAL_EMAIL_REFUSAL_CODES = FOLLOW_UP_SEND_REFUSAL_CODES.filter((c) => !(PASSING_REFUSAL_CODES as readonly string[]).includes(c));

/** Queue-row reasons on a reactive campaign: the row is closed, the date lives on lead-service. */
export const FOLLOW_UP_ROW_REASONS = {
  sent: "follow_up_sent",
  later: "follow_up_later",
  queued: "follow_up_queued",
  notYet: "follow_up_not_yet",
  notOwed: "follow_up_not_owed",
  stopped: "follow_up_stopped",
  refused: "follow_up_refused",
  noChannel: "follow_up_no_channel",
  notWritable: "instruction_not_writable",
} as const;

export const FOLLOW_UP_PROACTIVE_DESCRIPTION =
  "Follows up each lead whose follow-up date has passed, one per run, on WhatsApp when the brand can reach them there, else by email in their last thread, at the moment their thread says is right, always leaving their next follow-up date. Only their own no, an unsubscribe, a disqualification or a payment ends the follow-ups.";

export const FOLLOW_UP_REACTIVE_DESCRIPTION =
  "Follows up one person as soon as something happens with them (a reply, a visit, a signup, a form, a meeting), on WhatsApp when the brand can reach them there, else by email in their last thread, at the moment their thread says is right, never doubling a message already queued and always leaving their next follow-up date.";

export const FOLLOW_UP_REACTIVE_FIGURES_DESCRIPTION =
  "Follows up one person as soon as something happens with them (a reply, a visit, a signup, a form, a meeting), on WhatsApp when the brand can reach them there, else by email in their last thread, at the moment their thread says is right, never doubling a message already queued and always leaving their next follow-up date. When the campaign gives an instruction, it first reads the figures that instruction asks for, from the person's own account or public data.";

/** The model's answer: one schema for both channels; `finalize` holds each channel to its own fields. */
export const FOLLOW_UP_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["write", "later", "stop", "cannot_write"] },
    subject: { type: "string", description: "Email only: the subject line. Empty on WhatsApp and unless decision is write." },
    bodyHtml: { type: "string", description: "Email only: the body as simple HTML paragraphs. Empty on WhatsApp and unless decision is write." },
    message: { type: "string", description: "WhatsApp only: the plain text message, its bubbles in order separated by one empty line. Empty on email and unless decision is write." },
    ...NEXT_DATE_SCHEMA_PROPERTIES,
    reason: {
      type: "string",
      description:
        "One sentence: what the message does, why now is not the moment, (stop) the person's own words that end the follow-ups, or (cannot_write) what is missing.",
    },
  },
  required: ["decision", "subject", "bodyHtml", "message", "nextFollowUpAt", "nextFollowUpWhy", "reason"],
} as const;

/** The digits of an international phone ("+33 6 12..." -> "33612..."), or "" when it is not one. */
const DIGITS_FN = `
function phoneDigits(s) {
  if (typeof s !== "string") return "";
  const t = s.trim();
  if (!/^(\\+|00)/.test(t)) return "";
  const d = t.replace(/^(\\+|00)/, "").replace(/\\D/g, "");
  return d.length >= 8 ? d : "";
}
`.trim();

/**
 * SERVED entry: the lead lead-service handed this pipe. `main(served, campaignId, runId)`. A WhatsApp-only person
 * comes with a phone and no email: both are optional, at least one is required.
 */
export const RESOLVE_SERVED_PERSON_CODE = `
export async function main(served, campaignId, runId) {
  if (served?.found !== true) return { ok: false, why: "nobody served", endKind: "no_lead" };
  const s = served.lead ?? {};
  const rowId = s.leadCampaignId;
  if (!rowId) throw new Error("resolve-person: a served lead carries no lead row id");
  const brandId = Array.isArray(s.brandIds) ? s.brandIds[0] : null;
  if (!brandId) throw new Error("resolve-person: a served lead carries no brand");
  const email = typeof s.email === "string" && s.email.trim() ? s.email.trim() : null;
  const digits = phoneDigits(s.phone ?? s.data?.phone ?? null);
  if (!email && !digits) throw new Error("resolve-person: a served lead carries neither an email nor a phone");
  return {
    ok: true,
    entry: "served",
    rowId,
    leadId: s.leadId ?? null,
    email,
    phone: digits ? "+" + digits : null,
    brandId,
    lead: s.data ?? {},
    timezone: s.data?.timezone ?? null,
    // One look per serve: a person is re-served each time their date passes, so the run names the look.
    sendKey: "follow-up:" + String(campaignId) + ":" + rowId + ":" + String(runId),
    eventId: null,
  };
}

${DIGITS_FN}
`.trim();

/**
 * CLAIMED entry: the person the run's trigger OCCURRENCE names, stated on the claim so lead-service hands THEIR row
 * (CLAIM-OCCURRENCE-PERSON-1025). Without it the claim handed the campaign's oldest due row: in a burst of occurrences
 * every run claimed someone else, ended `other_person`, failed and left that row leased for an hour (Lead Follow-up
 * f1ab54e3, 2026-10-24). No occurrence, or one naming nobody = null: the claim is the queue's, oldest first.
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

/** CLAIMED entry: whether the claim found someone, so the lead read is not made for nobody. */
export const CLAIM_PLAN_CODE = `
export async function main(claim) {
  const found = claim?.found === true && !!claim?.followup?.id;
  return { found, skipDetail: !found };
}
`.trim();

/**
 * CLAIMED entry: the claimed person. A run whose occurrence names SOMEONE ELSE (email case-folded, else phone digits)
 * writes nothing and leaves that row alone (the occurrence is redelivered). The send is keyed on the occurrence when
 * it names this person (campaign-service redelivers with the same eventId), else on the row and its due date.
 */
export const RESOLVE_CLAIMED_PERSON_CODE = `
export async function main(claim, detail, trigger) {
  if (claim?.found !== true) {
    const carries = !!(trigger && typeof trigger === "object" && typeof trigger.eventId === "string" && trigger.eventId.trim());
    // A run with no occurrence that finds nobody due: nothing to do. One carrying an occurrence: it must claim someone.
    return { ok: false, why: "nobody claimed", endKind: carries ? "unclaimed" : "idle" };
  }
  const f = claim.followup ?? {};
  if (!f.id) throw new Error("resolve-person: a claimed row carries no id");
  if (!f.brandId) throw new Error("resolve-person: the claimed row carries no brand");
  const fold = (s) => (typeof s === "string" && s.trim() !== "" ? s.trim().toLowerCase() : null);
  const lead = detail?.leadDetail?.lead ?? null;
  if (!lead) throw new Error("resolve-person: the claimed person's lead read returned no lead");
  const email = fold(f.email);
  const digits = phoneDigits(f.phone ?? lead.phone ?? null);
  if (!email && !digits) throw new Error("resolve-person: the claimed row carries neither an email nor a phone");
  const t = trigger && typeof trigger === "object" ? trigger : null;
  const eventId = t && typeof t.eventId === "string" && t.eventId.trim() ? t.eventId.trim() : null;
  const named = t?.person && typeof t.person === "object" ? t.person : null;
  // An occurrence names its person by identity (email, else phone) or, for a fact rung with only a lead, by leadId.
  const namedLead = t && typeof t.leadId === "string" && t.leadId.trim() ? t.leadId.trim() : null;
  const namesSomeone = !!((named && (fold(named.email) || phoneDigits(named.phone))) || namedLead);
  const namesThem = !!(
    (named && ((email && fold(named.email) === email) || (!fold(named.email) && digits && phoneDigits(named.phone) === digits))) ||
    (!(named && (fold(named.email) || phoneDigits(named.phone))) && namedLead && namedLead === f.leadId)
  );
  if (eventId && namesSomeone && !namesThem) {
    console.error("[follow-up] claimed " + String(email ?? "+" + digits) + " but this run's occurrence names " +
      String(named?.email ?? named?.phone ?? namedLead) + ": nothing is written, their row is left alone");
    return { ok: false, why: "occurrence names someone else", endKind: "other_person", rowId: f.id };
  }
  return {
    ok: true,
    entry: "claimed",
    rowId: f.id,
    leadId: f.leadId ?? null,
    email,
    phone: digits ? "+" + digits : null,
    brandId: f.brandId,
    lead,
    timezone: lead.timezone ?? null,
    sendKey: eventId && namesThem ? "follow-up:event:" + eventId : "follow-up:" + f.id + ":" + String(f.dueAt ?? ""),
    eventId: eventId && namesThem ? eventId : null,
  };
}

${DIGITS_FN}
`.trim();

/**
 * lead-service's follow-up state held to its contract: `owed` (write, or look at it), `stop` (the chain ends),
 * `not_yet` (a passing state: the date moves to `retryAfter`, nothing written). Plus the queued message, when one
 * exists. Anything else throws: an absent answer is never a yes and never a stop. Returns `proceed` (the writer
 * runs) and the reads' skip flags.
 */
export const READ_STATE_CODE = `
export async function main(person, state, nowIso) {
  if (person?.ok !== true) return { proceed: false, kind: "none", skip: true };
  const owed = state?.owed;
  let kind = owed?.kind;
  if (kind !== "owed" && kind !== "stop" && kind !== "not_yet") {
    throw new Error("follow-up-state: lead-service answered no follow-up kind: " + JSON.stringify(state).slice(0, 300));
  }
  if (!state.followupDate || typeof state.followupDate !== "object" || !state.queued || typeof state.queued !== "object") {
    throw new Error("follow-up-state: lead-service answered no date or queue: " + JSON.stringify(state).slice(0, 300));
  }
  const now = Date.parse(String(nowIso));
  const currentNext = Date.parse(String(state.followupDate.nextFollowupAt ?? ""));
  let reason = String(owed.reason ?? kind);
  // A run answering a lead EVENT (claimed) exists because the person just engaged: a reply, a booking, a live
  // conversation are what the writer reads in the thread and judges, never a reason to stay silent. Only the owner's
  // stops (opted out, unsubscribed, bounced, disqualified, a client or anyone but a prospect) end it; who they are
  // still unresolved waits. The proactive walk keeps lead-service's whole verdict (its serve already re-checked it).
  const reasons = Array.isArray(owed.reasons) ? owed.reasons : [];
  if (person.entry === "claimed" && kind !== "owed" && reasons.length > 0) {
    const left = reasons.filter((r) => !${JSON.stringify(ENGAGEMENT_REASONS)}.includes(r));
    if (left.length === 0) {
      console.log("[follow-up] lead-service holds them back for " + reasons.join(", ") + ": a lead event is answered anyway, the writer judges the thread");
      kind = "owed";
    } else if (left.every((r) => r === "sequence_running")) {
      kind = "owed";
      state = { ...state, queued: { ...state.queued, emailSequence: true } };
    } else if (left.some((r) => !${JSON.stringify(WAIT_REASONS)}.includes(r))) {
      kind = "stop";
      reason = left.find((r) => !${JSON.stringify(WAIT_REASONS)}.includes(r));
    } else {
      kind = "not_yet";
      reason = left[0];
    }
  }
  if (kind === "stop") {
    console.log("[follow-up] lead-service says stop (" + reason + "): nothing written, no next date");
    return { proceed: false, kind, reason, skip: true };
  }
  if (kind === "not_yet") {
    const at = owed.kind === "not_yet" ? Date.parse(String(owed.retryAfter ?? "")) : now + 24 * 3600000;
    if (!Number.isFinite(at)) throw new Error("follow-up-state: not_yet without a retryAfter: " + JSON.stringify(owed).slice(0, 300));
    // A date already past fires again at once: ask again in an hour rather than in a loop.
    const next = new Date(Math.max(at, now + 3600000)).toISOString();
    console.log("[follow-up] not yet (" + reason + "): nothing written, next look at " + next);
    return { proceed: false, kind, reason, skip: true, nextFollowUpAt: next, nextFollowUpWhy: "Not yet: " + reason };
  }
  // Queued = a message of ours already waiting for them: a step of their email sequence, or a follow-up another
  // campaign owes them. This run's own claimed row is not one.
  const q = state.queued;
  const others = (Array.isArray(q.followups) ? q.followups : []).filter((f) => f && f.leadCampaignId !== person.rowId && Number.isFinite(Date.parse(String(f.dueAt))));
  if (q.emailSequence === true || others.length > 0) {
    const lastDue = others.reduce((m, f) => Math.max(m, Date.parse(String(f.dueAt))), now);
    const after = lastDue + ${QUEUED_FOLLOW_UP_GAP_DAYS} * 86400000;
    // The queued message goes out first; the next look comes after it, or at lead-service's own date when later.
    const next = new Date(Number.isFinite(currentNext) && currentNext > after ? currentNext : after).toISOString();
    const what = q.emailSequence === true
      ? "a step of their email sequence is still queued"
      : others.length + " follow-up(s) already owed to them by another campaign, the last due " + new Date(lastDue).toISOString();
    console.log("[follow-up] " + what + ": nothing written, next look at " + next);
    return { proceed: false, kind: "queued", reason: what, skip: true, nextFollowUpAt: next, nextFollowUpWhy: "Already queued: " + what };
  }
  return { proceed: true, kind, reason: null, skip: false };
}
`.trim();

/** Who the run would write to, for the WhatsApp reach check (never a null field: crm-service 400s it). */
export const REACH_BODY_CODE = `
export async function main(person, plan) {
  if (plan?.proceed !== true) return { skip: true, body: {} };
  const body = { brandId: person.brandId };
  if (person.email) body.email = person.email;
  if (person.phone) body.phone = person.phone;
  return { skip: false, body };
}
`.trim();

/** Where the person's whole thread is read from: their email, else their phone (crm-service identity keys). */
export const THREAD_QUERY_CODE = `
export async function main(person, plan) {
  if (plan?.proceed !== true) return { skip: true, query: {} };
  const key = person.email ? "email:" + person.email.toLowerCase() : "phone:" + person.phone;
  return { skip: false, query: { brandId: person.brandId, personKey: key } };
}
`.trim();

/**
 * THE CHANNEL, decided before any model spend and never by the model: WhatsApp when the brand's WhatsApp reaches
 * them (preferred), else email when an address is known (the thread's own addresses count), else none.
 */
export const CHANNEL_PLAN_CODE = `
export async function main(person, plan, reach, timeline) {
  if (plan?.proceed !== true) return { channel: null, skipModel: true };
  if (!reach || reach.ok === false || typeof reach.reachable !== "boolean") {
    throw new Error("channel-plan: the WhatsApp reach check did not answer: " + JSON.stringify(reach).slice(0, 300));
  }
  const items = Array.isArray(timeline?.items) ? timeline.items : [];
  const msgs = items.filter((i) => i?.kind === "message" && i.source !== "api");
  const lastTheirs = [...msgs].reverse().find((i) => i.direction === "inbound") ?? null;
  const emails = Array.isArray(timeline?.person?.emails) ? timeline.person.emails.filter((e) => typeof e === "string" && e.includes("@")) : [];
  const email = person.email ?? emails[0] ?? null;
  const lastWhere = lastTheirs ? String(lastTheirs.channel ?? "unknown") : null;
  if (reach.reachable === true) {
    return {
      channel: "whatsapp",
      skipModel: false,
      email,
      phone: reach.to ?? person.phone ?? null,
      fromAccount: reach.fromAccount ?? null,
      // The persona of the account that will send, or null (SOPHIE-WA-1016): the writer speaks as it.
      persona: senderPersona(reach),
      why: "The brand's WhatsApp reaches them (" + String(reach.to) + ")" + (lastWhere && lastWhere !== "whatsapp" ? "; their last message came by " + lastWhere : "") + ".",
    };
  }
  if (email) {
    return {
      channel: "email",
      skipModel: false,
      email,
      phone: person.phone ?? null,
      why: "WhatsApp cannot reach them (" + String(reach.code) + "); we hold their address " + email + "." + (lastWhere && lastWhere !== "email" ? " Their last message came by " + lastWhere + ", where we cannot write." : ""),
    };
  }
  console.error("[follow-up] no route can write to " + String(person.phone ?? "this person") + ": WhatsApp " + String(reach.code) + ", no email known; nothing drafted");
  return { channel: null, skipModel: true, noChannel: true, why: "WhatsApp " + String(reach.code) + " and no email known" };
}

${SENDER_PERSONA_FN}
`.trim();

const GATHER_FACTS_SIGNATURE = "export async function main(plan, offerAnswers, offerFields, brandFields)";
if (!GATHER_FACTS_CODE.startsWith(GATHER_FACTS_SIGNATURE)) {
  throw new Error("follow-up: GATHER_FACTS_CODE changed its signature; re-wrap it");
}

/**
 * `ai-meeting-booking`'s fact gathering, unchanged, with no question list (what the client told us: offer answers and
 * confirmed user-fields, never the website). Not gathered when the writer does not run.
 */
export const GATHER_CLIENT_FACTS_CODE =
  GATHER_FACTS_CODE.replace(GATHER_FACTS_SIGNATURE, "async function gatherFacts(plan, offerAnswers, offerFields, brandFields)") +
  "\n\nexport async function main(channel, offerAnswers, offerFields, brandFields) {\n" +
  "  if (channel?.skipModel === true) return { exact: [], neverGive: [], skipped: true };\n" +
  "  return gatherFacts(null, offerAnswers, offerFields, brandFields);\n}";

/**
 * Everything that happened to the person on this brand (lead-service history): our sends with dates, their words,
 * opens, clicks, visits, signups. A source that holds what we sent or what they did being unreadable fails loud.
 */
export const PERSON_HISTORY_CODE = `
export async function main(channel, history) {
  if (channel?.skipModel === true) return { lines: [], omitted: 0, ourMessages: 0, lastOursAt: null, lastTheirsAt: null, unreadable: [] };
  if (!history || !Array.isArray(history.events)) throw new Error("person-history: lead-service returned no events");
  const BLIND = ["lead-service", "outreach", "delivery"];
  const down = (history.sources ?? []).filter((s) => BLIND.includes(s?.source) && s?.status === "unavailable");
  if (down.length) {
    throw new Error("person-history: " + down.map((s) => s.source + " (" + (s.reason ?? "unavailable") + ")").join(", ") +
      " could not be read; the next follow-up is never decided blind");
  }
  const clip = (t, n) => { const s = String(t ?? "").replace(/\\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "..." : s; };
  const day = (at) => (typeof at === "string" ? at.slice(0, 16).replace("T", " ") + " UTC" : "date unknown");
  const lines = [];
  let ours = 0;
  let lastOurs = null;
  let lastTheirs = null;
  for (const e of history.events) {
    if (e?.type === "message") {
      if (e.direction === "outbound") { ours += 1; lastOurs = e.at ?? lastOurs; }
      if (e.direction === "inbound") lastTheirs = e.at ?? lastTheirs;
      continue; // the words are in THE THREAD
    }
    if (e?.type === "delivery") {
      if (e.milestone === "sent") { ours += 1; lastOurs = e.at ?? lastOurs; }
      lines.push(day(e.at) + " | EVENT: " + (e.channel ?? "email") + " " + e.milestone);
    } else if (e?.type === "conversion") {
      lines.push(day(e.at) + " | EVENT: " + (e.event ?? e.step ?? "conversion"));
    } else if (e?.type === "reply_statement" || e?.type === "opt_out_statement" || e?.type === "step_statement") {
      lines.push(day(e.at) + " | RECORDED: " + e.type.replace("_", " ") + (e.replyKind ? " " + e.replyKind : "") + (e.step ? " " + e.step : "") + (e.note ? ": " + clip(e.note, 200) : ""));
    }
  }
  return {
    lines: lines.slice(-60),
    omitted: Math.max(0, lines.length - 60),
    ourMessages: ours,
    lastOursAt: lastOurs,
    lastTheirsAt: lastTheirs,
    unreadable: (history.sources ?? []).filter((s) => s?.status === "unavailable").map((s) => s.source),
  };
}
`.trim();

/** The run's "now", read once so the prompt, the bounds and the queued date agree. */
export const NOW_CODE = `
export async function main() {
  return { now: new Date().toISOString() };
}
`.trim();

/**
 * The writer's GAME: who it writes to and why (owner rule: a strategy, never a canned reply per case). The lead game
 * is the follow-up channel's own; another audience (current clients, `client-check-in-dag.ts`) states its own four
 * prompt lines and keeps everything else of the writer byte for byte. Each value is one line of the generated script
 * (a JS string literal, its comma and newline included).
 */
export interface FollowUpGame {
  intro: string;
  game: string;
  read: string;
  stop: string;
  /**
   * Also shows the writer what the run's occurrence CARRIES (`trigger.item`: a form's answers, a pushed email, a
   * payment), clipped: the event that just happened, in its own words. Absent = not shown (the lead game).
   */
  occurrenceItem?: boolean;
}

/** `itemLines(trigger)`: the occurrence's item as plain lines, clipped, for the writer. */
export const OCCURRENCE_ITEM_FN = `
function itemLines(trigger) {
  const item = trigger && typeof trigger === "object" && trigger.item && typeof trigger.item === "object" ? trigger.item : null;
  if (!item) return [];
  const text = JSON.stringify(item, null, 1).replace(/[\\u2013\\u2014]/g, ",");
  if (!text || text === "{}") return [];
  return [text.length > 3000 ? text.slice(0, 3000) + "..." : text];
}
`.trim();

export const LEAD_FOLLOW_UP_GAME: FollowUpGame = {
  intro: "    \"You follow up ONE person for the team at \" + brandName + \", and you decide WHEN they are next followed up. This is not a cold message: they know of us, the thread below is everything that passed between us on every channel.\",\n",
  game: "    \"THE GAME. We follow up every lead until they say yes, no or stop. Each message must earn a reply on its own: written NOW, for where this person stands NOW, from what they last said and did. Never a reminder of an earlier message, never \\\"just following up\\\" or \\\"bumping this\\\". Pick ONE thing that moves them one step: answer what they were waiting for, a useful fact about what we offer, a simpler next step, or a plain question about their situation. End with ONE easy question they can answer in a line.\",\n",
  read: "    \"Read the thread like the person who wrote it on our side. If they asked something, answer it if the FACTS hold the answer. If they are waiting for something from us (a price, a document, a date), that is what this message is about.\",\n",
  stop: "    \"STOP only on the person's OWN words, and only for two things: they asked us to stop, unsubscribe or never write again, or they show they are not a fit at all (the wrong person, they left the company, they do not run anything like what we offer). Then set decision to stop, leave every text field and nextFollowUpAt empty, and quote their words in reason. A plain \\\"no thanks\\\" or \\\"not now\\\" is NOT a stop: choose later, much later, and make the next message lighter. Silence is never a reason to stop.\",\n",
};

/**
 * Builds the system prompt and the message. Explains THE GAME (owner rule: a strategy, never a canned reply per case),
 * with the channel already chosen. Kept free of em and en dashes: the model copies the style of its prompt.
 */
export function composeFollowUpCode(GAME: FollowUpGame): string {
  return `
export async function main(person, channel, offer, brand, facts, history, figures, instruction, occurrence, triggerType, trigger, nowIso, currentDate, who) {
  if (channel?.skipModel === true) return { skip: true, systemPrompt: "", message: "" };
  if (!who || !Array.isArray(who.lines) || !Array.isArray(who.threadLines) || typeof who.strategy !== "string") {
    throw new Error("compose: who this person is to the brand was not read; nothing is written blind");
  }
  const offerName = typeof offer?.name === "string" ? offer.name.trim() : "";
  if (!offerName) throw new Error("compose: the campaign's offer read carries no name");
  const b = brand?.brand ?? {};
  const brandName = typeof b.name === "string" && b.name.trim() ? b.name.trim() : null;
  if (!brandName) throw new Error("compose: the brand read carries no name");
  const wa = channel.channel === "whatsapp";
  const present = (v) => typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined;
  const p = person?.lead ?? {};
  const org = p.organization ?? {};
  const personLines = [
    ["Name", [p.firstName, p.lastName].filter(present).join(" ")],
    ["Email", channel.email],
    ["Phone", channel.phone],
    ["Title", p.currentTitle],
    ["Company", org.name],
    ["Timezone", person?.timezone],
  ].filter(([, v]) => present(v)).map(([k, v]) => k + ": " + String(v).trim());
  const text = typeof instruction === "string" ? instruction.trim() : "";
  const factLines = whyNowLines(occurrence, triggerType, person?.email, nowIso);
  // A generic trigger (Lead event) names the fact behind it: what the person actually did.
  const source = trigger && typeof trigger === "object" && typeof trigger.sourceTriggerId === "string" ? trigger.sourceTriggerId.trim() : "";
  if (factLines.length && source) factLines.push("The fact behind it: " + source.replace(/_/g, " ") + ".");
  const exact = facts?.exact ?? [];
  const neverGive = facts?.neverGive ?? [];
  const skippedFigures = !figures || figures.notCalled === true;
  if (!skippedFigures && !Array.isArray(figures.figures)) throw new Error("compose: the figure read returned no figures list");
  const read = skippedFigures ? [] : figures.figures;
  const notRead = !skippedFigures && typeof figures.missing === "string" && figures.missing.trim() ? figures.missing.trim() : null;
  const game = wa ? ${JSON.stringify(rightMomentStrategy(WHATSAPP_MEDIUM))} : ${JSON.stringify(rightMomentStrategy(EMAIL_MEDIUM))};
  const nextDate = wa ? ${JSON.stringify(nextDateStrategy(WHATSAPP_MEDIUM))} : ${JSON.stringify(nextDateStrategy(EMAIL_MEDIUM))};
  const localHour = wa ? ${JSON.stringify(localTimeStrategy(WHATSAPP_MEDIUM))} : ${JSON.stringify(localTimeStrategy(EMAIL_MEDIUM))};
  const localTime = localTimeLines(nowIso, { timezone: person?.timezone, city: p.city, country: p.country, phone: channel.phone ?? person?.phone });

  const systemPrompt = [
${GAME.intro}${GAME.game}${GAME.read}    wa
      ? "THE CHANNEL is WhatsApp: the message continues our WhatsApp conversation with them, from the same number, in the language and tone of that conversation. No greeting line of its own, no sign off, plain text, no links unless the facts give one. " + ${JSON.stringify(whatsappBubblesStrategy("persona"))}
      : "THE CHANNEL is email: the email is a reply in the last email thread we have with them, from the same mailbox, so never re-introduce us. Under 120 words. Greet them by first name when you have it. No sign off or signature block: ours is added below your text. bodyHtml is simple HTML, <p> paragraphs only. The subject is short and plain, never \\"Re:\\" or \\"Follow-up\\".",
    // The sending WhatsApp account's own persona (SOPHIE-WA-1016): none = the prompt of before.
    ...(wa && channel.persona ? personaLines(channel.persona, brandName) : []),
    "The channel was chosen for you. Their last message may be on another channel (LinkedIn, Telegram, a call): read it, carry on from it, never say where you are writing from or why.",
    ...(text
      ? ["You also follow the INSTRUCTION from our client below where it does not contradict these rules."]
      : []),
    ...(factLines.length ? [${JSON.stringify(WHY_NOW_STRATEGY)}] : []),
    "What they did (opened, clicked, visited, signed up) is for choosing what to say and when, never something to say: never write that you saw them open, click or visit.",
    "You state only what the FACTS, the FIGURES or the INSTRUCTION say. Never invent a figure, a price, a result, a customer, a date or a promise. A number appears only if it is written there, exactly as written.",
    "If the INSTRUCTION asks for something none of those hold (a figure that could not be read), set decision to cannot_write and say in reason what is missing.",
    who.strategy,
    game,
    localHour,
    nextDate,
${GAME.stop}    "Write like a person who knows them: short, plain, warm, one idea per sentence. No filler, no \\"I hope this finds you well\\".",
    "Never use an em dash or an en dash. Use a comma or a period.",
    wa ? "Fill message; leave subject and bodyHtml empty." : "Fill subject and bodyHtml; leave message empty.",
  ].join("\\n");

  const message = [
    "NOW: " + String(nowIso),
    "TODAY: " + String(currentDate ?? String(nowIso).slice(0, 10)),
    "CHANNEL: " + channel.channel + ". " + String(channel.why ?? ""),
    "Messages of ours on record: " + String(history?.ourMessages ?? 0) + ". Our last: " + String(history?.lastOursAt ?? "unknown") + ". Their last message: " + String(history?.lastTheirsAt ?? "never") + ".",
    ...(text ? ["", "INSTRUCTION from our client:", text] : []),
    ...(factLines.length ? ["", "WHY WE WRITE NOW:", ...factLines] : []),
${GAME.occurrenceItem ? '    ...(itemLines(trigger).length ? ["", "WHAT THE EVENT CARRIES (its own record, never quote it as ours):", ...itemLines(trigger)] : []),\n' : ""}    "",
    "THEIR LOCAL TIME:",
    ...localTime,
    "",
    "WHO WE WRITE TO:",
    ...(personLines.length ? personLines : ["(nothing beyond how to reach them)"]),
    "",
    "WHO THEY ARE TO US:",
    ...who.lines,
    "",
    "THE THREAD with this person, every channel, oldest first:",
    ...(who.olderMessagesOmitted > 0 ? ["(" + who.olderMessagesOmitted + " older messages not shown)"] : []),
    ...(who.threadLines.length ? who.threadLines : ["(no message ever exchanged)"]),
    ...(who.eventLines?.length ? ["", "RECENT EVENTS:", ...who.eventLines] : []),
    ...(history?.lines?.length ? ["", "WHAT WE SENT AND WHAT THEY DID, oldest first:", ...history.lines] : []),
    "",
    "WHO WE ARE: " + brandName + ", offer \\"" + offerName + "\\".",
    "",
    ...(read.length || notRead ? ["FIGURES read for this message (their own account, or public):",
      ...read.map((f, i) => "F" + (i + 1) + ". " + f.label + ": " + f.value + " (source: " + f.source + ")"),
      ...(notRead ? ["NOT READABLE: " + notRead] : []), ""] : []),
    "FACTS our client told us:",
    ...(exact.length ? exact.map((f) => f.id + ". " + f.label + ": " + f.value) : ["(none)"]),
    ...(neverGive.length ? ["", "NEVER offer or promise any of these, whole or in part:", ...neverGive.map((x) => "- " + x)] : []),
  ].join("\\n");

  return { skip: false, systemPrompt, message };
}

${WHY_NOW_FN}

${LOCAL_TIME_FN}
${GAME.occurrenceItem ? "\n" + OCCURRENCE_ITEM_FN + "\n" : ""}
${SENDER_PERSONA_FN}
`.trim();
}

export const COMPOSE_FOLLOW_UP_CODE = composeFollowUpCode(LEAD_FOLLOW_UP_GAME);

/**
 * Holds the model to its contract strictly BEFORE the send and builds each transport's body: a `write` with an empty
 * text, or a next date that is not strictly in the future (at most a year), throws (nothing is sent). Any em/en dash
 * is rewritten (between digits a hyphen, otherwise a comma). Exactly one transport runs; the other is skipped.
 */
export const FINALIZE_FOLLOW_UP_CODE = `
export async function main(draft, person, channel, campaignId) {
  if (channel?.skipModel === true) return { decision: "none", skipWhatsapp: true, skipEmail: true, whatsappBody: {} };
  const json = draft?.json ?? {};
  const none = { skipWhatsapp: true, skipEmail: true, whatsappBody: {} };
  if (json.decision === "cannot_write") {
    console.error("[follow-up] the instruction cannot be written from what we hold; nothing is sent. Missing: " + JSON.stringify(json.reason ?? null));
    return { decision: "cannot_write", reason: String(json.reason ?? ""), ...none };
  }
  if (json.decision === "stop") {
    console.log("[follow-up] the person's own words end the follow-ups: " + JSON.stringify(json.reason ?? null));
    return { decision: "stop", reason: String(json.reason ?? ""), ...none };
  }
  if (json.decision === "later") {
    const later = nextDate(json, "finalize");
    console.log("[follow-up] not the right moment, nothing is sent; next look at " + later.nextFollowUpAt + ": " + later.nextFollowUpWhy);
    return { decision: "later", ...later, reason: String(json.reason ?? ""), ...none };
  }
  if (json.decision !== "write") throw new Error("finalize: unknown decision " + JSON.stringify(json.decision));
  const undash = (s) => String(s ?? "")
    .replace(/&(mdash|ndash);|&#(8212|8211|x2014|x2013);/gi, (m) => (/mdash|8212|2014/i.test(m) ? "\\u2014" : "\\u2013"))
    .replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-")
    .replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ")
    .trim();
  const next = nextDate(json, "finalize");
  if (channel.channel === "whatsapp") {
    const text = undash(json.message);
    if (!text) throw new Error("finalize: decision write on WhatsApp with an empty message");
    if (text !== String(json.message ?? "").trim()) console.error("[follow-up] the draft used a dash the person must never read; rewritten before the send");
    // Several bubbles = crm-service's \`messages\` (WA-BUBBLES-1023), one = \`text\` as before.
    const whatsappBody = { brandId: person.brandId, ...bubbleSendFields(text), idempotencyKey: person.sendKey };
    if (channel.email) whatsappBody.email = channel.email;
    if (channel.phone) whatsappBody.phone = channel.phone;
    if (channel.fromAccount) whatsappBody.fromAccount = channel.fromAccount;
    return { decision: "write", channel: "whatsapp", ...next, skipWhatsapp: false, skipEmail: true, whatsappBody };
  }
  if (channel.channel !== "email") throw new Error("finalize: no transport for channel " + JSON.stringify(channel.channel));
  const subject = undash(json.subject);
  const bodyHtml = undash(json.bodyHtml);
  if (!subject || !bodyHtml) throw new Error("finalize: decision write by email with an empty subject or body");
  if (subject !== String(json.subject ?? "").trim() || bodyHtml !== String(json.bodyHtml ?? "").trim()) {
    console.error("[follow-up] the draft used a dash the person must never read; rewritten before the send");
  }
  return {
    decision: "write",
    channel: "email",
    ...next,
    skipWhatsapp: true,
    skipEmail: false,
    whatsappBody: {},
    to: channel.email,
    subject,
    sequence: [{ step: 1, bodyHtml, daysSinceLastStep: 0 }],
    idempotencyKey: person.sendKey,
  };
}

${NEXT_DATE_FN}

${BUBBLE_SEND_FN}
`.trim();

/**
 * What the run did, read off every step, and what lead-service and the queue row are told. EVERY path that reached a
 * person leaves a next date, except a stop (lead-service's verdict, their own words, a refusal saying they opted out).
 * `endKind` picks the end-run. Never throws on a path: a missing piece already threw where it was read.
 */
export const OUTCOME_CODE = `
export async function main(person, plan, channel, final, sendWhatsapp, sendEmail, nowIso) {
  const PASSING = ${JSON.stringify(PASSING_REFUSAL_CODES)};
  const R = ${JSON.stringify(FOLLOW_UP_ROW_REASONS)};
  const now = Date.parse(String(nowIso));
  const skipAll = { skipSetDate: true, skipStop: true, skipRow: true, setDateBody: {}, stopBody: {}, rowBody: {}, delivery: null };
  if (person?.ok !== true) return { endKind: person?.endKind ?? "idle", ...skipAll };
  const row = (reason) => person.entry === "claimed" ? { skipRow: false, rowBody: { kind: "stopped", reason } } : { skipRow: true, rowBody: {} };
  // lead-service's statements (idempotent there on the run and the body): a date, with the send it follows when one
  // went out, or a stop in the person's own words.
  const date = (at, why, sent) => ({
    skipSetDate: false,
    setDateBody: { nextFollowupAt: at, reason: String(why ?? "").slice(0, 500) || "next look", ...(sent ? { sent: { channel: sent } } : {}) },
    skipStop: true,
    stopBody: {},
  });
  const stop = (why) => ({
    skipSetDate: true,
    setDateBody: {},
    skipStop: false,
    stopBody: { stop: { reason: String(why ?? "").slice(0, 1000) || "stopped" } },
  });
  if (plan?.kind === "stop") return { endKind: "not_owed", ...row(R.notOwed), skipSetDate: true, setDateBody: {}, skipStop: true, stopBody: {}, delivery: null };
  if (plan?.kind === "not_yet") return { endKind: "not_yet", ...row(R.notYet), ...date(plan.nextFollowUpAt, plan.nextFollowUpWhy), delivery: null };
  if (plan?.kind === "queued") return { endKind: "queued", ...row(R.queued), ...date(plan.nextFollowUpAt, plan.nextFollowUpWhy), delivery: null };
  if (channel?.noChannel === true) {
    const at = new Date(now + ${NO_CHANNEL_RECHECK_DAYS} * 86400000).toISOString();
    return { endKind: "no_channel", ...row(R.noChannel), ...date(at, "No route can write to them now: " + channel.why),
      delivery: { state: "refused", code: "no_channel", reason: "Nothing can be sent to this person: " + channel.why } };
  }
  const d = final?.decision;
  if (d === "cannot_write") {
    return { endKind: "not_writable", ...row(R.notWritable), skipSetDate: true, setDateBody: {}, skipStop: true, stopBody: {},
      delivery: { state: "refused", code: R.notWritable, reason: final.reason || "The message could not be written from what we hold." } };
  }
  if (d === "stop") return { endKind: "stopped", ...row(R.stopped), ...stop("Their own words: " + final.reason), delivery: null };
  if (d === "later") return { endKind: "later", ...row(R.later), ...date(final.nextFollowUpAt, final.nextFollowUpWhy), delivery: null };
  if (d !== "write") throw new Error("outcome: no decision to act on: " + JSON.stringify(final).slice(0, 200));
  const send = final.channel === "whatsapp" ? sendWhatsapp : sendEmail;
  if (!send || send.notCalled === true) throw new Error("outcome: the " + final.channel + " send did not run");
  if (send.skipped !== true) {
    return { endKind: "sent", ...row(R.sent), ...date(final.nextFollowUpAt, final.nextFollowUpWhy, final.channel), delivery: { state: "delivered" } };
  }
  const code = String(send.code ?? "refused");
  const refused = { state: "refused", code, reason: typeof send.reason === "string" ? send.reason : code };
  // A refusal on WhatsApp is about the channel (reach changed since the check), never about the person: kept.
  // By email, a passing refusal keeps them (a queued step, a live thread); any other says they are out.
  if (final.channel === "whatsapp" || PASSING.includes(code)) {
    return { endKind: "refused_kept", ...row(R.refused), ...date(final.nextFollowUpAt, "Not sent (" + code + "); " + final.nextFollowUpWhy), delivery: refused };
  }
  return { endKind: "refused_final", ...row(R.refused), ...stop("The send was refused: " + code), delivery: refused };
}
`.trim();

const endRun = (id: string, body: Record<string, unknown>, inputMapping?: Record<string, string>): DAGNode => ({
  id,
  type: "http.call",
  config: { service: "campaign", method: "POST", path: "/end-run", body },
  ...(inputMapping ? { inputMapping } : {}),
});

const DELIVERY = { "body.delivery": "$ref:outcome.output.delivery" };

/** Every end the run can reach, one end-run each (the converter runs a shared one on every run). */
export const FOLLOW_UP_END_KINDS = [
  "sent",
  "later",
  "queued",
  "not_yet",
  "not_owed",
  "stopped",
  "no_channel",
  "refused_kept",
  "refused_final",
  "not_writable",
] as const;

const P = "$ref:resolve-person.output";
const SKIP_READS = "$ref:read-state.output.skip";
const SKIP_MODEL = "$ref:channel-plan.output.skipModel";

/**
 * Who a reactive follow-up writes to, when it is not the brand's leads (`client-check-in-dag.ts`): the claim body it
 * states (WHO = the pipe's strategy, judged by lead-service), the scripts that read the claim, the state and write the
 * prompt, and the end kinds its claim adds. Absent = the lead follow-up, byte for byte.
 */
export interface FollowUpAudience {
  claimBody: Record<string, unknown>;
  resolveClaimedCode: string;
  readStateCode: string;
  composeCode: string;
  /** End kinds the claim adds, each with its end-run body and mappings. */
  claimEnds: Array<{ kind: string; body: Record<string, unknown>; inputMapping?: Record<string, string> }>;
}

/** The straight line after "who is this run for": state, reads, channel, write, send, date, row. */
function tail(opts: { readFigures: boolean; reactive: boolean; audience?: FollowUpAudience }): { nodes: DAGNode[]; edges: DAG["edges"] } {
  const nodes: DAGNode[] = [
    { id: "now", type: "script", config: { code: NOW_CODE }, retries: 0 },
    {
      id: "followup-state",
      type: "http.call",
      config: { service: "lead", method: FOLLOW_UP_STATE.method, path: FOLLOW_UP_STATE.path },
      // A read: safe to retry through a sibling being redeployed.
      retries: 2,
      inputMapping: { "params.id": `${P}.rowId`, "query.brandId": `${P}.brandId`, skip: "$ref:resolve-person.output.skipState" },
    },
    {
      id: "read-state",
      type: "script",
      config: { code: opts.audience?.readStateCode ?? READ_STATE_CODE },
      retries: 0,
      inputMapping: { person: P, state: "$ref:followup-state.output", nowIso: "$ref:now.output.now" },
    },
    // The person's whole Unibox thread (every channel) and who they are to the brand: read before anything else.
    { id: PERSON_THREAD_QUERY_NODE_ID, type: "script", config: { code: THREAD_QUERY_CODE }, retries: 0, inputMapping: { person: P, plan: "$ref:read-state.output" } },
    {
      id: PERSON_THREAD_NODE_ID,
      type: "http.call",
      config: { service: "crm", method: "GET", path: "/orgs/people/timeline", tolerateFailure: true },
      inputMapping: { query: `$ref:${PERSON_THREAD_QUERY_NODE_ID}.output.query`, skip: `$ref:${PERSON_THREAD_QUERY_NODE_ID}.output.skip` },
    },
    { id: "reach-body", type: "script", config: { code: REACH_BODY_CODE }, retries: 0, inputMapping: { person: P, plan: "$ref:read-state.output" } },
    {
      id: "reach-check",
      type: "http.call",
      // Nothing sent: the send's own checks, so the channel is chosen before any model spend.
      config: { service: "crm", method: "POST", path: "/orgs/whatsapp/reach" },
      retries: 2,
      inputMapping: { body: "$ref:reach-body.output.body", skip: "$ref:reach-body.output.skip" },
    },
    {
      id: "channel-plan",
      type: "script",
      config: { code: CHANNEL_PLAN_CODE },
      retries: 0,
      inputMapping: { person: P, plan: "$ref:read-state.output", reach: "$ref:reach-check.output", timeline: `$ref:${PERSON_THREAD_NODE_ID}.output` },
    },
    {
      id: "offer-economics",
      type: "http.call",
      config: { service: "brand", method: "GET", path: "/internal/offers/{offerId}/economics" },
      inputMapping: { "params.offerId": "$ref:start-run.output.offerId", skip: SKIP_MODEL },
    },
    {
      id: "brand-profile",
      type: "http.call",
      config: { service: "brand", method: "GET", path: "/internal/brands/{id}" },
      inputMapping: { "params.id": `${P}.brandId`, skip: SKIP_MODEL },
    },
    {
      id: "offer-answers",
      type: "http.call",
      config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/answers" },
      inputMapping: { "params.brandId": `${P}.brandId`, "params.offerId": "$ref:start-run.output.offerId", skip: SKIP_MODEL },
    },
    {
      id: "offer-user-fields",
      type: "http.call",
      config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/user-fields" },
      inputMapping: { "params.brandId": `${P}.brandId`, "params.offerId": "$ref:start-run.output.offerId", skip: SKIP_MODEL },
    },
    {
      id: "brand-user-fields",
      type: "http.call",
      // Refused (409 SEVERAL_OFFERS) for a brand selling several offers: gather-facts reads that one refusal as
      // "no brand-level fields" and re-throws every other failure.
      config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/user-fields", tolerateFailure: true },
      inputMapping: { "params.brandId": `${P}.brandId`, skip: SKIP_MODEL },
    },
    {
      id: "gather-facts",
      type: "script",
      config: { code: GATHER_CLIENT_FACTS_CODE },
      retries: 0,
      inputMapping: {
        channel: "$ref:channel-plan.output",
        offerAnswers: "$ref:offer-answers.output",
        offerFields: "$ref:offer-user-fields.output",
        brandFields: "$ref:brand-user-fields.output",
      },
    },
    ...(opts.readFigures
      ? [
          {
            id: "figures-plan",
            type: "script",
            config: {
              code:
                "export async function main(occurrence, channel) {\n" +
                "  return { skip: channel?.skipModel === true || occurrence?.skipFigures === true };\n}",
            },
            retries: 0,
            inputMapping: { occurrence: "$ref:occurrence.output", channel: "$ref:channel-plan.output" },
          } as DAGNode,
          // The figures the instruction needs, read now: public ones and the PERSON's own account, never another
          // customer's (`figure-reader.ts`). Not called without an instruction.
          {
            id: "read-figures",
            type: "http.call",
            config: { service: "workflow", method: "POST", path: "/orgs/figures/read" },
            retries: 2,
            inputMapping: {
              "body.question": "$ref:start-run.output.instruction",
              "body.recipientEmail": "$ref:channel-plan.output.email",
              skip: "$ref:figures-plan.output.skip",
            },
          } as DAGNode,
        ]
      : []),
    {
      id: "history-read",
      type: "http.call",
      config: { service: "lead", method: "GET", path: "/orgs/leads/{id}/history", query: { scope: "brand" } },
      retries: 2,
      inputMapping: { "params.id": `${P}.rowId`, "query.brandId": `${P}.brandId`, skip: SKIP_MODEL },
    },
    { id: "person-history", type: "script", config: { code: PERSON_HISTORY_CODE }, retries: 0, inputMapping: { channel: "$ref:channel-plan.output", history: "$ref:history-read.output" } },
    {
      ...relationshipReadNode({ leadRowId: `${P}.rowId`, brandId: `${P}.brandId` }),
      inputMapping: { "params.id": `${P}.rowId`, "query.brandId": `${P}.brandId`, skip: SKIP_MODEL },
    },
    whoTheyAreNode({ relationshipRead: "$ref:relationship-read.output", timeline: `$ref:${PERSON_THREAD_NODE_ID}.output` }),
    {
      id: "compose",
      type: "script",
      config: { code: opts.audience?.composeCode ?? COMPOSE_FOLLOW_UP_CODE },
      retries: 0,
      inputMapping: {
        person: P,
        channel: "$ref:channel-plan.output",
        offer: "$ref:offer-economics.output",
        brand: "$ref:brand-profile.output",
        facts: "$ref:gather-facts.output",
        history: "$ref:person-history.output",
        ...(opts.readFigures ? { figures: "$ref:read-figures.output" } : {}),
        instruction: "$ref:start-run.output.instruction",
        ...(opts.reactive
          ? { occurrence: "$ref:occurrence.output", triggerType: "$ref:trigger-type.output", trigger: "$ref:flow_input.trigger" }
          : {}),
        nowIso: "$ref:now.output.now",
        currentDate: "$ref:flow_input.currentDate",
        who: "$ref:who-they-are.output",
      },
    },
    {
      id: "draft",
      type: "http.call",
      config: {
        service: "chat",
        method: "POST",
        path: "/complete",
        body: {
          provider: FOLLOW_UP_LLM.provider,
          model: FOLLOW_UP_LLM.model,
          responseFormat: "json",
          responseSchema: FOLLOW_UP_RESPONSE_SCHEMA,
          maxTokens: CHAT_STEP_MAX_TOKENS,
        },
      },
      retries: 0,
      inputMapping: {
        "body.message": "$ref:compose.output.message",
        "body.systemPrompt": "$ref:compose.output.systemPrompt",
        skip: "$ref:compose.output.skip",
      },
    },
    {
      id: "finalize",
      type: "script",
      config: { code: FINALIZE_FOLLOW_UP_CODE },
      retries: 0,
      inputMapping: { draft: "$ref:draft.output", person: P, channel: "$ref:channel-plan.output", campaignId: "$ref:flow_input.campaignId" },
    },
    // WhatsApp, from the brand's account that already talks with them (crm-service picks it by default).
    {
      id: "send-whatsapp",
      type: "http.call",
      config: { ...CRM_WHATSAPP_SEND, skipOnRefusalCodes: [...FOLLOW_UP_WHATSAPP_REFUSAL_CODES] },
      retries: 0,
      inputMapping: { body: "$ref:finalize.output.whatsappBody", skip: "$ref:finalize.output.skipWhatsapp" },
    },
    // Email: a reply in the brand's latest thread with them (`followUp: true`: same mailbox, `Re:` its subject; a
    // connected Gmail thread goes out through Gmail). Lands in the Unibox; a reply fires like any campaign.
    {
      id: "send-email",
      type: "http.call",
      config: {
        service: "email-gateway",
        method: "POST",
        path: "/orgs/send",
        body: { type: "broadcast", tag: "follow-up", followUp: true },
        validateResponse: { field: "success", equals: true },
        skipOnRefusalCodes: [...FOLLOW_UP_SEND_REFUSAL_CODES],
      },
      retries: 0,
      inputMapping: {
        "body.to": "$ref:finalize.output.to",
        "body.subject": "$ref:finalize.output.subject",
        "body.sequence": "$ref:finalize.output.sequence",
        "body.idempotencyKey": "$ref:finalize.output.idempotencyKey",
        "body.leadId": `${P}.leadId`,
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.workflowSlug": "$ref:start-run.output.workflowSlug",
        "body.timezone": `${P}.timezone`,
        skip: "$ref:finalize.output.skipEmail",
      },
    },
    {
      id: "outcome",
      type: "script",
      config: { code: OUTCOME_CODE },
      retries: 0,
      inputMapping: {
        person: P,
        plan: "$ref:read-state.output",
        channel: "$ref:channel-plan.output",
        final: "$ref:finalize.output",
        sendWhatsapp: "$ref:send-whatsapp.output",
        sendEmail: "$ref:send-email.output",
        nowIso: "$ref:now.output.now",
      },
    },
    // Strictly AFTER the send: the next date on lead-service, idempotent on the run's key. Every path but a stop.
    {
      id: "set-next-date",
      type: "http.call",
      config: { service: "lead", method: SET_NEXT_DATE.method, path: SET_NEXT_DATE.path },
      retries: 2,
      inputMapping: { "params.id": `${P}.rowId`, "query.brandId": `${P}.brandId`, body: "$ref:outcome.output.setDateBody", skip: "$ref:outcome.output.skipSetDate" },
    },
    // A stop (their own words, or a refusal saying they are out): the chain ends on lead-service.
    {
      id: "stop-chain",
      type: "http.call",
      config: { service: "lead", method: SET_NEXT_DATE.method, path: SET_NEXT_DATE.path },
      retries: 2,
      inputMapping: { "params.id": `${P}.rowId`, "query.brandId": `${P}.brandId`, body: "$ref:outcome.output.stopBody", skip: "$ref:outcome.output.skipStop" },
    },
    // A claimed queue row is closed (stopped, never handed: a new occurrence files them again); the date lives on
    // lead-service. A served person has no row here.
    {
      id: "record-row",
      type: "http.call",
      config: { service: "lead", method: "POST", path: "/orgs/leads/{id}/followups" },
      retries: 0,
      inputMapping: { "params.id": `${P}.rowId`, body: "$ref:outcome.output.rowBody", skip: "$ref:outcome.output.skipRow" },
    },
    { id: "check-end", type: "condition" },
    endRun("end-run-sent", { success: true, stopCampaign: false }, DELIVERY),
    endRun("end-run-later", { success: true, stopCampaign: false }),
    endRun("end-run-queued", { success: true, stopCampaign: false }),
    endRun("end-run-not-yet", { success: true, stopCampaign: false }),
    endRun("end-run-not-owed", { success: true, stopCampaign: false }),
    endRun("end-run-stopped", { success: true, stopCampaign: false }),
    endRun("end-run-no-channel", { success: true, stopCampaign: false }, DELIVERY),
    endRun("end-run-refused-kept", { success: true, stopCampaign: false }, DELIVERY),
    endRun("end-run-refused-final", { success: true, stopCampaign: false }, DELIVERY),
    // Failed (named in the log) but FINAL for an occurrence: a redelivery would only re-draft the same refusal.
    endRun("end-run-not-writable", { success: false, stopCampaign: false }, DELIVERY),
  ];
  const line = [
    "now",
    "followup-state",
    "read-state",
    PERSON_THREAD_QUERY_NODE_ID,
    PERSON_THREAD_NODE_ID,
    "reach-body",
    "reach-check",
    "channel-plan",
    "offer-economics",
    "brand-profile",
    "offer-answers",
    "offer-user-fields",
    "brand-user-fields",
    "gather-facts",
    ...(opts.readFigures ? ["figures-plan", "read-figures"] : []),
    "history-read",
    "person-history",
    "relationship-read",
    "who-they-are",
    "compose",
    "draft",
    "finalize",
    "send-whatsapp",
    "send-email",
    "outcome",
    "set-next-date",
    "stop-chain",
    "record-row",
    "check-end",
  ];
  const edges: DAG["edges"] = line.slice(1).map((to, i) => ({ from: line[i], to }));
  for (const kind of FOLLOW_UP_END_KINDS) {
    edges.push({ from: "check-end", to: `end-run-${kind.replace(/_/g, "-")}`, condition: `results['outcome']?.endKind == '${kind}'` });
  }
  // Our voice (the `client-comms` skill, read live) on the prompt `draft` writes from.
  // The written message on the ledger, once it went out (COST-ACCOUNTING-1023-P1).
  const declared = withMessageWrittenDeclaration(
    { nodes, edges },
    { after: "record-row", signalRef: "$ref:outcome.output.endKind", sentWhen: "sent", leadIdRef: `${P}.leadId`, consumedAfter: "now" },
  );
  return withLegBestLlm(withClientCommsVoice(declared, "draft"), "draft");
}

/** The proactive chassis. */
const chassis = (): DAGNode[] => [
  {
    id: "gate-check",
    type: "http.call",
    config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" },
  },
  { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
];

const SKIP_STATE_PATCH = `
  const out = await inner(...arguments);
  return { ...out, skipState: out.ok !== true };
`;

/** Adds `skipState` (the state read is not made for nobody) to a resolve script without touching its logic. */
function withSkipState(code: string, params: string): string {
  return code.replace(`export async function main(${params})`, `async function inner(${params})`) +
    `\n\nexport async function main(${params}) {${SKIP_STATE_PATCH}}`;
}

/** PROACTIVE: the lead lead-service hands this pipe (a "Lead follow-up due" source upstream). */
export function buildFollowUpProactiveDag(): DAG {
  const t = tail({ readFigures: false, reactive: false });
  return {
    nodes: [
      ...chassis(),
      // WHO is served is the source pipe's lead strategy (lead-service), never this workflow's.
      { id: "serve-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" }, retries: 0 },
      {
        id: "resolve-person",
        type: "script",
        config: { code: withSkipState(RESOLVE_SERVED_PERSON_CODE, "served, campaignId, runId") },
        retries: 0,
        inputMapping: { served: "$ref:serve-lead.output", campaignId: "$ref:flow_input.campaignId", runId: "$ref:flow_input.runId" },
      },
      ...t.nodes,
      // Nobody served: the converter decides at conversion time whether that means the population ran out.
      endRun("end-run-no-lead", { success: true, stopCampaign: true }),
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "serve-lead" },
      { from: "serve-lead", to: "resolve-person" },
      { from: "resolve-person", to: "now" },
      ...t.edges,
      { from: "check-end", to: "end-run-no-lead", condition: "results['outcome']?.endKind == 'no_lead'" },
    ],
    onError: "end-run-error",
  };
}

/**
 * REACTIVE: the person a trigger occurrence filed on this campaign's own queue. `readFigures` reads the figures the
 * campaign's instruction asks for (the Copilot's follow-ups); the follow-up-date chain runs without.
 */
export function buildFollowUpReactiveDag(opts: { readFigures: boolean; audience?: FollowUpAudience }): DAG {
  const t = tail({ readFigures: opts.readFigures, reactive: true, audience: opts.audience });
  const a = opts.audience;
  return {
    nodes: [
      ...chassis(),
      // What the run answers (a trigger occurrence, or nothing) and the trigger type's declaration.
      occurrencePlanNode(),
      triggerTypeNode(),
      // Who the occurrence names: the claim takes THEIR row, never the queue's oldest one.
      { id: "claim-person", type: "script", config: { code: CLAIM_PERSON_CODE }, retries: 0, inputMapping: { trigger: "$ref:flow_input.trigger" } },
      // THIS campaign's own queue: campaign-service made the person due right before the dispatch.
      {
        id: "claim-followup",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/campaigns/{campaignId}/followups/claim-next",
          // WHO this pipe answers, judged by lead-service (the strategy's tactic reads this literal).
          ...(a ? { body: a.claimBody } : {}),
        },
        retries: 0,
        inputMapping: { "params.campaignId": "$ref:flow_input.campaignId", "body.person": "$ref:claim-person.output.person" },
      },
      { id: "claim-plan", type: "script", config: { code: CLAIM_PLAN_CODE }, retries: 0, inputMapping: { claim: "$ref:claim-followup.output" } },
      {
        id: "lead-detail",
        type: "http.call",
        config: { service: "lead", method: "GET", path: "/orgs/leads/{id}" },
        inputMapping: {
          "params.id": "$ref:claim-followup.output.followup.id",
          "query.campaignId": "$ref:flow_input.campaignId",
          skip: "$ref:claim-plan.output.skipDetail",
        },
      },
      {
        id: "resolve-person",
        type: "script",
        config: { code: withSkipState(a?.resolveClaimedCode ?? RESOLVE_CLAIMED_PERSON_CODE, "claim, detail, trigger") },
        retries: 0,
        inputMapping: { claim: "$ref:claim-followup.output", detail: "$ref:lead-detail.output", trigger: "$ref:flow_input.trigger" },
      },
      ...t.nodes,
      // Nobody due is NOTHING TO DO, never a failure (the scheduler runs every unit on its cadence with no trigger).
      endRun("end-run-idle", { success: true, stopCampaign: false, noWorkAvailable: true }),
      // A run carrying an occurrence that claims nobody, or someone else: fails, so the occurrence is redelivered.
      endRun("end-run-unclaimed", { success: false, stopCampaign: false }),
      endRun("end-run-other-person", { success: false, stopCampaign: false }),
      ...(a?.claimEnds ?? []).map((e) => endRun(`end-run-${e.kind.replace(/_/g, "-")}`, e.body, e.inputMapping)),
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "occurrence" },
      { from: "occurrence", to: "trigger-type" },
      { from: "trigger-type", to: "claim-person" },
      { from: "claim-person", to: "claim-followup" },
      { from: "claim-followup", to: "claim-plan" },
      { from: "claim-plan", to: "lead-detail" },
      { from: "lead-detail", to: "resolve-person" },
      { from: "resolve-person", to: "now" },
      ...t.edges,
      { from: "check-end", to: "end-run-idle", condition: "results['outcome']?.endKind == 'idle'" },
      { from: "check-end", to: "end-run-unclaimed", condition: "results['outcome']?.endKind == 'unclaimed'" },
      { from: "check-end", to: "end-run-other-person", condition: "results['outcome']?.endKind == 'other_person'" },
      ...(a?.claimEnds ?? []).map((e) => ({
        from: "check-end",
        to: `end-run-${e.kind.replace(/_/g, "-")}`,
        condition: `results['outcome']?.endKind == '${e.kind}'`,
      })),
    ],
    onError: "end-run-error",
  };
}
