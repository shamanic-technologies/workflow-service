/**
 * THE WORKFLOW OF THE COLD WHATSAPP OUTREACH PIPES (owner 2026-10-12: "every pipe in prod HAS a workflow").
 *
 * The channel `cold-whatsapp-outreach` has two proactive pipes (Lead found -> Positive reply, Lead found -> Website
 * visit). Both run THIS DAG: what differs between them is what features-service measures, never the step. One run
 * writes to AT MOST ONE person, on WhatsApp, from the brand's own linked WhatsApp account (crm-service owns the
 * account, the send, and the thread the message lands in, so the brand's team sees it in the Unibox and on their
 * phone, and takes over the moment the person answers).
 *
 * Each run, in order:
 *
 *  - The FOLLOW-UP comes first. This campaign's own lead-service queue (`claim-next`, atomic, at most one, exactly
 *    once) hands back a person whose next look is due (WA-FOLLOWUP-LOOP-1015, owner 2026-10-15: « une campagne qui
 *    output non seulement un message à envoyer mais une date de followup. Puis sur trigger de ce followup, check la
 *    conv et décide s'il écrit ou s'arrête car déjà répondu. Si pas répondu, alors écrit et choisit une autre date de
 *    followup. Ainsi de suite jusqu'à l'infini. »). The SAME game as every email follow-up writer (`right-moment.ts`,
 *    one text, the channel only names its message): no fixed count, no fixed delay. Each look:
 *      - they answered since this campaign first wrote to them, on ANY channel (`reach-plan`, off their merged
 *        thread, before any model spend): nothing is drafted or sent, the row is `handed` (their conversation is a
 *        person's now; the responder answers them). crm-service's `skipIfReplied` is the race guard on the send.
 *      - otherwise the model decides `write` (sent in the same WhatsApp conversation, from the account that already
 *        talks with them: crm-service picks it), `later` (nothing sent) or `stop` (only on their own words), and states
 *        the next date. write = row `acted` due again at that date; later = row `scheduled` at that date; stop =
 *        `stopped`. The queue row is the date's ONLY store.
 *  - Nobody due: the NEXT person is served by lead-service (`POST /orgs/buffer/next`, the same serve every
 *    outreach workflow calls; for the CRM pipe it hands out the brand's own people). Nobody left ends the run on
 *    the no-lead end-run, which the converter turns into "exhausted" only on lead-service's `audience_exhausted`.
 *    ONLY a unit `/start-run` states proactive (`reactive: false`) is served a new person: a reactive unit, or one
 *    whose leg is unknown (`null`, or a campaign-service that does not say), ends idle (`noWorkAvailable`) with
 *    nobody due, never cold-messaging a stranger (owner rule, la-paz 2026-10-14).
 *  - The message is written by the model through chat-service `/complete` (which owns the model, the key and the
 *    cost declaration), from the campaign's own `instruction` (read off `/start-run` at THIS run, so an edit is
 *    what the next run writes from), what the CLIENT told us about the offer (`GATHER_FACTS_CODE`, never the
 *    website), the person as we know them, and a STRATEGY: start a real conversation, get to know them. Never a
 *    canned reply.
 *  - It is sent by crm-service on WhatsApp. A person we cannot reach there (no phone known, number not on
 *    WhatsApp, the brand's WhatsApp not linked or not connected, or, on the follow-up, they wrote to us since) is a named REFUSAL, not an error: the
 *    run names it in the log and ends as a normal run, and it is the email path's job to reach them. Any other
 *    failure fails the run loud.
 *  - A first message refused for a reason about the CHANNEL (`CHANNEL_UNREACHABLE_CODES`: no phone known, not on
 *    WhatsApp) RELEASES the person to the brand's other pipes that can reach them (lead-service
 *    `channel-refusals`, owner 2026-10-12): a refusal about the channel never burns the person.
 *  - Strictly AFTER the send, lead-service records what we owe them: a first message schedules the first follow-up
 *    look at the date the model chose (`schedule-by-email`); a follow-up records the look (above). A refusal on a
 *    follow-up about the PERSON (they answered, no phone, not on WhatsApp) hands the row over; one about the BRAND's
 *    WhatsApp (not linked, not connected: the owner is told by crm-service) keeps the person followed up at the
 *    model's date.
 *
 * A run that answers a trigger OCCURRENCE (FACT-NOT-FOLLOWED-1014, owner 2026-10-14: « Pareil pour un WA si signup non
 * suivi d'un paid client dans les 24 h »; campaign-service filed the person and made them due on this campaign's
 * own queue before dispatching it) owes that person ONE message and nothing else:
 *
 *  - The claimed person is kind `occurrence`: never a "follow-up" (we never wrote to them), never served a new lead
 *    (nobody due = the idle end-run, `noWorkAvailable`), never a scheduled follow-up after a sent one (the row is handed).
 *  - The model still judges THE RIGHT MOMENT and THEIR LOCAL TIME (TRIGGER-RIGHT-MOMENT-1016, owner 2026-10-16: a
 *    trigger message landed at 08:27 their time on top of six messages the owner typed at midnight their time, which
 *    they had not answered yet): `later` sends nothing and schedules the row on THIS campaign's queue at the model's
 *    date; that look (a row this campaign never wrote to, `reach-plan` `owed`) is judged again the same way, and a
 *    written one is the occurrence's one message. `stop` only on their own words. Never a new occurrence at the
 *    trigger door: it would reach every campaign on that trigger.
 *  - WHY WE WRITE NOW is the trigger type features-service declares (`occurrence-fact.ts`), any trigger, any params.
 *  - The phone the occurrence names wins (crm-service `phone`); the send is keyed on the occurrence
 *    (`OCCURRENCE_SEND_KEY_FN`), so a redelivery of the same event never writes twice (crm-service's key is durable).
 *
 * No phone known (none on the occurrence, none in the brand's CRM person: the thread read already holds them) is
 * decided BEFORE the model writes, for every kind (`reach-plan`): nothing is drafted, nothing is sent, the refusal
 * `no_phone_known` is named in the log and recorded exactly as crm-service's own refusal would be, never a spend for
 * a message that cannot leave.
 *
 * Shape: three decisions (`check-due`, `check-person`, `check-record`) are SIBLING top-level branchones, each
 * pinned by a convergence edge from a node outside the previous decision's branch (`nodeToModule` builds a
 * condition nested in a branch as an ordinary module, which silently does nothing); every arm reads its evidence
 * with `?.`, because on another path the node it reads never ran.
 */
import { GENERATE_WHATSAPP_PATH, withLegBestWhatsappTemplate } from "./whatsapp-template-writer.js";
import type { DAG } from "./dag-validator.js";
import { CHAT_STEP_MAX_TOKENS, CRM_WHATSAPP_SEND, GATHER_FACTS_CODE } from "./ai-meeting-booking-dag.js";
import { relationshipReadNode, whoTheyAreNode } from "./person-relationship.js";
import { WHY_NOW_FN, WHY_NOW_STRATEGY, occurrencePlanNode, triggerTypeNode } from "./occurrence-fact.js";
import { OCCURRENCE_SEND_KEY_FN } from "./occurrence-send-key.js";
import { SENDER_PERSONA_FN } from "./sender-persona.js";
import { BUBBLE_SEND_FN, HAND_TYPED_FN, whatsappBubblesStrategy } from "./whatsapp-bubbles.js";
import {
  LOCAL_TIME_FN,
  NEXT_DATE_FN,
  NEXT_DATE_SCHEMA_PROPERTIES,
  RIGHT_MOMENT_DECISIONS,
  WHATSAPP_MEDIUM,
  localTimeStrategy,
  nextDateStrategy,
  rightMomentStrategy,
} from "./right-moment.js";

export { CRM_WHATSAPP_SEND };

export const COLD_WHATSAPP_OUTREACH_FEATURE_SLUG = "cold-whatsapp-outreach";

/**
 * The legs the channel's pipes perform (features-service catalogue). The two proactive ones (2026-10-12), then the two
 * REACTIVE ones, where a trigger occurrence makes ONE person due and the run writes them ONE message: Signup -> Paid
 * client (FACT-NOT-FOLLOWED-1014) and Start -> Signup on `whatsapp_number_given` (WA-WELCOME-WORKFLOW-1015: a person
 * who just gave their WhatsApp number, often known only by that phone, is greeted once).
 */
export const COLD_WHATSAPP_OUTREACH_LEG_KEYS = [
  "lead_found_to_conversation",
  "lead_found_to_website_visit",
  "signup_to_paid_client",
  "start_to_signup",
] as const;

export const coldWhatsappPipeIdOf = (legKey: string): string => `${COLD_WHATSAPP_OUTREACH_FEATURE_SLUG}|${legKey}`;

export const COLD_WHATSAPP_OUTREACH_DESCRIPTION =
  "Starts a real WhatsApp conversation with one person per run from the brand's own number, written from the campaign's instruction, then follows up in the same conversation at moments it judges right until they answer, when the brand's team takes over. On a trigger (a number given, a signup not paid) it sends one message only, and only to a new contact: someone with a visit to the brand's website who never wrote to the brand on any channel and is neither our staff nor the brand's own team.";

/** The model the message is written with, through chat-service. Always-thinking: no temperature. */
export const COLD_WHATSAPP_LLM = { provider: "anthropic", model: "opus" } as const;

/**
 * The template variable carrying the whole voice block (the sending account's persona, else how the owner writes):
 * content-generation-service's WhatsApp template contract (WA-TEMPLATES-1023).
 */
export const WHATSAPP_VOICE_RULES_VARIABLE = "voiceRules";

/** Stored on the queue row when the person's own words end the follow-ups (decision `stop`). */
export const WHATSAPP_FOLLOW_UP_STOPPED_REASON = "whatsapp_follow_up_stopped";

/** Message sources on which the PERSON can answer (Copilot and API calls are product use, not an answer). */
export const REPLY_SOURCES = ["gmail", "matrix", "instantly"] as const;

/**
 * crm-service refusals about the BRAND's WhatsApp, not the person: on a follow-up look nothing was sent and the
 * person stays followed up at the model's date (crm-service tells the owner to reconnect), or, when the refusal came
 * before any draft (the reach check), `BRAND_SIDE_RECHECK_DAYS` later. `automation_not_allowed` = the brand has no
 * linked account it lets automation write from (SOPHIE-WA-1016).
 */
export const BRAND_SIDE_REFUSAL_CODES = ["whatsapp_not_linked", "whatsapp_not_connected", "automation_not_allowed"] as const;

/** A brand-side refusal with no date of the model's (nothing was drafted): the person is looked at again this long after. */
export const BRAND_SIDE_RECHECK_DAYS = 7;

/**
 * crm-service refusal: someone of the brand typed by hand in this person's WhatsApp thread, so automation stays out of
 * it for good. Named (never a failed run) but about the PERSON, not brand-side: a follow-up look hands them over
 * (`handed`, permanent), never a recheck that would re-look at them forever.
 */
export const HUMAN_IN_CONVERSATION_CODE = "human_in_conversation";

/** Stored on the queue row once the message answering an occurrence went out: handed, permanent, one message. */
export const WHATSAPP_OCCURRENCE_SENT_REASON = "whatsapp_occurrence_sent";

/**
 * Who this run writes to, from whichever path ran: the claimed queue row (lead-detail read) or the newly served
 * lead. `kind` is `occurrence` (the run answers a trigger occurrence: the claimed person is owed ONE message
 * because of it), `followup`, `first`, `nobody_due` (an occurrence run with nobody due: never a served lead), or
 * `nobody` (nothing due and nobody served). Reads both with `?.`: exactly one of them ran. The phone an occurrence
 * names is carried only when the occurrence names THIS person.
 */
export const PICK_PERSON_CODE = `
export async function main(claim, detail, served, occurrence, trigger) {
  const answering = occurrence?.answering === true;
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const digits = (v) => (s(v) && /^\\s*(\\+|00)/.test(v) ? v.replace(/^\\s*(\\+|00)/, "").replace(/\\D/g, "") : "");
  if (claim?.found === true) {
    const f = claim.followup ?? {};
    const lead = detail?.leadDetail?.lead ?? null;
    const email = s(f.email);
    // A person known only by phone (a WhatsApp number given, REPLY-PHONE-ONLY-1015): the claim's phone names them.
    const claimPhone = email ? null : s(f.phone);
    if (!f.id || (!email && !claimPhone)) throw new Error("pick-person: a claimed follow-up carries no row id, or neither an email nor a phone");
    if (!lead) throw new Error("pick-person: the claimed person's lead read returned no lead");
    const base = { skipSends: false, rowId: f.id, leadId: f.leadId ?? null, email, brandId: f.brandId ?? null, lead, dueAt: f.dueAt ?? null };
    const sendsQuery = email ? { brandId: base.brandId, email } : { brandId: base.brandId, phone: claimPhone };
    if (answering) {
      const named = email
        ? s(occurrence.person?.email) === email.toLowerCase()
        : digits(claimPhone).length >= 8 && digits(occurrence.person?.phone) === digits(claimPhone);
      // The first name the occurrence states (a number given with a name), else the first word of its person's name.
      const item = trigger?.item && typeof trigger.item === "object" ? trigger.item : {};
      const firstName = named ? (s(item.firstName) ?? s(occurrence.person?.name)?.split(/\\s+/)[0] ?? null) : null;
      const lastName = named ? s(item.lastName) : null;
      return {
        kind: "occurrence", step: 1, ...base, sendsQuery, firstName, lastName,
        phone: named ? (s(occurrence.person.phone) ?? claimPhone) : claimPhone,
      };
    }
    return { kind: "followup", step: 2, ...base, sendsQuery, phone: claimPhone };
  }
  // Nobody due, and this run may not buy a stranger (it answers an occurrence, or the unit is reactive or unknown).
  if (answering || occurrence?.serveNewLead !== true) return { kind: "nobody_due", skipSends: true, reason: claim?.reason ?? null };
  if (served?.found === true) {
    const l = served.lead ?? {};
    if (!l.email) throw new Error("pick-person: a served lead carries no email");
    const brandId = (l.brandIds ?? [])[0] ?? null;
    return { kind: "first", step: 1, skipSends: false, rowId: null, leadId: l.leadId ?? null, email: l.email, brandId, lead: l.data ?? {}, sendsQuery: { brandId, email: l.email } };
  }
  return { kind: "nobody", skipSends: true, reason: served?.reason ?? claim?.reason ?? null };
}
`.trim();

/** crm-service send statuses that mean the message is out (or going out): writing it again sends nothing. */
export const WRITTEN_SEND_STATUSES = ["sent", "sending"] as const;

/**
 * Has THIS campaign already written to this person on WhatsApp? Read off crm-service, the sender, BEFORE anything is
 * read or paid for. A first message to someone this campaign already wrote to is a RE-SERVE: crm-service would answer
 * the send as a duplicate (same idempotency key) and nothing would go out, after a full read and an Opus draft.
 * WA-SPENT-NOTHING-SENT-1014: lead-service re-served the same 8 people 16 to 18 times each on campaign 4af21454,
 * 147 drafts for 8 real messages. Stopping the re-serve is lead-service's; not paying for one is this flow's.
 * A follow-up is never a re-serve here: its first message is exactly what makes it due.
 */
export const PRIOR_CONTACT_CODE = `
export async function main(person, sends, campaignId) {
  if (person?.kind !== "first") return { alreadyWritten: false };
  if (!Array.isArray(sends?.sends)) throw new Error("prior-contact: crm-service answered no sends list for " + String(person.email));
  const mine = sends.sends.find((x) => x?.campaignId === campaignId && ${JSON.stringify(WRITTEN_SEND_STATUSES)}.includes(x?.status));
  if (!mine) return { alreadyWritten: false };
  console.error("[cold-whatsapp-outreach] " + String(person.email) + " was served again, but this campaign already wrote to them on WhatsApp (send " +
    String(mine.sendId) + ", " + String(mine.status) + " " + String(mine.sentAt ?? mine.createdAt) + "): nothing is read, written or sent. Re-serving is lead-service's to stop.");
  return { alreadyWritten: true, sendId: mine.sendId ?? null, sentAt: mine.sentAt ?? null };
}
`.trim();

/** How many OTHER people's threads the owner's voice is learned from (besides this person's own thread). */
export const VOICE_SAMPLE_PEOPLE = 4;

/** A person counts as a voice sample when the owner wrote them at least this many messages on a personal channel. */
export const VOICE_SAMPLE_MIN_OUTBOUND = 5;

/**
 * Where the history is read from (crm-service, the brand's people index), planned off the person and the brand's
 * most recent personal-channel conversations: this person's merged thread, what our automated outreach already sent
 * them on WhatsApp, and VOICE_SAMPLE_PEOPLE other people the owner really talked with (their threads teach the model
 * how the owner writes). Fewer candidates than slots: the free slots repeat this person, which the reader drops, so
 * every read node always has a valid query.
 */
export const HISTORY_PLAN_CODE = `
export async function main(person, recent) {
  const email = typeof person?.email === "string" ? person.email.trim().toLowerCase() : "";
  // A person known only by phone (REPLY-PHONE-ONLY-1015): their thread is keyed phone:+<digits>.
  const phoneDigits = !email && typeof person?.phone === "string" && /^\\s*(\\+|00)/.test(person.phone) ? person.phone.replace(/^\\s*(\\+|00)/, "").replace(/\\D/g, "") : "";
  const brandId = person?.brandId;
  if (!email && phoneDigits.length < 8) throw new Error("history-plan: the person carries neither an email nor a phone to find their thread by");
  if (!brandId) throw new Error("history-plan: the person carries no brand");
  if (!Array.isArray(recent?.people)) throw new Error("history-plan: the brand's people index answered no people list");
  const self = email
    ? { personId: null, timelineQuery: { brandId, personKey: "email:" + email }, sendsQuery: { brandId, email } }
    : { personId: null, timelineQuery: { brandId, personKey: "phone:+" + phoneDigits }, sendsQuery: { brandId, phone: "+" + phoneDigits } };
  const isSelf = (p) => email
    ? (p.emails ?? []).map((e) => String(e).toLowerCase()).includes(email)
    : (p.phones ?? []).map((x) => String(x).replace(/\\D/g, "")).includes(phoneDigits);
  const samples = [];
  for (const p of recent.people) {
    if (samples.length >= ${VOICE_SAMPLE_PEOPLE}) break;
    if (!p?.personId || isSelf(p)) continue;
    const wrote = (p.presences ?? []).filter((x) => x?.source === "matrix").reduce((n, x) => n + (Number(x.outboundCount) || 0), 0);
    if (wrote < ${VOICE_SAMPLE_MIN_OUTBOUND}) continue;
    const key = p.emails?.[0] ? { email: p.emails[0] } : p.phones?.[0] ? { phone: p.phones[0] } : null;
    samples.push({
      personId: p.personId,
      timelineQuery: { brandId, personId: p.personId },
      // No email and no phone: nothing of ours was ever sent to them by address, so there is nothing to exclude.
      sendsQuery: key ? { brandId, ...key } : self.sendsQuery,
    });
  }
  while (samples.length < ${VOICE_SAMPLE_PEOPLE}) samples.push(self);
  return { thread: self.timelineQuery, sends: self.sendsQuery, samples };
}
`.trim();

/** Timeline sources that carry MESSAGES: one of them unreadable means the thread is unreadable, and nothing is written. */
export const MESSAGE_SOURCES = ["gmail", "matrix", "instantly", "copilot"] as const;

/**
 * Reads this person's whole merged thread (every channel, oldest first) and the owner's own words, for the writer.
 *
 * - The THREAD: every message (and the last few events: signup, visit, payment) ever exchanged with this person. A
 *   message our software sent (a cold email, a WhatsApp from this workflow, the AI Copilot) is labelled as such:
 *   the person saw it, but the owner did not type it.
 * - The OWNER'S VOICE: his own outbound messages on his personal channels, never one our software sent: this
 *   person's thread first, then the other sampled people's. His chat messages (WhatsApp, LinkedIn) when he has any,
 *   since a WhatsApp message is what is being written; his emails only when he never chatted.
 *
 * Fails the person loud when the thread cannot be read whole: a blind generic message is exactly what this step
 * exists to prevent. Not one message of the owner to learn his voice from is decided by the writer (compose), once
 * the reach check said who sends: a sending account with a persona speaks as itself and needs no owner voice
 * (SOPHIE-WA-1016); without one, compose fails loud as this step used to.
 */
export const READ_HISTORY_CODE = `
export async function main(thread, sends, v1, s1, v2, s2, v3, s3, v4, s4) {
  if (!thread || !Array.isArray(thread.items)) throw new Error("read-history: the person's thread did not come back");
  const failed = (thread.sources ?? []).filter((x) => ${JSON.stringify(MESSAGE_SOURCES)}.includes(x?.source) && x?.status === "failed");
  if (failed.length) {
    throw new Error("read-history: the person's thread is unreadable (" + failed.map((x) => x.source + ": " + (x.error ?? "failed")).join("; ") + "); nothing is written blind");
  }
  const clip = (t, n) => { const s = String(t ?? "").replace(/\\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "..." : s; };
  const botOf = (r) => {
    const rows = Array.isArray(r?.sends) ? r.sends : [];
    return { ids: new Set(rows.map((x) => x?.eventId).filter(Boolean)), texts: new Set(rows.map((x) => clip(x?.text, 4000)).filter(Boolean)) };
  };
  const isBot = (i, bot) => i.source === "matrix" && (bot.ids.has(i.ref?.eventId) || bot.texts.has(clip(i.text, 4000)));
  // What the OWNER typed himself: his personal channels, outbound, not sent by our software, never part of an
  // automated burst (an agent writing through his account: WA-BUBBLES-1023, his hand-typed bubbles only).
  const handOf = (items) => new Set(handTyped(items.filter((i) => i?.kind === "message" && i?.direction === "outbound" && i?.source === "matrix")));
  const ownerTyped = (i, bot, hand) => i.kind === "message" && i.direction === "outbound" && (i.source === "gmail" || (i.source === "matrix" && hand.has(i))) && !isBot(i, bot) && clip(i.text, 10);
  const day = (at) => (typeof at === "string" ? at.slice(0, 16).replace("T", " ") : "date unknown");

  const bot = botOf(sends);
  const items = thread.items;
  const messages = items.filter((i) => i.kind === "message" && i.source !== "api" && clip(i.text, 10));
  const label = (i) => {
    if (i.direction === "inbound") return "THEM";
    if (i.source === "instantly") return "US [automated cold email]";
    if (i.source === "copilot") return "US [AI Copilot]";
    if (isBot(i, bot)) return "US [automated WhatsApp]";
    return "OWNER";
  };
  const lines = messages.slice(-60).map((i) =>
    day(i.at) + " | " + i.channel + " | " + label(i) + ": " + (i.subject && i.channel === "email" ? "[" + clip(i.subject, 80) + "] " : "") + clip(i.text, 500));
  // What they did, in crm-service's own words (its \`text\`: "Get started step done · step: offer · ..."), the step name only when it states none.
  const events = items.filter((i) => i.kind === "event").slice(-30).map((i) => day(i.at) + " | " + i.channel + " | EVENT: " + (clip(i.text, 300) || (i.event?.step ?? "event")) + " (" + i.source + ")");
  const last = messages[messages.length - 1] ?? null;

  // His chat voice (WhatsApp, LinkedIn: what this message is) first; his emails only when he never chatted.
  const chat = [];
  const mail = [];
  const take = (i, who) => (i.source === "matrix" ? chat : mail).push(who + ", " + i.channel + ": " + clip(i.text, 300));
  const hand = handOf(items);
  const own = messages.filter((i) => ownerTyped(i, bot, hand));
  for (const i of own.slice(-25)) take(i, "to this person");
  const seen = new Set([thread.person?.personId]);
  for (const [v, s] of [[v1, s1], [v2, s2], [v3, s3], [v4, s4]]) {
    const pid = v?.person?.personId;
    if (!Array.isArray(v?.items) || !pid || seen.has(pid)) continue;
    seen.add(pid);
    const b = botOf(s);
    const h = handOf(v.items);
    for (const i of v.items.filter((x) => ownerTyped(x, b, h)).slice(-12)) take(i, "to someone else");
  }
  const voice = chat.length ? chat : mail;

  return {
    hasHistory: messages.length > 0,
    ownerWroteThem: own.length > 0,
    lastMessage: last ? { at: last.at, channel: last.channel, from: label(last), text: clip(last.text, 300) } : null,
    threadLines: lines,
    olderMessagesOmitted: Math.max(0, messages.length - lines.length),
    eventLines: events,
    voiceLines: voice,
  };
}

${HAND_TYPED_FN}
`.trim();

/** Timeline event steps that are a visit to the brand's website (PostHog `visit`, a CRM `website_visit` fact). */
export const WEBSITE_VISIT_STEPS = ["visit", "website_visit"] as const;

/**
 * Why a person a trigger made due is NOT written to (WA-WELCOME-STRATEGY-1017, owner 2026-10-17: a person who just
 * gave their WhatsApp number gets ONE warm welcome only when they are a new contact of the brand). Each is a tactic
 * features-service judges on this workflow's versions; the trigger states only the fact.
 */
export const NOT_ADMITTED_CODES = {
  noWebsiteVisit: "no_website_visit",
  personWrote: "person_wrote",
  staff: "staff",
  ownTeam: "own_team",
} as const;

/**
 * The timeline sources a website visit can come from (PostHog `visit`, a CRM `website_visit` funnel event).
 * ADMISSION-RECHECK-1023: "no visit" is final only when each of them was really READ.
 */
export const WEBSITE_VISIT_SOURCES = ["posthog", "gohighlevel"] as const;

/**
 * Not a refusal: no visit is on record YET, but a source that could hold one was not really read (crm-service had
 * not joined the person there: `empty` with nothing asked, a failed or not-ready read, a re-read still running).
 * Nothing is drafted or sent; the row is looked at again and admitted or refused then: the FIRST look (the occurrence
 * itself) again `ADMISSION_FIRST_RECHECK_MINUTES` later, any later look `ADMISSION_RECHECK_HOURS` later.
 * (2026-10-22: Albin, 3 PostHog visits, was refused for good on a PostHog read that asked nothing: he had signed up
 * 4 min before, and crm-service mirrors PostHog every 15 min. WA-WELCOME-VISIT-RACE-1022: the welcome is owed
 * « instantanément », so the first recheck waits one mirror pass plus margin, never 6 hours.)
 */
export const ADMISSION_RECHECK_CODE = "website_visit_unconfirmed";
export const ADMISSION_FIRST_RECHECK_MINUTES = 20;
export const ADMISSION_RECHECK_HOURS = 6;

/**
 * WHO a message a trigger made due may reach (a run answering an occurrence, or the deferred look of one: a row this
 * campaign never sent anything to), decided off their merged thread BEFORE any model spend:
 *  - no visit to the brand's website on record = not admitted (`no_website_visit`), but ONLY when every source a
 *    visit can come from (`WEBSITE_VISIT_SOURCES`) was really read: `ok`, `empty` with something asked, or
 *    `not_connected` (nothing will ever come from it). Any other state (`empty` with nothing asked, failed, not
 *    ready, stale, still re-reading, absent) = looked at again later (`recheck`, `ADMISSION_RECHECK_CODE`), never a
 *    final refusal on a read that did not happen;
 *  - a message FROM them on any channel (`REPLY_SOURCES`: a visit, a click or a product use is not a message) = not
 *    admitted (`person_wrote`): they are already talking with the brand, a welcome would read as a bot;
 *  - otherwise crm-service is asked whether they are our staff or the brand's own team (`team-membership`, the next
 *    node; reach-plan reads its answer).
 * A newly served person or a follow-up of a message we sent is not gated here (`gated: false`, nothing asked).
 */
export const ADMISSION_PLAN_CODE = `
export async function main(person, thread, sends, campaignId) {
  const owedLook = person?.kind === "followup"
    && !(Array.isArray(sends?.sends) ? sends.sends : []).some((x) => x?.campaignId === campaignId && x?.status === "sent");
  const gated = person?.kind === "occurrence" || owedLook;
  if (!gated) return { gated: false, skipTeam: true, teamBody: null, notAdmitted: null };
  if (!thread || !Array.isArray(thread.items)) throw new Error("admission-plan: the person's thread did not come back");
  const items = thread.items;
  const who = String(person.email ?? person.phone ?? "");
  const refuse = (code, reason) => {
    console.log("[cold-whatsapp-outreach] " + who + " not admitted (" + code + "): " + reason);
    return { gated: true, skipTeam: true, teamBody: null, code, notAdmitted: { reason: code + ": " + reason } };
  };
  const visited = items.some((i) => i?.kind === "event" && ${JSON.stringify(WEBSITE_VISIT_STEPS)}.includes(i?.event?.step));
  if (!visited) {
    // An ABSENCE is final only off a source really read (ADMISSION-RECHECK-1023).
    const sources = Array.isArray(thread.sources) ? thread.sources : [];
    const unread = ${JSON.stringify(WEBSITE_VISIT_SOURCES)}.map((name) => {
      const r = sources.find((x) => x?.source === name);
      if (!r) return name + ": not in the answer";
      if (r.refreshing === true) return name + ": still re-reading";
      if (r.status === "ok" || r.status === "not_connected") return null;
      if (r.status === "empty") return Array.isArray(r.asked) && r.asked.length > 0 ? null : name + ": empty with nothing asked";
      return name + ": " + String(r.status) + (r.error ? " (" + String(r.error) + ")" : "");
    }).filter(Boolean);
    if (unread.length) {
      const waitMs = person.kind === "occurrence" ? ${ADMISSION_FIRST_RECHECK_MINUTES} * 60000 : ${ADMISSION_RECHECK_HOURS} * 3600000;
      const dueAt = new Date(Date.now() + waitMs).toISOString();
      const reason = "no visit is on record yet, but " + unread.join("; ") + ": looked at again at " + dueAt;
      console.log("[cold-whatsapp-outreach] " + who + " not decided yet (${ADMISSION_RECHECK_CODE}): " + reason);
      return { gated: true, skipTeam: true, teamBody: null, code: "${ADMISSION_RECHECK_CODE}", notAdmitted: null, recheck: { dueAt, reason } };
    }
    return refuse("${NOT_ADMITTED_CODES.noWebsiteVisit}", "no visit to the brand's website is on record for this person");
  }
  const wrote = items.find((i) => i?.kind === "message" && i?.direction === "inbound" && ${JSON.stringify(REPLY_SOURCES)}.includes(i?.source));
  if (wrote) return refuse("${NOT_ADMITTED_CODES.personWrote}", "they already wrote to the brand (" + String(wrote.channel ?? wrote.source) + ", " + String(wrote.at ?? "date unknown") + ")");
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const phone = s(person.phone) ?? (Array.isArray(thread.person?.phones) ? thread.person.phones.map(s).find(Boolean) ?? null : null);
  const email = s(person.email);
  if (!email && !phone) throw new Error("admission-plan: the person carries neither an email nor a phone to ask crm-service about");
  if (!person.brandId) throw new Error("admission-plan: the person carries no brand");
  return {
    gated: true,
    skipTeam: false,
    teamBody: { brandId: person.brandId, ...(email ? { email } : {}), ...(phone ? { phone } : {}) },
    code: null,
    notAdmitted: null,
  };
}
`.trim();

/**
 * Whether the message may leave at all, decided BEFORE the model writes.
 *
 * First, for a message a trigger made due: the admission (`ADMISSION_PLAN_CODE` + crm-service's team-membership
 * answer). Not admitted = nothing drafted or sent, the row stopped, and the run states `personNotAdmitted` (final for
 * this occurrence, never redelivered). An unanswered team read throws: nobody is welcomed blind.
 *
 * A FOLLOW-UP look first: did the person answer since this campaign first wrote to them (its earliest `sent` send),
 * on any channel (`REPLY_SOURCES`, off their merged thread)? Then nothing is drafted or sent (`person_replied`, the
 * code crm-service's own guard answers): their conversation is a person's now. A row this campaign never sent anything
 * to is `owed` (a deferred occurrence message): no hand-off, the model judges the moment again. `skipIfReplied` (crm-service: "ever wrote to the brand") is then asked on the send only when
 * they never wrote at all, so it is an exact race guard and never blocks someone who talked with us BEFORE the
 * campaign wrote.
 *
 * Then a phone the occurrence names, or one the brand's CRM person holds (the thread read returns the person
 * crm-service resolves the send by). Neither = the refusal crm-service would answer (`no_phone_known`), with nothing
 * drafted. A thread read that states no phone list decides nothing (crm-service answers).
 */
export const REACH_PLAN_CODE = `
export async function main(person, thread, sends, campaignId, admission, team) {
  if (admission?.gated === true) {
    const owedRow = person?.kind === "followup";
    const notAdmitted = (code, reason) => ({ skip: true, code, skipIfReplied: false, owed: owedRow, reason, notAdmitted: { reason: code + ": " + reason } });
    // Not decided yet (a visit source not really read): nothing drafted, the row looked at again (ADMISSION-RECHECK-1023).
    if (admission.recheck) return { skip: true, code: admission.code, skipIfReplied: false, owed: owedRow, reason: admission.recheck.reason, recheck: admission.recheck };
    if (admission.notAdmitted) return { ...notAdmitted(admission.code, admission.notAdmitted.reason), notAdmitted: admission.notAdmitted };
    if (!team || team.notCalled === true || typeof team.staff !== "boolean" || typeof team.ownTeam !== "boolean") {
      throw new Error("reach-plan: crm-service did not say whether this person is our staff or the brand's own team; nobody is welcomed blind");
    }
    const via = (Array.isArray(team.matches) ? team.matches : []).map((m) => String(m?.description ?? m?.kind)).join(", ");
    if (team.staff === true) {
      console.log("[cold-whatsapp-outreach] " + String(person?.email ?? person?.phone) + " not admitted (${NOT_ADMITTED_CODES.staff}): " + via);
      return notAdmitted("${NOT_ADMITTED_CODES.staff}", "one of our own staff (" + via + ")");
    }
    if (team.ownTeam === true) {
      console.log("[cold-whatsapp-outreach] " + String(person?.email ?? person?.phone) + " not admitted (${NOT_ADMITTED_CODES.ownTeam}): " + via);
      return notAdmitted("${NOT_ADMITTED_CODES.ownTeam}", "one of the brand's own team (" + via + ")");
    }
  }
  let skipIfReplied = false;
  let owed = false;
  if (person?.kind === "followup") {
    const items = Array.isArray(thread?.items) ? thread.items : [];
    const inbound = items.filter((i) => i?.kind === "message" && i?.direction === "inbound" && ${JSON.stringify(REPLY_SOURCES)}.includes(i?.source));
    const ours = (Array.isArray(sends?.sends) ? sends.sends : []).filter((x) => x?.campaignId === campaignId && x?.status === "sent");
    // Nothing of this campaign was ever sent to them: the row is the message an occurrence made due, deferred by an
    // earlier look (decision later). Still owed: the model judges the moment again from the whole thread, never a hand-off.
    owed = ours.length === 0;
  }
  if (person?.kind === "followup" && !owed) {
    const items = Array.isArray(thread?.items) ? thread.items : [];
    const inbound = items.filter((i) => i?.kind === "message" && i?.direction === "inbound" && ${JSON.stringify(REPLY_SOURCES)}.includes(i?.source));
    const ours = (Array.isArray(sends?.sends) ? sends.sends : []).filter((x) => x?.campaignId === campaignId && x?.status === "sent");
    const firstAt = ours.map((x) => Date.parse(String(x?.sentAt ?? x?.createdAt ?? ""))).filter(Number.isFinite).sort((a, b) => a - b)[0];
    const since = inbound.filter((i) => { const t = Date.parse(String(i.at ?? "")); return !Number.isFinite(t) || !Number.isFinite(firstAt) || t > firstAt; });
    if (since.length) {
      const last = since[since.length - 1];
      console.log("[cold-whatsapp-outreach] " + String(person.email) + " answered since this campaign first wrote (" + String(last.channel ?? last.source) + ", " +
        String(last.at ?? "date unknown") + "): no automated follow-up for this look, their conversation is a person's now (person_replied)");
      return { skip: true, code: "person_replied", skipIfReplied: false, reason: "They answered since our campaign first wrote to them: no automated follow-up was sent." };
    }
    skipIfReplied = inbound.length === 0;
  }
  const asked = typeof person?.phone === "string" && person.phone.trim() !== "";
  const phones = thread?.person?.phones;
  if (asked || !Array.isArray(phones) || phones.some((p) => typeof p === "string" && p.trim() !== "")) {
    // The person exactly as the send will name them: crm-service's reach check answers what that send would.
    const phone = asked ? person.phone.trim() : null;
    if (!phone && !person?.email) throw new Error("reach-plan: the person carries neither an email nor a phone");
    const reachBody = { ...(person?.email ? { email: person.email } : {}), brandId: person?.brandId, skipIfReplied, ...(phone ? { phone } : {}) };
    return { skip: false, code: null, skipIfReplied, owed, reachBody };
  }
  console.error("[cold-whatsapp-outreach] " + String(person?.email) + ": no phone known on the occurrence or in the brand's CRM; nothing drafted, nothing sent (no_phone_known)");
  return { skip: true, code: "no_phone_known", skipIfReplied: false, owed, reason: "No phone number is known for this person, on the occurrence or in the brand's CRM: nothing was sent." };
}
`.trim();

/**
 * crm-service's answer to "can the brand's WhatsApp reach this person now?" (`POST /orgs/whatsapp/reach`: the same
 * checks the send runs, in its order, nothing sent), merged with reach-plan's own verdict BEFORE any model call
 * (LLM-SPEND-NO-SEND-1016: 28 Opus drafts in 5 days went to people the send then refused, one invalid number
 * redrafted every hour for 18 hours). `reachable: false` = the send's own refusal code, nothing drafted or sent,
 * recorded exactly as that refusal would be. A failed check throws (a bridge failure on a valid number): the run
 * fails having paid for no draft. Reachable = the persona of the account that will send, for the writer
 * (`persona`, null when the account states none; SOPHIE-WA-1016).
 */
export const REACH_VERDICT_CODE = `
export async function main(plan, check) {
  if (plan?.skip === true) return plan;
  if (!check || check.notCalled === true || typeof check.reachable !== "boolean") {
    throw new Error("reach-verdict: crm-service's reach check gave no answer; nothing is drafted blind");
  }
  if (check.reachable === true) return { ...plan, persona: senderPersona(check) };
  const code = typeof check.code === "string" && check.code ? check.code : "not_reachable";
  console.error("[cold-whatsapp-outreach] crm-service says the brand's WhatsApp cannot reach this person (" + code + "): nothing drafted, nothing sent");
  const reason = typeof check.error === "string" && check.error.trim() ? check.error : "This person cannot be reached on WhatsApp: nothing was sent.";
  return { skip: true, code, skipIfReplied: false, owed: plan?.owed === true, reason };
}

${SENDER_PERSONA_FN}
`.trim();

/**
 * Builds the system prompt and the message. chat-service `/complete` takes one flat `message`, so the
 * interpolation happens in the flow; this is also what makes the prompt readable in the stored DAG.
 * The strategy is explained to the model, never a script per case (owner rule).
 */
export const COMPOSE_MESSAGE_PROMPT_CODE = `
export async function main(person, instruction, offer, brand, rep, facts, history, currentDate, occurrence, triggerType, who, reach) {
  const offerName = typeof offer?.name === "string" ? offer.name.trim() : "";
  if (!offerName) throw new Error("compose-message: the campaign's offer read carries no name");
  const b = brand?.brand ?? {};
  const brandName = typeof b.name === "string" && b.name.trim() ? b.name.trim() : null;
  if (!brandName) throw new Error("compose-message: the brand read carries no name");
  if (person?.kind !== "first" && person?.kind !== "followup" && person?.kind !== "occurrence") throw new Error("compose-message: no person to write to");
  // The persona of the account that will send (crm-service's reach check): it speaks as itself, and needs no owner voice.
  const persona = senderPersona(reach);
  if (!Array.isArray(history?.threadLines) || !Array.isArray(history?.voiceLines) || (history.voiceLines.length === 0 && !persona)) {
    throw new Error("compose-message: no thread or no owner's voice was read; nothing is written blind");
  }
  if (!who || !Array.isArray(who.lines) || typeof who.strategy !== "string") {
    throw new Error("compose-message: who this person is to the brand was not read; nothing is written blind");
  }

  const present = (v) => typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined;
  const lead = person.lead ?? {};
  const org = lead.organization ?? {};
  const personLines = [
    ["Name", [lead.firstName ?? person.firstName, lead.lastName ?? person.lastName].filter(present).join(" ")],
    // The first name the person gave us themselves (a number given with a name): greet them by it.
    ["First name they gave us", present(lead.firstName) ? null : person.firstName],
    ["Title", lead.currentTitle],
    ["Company", org.name],
    ["Company website", org.websiteUrl ?? org.primaryDomain],
    ["Industry", org.industry],
    ["City", [lead.city, lead.country].filter(present).join(", ")],
  ].filter(([, v]) => present(v)).map(([k, v]) => k + ": " + String(v).trim());

  const senderName = present(rep?.salesRepFirstName) ? rep.salesRepFirstName.trim() : null;
  const senderRole = present(rep?.salesRepRole) ? rep.salesRepRole.trim() : (senderName ? "founder" : null);
  const owner = senderName ?? "the founder";
  const exact = facts?.exact ?? [];
  const neverGive = facts?.neverGive ?? [];
  const text = typeof instruction === "string" ? instruction.trim() : "";
  const followup = person.kind === "followup";
  // A row nothing of this campaign was ever sent to: the message an occurrence made due, deferred by an earlier look.
  const owed = followup && reach?.owed === true;
  // ONE message a fact made due (now, or deferred): the right moment is judged, and no follow-up comes after it.
  const oneMessage = person.kind === "occurrence" || owed;
  const talked = history.hasHistory === true;
  const nowIso = new Date().toISOString();
  const whyNow = whyNowLines(occurrence, triggerType, person.email ?? null, nowIso);
  if (owed) whyNow.push("An earlier look judged it was not the right moment for the message this person is owed, and nothing was sent. This is the next look.");
  const contactPhone = (lead.contacts ?? []).find((c) => c?.channel === "phone" && present(c.value))?.value;
  const localTime = localTimeLines(nowIso, { timezone: lead.timezone, city: lead.city, country: lead.country, phone: person.phone ?? contactPhone });

  // The pieces of the writer's system prompt that depend on this run. The prompt itself is the pipe's WhatsApp
  // template (content-generation-service), never text held here (WA-BUBBLES-1023).
  const lines = (arr) => arr.filter((l) => typeof l === "string" && l !== "").join("\\n");
  const variables = {
    writerRole: persona
      ? "You are " + persona.name + (persona.role ? ", " + persona.role : "") + " at " + brandName + ". You write ONE WhatsApp message to one person, from " + brandName + "'s WhatsApp number, as yourself."
      : "You are " + (senderName ? senderName + ", " + senderRole + " of " + brandName : "the founder of " + brandName) + ". You write ONE WhatsApp message to one person, from the brand's own WhatsApp number, exactly as " + owner + " would type it himself.",
    ownerName: persona ? persona.name : owner,
    brandName,
    conversationStance: talked
      ? "They ALREADY talked with us. This is NOT a first contact: never introduce yourself, never say who you are or what " + brandName + " is, never thank them for signing up as if it were news. Pick the conversation back up from where it stopped, like a friend reopening a chat: answer anything they asked that was left unanswered, follow up on the last thing that was still alive, or bring a new angle that fits what they told us. Refer to what was actually said."
      : who.state === "known"
        ? "No message with them is on record, but the brand ALREADY KNOWS them (WHO THEY ARE TO US below). This is NOT a cold first contact: " + (persona ? "write to them as someone " + brandName + " knows" : "write as " + owner + " writing to someone he knows") + ", never an introduction."
        : who.state === "possibly_known"
          ? "No message with them is on record, and nobody confirmed yet whether " + (persona ? brandName : owner) + " knows them. Write so it reads right either way: a light word on who you are is fine, never a pitch to a stranger, never claim you never met."
          : "Nobody from " + brandName + " ever exchanged a message with them. This is a FIRST message: who you are fits in a few words of the first bubble (" + (persona ? persona.name : owner) + " from " + brandName + "), never what " + brandName + " does.",
    relationshipStrategy: who.strategy,
    automatedLinesRule: persona
      ? "Lines marked [automated WhatsApp] are earlier messages from this number, sent as you: stay consistent with them, never repeat them. Lines marked [automated cold email] or [AI Copilot] were sent by our software: the person saw them, so they are part of the history. If one was a clumsy cold introduction, do not repeat it, and do not make a big deal of it."
      : "Lines marked [automated ...] or [AI Copilot] were sent by our software, not typed by " + owner + ": the person saw them, so they are part of the history, but they are NEVER a model of how " + owner + " writes. If one was a clumsy cold introduction, do not repeat it, and do not make a big deal of it.",
    timingRules: lines([
      ...(followup && !owed ? [
        "THIS IS A FOLLOW-UP LOOK. Our campaign already wrote to them on WhatsApp (the [automated WhatsApp] lines in THE THREAD) and they have not answered since, on any channel. There is no fixed number of follow-ups and no fixed delay: we keep following up, each time at the moment you judge right, until they answer.",
        ${JSON.stringify(rightMomentStrategy(WHATSAPP_MEDIUM))},
        "If you write: do not repeat an earlier message and do not guilt them. Give them a different, lighter reason to answer, or a short tip, and make it easy to say no.",
        "Set decision to stop ONLY when their own words in THE THREAD asked us to stop or showed they are not a fit at all. Never stop on silence: silence is why we follow up.",
        ${JSON.stringify(localTimeStrategy(WHATSAPP_MEDIUM))},
        ${JSON.stringify(nextDateStrategy(WHATSAPP_MEDIUM))},
      ] : []),
      person.kind === "first" ? "Set decision to write: this message goes out now. " + ${JSON.stringify(nextDateStrategy(WHATSAPP_MEDIUM))} + " That date is the first follow-up look, in case they do not answer. Any day or time you put in the message is in their timezone (THEIR LOCAL TIME), never UTC." : "",
      ...(oneMessage ? [
        "A FACT MADE THIS MESSAGE DUE (WHY WE WRITE NOW), and it is still yours to judge WHEN it goes out.",
        ${JSON.stringify(rightMomentStrategy(WHATSAPP_MEDIUM))},
        ${JSON.stringify(localTimeStrategy(WHATSAPP_MEDIUM))},
        "If you write, this is the ONE message this fact gets (its bubbles together are that one message): there is no follow-up after it, so leave nextFollowUpAt and nextFollowUpWhy empty.",
        "If you choose later, nothing is sent, the message stays owed, and this person is looked at again at nextFollowUpAt. " + ${JSON.stringify(nextDateStrategy(WHATSAPP_MEDIUM))},
        "Set decision to stop ONLY when their own words in THE THREAD asked us to stop or showed they are not a fit at all.",
      ] : []),
    ]),
    whyNowRule: whyNow.length ? ${JSON.stringify(WHY_NOW_STRATEGY)} : "",
    // The whole voice block: the persona of the sending account, else how the owner writes (his own typed messages).
    VOICE_RULES_KEY: lines(persona
      ? [...personaLines(persona, brandName), "Write in the language they use with us in THE THREAD; with no thread, write in English."]
      : ["HOW " + owner.toUpperCase() + " WRITES: learn it from HIS OWN MESSAGES below (to this person first, then to other people), the ones he typed himself on his phone. Copy his tone, his greeting habits (or the lack of them), whether he signs. Write in the language he uses with THIS person in the thread; with no thread, write in English."]),
  };

  const last = history.lastMessage;
  const message = [
    "TODAY: " + String(currentDate ?? new Date().toISOString().slice(0, 10)),
    "NOW: " + new Date().toISOString(),
    "",
    "INSTRUCTION:",
    text || "(none: follow the strategy)",
    "",
    ...(whyNow.length ? ["WHY WE WRITE NOW:", ...whyNow, ""] : []),
    "THEIR LOCAL TIME:",
    ...localTime,
    "",
    "WHO WE WRITE TO:",
    ...(personLines.length ? personLines : ["(nothing beyond their contact)"]),
    "",
    "WHO THEY ARE TO US:",
    ...who.lines,
    "",
    "WHO WE ARE: " + brandName + ", offer \\"" + offerName + "\\".",
    "",
    "FACTS our client told us:",
    ...(exact.length ? exact.map((f) => f.id + ". " + f.label + ": " + f.value) : ["(none)"]),
    ...(neverGive.length ? ["", "NEVER offer or promise any of these, whole or in part:", ...neverGive.map((x) => "- " + x)] : []),
    "",
    persona
      ? "THE THREAD with this person (oldest first; OWNER = someone at " + brandName + " typing himself; [automated WhatsApp] = earlier messages from this number):"
      : "THE THREAD with this person (oldest first; OWNER = " + owner + " typing himself):",
    ...(history.olderMessagesOmitted > 0 ? ["(" + history.olderMessagesOmitted + " older messages not shown)"] : []),
    ...(history.threadLines.length ? history.threadLines : ["(no message ever exchanged)"]),
    ...(history.eventLines?.length ? ["", "RECENT EVENTS:", ...history.eventLines] : []),
    ...(last ? ["", "THE CONVERSATION STOPPED HERE: " + last.from + " wrote last, " + String(last.at ?? "date unknown").slice(0, 10) + ": " + last.text] : []),
    ...(persona
      ? (history.voiceLines.length ? ["", "THE MESSAGES TYPED BY PEOPLE OF " + brandName.toUpperCase() + " (their rhythm only, never their identity):", ...history.voiceLines.map((l) => "- " + l)] : [])
      : ["", "HIS OWN MESSAGES (how " + owner + " writes):", ...history.voiceLines.map((l) => "- " + l)]),
  ].join("\\n");

  return { variables, message };
}

${WHY_NOW_FN}

${LOCAL_TIME_FN}

${SENDER_PERSONA_FN}
`.trim().replace("VOICE_RULES_KEY", WHATSAPP_VOICE_RULES_VARIABLE);

/**
 * Holds the model to its contract before anything is sent. A follow-up look may decide `later` (nothing sent, the
 * next date checked) or `stop` (nothing sent), and so may an occurrence and its deferred look; a first message to a
 * newly served person must `write`. A `write` with an empty
 * message throws, any em/en dash is rewritten (between digits a hyphen, otherwise a comma), and the next date (first
 * message and follow-up) is held to `NEXT_DATE_FN` strictly BEFORE the send: a message whose next look cannot be
 * recorded is the dead end the loop exists to prevent. Builds the send's idempotency key (a first message per person;
 * a follow-up per queue row AND its due date, so each look of the same person is its own send and a retried look is
 * not; an occurrence's on the occurrence, `OCCURRENCE_SEND_KEY_FN`) and the whole send body (the occurrence's phone
 * only when it names one: crm-service refuses a null). Nothing drafted (reach-plan) = nothing to send.
 */
export const FINALIZE_MESSAGE_CODE = `
export async function main(draft, person, campaignId, reach, trigger) {
  if (reach?.skip === true) {
    return { skipped: true, skipSend: true, decision: null, code: reach.code ?? null, text: null, idempotencyKey: null, skipIfReplied: false, sendBody: null };
  }
  // content-generation's /generate-whatsapp answers the decision at top level (message = the bubbles, one empty line apart).
  const json = draft?.json ?? draft ?? {};
  const followup = person?.kind === "followup";
  // ONE message a fact made due, now (an occurrence) or deferred by an earlier look (a row this campaign never wrote).
  const oneMessage = person?.kind === "occurrence" || (followup && reach?.owed === true);
  // Every person but a newly served one may be judged not the right moment (TRIGGER-RIGHT-MOMENT-1016).
  const judged = followup || person?.kind === "occurrence";
  const personLabel = String(person?.email ?? person?.phone ?? "");
  if (judged && json.decision === "stop") {
    console.log("[cold-whatsapp-outreach] " + personLabel + ": their own words end it, nothing is sent: " + JSON.stringify(json.reason ?? null));
    return { skipSend: true, decision: "stop", reason: String(json.reason ?? ""), sendBody: null };
  }
  if (judged && json.decision === "later") {
    const later = nextDate(json, "finalize-message");
    console.log("[cold-whatsapp-outreach] " + personLabel + ": not the right moment, nothing is sent; next look at " + later.nextFollowUpAt + ": " + later.nextFollowUpWhy);
    return { skipSend: true, decision: "later", reason: String(json.reason ?? ""), ...later, sendBody: null };
  }
  if (json.decision !== "write") {
    throw new Error("finalize-message: decision " + JSON.stringify(json.decision) + " on a " + String(person?.kind) + " message; a first message to a new person is always written");
  }
  const undash = (s) => String(s ?? "")
    .replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-")
    .replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ")
    .trim();
  const text = undash(json.message);
  if (!text) throw new Error("finalize-message: the model returned an empty message");
  if (text !== String(json.message ?? "").trim()) {
    console.error("[cold-whatsapp-outreach] the draft used a dash the person must never read; rewritten before the send");
  }
  const who = person?.leadId ?? person?.email ?? person?.phone;
  if (!who) throw new Error("finalize-message: no person to key the send on");
  // The next look, checked BEFORE the send (the one message a fact made due has none).
  const next = oneMessage ? {} : nextDate(json, "finalize-message");
  let idempotencyKey;
  if (person.kind === "occurrence") {
    idempotencyKey = sendKey("cold-whatsapp-outreach", { id: person.rowId, email: person.email, phone: person.phone, dueAt: person.dueAt }, trigger);
  } else if (followup) {
    if (!person.rowId || !person.dueAt) throw new Error("finalize-message: a follow-up look carries no queue row or due date to key the send on");
    idempotencyKey = "cold-whatsapp-outreach:" + String(campaignId) + ":" + String(who) + ":followup:" + String(person.rowId) + ":" + String(person.dueAt);
  } else {
    idempotencyKey = "cold-whatsapp-outreach:" + String(campaignId) + ":" + String(who) + ":" + String(person.step);
  }
  // A follow-up is never sent to someone who wrote to us since (reach-plan read it; crm-service guards the race).
  const skipIfReplied = followup && reach?.skipIfReplied === true;
  const phone = typeof person.phone === "string" && person.phone.trim() !== "" ? person.phone.trim() : null;
  if (!phone && !person.email) throw new Error("finalize-message: the person carries neither an email nor a phone to send to");
  return {
    decision: "write",
    skipSend: false,
    text,
    idempotencyKey,
    skipIfReplied,
    ...next,
    // Never a null field (crm-service 400s it): a person known only by phone is sent to by phone.
    // Several bubbles = crm-service's \`messages\`, delivered in order and paced like a person typing (WA-BUBBLES-1023).
    sendBody: { ...(person.email ? { email: person.email } : {}), brandId: person.brandId, ...bubbleSendFields(text), idempotencyKey, skipIfReplied, ...(phone ? { phone } : {}) },
  };
}

SEND_KEY_FN

NEXT_DATE_FN_TEXT

BUBBLE_SEND_TEXT
`.trim().replace("SEND_KEY_FN", OCCURRENCE_SEND_KEY_FN).replace("NEXT_DATE_FN_TEXT", NEXT_DATE_FN).replace("BUBBLE_SEND_TEXT", BUBBLE_SEND_FN);

/**
 * crm-service refusals that are about the CHANNEL, not the person: the person is released to the brand's pipes that
 * can reach them (lead-service `POST /orgs/campaigns/{campaignId}/leads/channel-refusals`).
 */
export const CHANNEL_UNREACHABLE_CODES = ["no_phone_known", "not_on_whatsapp"] as const;

/**
 * What lead-service must record, read off the send. A refusal is legible here and in the log; anything else threw
 * before this node.
 */
export const RECORD_PLAN_CODE = `
// The LLM the writer actually used this run (the leg's pick).
let WRITER_MODEL = null;
export async function main(person, send, currentDate, reach, final, writer) {
  WRITER_MODEL = writer && typeof writer.model === "string" ? writer.model : null;
  const out = plan(person, send, currentDate, reach, final);
  // A look that decided to send nothing (later, stop) states no delivery: nothing was attempted.
  if (out.decided === true) {
    delete out.decided;
    return out;
  }
  // The occurrence's truth on /end-run (PUSHED-TRUTH-1015): refused + the refusal's code and sentence, verbatim.
  const refusedNow = send?.skipped === true;
  const reason = send?.notCalled === true ? reach?.reason : (send?.reason ?? send?.delivery?.reason);
  out.delivery = refusedNow
    ? { state: "refused", code: out.code, reason: typeof reason === "string" && reason.trim() !== "" ? reason : out.code }
    : { state: "delivered" };
  return out;
}

function plan(person, send, currentDate, reach, final) {
  // A later or a stop on a follow-up look, an occurrence, or a deferred occurrence: the queue row is the date's only
  // store, so a later keeps the person owed on THIS campaign's queue (never a new occurrence: that would reach every
  // campaign on the trigger).
  // A person a trigger made due who is not a new contact of the brand (WA-WELCOME-STRATEGY-1017): nothing was
  // drafted or sent, the row is stopped, and the run tells campaign-service the person was not admitted (final for
  // this occurrence, never redelivered). No delivery: nothing was attempted.
  // Admission not decided yet (ADMISSION-RECHECK-1023): nothing drafted or sent, never stopped, the row due again.
  if (reach?.recheck && (person?.kind === "occurrence" || person?.kind === "followup")) {
    if (typeof reach.recheck.dueAt !== "string" || !reach.recheck.dueAt) throw new Error("record-plan: an admission recheck carries no date");
    return { action: "record", outcome: "recheck", decided: true, code: String(reach.code), body: { kind: "scheduled", dueAt: reach.recheck.dueAt } };
  }
  if (reach?.notAdmitted && (person?.kind === "occurrence" || person?.kind === "followup")) {
    return {
      action: "record",
      outcome: "not_admitted",
      decided: true,
      code: String(reach.code),
      notAdmitted: reach.notAdmitted,
      body: { kind: "stopped", reason: "whatsapp_" + String(reach.code) },
    };
  }
  const judged = person?.kind === "followup" || person?.kind === "occurrence";
  if (judged && final?.decision === "later") {
    if (!final.nextFollowUpAt) throw new Error("record-plan: a later look carries no next date");
    return { action: "record", outcome: "later", decided: true, body: { kind: "scheduled", dueAt: final.nextFollowUpAt } };
  }
  if (judged && final?.decision === "stop") {
    return { action: "record", outcome: "stopped", decided: true, body: { kind: "stopped", reason: "${WHATSAPP_FOLLOW_UP_STOPPED_REASON}" } };
  }
  const nextAt = () => {
    if (typeof final?.nextFollowUpAt !== "string" || !final.nextFollowUpAt) throw new Error("record-plan: a sent message carries no next follow-up date");
    return final.nextFollowUpAt;
  };
  const refused = send?.skipped === true;
  // Not called: reach-plan found no phone before anything was drafted; recorded as crm-service's refusal would be.
  const code = !refused ? null : send.notCalled === true ? String(reach?.code ?? "not_sent") : String(send.code ?? "refused");
  if (refused) {
    console.error("[cold-whatsapp-outreach] " + String(person?.email) + " not written on WhatsApp: " + code +
      " (" + String(send.refusal ?? send.error ?? "") + "). Left to the email path.");
  }
  if (person?.kind === "first") {
    // A refusal about the CHANNEL (no phone, not on WhatsApp) says nothing about the person: release them to the
    // brand's pipes that can reach them (lead-service channel-refusals). Any other refusal ends the person here.
    if (refused && ${JSON.stringify(CHANNEL_UNREACHABLE_CODES)}.includes(code)) {
      return { action: "release", outcome: "unreachable", code, email: person.email };
    }
    if (refused) return { action: "none", outcome: "unreachable", code };
    // The first follow-up look, at the date the model chose.
    return { action: "schedule", outcome: "sent", dueAt: nextAt(), email: person.email };
  }
  if (person?.kind === "occurrence" || (person?.kind === "followup" && reach?.owed === true)) {
    // ONE message per occurrence (sent now, or deferred by an earlier look): sent = handed for good; refused =
    // stopped (a later occurrence may reach them).
    if (!refused) return { action: "record", outcome: "sent", body: { kind: "handed", reason: "${WHATSAPP_OCCURRENCE_SENT_REASON}" } };
    return { action: "record", outcome: "unreachable", code, body: { kind: "stopped", reason: "whatsapp_" + code } };
  }
  if (person?.kind === "followup") {
    // Sent: acted, due again at the model's date (the queue row is the date's only store).
    // BEST-TPL-LLM-1022: the act names the LLM that wrote it, so features-service can measure it per leg.
    if (!refused) return { action: "record", outcome: "sent", body: { kind: "acted", nextDueAt: nextAt(), llmAlias: WRITER_MODEL ?? ${JSON.stringify(COLD_WHATSAPP_LLM.model)} } };
    // The brand's WhatsApp cannot write (not linked, not connected, no account automation may write from): nothing
    // was sent, the person stays followed up, at the model's date, else (refused before any draft) a recheck later.
    if (${JSON.stringify(BRAND_SIDE_REFUSAL_CODES)}.includes(code)) {
      const dueAt = typeof final?.nextFollowUpAt === "string" && final.nextFollowUpAt
        ? final.nextFollowUpAt
        : new Date(Date.now() + ${BRAND_SIDE_RECHECK_DAYS} * 86400000).toISOString();
      return { action: "record", outcome: "deferred", code, body: { kind: "scheduled", dueAt } };
    }
    // About the person (they answered, no phone, not on WhatsApp): handed, their conversation is not ours to automate.
    return { action: "record", outcome: "unreachable", code, body: { kind: "handed", reason: "whatsapp_" + code } };
  }
  throw new Error("record-plan: no person was written to");
}
`.trim();

const GATHER_FACTS_SIGNATURE = "export async function main(plan, offerAnswers, offerFields, brandFields)";
if (!GATHER_FACTS_CODE.startsWith(GATHER_FACTS_SIGNATURE)) {
  throw new Error("cold-whatsapp-outreach: GATHER_FACTS_CODE changed its signature; re-wrap it");
}

/** `ai-meeting-booking`'s fact gathering, unchanged, with no question list. */
export const GATHER_CLIENT_FACTS_CODE =
  GATHER_FACTS_CODE.replace(GATHER_FACTS_SIGNATURE, "async function gatherFacts(plan, offerAnswers, offerFields, brandFields)") +
  "\n\nexport async function main(offerAnswers, offerFields, brandFields) {\n" +
  "  return gatherFacts(null, offerAnswers, offerFields, brandFields);\n}";

/**
 * crm-service refusals (422 `type: "refused"`) that mean "this person cannot be written to on WhatsApp now": they
 * end the person, not the run. `person_replied` only comes back on a follow-up look (`skipIfReplied`): they wrote on
 * any channel, so their thread is a person's. `send_in_progress` (409), `invalid_request` and `bridge_error` are
 * NOT here: they fail the run loud.
 */
export const WHATSAPP_REFUSAL_CODES = [
  "whatsapp_not_linked",
  "whatsapp_not_connected",
  "no_phone_known",
  "not_on_whatsapp",
  "person_replied",
  "automation_not_allowed",
  HUMAN_IN_CONVERSATION_CODE,
] as const;

const PERSON = "results['pick-person']";
const WRITTEN = "results['prior-contact']?.alreadyWritten";
const VOICE_SLOTS = Array.from({ length: VOICE_SAMPLE_PEOPLE }, (_, i) => i + 1);
const endRun = (id: string, body: Record<string, unknown>, inputMapping?: Record<string, string>) => ({
  id,
  type: "http.call" as const,
  config: { service: "campaign", method: "POST", path: "/end-run", body },
  ...(inputMapping ? { inputMapping } : {}),
});
const RECORDED_DELIVERY = { "body.delivery": "$ref:record-plan.output.delivery" };

/** The writer: the pipe's best WhatsApp template + LLM, written by content-generation in our voice (WA-BUBBLES-1023). */
export function buildColdWhatsappOutreachDag(): DAG {
  return withLegBestWhatsappTemplate(coldWhatsappOutreachDagUnvoiced(), "draft-message");
}

function coldWhatsappOutreachDagUnvoiced(): DAG {
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" },
      },
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      // What the run answers (a trigger occurrence, or nothing), and the trigger type's declaration.
      occurrencePlanNode(),
      triggerTypeNode(),
      // The one follow-up (or the person an occurrence made due) first: this campaign's own queue.
      {
        id: "claim-followup",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/campaigns/{campaignId}/followups/claim-next" },
        retries: 0,
        inputMapping: { "params.campaignId": "$ref:flow_input.campaignId" },
      },
      { id: "check-due", type: "condition" },
      {
        id: "lead-detail",
        type: "http.call",
        config: { service: "lead", method: "GET", path: "/orgs/leads/{id}" },
        inputMapping: {
          "params.id": "$ref:claim-followup.output.followup.id",
          "query.campaignId": "$ref:flow_input.campaignId",
        },
      },
      relationshipReadNode({
        leadRowId: "$ref:claim-followup.output.followup.id",
        brandId: "$ref:claim-followup.output.followup.brandId",
      }),
      // Nobody due: the next person.
      { id: "serve-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" }, retries: 0 },
      // Converges (edge from claim-followup, outside check-due's branches) so it is top level.
      {
        id: "pick-person",
        type: "script",
        config: { code: PICK_PERSON_CODE },
        retries: 0,
        inputMapping: {
          claim: "$ref:claim-followup.output",
          detail: "$ref:lead-detail.output",
          served: "$ref:serve-lead.output",
          occurrence: "$ref:occurrence.output",
          trigger: "$ref:flow_input.trigger",
        },
      },
      // What this campaign already sent them, read BEFORE anything is paid for (and reused as the writer's history).
      {
        id: "prior-sends",
        type: "http.call",
        config: { service: "crm", method: "GET", path: "/orgs/whatsapp/messages" },
        retries: 0,
        inputMapping: {
          // By email, or by phone for a person known only by phone.
          query: "$ref:pick-person.output.sendsQuery",
          skip: "$ref:pick-person.output.skipSends",
        },
      },
      {
        id: "prior-contact",
        type: "script",
        config: { code: PRIOR_CONTACT_CODE },
        retries: 0,
        inputMapping: {
          person: "$ref:pick-person.output",
          sends: "$ref:prior-sends.output",
          campaignId: "$ref:flow_input.campaignId",
        },
      },
      { id: "check-person", type: "condition" },
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
        inputMapping: { "params.id": "$ref:pick-person.output.brandId" },
      },
      // Who signs: the brand's stated rep, who answers on that WhatsApp number.
      {
        id: "sales-rep",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/sales-rep" },
        inputMapping: { "params.brandId": "$ref:pick-person.output.brandId" },
      },
      {
        id: "offer-answers",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/answers" },
        inputMapping: {
          "params.brandId": "$ref:pick-person.output.brandId",
          "params.offerId": "$ref:start-run.output.offerId",
        },
      },
      {
        id: "offer-user-fields",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/user-fields" },
        inputMapping: {
          "params.brandId": "$ref:pick-person.output.brandId",
          "params.offerId": "$ref:start-run.output.offerId",
        },
      },
      {
        id: "brand-user-fields",
        type: "http.call",
        // Refused (409 SEVERAL_OFFERS) for a brand selling several offers: gather-facts reads that one
        // refusal as "no brand-level fields" and re-throws every other failure.
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/user-fields", tolerateFailure: true },
        inputMapping: { "params.brandId": "$ref:pick-person.output.brandId" },
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
      // The history: the brand's recent personal-channel conversations (voice samples), then this person's whole
      // merged thread and what our software already sent them, read BEFORE anything is written.
      {
        id: "voice-people",
        type: "http.call",
        config: { service: "crm", method: "GET", path: "/orgs/people", query: { source: "matrix", limit: "30" } },
        inputMapping: { "query.brandId": "$ref:pick-person.output.brandId" },
      },
      {
        id: "history-plan",
        type: "script",
        config: { code: HISTORY_PLAN_CODE },
        retries: 0,
        inputMapping: { person: "$ref:pick-person.output", recent: "$ref:voice-people.output" },
      },
      // 404 person_not_found (nobody under that key in the people index) fails the person loud.
      {
        id: "person-thread",
        type: "http.call",
        config: { service: "crm", method: "GET", path: "/orgs/people/timeline" },
        inputMapping: { query: "$ref:history-plan.output.thread" },
      },
      ...VOICE_SLOTS.flatMap((n) => [
        {
          id: `voice-thread-${n}`,
          type: "http.call" as const,
          // One sample the reader cannot read is dropped; the person's own thread is never tolerated.
          config: { service: "crm", method: "GET", path: "/orgs/people/timeline", tolerateFailure: true },
          inputMapping: { query: `$ref:history-plan.output.samples.${n - 1}.timelineQuery` },
        },
        {
          id: `voice-sends-${n}`,
          type: "http.call" as const,
          config: { service: "crm", method: "GET", path: "/orgs/whatsapp/messages", tolerateFailure: true },
          inputMapping: { query: `$ref:history-plan.output.samples.${n - 1}.sendsQuery` },
        },
      ]),
      {
        id: "read-history",
        type: "script",
        config: { code: READ_HISTORY_CODE },
        retries: 0,
        inputMapping: {
          thread: "$ref:person-thread.output",
          sends: "$ref:prior-sends.output",
          ...Object.fromEntries(
            VOICE_SLOTS.flatMap((n) => [
              [`v${n}`, `$ref:voice-thread-${n}.output`],
              [`s${n}`, `$ref:voice-sends-${n}.output`],
            ]),
          ),
        },
      },
      // Who this person is to the brand (lead-service tags) beside their thread: the shared step of every writer.
      whoTheyAreNode({
        relationshipRead: "$ref:relationship-read.output",
        served: "$ref:serve-lead.output",
        timeline: "$ref:person-thread.output",
      }),
      // A message a trigger made due reaches only a new contact of the brand: a visit on record, no message from
      // them, not our staff, not the brand's own team (WA-WELCOME-STRATEGY-1017).
      {
        id: "admission-plan",
        type: "script",
        config: { code: ADMISSION_PLAN_CODE },
        retries: 0,
        inputMapping: {
          person: "$ref:pick-person.output",
          thread: "$ref:person-thread.output",
          sends: "$ref:prior-sends.output",
          campaignId: "$ref:flow_input.campaignId",
        },
      },
      {
        id: "team-membership",
        type: "http.call",
        config: { service: "crm", method: "POST", path: "/orgs/people/team-membership" },
        retries: 1,
        inputMapping: { body: "$ref:admission-plan.output.teamBody", skip: "$ref:admission-plan.output.skipTeam" },
      },
      // Can the message leave at all? Decided before the model writes (no phone known = nothing drafted).
      {
        id: "reach-plan",
        type: "script",
        config: { code: REACH_PLAN_CODE },
        retries: 0,
        inputMapping: {
          person: "$ref:pick-person.output",
          thread: "$ref:person-thread.output",
          sends: "$ref:prior-sends.output",
          campaignId: "$ref:flow_input.campaignId",
          admission: "$ref:admission-plan.output",
          team: "$ref:team-membership.output",
        },
      },
      // crm-service runs the send's own checks (phone, on WhatsApp, account connected) without sending: an
      // unreachable person costs no model call.
      {
        id: "reach-check",
        type: "http.call",
        config: { service: "crm", method: "POST", path: "/orgs/whatsapp/reach" },
        retries: 1,
        inputMapping: { body: "$ref:reach-plan.output.reachBody", skip: "$ref:reach-plan.output.skip" },
      },
      {
        id: "reach-verdict",
        type: "script",
        config: { code: REACH_VERDICT_CODE },
        retries: 0,
        inputMapping: { plan: "$ref:reach-plan.output", check: "$ref:reach-check.output" },
      },
      {
        id: "compose-message",
        type: "script",
        config: { code: COMPOSE_MESSAGE_PROMPT_CODE },
        retries: 0,
        inputMapping: {
          person: "$ref:pick-person.output",
          instruction: "$ref:start-run.output.instruction",
          offer: "$ref:offer-economics.output",
          brand: "$ref:brand-profile.output",
          rep: "$ref:sales-rep.output",
          facts: "$ref:gather-facts.output",
          history: "$ref:read-history.output",
          who: "$ref:who-they-are.output",
          currentDate: "$ref:flow_input.currentDate",
          occurrence: "$ref:occurrence.output",
          triggerType: "$ref:trigger-type.output",
          reach: "$ref:reach-verdict.output",
        },
      },
      // content-generation writes with the pipe's WhatsApp template (its head) and the leg's best LLM, both picked
      // per run by features-service (withLegBestWhatsappTemplate), our client-comms voice added there.
      {
        id: "draft-message",
        type: "http.call",
        config: {
          service: "content-generation",
          method: "POST",
          path: GENERATE_WHATSAPP_PATH,
          body: { featureSlug: COLD_WHATSAPP_OUTREACH_FEATURE_SLUG },
        },
        retries: 0,
        inputMapping: {
          "body.context": "$ref:compose-message.output.message",
          "body.variables": "$ref:compose-message.output.variables",
          "body.workflowSlug": "$ref:flow_input.workflowSlug",
          "body.campaignId": "$ref:flow_input.campaignId",
          skip: "$ref:reach-verdict.output.skip",
        },
      },
      {
        id: "finalize-message",
        type: "script",
        config: { code: FINALIZE_MESSAGE_CODE },
        retries: 0,
        inputMapping: {
          draft: "$ref:draft-message.output",
          person: "$ref:pick-person.output",
          campaignId: "$ref:flow_input.campaignId",
          reach: "$ref:reach-verdict.output",
          trigger: "$ref:flow_input.trigger",
        },
      },
      {
        id: "send-whatsapp",
        type: "http.call",
        config: { ...CRM_WHATSAPP_SEND, skipOnRefusalCodes: [...WHATSAPP_REFUSAL_CODES] },
        retries: 0,
        inputMapping: {
          body: "$ref:finalize-message.output.sendBody",
          skip: "$ref:finalize-message.output.skipSend",
        },
      },
      {
        id: "record-plan",
        type: "script",
        config: { code: RECORD_PLAN_CODE },
        retries: 0,
        inputMapping: {
          person: "$ref:pick-person.output",
          send: "$ref:send-whatsapp.output",
          currentDate: "$ref:flow_input.currentDate",
          reach: "$ref:reach-verdict.output",
          writer: "$ref:writer-plan.output",
          final: "$ref:finalize-message.output",
        },
      },
      // Converges (edge from pick-person, outside check-person's branch) so it is top level.
      { id: "check-record", type: "condition" },
      // A channel refusal on a first message: the person goes back to the brand's pipes that can reach them.
      {
        id: "release-person",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/campaigns/{campaignId}/leads/channel-refusals" },
        retries: 0,
        inputMapping: {
          "params.campaignId": "$ref:flow_input.campaignId",
          "body.email": "$ref:record-plan.output.email",
          "body.code": "$ref:record-plan.output.code",
        },
      },
      // A first message went out: the first follow-up look is due at the date the model chose.
      {
        id: "schedule-followup",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/campaigns/{campaignId}/followups/schedule-by-email" },
        retries: 0,
        inputMapping: {
          "params.campaignId": "$ref:flow_input.campaignId",
          "body.email": "$ref:record-plan.output.email",
          "body.dueAt": "$ref:record-plan.output.dueAt",
        },
      },
      // A follow-up look (sent, later, stop, or refused): what record-plan decided, the next date included.
      {
        id: "record-followup",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/leads/{id}/followups" },
        retries: 0,
        inputMapping: {
          "params.id": "$ref:pick-person.output.rowId",
          body: "$ref:record-plan.output.body",
        },
      },
      // The occurrence's truth (PUSHED-TRUTH-1015): every arm after the send states record-plan's delivery.
      endRun("end-run", { success: true, stopCampaign: false }, RECORDED_DELIVERY),
      // A person not admitted (WA-WELCOME-STRATEGY-1017) is stated as such: final for the occurrence, never redelivered.
      endRun("end-run-followup", { success: true, stopCampaign: false }, {
        ...RECORDED_DELIVERY,
        "body.personNotAdmitted": "$ref:record-plan.output.notAdmitted",
      }),
      endRun("end-run-unreachable", { success: true, stopCampaign: false }, RECORDED_DELIVERY),
      // Its own end-run, never a shared one with the `none` arm: a node fed by an arm AND by a node inside another
      // arm is a convergence point, emitted top level, run on EVERY run after the branch's own end-run
      // (LLM-SPEND-NO-SEND-1016: "normal run" after "idle" re-dispatched the campaign every ~14 seconds).
      endRun("end-run-released", { success: true, stopCampaign: false }, RECORDED_DELIVERY),
      // A re-served person this campaign already wrote to: nothing to do this run.
      endRun("end-run-already-written", { success: true, stopCampaign: false, noWorkAvailable: true }),
      endRun("end-run-no-lead", { success: true, stopCampaign: true }),
      // An occurrence run with nobody due on this campaign's queue: idle, never a served lead.
      endRun("end-run-nobody-due", { success: true, stopCampaign: false, noWorkAvailable: true }),
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "occurrence" },
      { from: "occurrence", to: "trigger-type" },
      { from: "trigger-type", to: "claim-followup" },
      { from: "claim-followup", to: "check-due" },
      { from: "check-due", to: "lead-detail", condition: "results['claim-followup']?.found == true" },
      {
        from: "check-due",
        to: "serve-lead",
        condition: "results['claim-followup']?.found != true && results['occurrence']?.serveNewLead == true",
      },
      { from: "lead-detail", to: "relationship-read" },
      { from: "relationship-read", to: "pick-person" },
      { from: "serve-lead", to: "pick-person" },
      { from: "claim-followup", to: "pick-person" },
      { from: "pick-person", to: "prior-sends" },
      { from: "prior-sends", to: "prior-contact" },
      { from: "prior-contact", to: "check-person" },
      { from: "check-person", to: "end-run-no-lead", condition: `${PERSON}?.kind == 'nobody'` },
      { from: "check-person", to: "end-run-nobody-due", condition: `${PERSON}?.kind == 'nobody_due'` },
      { from: "check-person", to: "end-run-already-written", condition: `${WRITTEN} == true` },
      {
        from: "check-person",
        to: "offer-economics",
        condition: `(${PERSON}?.kind == 'first' || ${PERSON}?.kind == 'followup' || ${PERSON}?.kind == 'occurrence') && ${WRITTEN} != true`,
      },
      { from: "offer-economics", to: "brand-profile" },
      { from: "brand-profile", to: "sales-rep" },
      { from: "sales-rep", to: "offer-answers" },
      { from: "offer-answers", to: "offer-user-fields" },
      { from: "offer-user-fields", to: "brand-user-fields" },
      { from: "brand-user-fields", to: "gather-facts" },
      { from: "gather-facts", to: "voice-people" },
      { from: "voice-people", to: "history-plan" },
      { from: "history-plan", to: "person-thread" },
      { from: "person-thread", to: "voice-thread-1" },
      ...VOICE_SLOTS.flatMap((n) => [
        { from: `voice-thread-${n}`, to: `voice-sends-${n}` },
        { from: `voice-sends-${n}`, to: n < VOICE_SAMPLE_PEOPLE ? `voice-thread-${n + 1}` : "read-history" },
      ]),
      { from: "read-history", to: "who-they-are" },
      { from: "who-they-are", to: "admission-plan" },
      { from: "admission-plan", to: "team-membership" },
      { from: "team-membership", to: "reach-plan" },
      { from: "reach-plan", to: "reach-check" },
      { from: "reach-check", to: "reach-verdict" },
      { from: "reach-verdict", to: "compose-message" },
      { from: "compose-message", to: "draft-message" },
      { from: "draft-message", to: "finalize-message" },
      { from: "finalize-message", to: "send-whatsapp" },
      { from: "send-whatsapp", to: "record-plan" },
      { from: "record-plan", to: "check-record" },
      { from: "pick-person", to: "check-record" },
      { from: "check-record", to: "schedule-followup", condition: "results['record-plan']?.action == 'schedule'" },
      { from: "check-record", to: "record-followup", condition: "results['record-plan']?.action == 'record'" },
      { from: "check-record", to: "end-run-unreachable", condition: "results['record-plan']?.action == 'none'" },
      { from: "check-record", to: "release-person", condition: "results['record-plan']?.action == 'release'" },
      { from: "release-person", to: "end-run-released" },
      { from: "schedule-followup", to: "end-run" },
      { from: "record-followup", to: "end-run-followup" },
    ],
    onError: "end-run-error",
  };
}
