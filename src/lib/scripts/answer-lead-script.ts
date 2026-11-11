/**
 * MIGRATE-1105 S1: ONE stored script answers a lead (owner 2026-11-05: « Tu peux pas merger en un followups qui fait
 * tout? »). Dr. Younce (Doc Dinners) answered « This Friday at 3:30 Central » and got TWO confirmations: one from the
 * Reply Booking campaign in his thread, one from the Lead event follow-up in a new thread from another mailbox. One
 * script, on the Lead event campaign, reads the whole thread and the lead's state, then decides ONE act: write now
 * (in their last thread, from the address they wrote to, or on WhatsApp when that is where they talk), later (the
 * lead's ONE next date), nothing (their own no), book the time they picked and confirm it, or hand an answer only the
 * team can give to the sales rep.
 *
 * This module only BUILDS the script's source (the code that is stored in the catalogue, `scripts` table), from the
 * owner's written strategies in this repo, word for word, so a rule the owner gave the old writers is never retyped.
 * The script reaches the world only through its vendors (run doors, `llm.complete`, `voice.read`, `booking.slots`).
 * Its one LLM call carries the brand's own MCP tools (BRAND-MCP-1109): stored as a new version of the dynasty.
 * Every improvement after this is an UPGRADE of the dynasty through the MCP, never a code change here.
 */
import { COMPETITOR_FIRST_STRATEGY, NEW_FACT_STRATEGY, TEAM_DECIDES_STRATEGY } from "../answering-strategies.js";
import { WHY_NOW_STRATEGY } from "../occurrence-fact.js";
import { PERSON_RELATIONSHIP_STRATEGY } from "../person-relationship.js";
import { SENDER_PERSONA_FN } from "../sender-persona.js";
import { EMAIL_MEDIUM, WHATSAPP_MEDIUM, localTimeStrategy, nextDateStrategy, rightMomentStrategy, MAX_NEXT_FOLLOW_UP_DAYS } from "../right-moment.js";

/**
 * The Unit this script makes: a message we sent one person (each follow-up one more; a booking is its own
 * `meeting_booked` Unit, declared by the door that books). Reached from a Lead event campaign's Target (Paid client)
 * through the Plan, never by moving the campaign's leg (owner's call).
 */
export const ANSWER_LEAD_OUTCOME = "message_sent";
export const ANSWER_LEAD_DYNASTY = "dy_answer_lead";

/**
 * The occurrences that ring the brand's sales rep before the answer (MIGRATE-1105 S1b): exactly the triggers the AI
 * Instant Call campaigns started on (a positive reply, a form fill), read off a Lead event's `sourceTriggerId`.
 */
export const ANSWER_LEAD_CALL_ON = ["positive_reply_received", "form_submitted"] as const;
/**
 * The Unit each of those occurrences IS on the ledger (the step a call consumes, as the old workflow declared it: a
 * positive reply = `conversation`, a form fill = `form_submitted`): handed to the call with the lead as its subject, so
 * the call's run consumes it (`consumesHanded`).
 */
export const ANSWER_LEAD_CALL_CONSUMES: Record<(typeof ANSWER_LEAD_CALL_ON)[number], string> = {
  positive_reply_received: "conversation",
  form_submitted: "form_submitted",
};
/** The Engine the call is asked of (its scripts: `scripts/engine-ports/ai-instant-call.ts`), literal in the source. */
export const ANSWER_LEAD_CALL_OUTCOME = "booking_call";

/** What the writer answers, strict (Anthropic needs every property required, no extra one). */
export const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "channel", "replyTo", "to", "cc", "bcc", "message", "subject", "bookSlot", "bookedMessage", "nextFollowUpAt", "nextFollowUpWhy", "question", "reason"],
  properties: {
    decision: { type: "string", enum: ["write", "later", "stop", "escalate"] },
    channel: { type: "string", enum: ["email", "whatsapp"], description: "When decision is write: one of THE CHANNELS OPEN. Otherwise the channel you would use." },
    replyTo: { type: "string", description: "Email only: the LABEL of the email you answer, exactly as THE THREAD shows it after \"email\" (for example M2): never its subject or an address. Empty = a new email thread (give it a subject)." },
    to: { type: "array", items: { type: "string" }, description: "Email only: the addresses it goes to. Empty = the person named in THE PERSON." },
    cc: { type: "array", items: { type: "string" }, description: "Email only: the addresses copied. Empty = our usual copy (our team)." },
    bcc: { type: "array", items: { type: "string" }, description: "Email only: the addresses copied without the others seeing it. Usually empty." },
    message: { type: "string", description: "The message to send when decision is write: plain text on WhatsApp (bubbles split by one empty line), simple HTML <p> paragraphs on email. Empty otherwise." },
    subject: { type: "string", description: "Email only, when there is no thread to answer in: a short plain subject. Empty otherwise." },
    bookSlot: { type: "string", description: "When their last message picks one of the OPEN TIMES below: that time copied exactly as listed. Empty otherwise." },
    bookedMessage: { type: "string", description: "When bookSlot is set: the short confirmation sent once the meeting is booked (same format as message). Empty otherwise." },
    nextFollowUpAt: { type: "string", description: "ISO 8601 UTC: when to look at this person again. Empty only when decision is stop." },
    nextFollowUpWhy: { type: "string" },
    question: { type: "string", description: "When decision is escalate: what they asked, in their words. Empty otherwise." },
    reason: { type: "string" },
  },
} as const;

/** The game, in the order the writer reads it: our voice is read live and put first by the script. */
export function answerLeadGame(): string[] {
  return [
    "You answer ONE person on behalf of the brand below. You are the only one who writes to them: no other campaign or person of ours writes to them about this, so whatever you decide is the one answer they get.",
    "THE GAME. Get them to the next step of their path with the least effort for them: answer what they asked first, from the FACTS only; when they want to talk, give them two concrete OPEN TIMES in their timezone, or the booking link when no time fits; when their last message picks a time, book it (bookSlot) and confirm it in one short line, nothing else; when the meeting is booked, the next message is the reminder before it. Never a pitch they did not ask for, never a menu of options, never a question that leaves them where they are.",
    "THE FACTS are what the brand stated. Never invent a figure, a price, a date, a promise or a status. A fact marked as not answered yet is unknown.",
    "WHERE IT GOES. You choose the channel, who it goes to and the thread, from THE THREAD, the way a person of the brand would. Answer whoever wrote to us and is waiting for us, where they wrote: every email in THE THREAD shows its label (M1, M2...), who wrote it and who was on it, and the one who wrote may be someone else than THE PERSON (a colleague who answered in their thread is waiting for our answer too). Copy the people a person would copy: the others already on that conversation who should read the answer. Bcc only someone who must see it without the others knowing. A new email thread only when no conversation fits what you write. Email: never re-introduce us, never restate the thread, no signature (ours is added). WhatsApp: short bubbles, one empty line between them, the way a person types.",
    TEAM_DECIDES_STRATEGY,
    COMPETITOR_FIRST_STRATEGY,
    NEW_FACT_STRATEGY,
    WHY_NOW_STRATEGY,
    PERSON_RELATIONSHIP_STRATEGY,
    "Write in the language of their own last message. Never use an em dash or an en dash.",
    "When they ask to stop, are not interested, or are not the right person, set decision to stop with their words in reason; nothing is sent.",
  ];
}

/** The medium-dependent lines (the right moment, the next date, their local time), word for word. */
export function mediumLines(): { email: string[]; whatsapp: string[] } {
  return {
    email: [rightMomentStrategy(EMAIL_MEDIUM), nextDateStrategy(EMAIL_MEDIUM), localTimeStrategy(EMAIL_MEDIUM)],
    whatsapp: [rightMomentStrategy(WHATSAPP_MEDIUM), nextDateStrategy(WHATSAPP_MEDIUM), localTimeStrategy(WHATSAPP_MEDIUM)],
  };
}

/**
 * The Lead event campaign's TARGET script (`paid_client`): it makes no paid client itself, it asks the Message sent
 * Engine for the one answer this occurrence is owed (S2's Provider: `ctx.ask` then `ctx.get`, run as a child, picked
 * by the same Rating) and records nothing (`recorded_by`: the payment is lead-service's fact). Its Request is the
 * run's own (the occurrence, the clock, the campaign), so the child reads exactly what this run was handed.
 */
export const ANSWER_LEAD_PULL = {
  outcome: "paid_client",
  dynasty: "dy_answer_lead_pull",
  tactics: { asks: [ANSWER_LEAD_OUTCOME], channel: "ai-follow-up-email", recorded_by: "lead" },
  description: "Gets the lead who just did something their one answer: asks the Message sent Engine for it and records nothing itself (the payment is the lead's own fact).",
  source: String.raw`
export default function run(ctx) {
  if (!ctx.request || !ctx.request.trigger) return { unmade: "no_occurrence" };
  ctx.ask({ units: {}, request: ctx.request, recordedBy: "sender" });
  const answer = ctx.get("message_sent");
  if (answer && typeof answer.unmade === "string") return { unmade: answer.unmade, ...(answer.decided === "done" || answer.decided === "idle" ? { decided: answer.decided } : {}) };
  return { content: { answered: answer.content } };
}
`,
} as const;

/** The stored script's source. Plain JavaScript (sync vendor calls); every constant is injected as JSON. */
export function answerLeadScriptSource(): string {
  const consts = {
    GAME: answerLeadGame(),
    MEDIUM: mediumLines(),
    SCHEMA: ANSWER_SCHEMA,
    MAX_DAYS: MAX_NEXT_FOLLOW_UP_DAYS,
    CALL_CONSUMES: ANSWER_LEAD_CALL_CONSUMES,
  };
  // Who speaks on WhatsApp = the persona of the line that sends (SOPHIE-WA-1016), the owner's own text, word for word.
  return `${SCRIPT_BODY}\n${SENDER_PERSONA_FN}\nconst K = ${JSON.stringify(consts)};\n`;
}

const SCRIPT_BODY = String.raw`
// Answers ONE lead per run (MIGRATE-1105 S1). Reads: the claim, the lead's state, the thread, the brand's facts,
// the open times. Decides once (one model call). Acts once: a reply, a booking + its confirmation, a hand-over, or
// nothing; always leaves the lead's ONE next date. The clock is ctx.request.now (the run's start), never Date.now().
function door(name, args) {
  return ctx_.vendor.call(name, args);
}
function must(name, args) {
  const a = door(name, args);
  if (!a.ok) throw new Error(name + " failed: " + String(a.data && a.data.error));
  return a.data;
}
function s(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
function addr(v) {
  const t = typeof v === "string" ? v : v && typeof v === "object" ? String(v.email || v.address || "") : "";
  const m = t.match(/<([^<>]+)>/);
  const a = (m ? m[1] : t).trim().toLowerCase();
  return /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(a) ? a : null;
}
function addrs(v) {
  const l = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return l.map(addr).filter(Boolean);
}
function uniq(l) {
  return l.filter(function (x, i) { return l.indexOf(x) === i; });
}
function undash(t) {
  return String(t || "").replace(/(\d)\s*[–—]\s*(?=\d)/g, "$1-").replace(/\s*[–—]\s*/g, ", ").trim();
}
let ctx_ = null;

export default function run(ctx) {
  ctx_ = ctx;
  const req = ctx.request || {};
  const trigger = req.trigger && typeof req.trigger === "object" ? req.trigger : null;
  if (!trigger) return { unmade: "no_occurrence" };
  const now = s(req.now);
  if (!now) throw new Error("the run states no clock (request.now)");
  const brandId = s(req.brandId) || (Array.isArray(req.brandIds) ? s(req.brandIds[0]) : null);
  const campaignId = s(req.campaignId);
  const offerId = s(req.offerId);
  // The WhatsApp line the campaign states it writes from (CAMPAIGN-WA-LINE-1028); none = crm-service picks.
  const line = s(req.whatsappSenderPhone);
  if (!brandId || !campaignId) throw new Error("the run names no brand or campaign");
  const p = trigger.person || {};
  const named = { email: s(p.email) ? s(p.email).toLowerCase() : null, phone: s(p.phone), leadId: s(trigger.leadId) };
  const relationships = s(ctx.tactics.relationships) || "pure_prospect";

  // 1. WHO: the person the occurrence names, claimed on this campaign (lead-service judges who may be answered).
  const claim = must("lead.followup.claim", { params: { campaignId: campaignId }, body: { person: named, relationships: relationships } });
  if (!claim.found) {
    const refused = ((claim.relationships && claim.relationships.refused) || [])[0];
    // Nobody owed on this campaign (or their relationship is not judged yet) is this script's reading, never a refusal:
    // nothing to do now (MON-UNSENT-RED-1111).
    if (refused) return { unmade: "person_not_admitted: " + String(refused.reason || refused.code || "refused") };
    return { unmade: "nobody_due: " + String(claim.reason || ""), decided: "idle" };
  }
  const row = claim.followup;

  // 1b. THE REP CALL (ported from the AI Instant Call workflow, MIGRATE-1105 S1b): a positive reply or a form fill rings
  // the brand's sales rep the moment it lands, as the Reply Callback / Form Callback campaigns did, before any answer.
  // The call is the Booking call Engine's Unit, asked as a child run (picked by the Rating among the scripts this
  // campaign's strategy keeps; none = "no_script", no call). The person's row stays this run's: handed as claimed, the
  // call script claims and stops nothing. Whatever it answers, this run goes on to answer the person.
  const occurrence = K.CALL_CONSUMES[String(trigger.sourceTriggerId || trigger.triggerId || "")];
  if (occurrence) {
    const leadId = s(row.leadId) || named.leadId;
    const handed = {};
    handed[occurrence] = { content: trigger, ...(leadId ? { subject: { service: "lead-service", id: leadId } } : {}) };
    ctx.ask({ units: handed, request: Object.assign({}, req, { claimed: claim }) });
    ctx.get("booking_call");
  }
  const email = s(row.email) ? s(row.email).toLowerCase() : named.email;
  const phone = s(row.phone) || named.phone;
  const sendKey = s(trigger.eventId) ? "answer-lead:event:" + trigger.eventId : "answer-lead:" + row.id + ":" + String(row.dueAt);
  const close = (reason) => must("lead.followup.record", { params: { id: row.id }, body: { kind: "stopped", reason: reason } });
  const setDate = (body) => must("lead.followup_date.set", { params: { id: row.id }, query: { brandId: brandId }, body: body });

  // 2. STATE: only their own stops end it; a lead event is answered whatever engaged them.
  const state = must("lead.followup_date.read", { params: { id: row.id }, query: { brandId: brandId } });
  const owed = state.owed || {};
  const stops = (Array.isArray(owed.reasons) ? owed.reasons : []).filter(function (r) {
    return ["positive_reply", "meeting_booked", "meeting_attended", "in_conversation", "sequence_running", "relationship_not_judged", "same_person_question_open", "identity_unresolved"].indexOf(r) < 0;
  });
  if (owed.kind === "stop" && (stops.length > 0 || !Array.isArray(owed.reasons) || owed.reasons.length === 0)) {
    close("follow_up_stopped");
    return { unmade: "stopped: " + String(owed.reason || stops[0] || "stop"), decided: "done" };
  }

  // 3. READ everything the writer needs.
  const lead = (must("lead.detail", { params: { id: row.id }, query: { campaignId: campaignId } }).leadDetail || {}).lead || {};
  const personKey = email ? "email:" + email : "phone:+" + String(phone || "").replace(/\D/g, "");
  // A person crm-service holds no thread for (404) has none yet; any other failure stops the run (never written blind).
  const threadRead = door("crm.person.thread", { query: { brandId: brandId, personKey: personKey }, pollWhile: { field: "factFeed.settled", equals: false, intervalSeconds: 10, timeoutSeconds: 180, throwWhenTimedOut: true } });
  if (!threadRead.ok && threadRead.data.status !== 404) throw new Error("crm.person.thread failed: " + String(threadRead.data.error));
  const items = threadRead.ok && Array.isArray(threadRead.data.items) ? threadRead.data.items : [];
  const conversation = email ? door("instantly.conversation", { query: { email: email } }) : { ok: false, data: {} };
  const convo = conversation.ok && conversation.data.conversation && typeof conversation.data.conversation === "object" ? conversation.data.conversation : {};
  const threads = Array.isArray(convo.threads) ? convo.threads : [];
  const brand = (must("brand.profile", { params: { id: brandId } }).brand) || {};
  const economics = offerId ? must("brand.offer.economics", { params: { offerId: offerId } }) : {};
  const answers = offerId ? must("brand.offer.answers", { params: { brandId: brandId, offerId: offerId } }) : {};
  const fields = offerId ? must("brand.offer.fields", { params: { brandId: brandId, offerId: offerId } }) : must("brand.fields", { params: { brandId: brandId } });
  const voice = must("voice.read", {});
  const bookingUrl = s(economics.bookingUrl);
  const booking = bookingUrl ? must("booking.slots", { bookingUrl: bookingUrl, timezone: s(lead.timezone) || "UTC" }) : { slots: [] };
  const slots = Array.isArray(booking.slots) ? booking.slots : [];

  // 3b. THE THREAD = the person's Unibox (every channel) + every email of their conversations, each with who wrote it,
  // who was on it and its Message-ID (EVERY-PERSON-ON-THE-THREAD-1109): a colleague who answered in their thread is
  // in it as himself. An email held by both reads is shown once (the one carrying the Message-ID and everyone on it).
  const mails = (Array.isArray(convo.messages) ? convo.messages : []).map(function (m) {
    const parts = Array.isArray(m.participants) ? m.participants : [];
    const role = function (r) { return parts.filter(function (x) { return x && x.role === r; }).map(function (x) { return addr(x.email); }).filter(Boolean); };
    return { at: String(m.at || ""), kind: "message", direction: m.direction, channel: "email", source: "email", subject: m.subject, text: m.text, messageId: s(m.messageId),
      from: parts.length > 0 ? role("from") : addrs(m.from), to: parts.length > 0 ? role("to") : addrs(m.to), cc: role("cc"), bcc: role("bcc") };
  });
  const mailKeys = {};
  mails.forEach(function (m) { if (m.messageId) mailKeys["id:" + m.messageId] = true; mailKeys["t:" + m.direction + ":" + m.at.slice(0, 16)] = true; });
  const unibox = items.filter(function (m) {
    if (m.channel !== "email" || m.kind !== "message") return true;
    const id = s(m.ref && m.ref.messageId) || s(m.messageId);
    return !(id && mailKeys["id:" + id]) && !mailKeys["t:" + m.direction + ":" + String(m.at || "").slice(0, 16)];
  }).map(function (m) {
    if (m.channel !== "email" || m.kind !== "message") return m;
    return Object.assign({}, m, { messageId: s(m.ref && m.ref.messageId) || s(m.messageId), from: addrs(m.from), to: addrs(m.to), cc: addrs(m.cc), bcc: [] });
  });
  const merged = unibox.concat(mails).sort(function (a, b) { return String(a.at || "").localeCompare(String(b.at || "")); });
  // Every email we can answer in its thread gets a label the writer names (replyTo).
  const labels = {};
  let n = 0;
  merged.forEach(function (m) { if (m.channel === "email" && m.kind === "message" && m.messageId) { n++; m.label = "M" + n; labels[m.label] = m; } });

  // 4. WHERE: the channels open to this person; the writer picks one, and on email who it goes to and in which thread.
  const inbound = merged.filter(function (m) { return m.kind === "message" && m.direction === "inbound"; });
  const last = inbound.length > 0 ? inbound[inbound.length - 1] : null;
  const open = [];
  if (email || n > 0) open.push("email");
  let reach = null;
  if (phone || (last && last.channel === "whatsapp")) {
    const r = door("crm.whatsapp.reach", { body: { brandId: brandId, ...(email ? { email: email } : {}), ...(phone ? { phone: phone } : {}), ...(line ? { fromAccount: line } : {}) } });
    if (r.ok && r.data.reachable === true) {
      reach = r.data;
      open.push("whatsapp");
    }
  }
  const replied = threads.filter(function (t) { return t.replied === true && s(t.campaignId); }).sort(function (a, b) { return String(b.lastInboundAt || "").localeCompare(String(a.lastInboundAt || "")); })[0] || null;
  if (open.length === 0) {
    setDate({ nextFollowupAt: new Date(Date.parse(now) + 30 * 86400000).toISOString(), reason: "No way to write to them yet" });
    close("follow_up_no_channel");
    return { unmade: "no_channel" };
  }

  // 5. DECIDE once.
  const factLines = [];
  const f = fields.fields || {};
  Object.keys(f).forEach(function (k) {
    const v = f[k];
    if (v && v.provenance === "confirmed" && v.value !== null && v.value !== undefined) factLines.push("- " + k + ": " + (typeof v.value === "string" ? v.value : JSON.stringify(v.value)));
  });
  (Array.isArray(answers.answers) ? answers.answers : []).forEach(function (a) {
    const text = String(a.answer || "");
    factLines.push("- " + a.question + " " + (/^\s*PLACEHOLDER/.test(text) ? "(not answered by our client yet)" : text));
  });
  const threadLines = merged.slice(-40).map(function (m) {
    const who = m.kind !== "message" ? "EVENT" : m.direction === "outbound" ? "US" : "THEM";
    const text = String(m.text || (m.event && m.event.text) || m.subject || "").slice(0, 2000);
    const head = m.label
      ? " label " + m.label + ", from " + (m.from.join(", ") || "?") + " to " + (m.to.join(", ") || "?") + (m.cc.length > 0 ? " cc " + m.cc.join(", ") : "") + (m.bcc.length > 0 ? " bcc " + m.bcc.join(", ") : "") + (s(m.subject) ? ", subject: " + m.subject : "")
      : "";
    return "[" + String(m.at) + "] " + who + " (" + String(m.channel || m.source || "") + ")" + head + ": " + text;
  });
  // On WhatsApp the writer IS the sending line's persona (crm-service states it on the reach answer); none = as before.
  const persona = reach ? senderPersona(reach) : null;
  const both = open.length > 1;
  const mediumLines = [].concat.apply([], open.map(function (c) { return (both ? ["ON " + c.toUpperCase() + ":"] : []).concat(K.MEDIUM[c]); }));
  const personaBlock = persona ? (both ? ["WHEN YOU WRITE ON WHATSAPP:"] : []).concat(personaLines(persona, String(brand.name || ""))) : [];
  const system = [voice.content].concat(personaBlock, K.GAME, mediumLines, [s(req.brief) ? "THE CAMPAIGN'S BRIEF (from the client):\n" + req.brief : ""]).filter(Boolean).join("\n\n");
  const message = [
    "NOW: " + now + " (UTC).",
    "THEIR TIMEZONE: " + (s(lead.timezone) || "not stated") + ". Clues: " + [lead.city, lead.state, lead.country, phone].filter(Boolean).join(", "),
    "THE PERSON: " + [lead.firstName, lead.lastName].filter(Boolean).join(" ") + (s(lead.headline) ? ", " + lead.headline : "") + (email ? ", " + email : ""),
    "THE BRAND: " + String(brand.name || "") + (s(economics.name) ? ". What we sell: " + economics.name : ""),
    "THE FACTS:\n" + (factLines.join("\n") || "(none stated)"),
    "BOOKING LINK: " + (bookingUrl || "none"),
    "OPEN TIMES (" + String(booking.timezone || "UTC") + "):\n" + (slots.length > 0 ? slots.join("\n") : "(none read)"),
    "WHAT JUST HAPPENED: " + JSON.stringify(trigger.item || {}).slice(0, 1500),
    "THE CHANNELS OPEN: " + open.join(", ") + (last ? " (their last message came on " + String(last.channel || last.source || "") + ")" : "") + (open.indexOf("email") >= 0 && n === 0 ? ". Email: " + (replied ? "a reply in the thread they answered" : "a follow-up in their last email thread") : ""),
    "THE THREAD (oldest first):\n" + (threadLines.join("\n") || "(empty)"),
  ].join("\n\n");
  // The writer's LLM is features-service's pick for this campaign (lowest cost per outcome, within its strategy):
  // never one the script states, never a default (BEST-TPL-LLM-1022, NO-WRITER-FALLBACK-1030).
  const writer = must("features.writer_pick", { query: { campaignId: campaignId } });
  const llm = writer.llm || {};
  if (!s(llm.provider) || !s(llm.model)) throw new Error("no writer LLM picked for this campaign: " + String(writer.llmUnavailableReason || "none"));
  // The brand's own tools on every call (BRAND-MCP-1109): the writer looks up what this person already has with the
  // brand, and acts when the brand's team asks, before it decides. No server plugged = today's one-shot call.
  // The schema names this run's own choices: the channels open to them and the labels of the emails they can be
  // answered in (empty = a new thread), so the writer picks among what exists.
  const schema = JSON.parse(JSON.stringify(K.SCHEMA));
  schema.properties.channel.enum = open.slice();
  schema.properties.replyTo.enum = Object.keys(labels).concat([""]);
  const draft = must("llm.complete", { provider: llm.provider, model: llm.model, systemPrompt: system, message: message, responseFormat: "json", responseSchema: schema, brandTools: { brandId: brandId } });
  const d = draft.json || {};
  // What the writer looked up or did through the brand's tools, on the run's output (each call is an event on the
  // completion's run); absent when the brand plugged no server, so those outputs are unchanged.
  const tools = typeof draft.brandToolCalls === "number" ? { brandToolCalls: draft.brandToolCalls } : {};
  const toolsNote = typeof draft.brandToolCalls === "number" ? " (brand tool calls: " + draft.brandToolCalls + ")" : "";
  const nextAt = s(d.nextFollowUpAt);
  const nextOk = nextAt && Date.parse(nextAt) > Date.parse(now) && Date.parse(nextAt) <= Date.parse(now) + K.MAX_DAYS * 86400000;

  if (d.decision === "stop") {
    setDate({ stop: { reason: String(d.reason || "their own words").slice(0, 500) } });
    close("follow_up_stopped");
    return { unmade: "stop: " + String(d.reason || "their own words") + toolsNote, decided: "done" };
  }
  if (!nextOk) throw new Error("the writer gave no usable next date: " + JSON.stringify(nextAt));
  if (d.decision === "later") {
    setDate({ nextFollowupAt: nextAt, reason: String(d.nextFollowUpWhy || "later").slice(0, 500) });
    close("follow_up_later");
    return { unmade: "later: " + String(d.nextFollowUpWhy || "") + toolsNote, decided: "done" };
  }
  if (d.decision === "escalate") {
    const rep = s(brand.salesRepPhone);
    if (rep) door("crm.whatsapp.send", { body: { brandId: brandId, phone: rep, text: "A lead needs your answer: " + [lead.firstName, lead.lastName].filter(Boolean).join(" ") + " (" + (email || phone) + ") asked: " + String(d.question || "") + ". Nothing was sent to them.", idempotencyKey: sendKey + ":rep-alert" }, omitHeaders: ["x-campaign-id"] });
    setDate({ nextFollowupAt: nextAt, reason: "Escalated to the team: " + String(d.question || "").slice(0, 400) });
    close("follow_up_escalated");
    return { unmade: "escalate: " + String(d.question || "") + (rep ? " (sales rep alerted)" : " (no sales rep phone)") + toolsNote, decided: "done" };
  }
  if (d.decision !== "write") throw new Error("the writer answered an unknown decision " + JSON.stringify(d.decision));
  const medium = s(d.channel);
  if (!medium || open.indexOf(medium) < 0) throw new Error("the writer chose a channel that is not open: " + JSON.stringify(d.channel) + " (open: " + open.join(", ") + ")");
  // Who it goes to, as the writer chose (email). Addresses are cleaned (trimmed, lowercased, deduped), never added.
  const to = uniq(addrs(d.to));
  const cc = uniq(addrs(d.cc)).filter(function (a) { return to.indexOf(a) < 0; });
  const bcc = uniq(addrs(d.bcc)).filter(function (a) { return to.indexOf(a) < 0 && cc.indexOf(a) < 0; });
  const chosen = { ...(to.length > 0 ? { to: to } : {}), ...(cc.length > 0 ? { cc: cc } : {}), ...(bcc.length > 0 ? { bcc: bcc } : {}) };
  const label = medium === "email" ? s(d.replyTo) : null;
  const target = label ? labels[label] : null;
  if (label && !target) throw new Error("the writer answers an email that is not in the thread: " + JSON.stringify(label));
  const recipient = email || to[0] || null;

  // 6. ACT once: book first when they picked an open time, then the one message.
  let text = undash(d.message);
  let booked = null;
  const pick = s(d.bookSlot);
  if (pick && slots.indexOf(pick) >= 0 && s(d.bookedMessage) && email) {
    const b = door("crm.meeting.book", { body: { brandId: brandId, idempotencyKey: sendKey + ":book", ...(bookingUrl ? { bookingPageUrl: bookingUrl } : {}), ...(s(booking.calendarId) ? { calendarId: booking.calendarId } : {}), startTime: pick, person: { email: email, ...(s(lead.firstName) ? { firstName: lead.firstName } : {}), ...(s(lead.lastName) ? { lastName: lead.lastName } : {}), ...(phone ? { phone: phone } : {}) } } });
    if (b.ok && b.data.status === "booked") {
      booked = pick;
      text = undash(d.bookedMessage);
    } else if (!b.ok && b.data.status !== 422) throw new Error("crm.meeting.book did not settle: " + String(b.data.error));
  }
  if (!text) throw new Error("the writer chose write with an empty message");
  let sent;
  if (medium === "whatsapp") {
    const bubbles = text.split(/\n\s*\n/).map(function (t) { return t.trim(); }).filter(Boolean);
    sent = door("crm.whatsapp.send", { body: { brandId: brandId, ...(email ? { email: email } : {}), ...(phone ? { phone: phone } : {}), ...(bubbles.length > 1 ? { messages: bubbles } : { text: text }), ...(line ? { fromAccount: line } : {}), idempotencyKey: sendKey } });
  } else if (!recipient) {
    throw new Error("the writer chose email with no address to write to");
  } else if (target) {
    // In the thread of the email they answer, whoever wrote it: the mailbox holding it sends (instantly-service).
    sent = door("instantly.reply.send", { body: { email: recipient, body_html: text, sent_by: "automation", in_reply_to: target.messageId, ...chosen } });
  } else if (n > 0 && threads.length > 0 && s(threads[0].campaignId)) {
    // A new thread, from the mailbox of their conversation.
    sent = door("instantly.reply.send", { body: { campaign_id: threads[0].campaignId, email: recipient, body_html: text, sent_by: "automation", new_thread_subject: undash(d.subject) || String(brand.name || ""), ...chosen } });
  } else if (n === 0 && replied) {
    sent = door("instantly.reply.send", { body: { campaign_id: replied.campaignId, email: recipient, body_html: text, sent_by: "automation" } });
  } else {
    sent = door("email.send", { body: { type: "broadcast", tag: "follow-up", followUp: true, to: recipient, subject: undash(d.subject) || String(brand.name || ""), sequence: [{ step: 1, bodyHtml: text, daysSinceLastStep: 0 }], idempotencyKey: sendKey, leadId: s(lead.leadId) || named.leadId, campaignId: campaignId } });
  }
  if (!sent.ok) {
    // A named refusal about the person is an outcome (nothing sent, the date kept); anything else fails the run.
    if (s(sent.data.code) && sent.data.status >= 400 && sent.data.status < 500) {
      setDate({ nextFollowupAt: nextAt, reason: "Not sent: " + sent.data.code });
      close("follow_up_refused");
      return { unmade: "refused: " + sent.data.code + toolsNote };
    }
    throw new Error("the send failed: " + String(sent.data.error));
  }
  setDate({ nextFollowupAt: nextAt, reason: String(d.nextFollowUpWhy || "next look").slice(0, 500), sent: { channel: medium } });
  close(booked ? "booking_confirmed" : "follow_up_sent");
  const addressed = medium === "email" && (to.length > 0 || cc.length > 0 || bcc.length > 0) ? { recipients: { to: to, cc: cc, bcc: bcc } } : {};
  return { content: { decision: "write", channel: medium, booked: booked, inThread: medium === "email" ? (n > 0 ? Boolean(target) : Boolean(replied)) : null, ...(target ? { replyTo: target.messageId } : {}), ...addressed, ...tools } };
}
`;
