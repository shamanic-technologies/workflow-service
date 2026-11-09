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
import { COMPETITOR_FIRST_STRATEGY, NEW_FACT_STRATEGY, TEAM_DECIDES_STRATEGY } from "../follow-up-dag.js";
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
  required: ["decision", "message", "subject", "bookSlot", "bookedMessage", "nextFollowUpAt", "nextFollowUpWhy", "question", "reason"],
  properties: {
    decision: { type: "string", enum: ["write", "later", "stop", "escalate"] },
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
    "WHERE IT GOES. Email: a reply in the thread they last wrote in, from the address they wrote to: never re-introduce us, never restate the thread, no signature (ours is added). WhatsApp: short bubbles, one empty line between them, the way a person types.",
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
  if (answer && typeof answer.unmade === "string") return { unmade: answer.unmade };
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
    return { unmade: refused ? "person_not_admitted: " + String(refused.reason || refused.code || "refused") : "nobody_due: " + String(claim.reason || "") };
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
    return { unmade: "stopped: " + String(owed.reason || stops[0] || "stop") };
  }

  // 3. READ everything the writer needs.
  const lead = (must("lead.detail", { params: { id: row.id }, query: { campaignId: campaignId } }).leadDetail || {}).lead || {};
  const personKey = email ? "email:" + email : "phone:+" + String(phone || "").replace(/\D/g, "");
  // A person crm-service holds no thread for (404) has none yet; any other failure stops the run (never written blind).
  const threadRead = door("crm.person.thread", { query: { brandId: brandId, personKey: personKey }, pollWhile: { field: "factFeed.settled", equals: false, intervalSeconds: 10, timeoutSeconds: 180, throwWhenTimedOut: true } });
  if (!threadRead.ok && threadRead.data.status !== 404) throw new Error("crm.person.thread failed: " + String(threadRead.data.error));
  const items = threadRead.ok && Array.isArray(threadRead.data.items) ? threadRead.data.items : [];
  const conversation = email ? door("instantly.conversation", { query: { email: email } }) : { ok: false, data: {} };
  const threads = conversation.ok && conversation.data.conversation && Array.isArray(conversation.data.conversation.threads) ? conversation.data.conversation.threads : [];
  const brand = (must("brand.profile", { params: { id: brandId } }).brand) || {};
  const economics = offerId ? must("brand.offer.economics", { params: { offerId: offerId } }) : {};
  const answers = offerId ? must("brand.offer.answers", { params: { brandId: brandId, offerId: offerId } }) : {};
  const fields = offerId ? must("brand.offer.fields", { params: { brandId: brandId, offerId: offerId } }) : must("brand.fields", { params: { brandId: brandId } });
  const voice = must("voice.read", {});
  const bookingUrl = s(economics.bookingUrl);
  const booking = bookingUrl ? must("booking.slots", { bookingUrl: bookingUrl, timezone: s(lead.timezone) || "UTC" }) : { slots: [] };
  const slots = Array.isArray(booking.slots) ? booking.slots : [];

  // 4. WHERE: the channel of their last message of their own; email answers in the thread they replied in.
  const inbound = items.filter(function (m) { return m.kind === "message" && m.direction === "inbound"; });
  const last = inbound.length > 0 ? inbound[inbound.length - 1] : null;
  let medium = last && last.channel === "whatsapp" ? "whatsapp" : "email";
  let reach = null;
  if (medium === "whatsapp") {
    const r = door("crm.whatsapp.reach", { body: { brandId: brandId, ...(email ? { email: email } : {}), ...(phone ? { phone: phone } : {}), ...(line ? { fromAccount: line } : {}) } });
    if (r.ok && r.data.reachable === true) reach = r.data;
    else medium = email ? "email" : "none";
  }
  const replied = threads.filter(function (t) { return t.replied === true && s(t.campaignId); }).sort(function (a, b) { return String(b.lastInboundAt || "").localeCompare(String(a.lastInboundAt || "")); })[0] || null;
  if (medium === "email" && !email) medium = "none";
  if (medium === "none") {
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
  const threadLines = items.slice(-40).map(function (m) {
    const who = m.direction === "inbound" ? "THEM" : m.direction === "outbound" ? "US" : "EVENT";
    const text = String(m.text || (m.event && m.event.text) || m.subject || "").slice(0, 2000);
    return "[" + String(m.at) + "] " + who + " (" + String(m.channel || m.source || "") + "): " + text;
  });
  // On WhatsApp the writer IS the sending line's persona (crm-service states it on the reach answer); none = as before.
  const persona = medium === "whatsapp" ? senderPersona(reach) : null;
  const system = [voice.content].concat(persona ? personaLines(persona, String(brand.name || "")) : [], K.GAME, K.MEDIUM[medium], [s(req.brief) ? "THE CAMPAIGN'S BRIEF (from the client):\n" + req.brief : ""]).filter(Boolean).join("\n\n");
  const message = [
    "NOW: " + now + " (UTC).",
    "THEIR TIMEZONE: " + (s(lead.timezone) || "not stated") + ". Clues: " + [lead.city, lead.state, lead.country, phone].filter(Boolean).join(", "),
    "THE PERSON: " + [lead.firstName, lead.lastName].filter(Boolean).join(" ") + (s(lead.headline) ? ", " + lead.headline : "") + (email ? ", " + email : ""),
    "THE BRAND: " + String(brand.name || "") + (s(economics.name) ? ". What we sell: " + economics.name : ""),
    "THE FACTS:\n" + (factLines.join("\n") || "(none stated)"),
    "BOOKING LINK: " + (bookingUrl || "none"),
    "OPEN TIMES (" + String(booking.timezone || "UTC") + "):\n" + (slots.length > 0 ? slots.join("\n") : "(none read)"),
    "WHAT JUST HAPPENED: " + JSON.stringify(trigger.item || {}).slice(0, 1500),
    "THE CHANNEL: " + medium + (medium === "email" ? (replied ? " (a reply in the thread they answered)" : " (a follow-up in their last email thread)") : ""),
    "THE THREAD (oldest first):\n" + (threadLines.join("\n") || "(empty)"),
  ].join("\n\n");
  // The writer's LLM is features-service's pick for this campaign (lowest cost per outcome, within its strategy):
  // never one the script states, never a default (BEST-TPL-LLM-1022, NO-WRITER-FALLBACK-1030).
  const writer = must("features.writer_pick", { query: { campaignId: campaignId } });
  const llm = writer.llm || {};
  if (!s(llm.provider) || !s(llm.model)) throw new Error("no writer LLM picked for this campaign: " + String(writer.llmUnavailableReason || "none"));
  // The brand's own tools on every call (BRAND-MCP-1109): the writer looks up what this person already has with the
  // brand, and acts when the brand's team asks, before it decides. No server plugged = today's one-shot call.
  const draft = must("llm.complete", { provider: llm.provider, model: llm.model, systemPrompt: system, message: message, responseFormat: "json", responseSchema: K.SCHEMA, brandTools: { brandId: brandId } });
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
    return { content: { decision: "stop", reason: String(d.reason || ""), ...tools } };
  }
  if (!nextOk) throw new Error("the writer gave no usable next date: " + JSON.stringify(nextAt));
  if (d.decision === "later") {
    setDate({ nextFollowupAt: nextAt, reason: String(d.nextFollowUpWhy || "later").slice(0, 500) });
    close("follow_up_later");
    return { unmade: "later: " + String(d.nextFollowUpWhy || "") + toolsNote };
  }
  if (d.decision === "escalate") {
    const rep = s(brand.salesRepPhone);
    if (rep) door("crm.whatsapp.send", { body: { brandId: brandId, phone: rep, text: "A lead needs your answer: " + [lead.firstName, lead.lastName].filter(Boolean).join(" ") + " (" + (email || phone) + ") asked: " + String(d.question || "") + ". Nothing was sent to them.", idempotencyKey: sendKey + ":rep-alert" }, omitHeaders: ["x-campaign-id"] });
    setDate({ nextFollowupAt: nextAt, reason: "Escalated to the team: " + String(d.question || "").slice(0, 400) });
    close("follow_up_escalated");
    return { content: { decision: "escalate", question: String(d.question || ""), repAlerted: Boolean(rep), ...tools } };
  }
  if (d.decision !== "write") throw new Error("the writer answered an unknown decision " + JSON.stringify(d.decision));

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
  } else if (replied) {
    sent = door("instantly.reply.send", { body: { campaign_id: replied.campaignId, email: email, body_html: text, sent_by: "automation" } });
  } else {
    sent = door("email.send", { body: { type: "broadcast", tag: "follow-up", followUp: true, to: email, subject: undash(d.subject) || String(brand.name || ""), sequence: [{ step: 1, bodyHtml: text, daysSinceLastStep: 0 }], idempotencyKey: sendKey, leadId: s(lead.leadId) || named.leadId, campaignId: campaignId } });
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
  return { content: { decision: "write", channel: medium, booked: booked, inThread: medium === "email" ? Boolean(replied) : null, ...tools } };
}
`;
