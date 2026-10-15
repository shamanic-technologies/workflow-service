/**
 * PROSPECT FOLLOW-UP (NEVER-NO-FOLLOWUP-1014): every pure prospect a brand contacted, who reached no terminal state,
 * always has a next follow-up date. Owner Kevin, 2026-10-14: « Cette campagne décide toujours de la date du prochain
 * followup au moment de l'envoi de l'email, de sorte qu'on ne se retrouve jamais dans une situation de non-followup,
 * sauf évidemment si unsubscribe, unqualified, opt-out, ou si on a une réponse positive d'ici là. Seule la date du
 * prochain followup est set à l'envoi, pas le contenu de l'email, qui sera décidé sur le moment en fonction de l'état
 * de ce contact. »
 *
 * Two workflows, one per pipe, sharing everything after "who is this run for":
 *
 *  - PROACTIVE (the first follow-up): a campaign run at the funnel campaign's caps; lead-service serves ONE of the
 *    brand's contacted pure prospects (`POST /orgs/buffer/next`: WHO is served is the source pipe's lead strategy,
 *    never this workflow's), the AI writes the first follow-up and states the next date.
 *  - REACTIVE (every next follow-up): campaign-service fires the dated occurrence this workflow recorded, files the
 *    person on this campaign's own lead-service follow-up queue and dispatches with `flow_input.trigger`. The run
 *    claims them (only a run carrying an occurrence claims anyone), the AI writes from the person's CURRENT state and
 *    states the next date.
 *
 * The date is the ONLY state of the chain, and it lives where it fires: right after each send the workflow records
 * ONE occurrence of the follow-up-date trigger on campaign-service's trigger door (`POST /internal/trigger-events`)
 * with the model's date as `dueAt` and the person. No cadence table: the model reads every past email of ours with
 * its date, everything the person wrote, and what they did (opens, clicks, visits, signups, conversions) and picks
 * the date from that (owner: « laisser l'AI décider de la prochaine date de followup accordingly »).
 *
 * The model first decides whether NOW is the right moment (`right-moment.ts`, RIGHT-MOMENT-OR-LATER-1014): `later`
 * (we already answered them, the point was made) sends nothing and records the same chain at its later date; `write`
 * replies in the thread they wrote in last (`followUp: true`) and records the next date after the send.
 *
 * Stop conditions end the chain BEFORE any model spend: lead-service's verdict (opted out / unsubscribed, bounced,
 * disqualified, a positive reply, a meeting or a sale, any relationship but prospect) is read first; a "no" sends
 * nothing and records no next date. The model may also stop on the person's OWN words (they said no, asked us to
 * stop, are the wrong person): never on silence. An email-gateway refusal because they opted out ends the chain; a
 * refusal because the brand is talking to them right now (`recent_brand_contact`) is not a stop: the next date is
 * still recorded, so the chain survives that thread.
 *
 * Same email rules as every writer: the client's facts only (`GATHER_FACTS_CODE`), never invent, who they are to the
 * brand and their whole thread first (`person-relationship.ts`), no em dash or en dash ever reaches them.
 */
import type { DAG, DAGNode } from "./dag-validator.js";
import { CHAT_STEP_MAX_TOKENS } from "./ai-meeting-booking-dag.js";
import { GATHER_CLIENT_FACTS_CODE } from "./ai-follow-up-email-dag.js";
import { deliveryOf, refusedDelivery, sendDeliveryNode } from "./occurrence-delivery.js";
import { personThreadNodes, relationshipReadNode, whoTheyAreNode } from "./person-relationship.js";
import {
  FOLLOW_UP_SEND_REFUSAL_CODES,
  NEXT_DATE_FN,
  NEXT_DATE_SCHEMA_PROPERTIES,
  NEXT_DATE_STRATEGY,
  PASSING_REFUSAL_CODES,
  RIGHT_MOMENT_STRATEGY,
  passingRefusal,
} from "./right-moment.js";

/** features-service's channel of both pipes (an AI writes ONE email to ONE person). */
export const PROSPECT_FOLLOW_UP_FEATURE_SLUG = "ai-follow-up-email";

/** The proactive pipe's leg: a contacted prospect (lead found) gets the first follow-up. */
export const PROSPECT_FOLLOW_UP_PROACTIVE_LEG_KEY = "lead_found_to_conversation";

/** The reactive pipe's leg, fired by the follow-up date trigger. */
export const PROSPECT_FOLLOW_UP_REACTIVE_LEG_KEY = "start_to_conversation";

export const PROSPECT_FOLLOW_UP_PROACTIVE_PIPE_ID = `${PROSPECT_FOLLOW_UP_FEATURE_SLUG}|${PROSPECT_FOLLOW_UP_PROACTIVE_LEG_KEY}`;
export const PROSPECT_FOLLOW_UP_REACTIVE_PIPE_ID = `${PROSPECT_FOLLOW_UP_FEATURE_SLUG}|${PROSPECT_FOLLOW_UP_REACTIVE_LEG_KEY}`;

/** features-service's trigger "this person's follow-up date is reached" (kind reported, reported by this flow). */
export const PROSPECT_FOLLOW_UP_TRIGGER_ID = "follow_up_date_reached";

export const PROSPECT_FOLLOW_UP_PROACTIVE_DESCRIPTION =
  "Follows up the prospects the brand already contacted: takes one contacted pure prospect at a time, reads " +
  "everything we sent them and everything they did, and first decides whether now is the right moment. If we " +
  "already answered them or the point was already made, it sends nothing and sets a later date. Otherwise it writes " +
  "one follow-up email from what the client told us, replies in the thread they wrote in last, and decides when the " +
  "next follow-up is due.";

export const PROSPECT_FOLLOW_UP_REACTIVE_DESCRIPTION =
  "Runs when a prospect's follow-up date is reached: checks they are still a pure prospect who never said yes, no " +
  "or stop, reads everything we sent them and everything they did since, and first decides whether now is the " +
  "right moment. If we already answered them or the point was already made, it sends nothing and sets a later date. " +
  "Otherwise it writes the next follow-up email from what the client told us, replies in the thread they wrote in " +
  "last, and decides when the next one is due.";

/** The model the email and the date are written with, through chat-service. Always-thinking: no temperature. */
export const PROSPECT_FOLLOW_UP_LLM = { provider: "anthropic", model: "opus" } as const;

/** Queue-row reasons on the reactive campaign (stopped, never handed: the next date makes them due again). */
export const PROSPECT_FOLLOW_UP_SENT_REASON = "prospect_follow_up_sent";
export const PROSPECT_FOLLOW_UP_NOT_OWED_REASON = "prospect_follow_up_not_owed";
export const PROSPECT_FOLLOW_UP_NOT_YET_REASON = "prospect_follow_up_not_yet";
export const PROSPECT_FOLLOW_UP_STOPPED_REASON = "prospect_follow_up_stopped";
export const PROSPECT_FOLLOW_UP_REFUSED_REASON = "prospect_follow_up_refused";
/** Not the right moment (RIGHT-MOMENT-OR-LATER-1014): nothing sent, the chain goes on at the model's later date. */
export const PROSPECT_FOLLOW_UP_LATER_REASON = "prospect_follow_up_later";

/** lead-service's "is this person still owed a prospect follow-up by this brand?" read (NEVER-NO-FOLLOWUP-1014). */
export const PROSPECT_VERDICT = {
  method: "GET",
  path: "/orgs/leads/{id}/prospect-followup",
} as const;

/** The trigger door of campaign-service: one dated occurrence = the next follow-up. */
export const SCHEDULE_NEXT_PATH = "/internal/trigger-events";

/** The model's answer. */
export const PROSPECT_EMAIL_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["write", "later", "stop"] },
    subject: { type: "string", description: "The subject line. Empty when decision is later or stop." },
    bodyHtml: { type: "string", description: "The email body as simple HTML paragraphs. Empty when decision is later or stop." },
    ...NEXT_DATE_SCHEMA_PROPERTIES,
    reason: { type: "string", description: "One sentence: what this email does, or (stop) the person's own words that end the follow-ups." },
  },
  required: ["decision", "subject", "bodyHtml", "nextFollowUpAt", "nextFollowUpWhy", "reason"],
} as const;

/**
 * PROACTIVE: the person lead-service served. `main(served)` -> the person every later node reads.
 * Keys: the send names the campaign and the served row (one first follow-up per person per campaign); the next
 * occurrence names the send, so a retried run never schedules twice.
 */
export const RESOLVE_SERVED_PERSON_CODE = `
export async function main(served, campaignId) {
  if (served?.found !== true) return { ok: false, why: "nobody served" };
  const s = served.lead ?? {};
  const rowId = s.leadCampaignId;
  if (!s.email) throw new Error("resolve-person: a served lead carries no email");
  if (!rowId) throw new Error("resolve-person: a served lead carries no lead row id");
  const brandId = Array.isArray(s.brandIds) ? s.brandIds[0] : null;
  if (!brandId) throw new Error("resolve-person: a served lead carries no brand");
  const sendKey = "prospect-follow-up:" + String(campaignId) + ":" + rowId;
  return {
    ok: true,
    kind: "first",
    rowId,
    leadId: s.leadId ?? null,
    email: s.email,
    brandId,
    lead: s.data ?? {},
    timezone: s.data?.timezone ?? null,
    sendKey,
    nextKey: sendKey + ":next",
    laterKey: sendKey + ":later",
    retryKey: sendKey + ":not-yet",
  };
}
`.trim();

/** REACTIVE: whether this run carries a dated occurrence naming someone; a run that does not claims nobody. */
export const PLAN_CLAIM_CODE = `
export async function main(trigger) {
  const email = trigger && typeof trigger === "object" ? trigger.person?.email : null;
  const carries = typeof email === "string" && email.trim() !== "";
  if (!carries) console.log("[prospect-follow-up] this run carries no follow-up date occurrence: nobody is claimed");
  return { skip: !carries };
}
`.trim();

/**
 * REACTIVE: the claimed person, used ONLY when the occurrence names them (email, case-folded). The send is keyed on
 * the occurrence (`eventId`): campaign-service redelivers it after a run that did not complete, with the same id.
 */
export const RESOLVE_CLAIMED_PERSON_CODE = `
export async function main(claim, detail, trigger) {
  const f = claim?.followup ?? {};
  if (!f.id || !f.email) throw new Error("resolve-person: a claimed row carries no id or email");
  const fold = (s) => typeof s === "string" && s.trim() !== "" ? s.trim().toLowerCase() : null;
  const t = trigger && typeof trigger === "object" ? trigger : null;
  if (!t || fold(t.person?.email) === null || fold(t.person?.email) !== fold(f.email)) {
    console.error("[prospect-follow-up] claimed " + String(f.email) + " but this run's occurrence names " +
      String(t?.person?.email ?? "nobody") + ": nothing is written, their row is left alone");
    return { ok: false, why: "occurrence names someone else", rowId: f.id };
  }
  if (!t.eventId) throw new Error("resolve-person: the occurrence carries no eventId to key the send on");
  const lead = detail?.leadDetail?.lead;
  if (!lead) throw new Error("resolve-person: the claimed person's lead read returned no lead");
  if (!f.brandId) throw new Error("resolve-person: the claimed row carries no brand");
  const sendKey = "prospect-follow-up:event:" + t.eventId;
  return {
    ok: true,
    kind: "next",
    rowId: f.id,
    leadId: f.leadId ?? null,
    email: f.email,
    brandId: f.brandId,
    lead,
    timezone: lead.timezone ?? null,
    sendKey,
    nextKey: sendKey + ":next",
    laterKey: sendKey + ":later",
    retryKey: sendKey + ":not-yet",
  };
}
`.trim();

/**
 * lead-service's verdict, held to its contract. `kind` is `owed` (write now), `stop` (a stop condition: the chain
 * ends, no next date) or `not_yet` (a passing state: their cold sequence still runs, they are mid-conversation, their
 * relationship is not judged yet), which carries `retryAfter`, the date worth asking again: the chain is NOT ended,
 * its next date is re-recorded there and nothing is written (owner: never a dead end). Anything else fails loud: an
 * absent answer is never a yes and never a stop.
 */
export const READ_VERDICT_CODE = `
export async function main(verdict) {
  const kind = verdict?.kind;
  if (kind !== "owed" && kind !== "stop" && kind !== "not_yet") {
    throw new Error("prospect-verdict: lead-service answered no verdict kind: " + JSON.stringify(verdict).slice(0, 300));
  }
  if (kind === "owed" && verdict.owed !== true) throw new Error("prospect-verdict: kind owed with owed " + JSON.stringify(verdict.owed));
  const reason = String(verdict.reason ?? kind);
  if (kind === "not_yet") {
    const at = Date.parse(String(verdict.retryAfter ?? ""));
    if (!Number.isFinite(at)) throw new Error("prospect-verdict: not_yet without a retryAfter date: " + JSON.stringify(verdict).slice(0, 300));
    // A date already past fires at once: ask again in an hour rather than in a loop.
    const retryAfter = new Date(Math.max(at, Date.now() + 3600000)).toISOString();
    console.log("[prospect-follow-up] not yet (" + reason + "): asked again at " + retryAfter + ", nothing written");
    return { owed: false, kind, reason, retryAfter };
  }
  if (kind === "stop") {
    console.log("[prospect-follow-up] stop (" + reason + "): no follow-up, no next date");
    return { owed: false, kind, reason, retryAfter: null };
  }
  return { owed: true, kind, reason: null, retryAfter: null };
}
`.trim();

/**
 * Everything that happened to the person on this brand, oldest first, as plain lines the model reads to write AND
 * to pick the next date: every email of ours with its date, everything they wrote, opens, clicks, visits, signups,
 * conversions, follow-ups stated. A source that holds what we sent or what they did being unreadable fails loud:
 * the next date would be picked blind.
 */
export const PERSON_HISTORY_CODE = `
export async function main(history) {
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
  let ourEmails = 0;
  let lastOurs = null;
  let lastTheirs = null;
  for (const e of history.events) {
    if (e?.type === "message") {
      const who = e.direction === "inbound" ? "THEM" : "US";
      if (e.direction === "outbound") { ourEmails += 1; lastOurs = e.at ?? lastOurs; }
      if (e.direction === "inbound") lastTheirs = e.at ?? lastTheirs;
      lines.push(day(e.at) + " | " + (e.channel ?? "email") + " | " + who + ": " + (e.subject ? "[" + clip(e.subject, 80) + "] " : "") +
        (e.bodyStatus === "ok" ? clip(e.bodyText, 500) : "(" + (e.bodyStatus ?? "no body") + ")"));
    } else if (e?.type === "delivery") {
      if (e.milestone === "sent") { ourEmails += 1; lastOurs = e.at ?? lastOurs; }
      lines.push(day(e.at) + " | EVENT: email " + e.milestone);
    } else if (e?.type === "conversion") {
      lines.push(day(e.at) + " | EVENT: " + (e.event ?? e.step ?? "conversion") + (e.observedBy ? " (seen by " + e.observedBy + ")" : ""));
    } else if (e?.type === "reply_statement" || e?.type === "opt_out_statement" || e?.type === "step_statement") {
      lines.push(day(e.at) + " | RECORDED: " + e.type.replace("_", " ") + (e.replyKind ? " " + e.replyKind : "") + (e.step ? " " + e.step : "") + (e.note ? ": " + clip(e.note, 200) : ""));
    } else if (e?.type === "followup") {
      lines.push(day(e.at) + " | FOLLOW-UP " + (e.state ?? "") + (e.dueAt ? " due " + day(e.dueAt) : "") + (e.stoppedReason ? " (" + e.stoppedReason + ")" : ""));
    }
  }
  const missing = (history.sources ?? []).filter((s) => s?.status === "unavailable").map((s) => s.source);
  return {
    lines: lines.slice(-80),
    omitted: Math.max(0, lines.length - 80),
    ourEmails,
    lastOursAt: lastOurs,
    lastTheirsAt: lastTheirs,
    unreadable: missing,
  };
}
`.trim();

/**
 * Builds the system prompt and the message. Explains the GAME (owner rule: strategy, never a canned reply per case).
 * Kept free of em and en dashes: the model copies the style of its prompt.
 */
export const COMPOSE_PROSPECT_EMAIL_CODE = `
export async function main(person, offer, brand, facts, history, instruction, currentDate, nowIso, who) {
  if (!who || !Array.isArray(who.lines) || !Array.isArray(who.threadLines) || typeof who.strategy !== "string") {
    throw new Error("compose-email: who this person is to the brand was not read; nothing is written blind");
  }
  if (!history || !Array.isArray(history.lines)) throw new Error("compose-email: the person's history was not read");
  const offerName = typeof offer?.name === "string" ? offer.name.trim() : "";
  if (!offerName) throw new Error("compose-email: the campaign's offer read carries no name");
  const b = brand?.brand ?? {};
  const brandName = typeof b.name === "string" && b.name.trim() ? b.name.trim() : null;
  if (!brandName) throw new Error("compose-email: the brand read carries no name");
  const present = (v) => typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined;
  const p = person?.lead ?? {};
  const org = p.organization ?? {};
  const personLines = [
    ["Email", person?.email],
    ["Name", [p.firstName, p.lastName].filter(present).join(" ")],
    ["Title", p.currentTitle],
    ["Company", org.name],
    ["Timezone", person?.timezone],
  ].filter(([, v]) => present(v)).map(([k, v]) => k + ": " + String(v).trim());
  const exact = facts?.exact ?? [];
  const neverGive = facts?.neverGive ?? [];
  const note = typeof instruction === "string" && instruction.trim() ? instruction.trim() : null;

  const systemPrompt = [
    "You write ONE follow-up email from the team at " + brandName + " to one prospect we already contacted, and you decide WHEN the next follow-up is due.",
    "THE GAME. This person heard from us before and never said yes, no or stop. Each follow-up must earn a reply on its own: it is written NOW, for where this person is NOW, never a copy or a reminder of an earlier email, never \\"just following up\\" or \\"bumping this\\".",
    "Read the HISTORY first: every email we sent with its date, everything they wrote, and what they did (opened, clicked, visited, signed up). Pick ONE angle that fits that state: a new useful fact about what we offer, a short concrete example, a simpler next step, or a plain question about their situation. Then ONE easy question they can answer in a line.",
    "What they did is for choosing what to say and when, never something to say: never write that you saw them open, click, visit or sign up.",
    "You state only what the FACTS our client told us say. Never invent a figure, a price, a result, a customer, a date or a promise. A number appears only if it is written in the facts, exactly as written.",
    who.strategy,
    ${JSON.stringify(RIGHT_MOMENT_STRATEGY)},
    ${JSON.stringify(NEXT_DATE_STRATEGY)},
    "STOP only on the person's OWN words, and only for two things: they asked us to stop, unsubscribe or never write again (an opt out), or they show they are not a fit at all (the wrong person, they left the company, they do not run anything like what we offer). Then set decision to stop, leave subject, bodyHtml and nextFollowUpAt empty, and quote their words in reason. A plain \\"no thanks\\" or \\"not now\\" is NOT a stop: keep following up, wait much longer, and make the next email lighter. Silence is never a reason to stop.",
    "Write like a person: short, plain, warm, one idea per sentence, under 120 words. Greet them by first name when you have it. No filler, no \\"I hope this finds you well\\".",
    "Never use an em dash or an en dash. Use a comma or a period.",
    "Do not sign off with a name or a signature block: ours is added below your text. End with your last sentence.",
    "bodyHtml is simple HTML: <p> paragraphs only. The subject is short and plain, never \\"Re:\\" or \\"Follow-up\\".",
  ].join("\\n");

  const message = [
    "NOW: " + String(nowIso),
    "TODAY: " + String(currentDate ?? String(nowIso).slice(0, 10)),
    "This is the " + (person?.kind === "first" ? "FIRST follow-up after our outreach" : "next follow-up in this chain") + ". Emails of ours on record: " + String(history.ourEmails ?? 0) +
      ". Our last: " + String(history.lastOursAt ?? "unknown") + ". Their last message: " + String(history.lastTheirsAt ?? "never") + ".",
    ...(note ? ["", "CAMPAIGN INSTRUCTION from our client (follow it where it does not contradict the rules):", note] : []),
    "",
    "WHO WE WRITE TO:",
    ...(personLines.length ? personLines : ["(nothing beyond their email)"]),
    "",
    "WHO THEY ARE TO US:",
    ...who.lines,
    "",
    "HISTORY with this person on this brand, oldest first:",
    ...(history.omitted > 0 ? ["(" + history.omitted + " older lines not shown)"] : []),
    ...(history.lines.length ? history.lines : ["(nothing on record)"]),
    ...(Array.isArray(history.unreadable) && history.unreadable.length ? ["(could not be read: " + history.unreadable.join(", ") + ")"] : []),
    "",
    "THE THREAD on every channel, oldest first:",
    ...(who.threadLines.length ? who.threadLines : ["(no message on record)"]),
    ...(who.eventLines?.length ? ["", "OTHER EVENTS:", ...who.eventLines] : []),
    "",
    "WHO WE ARE: " + brandName + ", offer \\"" + offerName + "\\".",
    "",
    "FACTS our client told us:",
    ...(exact.length ? exact.map((f) => f.id + ". " + f.label + ": " + f.value) : ["(none)"]),
    ...(neverGive.length ? ["", "NEVER offer or promise any of these, whole or in part:", ...neverGive.map((x) => "- " + x)] : []),
  ].join("\\n");

  return { systemPrompt, message };
}
`.trim();

/**
 * Holds the model to its contract strictly BEFORE the send: a `write` with an empty subject or body, or a next date
 * that is not a date strictly in the future, throws (nothing is sent: an email whose next date cannot be recorded is
 * the dead end this flow exists to prevent). Any em/en dash is rewritten (between digits a hyphen, else a comma).
 */
export const FINALIZE_PROSPECT_EMAIL_CODE = `
export async function main(draft, person) {
  const json = draft?.json ?? {};
  if (!person?.sendKey) throw new Error("finalize-email: no resolved person");
  if (json.decision === "stop") {
    console.log("[prospect-follow-up] the person's own words end the follow-ups: " + JSON.stringify(json.reason ?? null));
    return { decision: "stop", reason: String(json.reason ?? "") };
  }
  if (json.decision === "later") {
    const later = nextDate(json, "finalize-email");
    console.log("[prospect-follow-up] not the right moment, nothing is sent; next look at " + later.nextFollowUpAt + ": " + later.nextFollowUpWhy);
    return { decision: "later", ...later, reason: String(json.reason ?? "") };
  }
  if (json.decision !== "write") throw new Error("finalize-email: unknown decision " + JSON.stringify(json.decision));
  const undash = (s) => String(s ?? "")
    .replace(/&(mdash|ndash);|&#(8212|8211|x2014|x2013);/gi, (m) => (/mdash|8212|2014/i.test(m) ? "\\u2014" : "\\u2013"))
    .replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-")
    .replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ")
    .trim();
  const subject = undash(json.subject);
  const bodyHtml = undash(json.bodyHtml);
  if (!subject || !bodyHtml) throw new Error("finalize-email: decision write with an empty subject or body");
  if (subject !== String(json.subject ?? "").trim() || bodyHtml !== String(json.bodyHtml ?? "").trim()) {
    console.error("[prospect-follow-up] the draft used a dash the person must never read; rewritten before the send");
  }
  return {
    decision: "write",
    subject,
    sequence: [{ step: 1, bodyHtml, daysSinceLastStep: 0 }],
    idempotencyKey: person.sendKey,
    ...nextDate(json, "finalize-email"),
  };
}

${NEXT_DATE_FN}
`.trim();

/** The run's "now", read once so the prompt and the bound agree. */
export const NOW_CODE = `
export async function main() {
  return { now: new Date().toISOString() };
}
`.trim();

const endRun = (id: string, body: Record<string, unknown>, inputMapping?: Record<string, string>): DAGNode => ({
  id,
  type: "http.call",
  config: { service: "campaign", method: "POST", path: "/end-run", body },
  ...(inputMapping ? { inputMapping } : {}),
});

const stopRow = (id: string, reason: string): DAGNode => ({
  id,
  type: "http.call",
  config: { service: "lead", method: "POST", path: "/orgs/leads/{id}/followups", body: { kind: "stopped", reason } },
  retries: 0,
  inputMapping: { "params.id": "$ref:resolve-person.output.rowId" },
});

/** The person resolved and owed a follow-up: the writer runs. */
export const OWED = "results['resolve-person']?.ok == true && results['read-verdict']?.owed == true";
/** A stop condition: nothing is written, no next date. */
export const NOT_OWED = "results['resolve-person']?.ok == true && results['read-verdict']?.kind == 'stop'";
/** A passing state: nothing is written now, the next date is re-recorded at lead-service's retryAfter. */
export const NOT_YET = "results['resolve-person']?.ok == true && results['read-verdict']?.kind == 'not_yet'";
export const WRITE = "results['finalize-email']?.decision == 'write'";
export const STOP = "results['finalize-email']?.decision == 'stop'";
/** Not the right moment: nothing is sent, the chain goes on at the model's later date. */
export const LATER = "results['finalize-email']?.decision == 'later'";
/**
 * Refusals that are NOT a stop: a step of the brand's sequence to them is still queued (two of our emails would race),
 * or the brand is in a thread with them right now. Nothing was sent; the chain goes on at the model's date.
 */
export { PASSING_REFUSAL_CODES };
/** Every per-person refusal the send reads as an outcome: the passing ones, and the stops (opted out, not a prospect). */
export const PROSPECT_SEND_REFUSAL_CODES = FOLLOW_UP_SEND_REFUSAL_CODES;
const PASSING = passingRefusal("send-email");
/** Sent, or refused for a passing reason: the chain goes on, the next date is recorded. */
export const CONTINUE =
  "results['finalize-email']?.decision == 'write' && results['send-email'] != null && " +
  `(results['send-email']?.skipped != true || ${PASSING})`;
/** Refused for a stop (opted out, not a prospect): the chain ends, no next date. */
export const OPTED_OUT =
  "results['finalize-email']?.decision == 'write' && results['send-email']?.skipped == true && " +
  `!(${PASSING})`;

/** The reactive row's record after the send: what actually happened, never "sent" for a refusal. */
export const SEND_OUTCOME_CODE = `
export async function main(send) {
  if (send?.skipped === true) return { reason: "prospect_follow_up_deferred_" + String(send.code ?? "refused") };
  return { reason: "${PROSPECT_FOLLOW_UP_SENT_REASON}" };
}
`.trim();

/**
 * Everything after "who is this run for": verdict, reads, write, send, next date. `anchor` is a node OUTSIDE every
 * branch body (it runs on every path) that each later condition also takes an edge from, so the conditions are
 * top-level sibling branchones rather than containers nested in a branch (which the converter drops silently).
 * `reactive` adds the queue-row records (the proactive person has no debt on a queue).
 */
function writerTail(opts: { anchor: string; reactive: boolean }): { nodes: DAGNode[]; edges: DAG["edges"] } {
  const { anchor, reactive } = opts;
  const P = "$ref:resolve-person.output";
  const nodes: DAGNode[] = [
    {
      id: "prospect-verdict",
      type: "http.call",
      config: { service: "lead", method: PROSPECT_VERDICT.method, path: PROSPECT_VERDICT.path },
      // A read: safe to retry through a sibling being redeployed.
      retries: 2,
      inputMapping: { "params.id": `${P}.rowId`, "query.brandId": `${P}.brandId` },
    },
    { id: "read-verdict", type: "script", config: { code: READ_VERDICT_CODE }, retries: 0, inputMapping: { verdict: "$ref:prospect-verdict.output" } },
    { id: "check-owed", type: "condition" },
    {
      id: "offer-economics",
      type: "http.call",
      config: { service: "brand", method: "GET", path: "/internal/offers/{offerId}/economics" },
      inputMapping: { "params.offerId": "$ref:start-run.output.offerId" },
    },
    {
      id: "brand-profile",
      type: "http.call",
      config: { service: "brand", method: "GET", path: "/internal/brands/{id}" },
      inputMapping: { "params.id": `${P}.brandId` },
    },
    {
      id: "offer-answers",
      type: "http.call",
      config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/answers" },
      inputMapping: { "params.brandId": `${P}.brandId`, "params.offerId": "$ref:start-run.output.offerId" },
    },
    {
      id: "offer-user-fields",
      type: "http.call",
      config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/user-fields" },
      inputMapping: { "params.brandId": `${P}.brandId`, "params.offerId": "$ref:start-run.output.offerId" },
    },
    {
      id: "brand-user-fields",
      type: "http.call",
      // Refused (409 SEVERAL_OFFERS) for a brand selling several offers: gather-facts reads that one refusal as
      // "no brand-level fields" and re-throws every other failure.
      config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/user-fields", tolerateFailure: true },
      inputMapping: { "params.brandId": `${P}.brandId` },
    },
    {
      id: "gather-facts",
      type: "script",
      config: { code: GATHER_CLIENT_FACTS_CODE },
      retries: 0,
      inputMapping: {
        offerAnswers: "$ref:offer-answers.output",
        offerFields: "$ref:offer-user-fields.output",
        brandFields: "$ref:brand-user-fields.output",
      },
    },
    // Everything that happened to them on this brand: our emails with dates, their words, what they did.
    {
      id: "history-read",
      type: "http.call",
      config: { service: "lead", method: "GET", path: "/orgs/leads/{id}/history", query: { scope: "brand" } },
      retries: 2,
      inputMapping: { "params.id": `${P}.rowId`, "query.brandId": `${P}.brandId` },
    },
    { id: "person-history", type: "script", config: { code: PERSON_HISTORY_CODE }, retries: 0, inputMapping: { history: "$ref:history-read.output" } },
    ...personThreadNodes({ email: `${P}.email`, brandId: `${P}.brandId` }),
    relationshipReadNode({ leadRowId: `${P}.rowId`, brandId: `${P}.brandId` }),
    whoTheyAreNode({ relationshipRead: "$ref:relationship-read.output", timeline: "$ref:person-thread.output" }),
    { id: "now", type: "script", config: { code: NOW_CODE }, retries: 0 },
    {
      id: "compose-email",
      type: "script",
      config: { code: COMPOSE_PROSPECT_EMAIL_CODE },
      retries: 0,
      inputMapping: {
        person: P,
        offer: "$ref:offer-economics.output",
        brand: "$ref:brand-profile.output",
        facts: "$ref:gather-facts.output",
        history: "$ref:person-history.output",
        instruction: "$ref:start-run.output.instruction",
        currentDate: "$ref:flow_input.currentDate",
        nowIso: "$ref:now.output.now",
        who: "$ref:who-they-are.output",
      },
    },
    {
      id: "draft-email",
      type: "http.call",
      config: {
        service: "chat",
        method: "POST",
        path: "/complete",
        body: {
          provider: PROSPECT_FOLLOW_UP_LLM.provider,
          model: PROSPECT_FOLLOW_UP_LLM.model,
          responseFormat: "json",
          responseSchema: PROSPECT_EMAIL_RESPONSE_SCHEMA,
          maxTokens: CHAT_STEP_MAX_TOKENS,
        },
      },
      retries: 0,
      inputMapping: {
        "body.message": "$ref:compose-email.output.message",
        "body.systemPrompt": "$ref:compose-email.output.systemPrompt",
      },
    },
    {
      id: "finalize-email",
      type: "script",
      config: { code: FINALIZE_PROSPECT_EMAIL_CODE },
      retries: 0,
      inputMapping: { draft: "$ref:draft-email.output", person: P },
    },
    { id: "check-decision", type: "condition" },
    // A reply in the thread they wrote in last (`followUp: true`), from our sending infra: lands in the Unibox, a reply
    // fires positive_reply_received like any campaign.
    {
      id: "send-email",
      type: "http.call",
      config: {
        service: "email-gateway",
        method: "POST",
        path: "/orgs/send",
        // `followUp: true`: a follow-up of the brand's own outreach to this person, so instantly-service does not
        // apply its 3-month re-contact window (which refused every one of these sends) and threads it on the
        // brand's latest thread with them. Keyed on the run's x-run-id there.
        body: { type: "broadcast", tag: "prospect-follow-up", followUp: true },
        validateResponse: { field: "success", equals: true },
        // Read, not thrown: an opted-out person, a step of their sequence still queued, or one the brand talks to
        // right now, is an outcome (check-sent).
        skipOnRefusalCodes: [...PROSPECT_SEND_REFUSAL_CODES],
      },
      retries: 0,
      inputMapping: {
        "body.to": `${P}.email`,
        "body.subject": "$ref:finalize-email.output.subject",
        "body.sequence": "$ref:finalize-email.output.sequence",
        "body.idempotencyKey": "$ref:finalize-email.output.idempotencyKey",
        "body.leadId": `${P}.leadId`,
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.workflowSlug": "$ref:start-run.output.workflowSlug",
        "body.timezone": `${P}.timezone`,
      },
    },
    { id: "check-sent", type: "condition" },
    // Strictly AFTER the send: the next date, as ONE dated occurrence campaign-service fires. Idempotent on the send.
    {
      id: "schedule-next",
      type: "http.call",
      config: {
        service: "campaign",
        method: "POST",
        path: SCHEDULE_NEXT_PATH,
        body: { triggerId: PROSPECT_FOLLOW_UP_TRIGGER_ID },
      },
      // Idempotent on its key: a retry through a redeploy never schedules twice.
      retries: 2,
      inputMapping: {
        "body.brandId": `${P}.brandId`,
        "body.offerId": "$ref:start-run.output.offerId",
        "body.leadId": `${P}.leadId`,
        "body.dueAt": "$ref:finalize-email.output.nextFollowUpAt",
        "body.person.email": `${P}.email`,
        "body.idempotencyKey": `${P}.nextKey`,
        "body.requestedByCampaignId": "$ref:flow_input.campaignId",
      },
    },
    // Not the right moment: nothing sent, the same chain recorded at the model's later date. Keyed on the run's
    // person, so a redelivered run never records it twice.
    {
      id: "schedule-later",
      type: "http.call",
      config: { service: "campaign", method: "POST", path: SCHEDULE_NEXT_PATH, body: { triggerId: PROSPECT_FOLLOW_UP_TRIGGER_ID } },
      retries: 2,
      inputMapping: {
        "body.brandId": `${P}.brandId`,
        "body.offerId": "$ref:start-run.output.offerId",
        "body.leadId": `${P}.leadId`,
        "body.dueAt": "$ref:finalize-email.output.nextFollowUpAt",
        "body.person.email": `${P}.email`,
        "body.idempotencyKey": `${P}.laterKey`,
        "body.requestedByCampaignId": "$ref:flow_input.campaignId",
      },
    },
    // The occurrence's truth (PUSHED-TRUTH-1015): `end-run` closes both a sent email and a passing refusal (next date
    // still recorded), so its delivery is read off the send (`send-delivery`); a final refusal states it verbatim.
    sendDeliveryNode("send-delivery", "send-email"),
    endRun("end-run", { success: true, stopCampaign: false }, deliveryOf("send-delivery")),
    endRun("end-run-later", { success: true, stopCampaign: false }),
    endRun("end-run-not-owed", { success: true, stopCampaign: false }),
    endRun("end-run-not-yet", { success: true, stopCampaign: false }),
    endRun("end-run-stopped", { success: true, stopCampaign: false }),
    endRun("end-run-opted-out", { success: true, stopCampaign: false }, refusedDelivery("send-email")),
  ];
  const edges: DAG["edges"] = [
    { from: "resolve-person", to: "prospect-verdict" },
    { from: "prospect-verdict", to: "read-verdict" },
    { from: "read-verdict", to: "check-owed" },
    { from: anchor, to: "check-owed" },
    { from: "check-owed", to: "offer-economics", condition: OWED },
    { from: "offer-economics", to: "brand-profile" },
    { from: "brand-profile", to: "offer-answers" },
    { from: "offer-answers", to: "offer-user-fields" },
    { from: "offer-user-fields", to: "brand-user-fields" },
    { from: "brand-user-fields", to: "gather-facts" },
    { from: "gather-facts", to: "history-read" },
    { from: "history-read", to: "person-history" },
    { from: "person-history", to: "person-thread-query" },
    { from: "person-thread-query", to: "person-thread" },
    { from: "person-thread", to: "relationship-read" },
    { from: "relationship-read", to: "who-they-are" },
    { from: "who-they-are", to: "now" },
    { from: "now", to: "compose-email" },
    { from: "compose-email", to: "draft-email" },
    { from: "draft-email", to: "finalize-email" },
    { from: "finalize-email", to: "check-decision" },
    { from: anchor, to: "check-decision" },
    { from: "check-decision", to: "send-email", condition: WRITE },
    { from: "check-decision", to: "schedule-later", condition: LATER },
    { from: "send-email", to: "check-sent" },
    { from: anchor, to: "check-sent" },
    { from: "check-sent", to: "schedule-next", condition: CONTINUE },
  ];
  if (reactive) {
    nodes.push(
      // Not yet: the same chain, its date moved to when lead-service says it is worth asking again. Keyed on the
      // occurrence, so a redelivered run never records it twice.
      {
        id: "schedule-retry",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: SCHEDULE_NEXT_PATH, body: { triggerId: PROSPECT_FOLLOW_UP_TRIGGER_ID } },
        retries: 2,
        inputMapping: {
          "body.brandId": `${P}.brandId`,
          "body.offerId": "$ref:start-run.output.offerId",
          "body.leadId": `${P}.leadId`,
          "body.dueAt": "$ref:read-verdict.output.retryAfter",
          "body.person.email": `${P}.email`,
          "body.idempotencyKey": `${P}.retryKey`,
          "body.requestedByCampaignId": "$ref:flow_input.campaignId",
        },
      },
      stopRow("record-not-yet", PROSPECT_FOLLOW_UP_NOT_YET_REASON),
      stopRow("record-not-owed", PROSPECT_FOLLOW_UP_NOT_OWED_REASON),
      stopRow("record-stopped", PROSPECT_FOLLOW_UP_STOPPED_REASON),
      stopRow("record-later", PROSPECT_FOLLOW_UP_LATER_REASON),
      { id: "send-outcome", type: "script", config: { code: SEND_OUTCOME_CODE }, retries: 0, inputMapping: { send: "$ref:send-email.output" } },
      {
        ...stopRow("record-sent", PROSPECT_FOLLOW_UP_SENT_REASON),
        inputMapping: { "params.id": "$ref:resolve-person.output.rowId", "body.reason": "$ref:send-outcome.output.reason" },
      },
      stopRow("record-opted-out", PROSPECT_FOLLOW_UP_REFUSED_REASON),
    );
    edges.push(
      { from: "check-owed", to: "schedule-retry", condition: NOT_YET },
      { from: "schedule-retry", to: "record-not-yet" },
      { from: "record-not-yet", to: "end-run-not-yet" },
      { from: "check-owed", to: "record-not-owed", condition: NOT_OWED },
      { from: "record-not-owed", to: "end-run-not-owed" },
      { from: "check-decision", to: "record-stopped", condition: STOP },
      { from: "record-stopped", to: "end-run-stopped" },
      { from: "schedule-later", to: "record-later" },
      { from: "record-later", to: "end-run-later" },
      { from: "schedule-next", to: "send-outcome" },
      { from: "send-outcome", to: "record-sent" },
      { from: "record-sent", to: "send-delivery" },
      { from: "send-delivery", to: "end-run" },
      { from: "check-sent", to: "record-opted-out", condition: OPTED_OUT },
      { from: "record-opted-out", to: "end-run-opted-out" },
    );
  } else {
    edges.push(
      // Not yet on a served person: lead-service released them and its source finds them again later.
      { from: "check-owed", to: "end-run-not-yet", condition: NOT_YET },
      { from: "check-owed", to: "end-run-not-owed", condition: NOT_OWED },
      { from: "check-decision", to: "end-run-stopped", condition: STOP },
      { from: "schedule-later", to: "end-run-later" },
      { from: "schedule-next", to: "send-delivery" },
      { from: "send-delivery", to: "end-run" },
      { from: "check-sent", to: "end-run-opted-out", condition: OPTED_OUT },
    );
  }
  return { nodes, edges };
}

const chassis = (): DAGNode[] => [
  {
    id: "gate-check",
    type: "http.call",
    config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" },
  },
  { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
];

/** PROACTIVE: one contacted pure prospect served by lead-service, the first follow-up, the next date. */
export function buildProspectFollowUpProactiveDag(): DAG {
  const tail = writerTail({ anchor: "serve-lead", reactive: false });
  return {
    nodes: [
      ...chassis(),
      // WHO is served is the source pipe's lead strategy (lead-service), never this workflow's.
      { id: "serve-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" }, retries: 0 },
      { id: "check-found", type: "condition" },
      {
        id: "resolve-person",
        type: "script",
        config: { code: RESOLVE_SERVED_PERSON_CODE },
        retries: 0,
        inputMapping: { served: "$ref:serve-lead.output", campaignId: "$ref:flow_input.campaignId" },
      },
      ...tail.nodes,
      // Nobody served: the converter decides at conversion time whether that means the population ran out.
      endRun("end-run-no-lead", { success: true, stopCampaign: true }),
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "serve-lead" },
      { from: "serve-lead", to: "check-found" },
      { from: "check-found", to: "resolve-person", condition: "results['serve-lead']?.found == true" },
      { from: "check-found", to: "end-run-no-lead", condition: "results['serve-lead']?.found == false" },
      ...tail.edges,
    ],
    onError: "end-run-error",
  };
}

/** REACTIVE: the person a dated occurrence names, the next follow-up, the next date. */
export function buildProspectFollowUpReactiveDag(): DAG {
  const tail = writerTail({ anchor: "claim-followup", reactive: true });
  return {
    nodes: [
      ...chassis(),
      { id: "plan-claim", type: "script", config: { code: PLAN_CLAIM_CODE }, retries: 0, inputMapping: { trigger: "$ref:flow_input.trigger" } },
      // THIS campaign's own queue: campaign-service made the person due right before the dispatch.
      {
        id: "claim-followup",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/campaigns/{campaignId}/followups/claim-next" },
        retries: 0,
        inputMapping: { "params.campaignId": "$ref:flow_input.campaignId", skip: "$ref:plan-claim.output.skip" },
      },
      { id: "check-claim", type: "condition" },
      {
        id: "lead-detail",
        type: "http.call",
        config: { service: "lead", method: "GET", path: "/orgs/leads/{id}" },
        inputMapping: {
          "params.id": "$ref:claim-followup.output.followup.id",
          "query.campaignId": "$ref:flow_input.campaignId",
        },
      },
      {
        id: "resolve-person",
        type: "script",
        config: { code: RESOLVE_CLAIMED_PERSON_CODE },
        retries: 0,
        inputMapping: {
          claim: "$ref:claim-followup.output",
          detail: "$ref:lead-detail.output",
          trigger: "$ref:flow_input.trigger",
        },
      },
      { id: "check-person", type: "condition" },
      ...tail.nodes,
      endRun("end-run-nobody-due", { success: true, stopCampaign: false, noWorkAvailable: true }),
      // A run carrying an occurrence that claims nobody, or someone else: fails, so the occurrence is redelivered.
      endRun("end-run-unclaimed", { success: false, stopCampaign: false }),
      endRun("end-run-other-person", { success: false, stopCampaign: false }),
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "plan-claim" },
      { from: "plan-claim", to: "claim-followup" },
      { from: "claim-followup", to: "check-claim" },
      { from: "check-claim", to: "lead-detail", condition: "results['claim-followup']?.found == true" },
      {
        from: "check-claim",
        to: "end-run-nobody-due",
        condition: "results['claim-followup']?.found != true && results['plan-claim']?.skip == true",
      },
      {
        from: "check-claim",
        to: "end-run-unclaimed",
        condition: "results['claim-followup']?.found != true && results['plan-claim']?.skip != true",
      },
      { from: "lead-detail", to: "resolve-person" },
      { from: "resolve-person", to: "check-person" },
      { from: "claim-followup", to: "check-person" },
      { from: "check-person", to: "prospect-verdict", condition: "results['resolve-person']?.ok == true" },
      { from: "check-person", to: "end-run-other-person", condition: "results['resolve-person']?.ok == false" },
      ...tail.edges.filter((e) => !(e.from === "resolve-person" && e.to === "prospect-verdict")),
    ],
    onError: "end-run-error",
  };
}
