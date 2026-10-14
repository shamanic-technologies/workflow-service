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
 *    once) hands back a person whose follow-up is due: we wrote to them once, three days ago, and nobody since
 *    stopped the schedule. They get ONE follow-up, never a second: the row is then marked `handed` (permanent, no
 *    automated writer claims them again), so "at most one follow-up" is structural rather than a count we hope to
 *    respect.
 *  - Nobody due: the NEXT person is served by lead-service (`POST /orgs/buffer/next`, the same serve every
 *    outreach workflow calls; for the CRM pipe it hands out the brand's own people). Nobody left ends the run on
 *    the no-lead end-run, which the converter turns into "exhausted" only on lead-service's `audience_exhausted`.
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
 *  - Strictly AFTER the send, lead-service records what we owe them: a first message schedules the one follow-up
 *    (`schedule-by-email`, due in three days); a follow-up hands the row over for good. A refusal on a follow-up
 *    hands it over too (they answered: their thread is a person's now) or stops it (unreachable).
 *
 * Shape: three decisions (`check-due`, `check-person`, `check-record`) are SIBLING top-level branchones, each
 * pinned by a convergence edge from a node outside the previous decision's branch (`nodeToModule` builds a
 * condition nested in a branch as an ordinary module, which silently does nothing); every arm reads its evidence
 * with `?.`, because on another path the node it reads never ran.
 */
import type { DAG } from "./dag-validator.js";
import { CHAT_STEP_MAX_TOKENS, CRM_WHATSAPP_SEND, GATHER_FACTS_CODE } from "./ai-meeting-booking-dag.js";
import { relationshipReadNode, whoTheyAreNode } from "./person-relationship.js";

export { CRM_WHATSAPP_SEND };

export const COLD_WHATSAPP_OUTREACH_FEATURE_SLUG = "cold-whatsapp-outreach";

/** The legs the channel's pipes perform (features-service catalogue, 2026-10-12). */
export const COLD_WHATSAPP_OUTREACH_LEG_KEYS = ["lead_found_to_conversation", "lead_found_to_website_visit"] as const;

export const coldWhatsappPipeIdOf = (legKey: string): string => `${COLD_WHATSAPP_OUTREACH_FEATURE_SLUG}|${legKey}`;

export const COLD_WHATSAPP_OUTREACH_DESCRIPTION =
  "Writes to one person per run on WhatsApp, from the brand's own linked WhatsApp number, to start a real " +
  "conversation: a short first message written from the campaign's instruction, and at most one follow-up three " +
  "days later if they have not answered. The brand's team takes over as soon as they answer. A person we cannot " +
  "reach on WhatsApp is named and left to the email path.";

/** The model the message is written with, through chat-service. Always-thinking: no temperature. */
export const COLD_WHATSAPP_LLM = { provider: "anthropic", model: "opus" } as const;

/** Days between the first message and the one follow-up. */
export const FOLLOW_UP_AFTER_DAYS = 3;

/** Stored on the queue row once the follow-up went out: handed, permanent, so there is never a second one. */
export const WHATSAPP_FOLLOW_UP_SENT_REASON = "whatsapp_follow_up_sent";

/** The model's answer: the message, and one sentence on what it is for. */
export const MESSAGE_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string", description: "The WhatsApp message, plain text, exactly as the person will read it." },
    reason: { type: "string", description: "One sentence: what this message is trying to learn or start." },
  },
  required: ["message", "reason"],
} as const;

/**
 * Who this run writes to, from whichever path ran: the claimed follow-up (lead-detail read) or the newly served
 * lead. `kind` is `followup`, `first`, or `nobody` (nothing due and nobody served). Reads both with `?.`: exactly
 * one of them ran.
 */
export const PICK_PERSON_CODE = `
export async function main(claim, detail, served) {
  if (claim?.found === true) {
    const f = claim.followup ?? {};
    const lead = detail?.leadDetail?.lead ?? null;
    if (!f.id || !f.email) throw new Error("pick-person: a claimed follow-up carries no row id or email");
    if (!lead) throw new Error("pick-person: the claimed person's lead read returned no lead");
    return { kind: "followup", step: 2, skipSends: false, rowId: f.id, leadId: f.leadId ?? null, email: f.email, brandId: f.brandId ?? null, lead };
  }
  if (served?.found === true) {
    const s = served.lead ?? {};
    if (!s.email) throw new Error("pick-person: a served lead carries no email");
    return { kind: "first", step: 1, skipSends: false, rowId: null, leadId: s.leadId ?? null, email: s.email, brandId: (s.brandIds ?? [])[0] ?? null, lead: s.data ?? {} };
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
  const brandId = person?.brandId;
  if (!email) throw new Error("history-plan: the person carries no email to find their thread by");
  if (!brandId) throw new Error("history-plan: the person carries no brand");
  if (!Array.isArray(recent?.people)) throw new Error("history-plan: the brand's people index answered no people list");
  const self = { personId: null, timelineQuery: { brandId, personKey: "email:" + email }, sendsQuery: { brandId, email } };
  const samples = [];
  for (const p of recent.people) {
    if (samples.length >= ${VOICE_SAMPLE_PEOPLE}) break;
    if (!p?.personId || (p.emails ?? []).map((e) => String(e).toLowerCase()).includes(email)) continue;
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
 * Fails the person loud when the thread cannot be read whole, or when there is not one message of the owner to learn
 * his voice from: a blind generic message is exactly what this step exists to prevent.
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
  // What the OWNER typed himself: his personal channels, outbound, not sent by our software.
  const ownerTyped = (i, bot) => i.kind === "message" && i.direction === "outbound" && (i.source === "gmail" || i.source === "matrix") && !isBot(i, bot) && clip(i.text, 10);
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
  const events = items.filter((i) => i.kind === "event").slice(-8).map((i) => day(i.at) + " | " + i.channel + " | EVENT: " + (i.event?.step ?? "event") + " (" + i.source + ")");
  const last = messages[messages.length - 1] ?? null;

  // His chat voice (WhatsApp, LinkedIn: what this message is) first; his emails only when he never chatted.
  const chat = [];
  const mail = [];
  const take = (i, who) => (i.source === "matrix" ? chat : mail).push(who + ", " + i.channel + ": " + clip(i.text, 300));
  const own = messages.filter((i) => ownerTyped(i, bot));
  for (const i of own.slice(-25)) take(i, "to this person");
  const seen = new Set([thread.person?.personId]);
  for (const [v, s] of [[v1, s1], [v2, s2], [v3, s3], [v4, s4]]) {
    const pid = v?.person?.personId;
    if (!Array.isArray(v?.items) || !pid || seen.has(pid)) continue;
    seen.add(pid);
    const b = botOf(s);
    for (const i of v.items.filter((x) => ownerTyped(x, b)).slice(-12)) take(i, "to someone else");
  }
  const voice = chat.length ? chat : mail;
  if (voice.length === 0) throw new Error("read-history: not one message the owner typed himself was found to learn his voice from; nothing is written blind");

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
`.trim();

/**
 * Builds the system prompt and the message. chat-service `/complete` takes one flat `message`, so the
 * interpolation happens in the flow; this is also what makes the prompt readable in the stored DAG.
 * The strategy is explained to the model, never a script per case (owner rule).
 */
export const COMPOSE_MESSAGE_PROMPT_CODE = `
export async function main(person, instruction, offer, brand, rep, facts, history, currentDate, who) {
  const offerName = typeof offer?.name === "string" ? offer.name.trim() : "";
  if (!offerName) throw new Error("compose-message: the campaign's offer read carries no name");
  const b = brand?.brand ?? {};
  const brandName = typeof b.name === "string" && b.name.trim() ? b.name.trim() : null;
  if (!brandName) throw new Error("compose-message: the brand read carries no name");
  if (person?.kind !== "first" && person?.kind !== "followup") throw new Error("compose-message: no person to write to");
  if (!Array.isArray(history?.threadLines) || !Array.isArray(history?.voiceLines) || history.voiceLines.length === 0) {
    throw new Error("compose-message: no thread or no owner's voice was read; nothing is written blind");
  }
  if (!who || !Array.isArray(who.lines) || typeof who.strategy !== "string") {
    throw new Error("compose-message: who this person is to the brand was not read; nothing is written blind");
  }

  const present = (v) => typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined;
  const lead = person.lead ?? {};
  const org = lead.organization ?? {};
  const personLines = [
    ["Name", [lead.firstName, lead.lastName].filter(present).join(" ")],
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
  const talked = history.hasHistory === true;

  const systemPrompt = [
    "You are " + (senderName ? senderName + ", " + senderRole + " of " + brandName : "the founder of " + brandName) + ". You write ONE WhatsApp message to one person, from the brand's own WhatsApp number, exactly as " + owner + " would type it himself.",
    "",
    "WHAT " + owner.toUpperCase() + " WANTS FROM THIS CONVERSATION (a strategy, not a script): a real conversation, not a sale. He wants to get to know them: what they want to grow, what they already tried to get there, whether they know what a new customer costs them (so he can compare with what he sees elsewhere), what they think of " + brandName + ", what questions they have. A call is welcome if they want one. A useful tip that could make them more revenue is the best gift. Pick the ONE angle that fits where the conversation is, and ask at most ONE easy question they can answer in a line (one question mark, never two questions joined by \\"and\\").",
    "",
    "WHERE THE CONVERSATION STANDS: THE THREAD below is every message ever exchanged with this person, on every channel (email, WhatsApp, LinkedIn), oldest first, plus a few events (signup, visits).",
    talked
      ? "They ALREADY talked with us. This is NOT a first contact: never introduce yourself, never say who you are or what " + brandName + " is, never thank them for signing up as if it were news. Pick the conversation back up from where it stopped, like a friend reopening a chat: answer anything they asked that was left unanswered, follow up on the last thing that was still alive, or bring a new angle that fits what they told us. Refer to what was actually said."
      : who.state === "known"
        ? "No message with them is on record, but the brand ALREADY KNOWS them (WHO THEY ARE TO US below). This is NOT a cold first contact: write as " + owner + " writing to someone he knows, never an introduction."
        : who.state === "possibly_known"
          ? "No message with them is on record, and nobody confirmed yet whether " + owner + " knows them. Write so it reads right either way: a light word on who you are is fine, never a pitch to a stranger, never claim you never met."
          : "Nobody from " + brandName + " ever exchanged a message with them. This is a FIRST message: say who you are in a few words and why you write to them, personally.",
    "",
    who.strategy,
    "Lines marked [automated ...] or [AI Copilot] were sent by our software, not typed by " + owner + ": the person saw them, so they are part of the history, but they are NEVER a model of how " + owner + " writes. If one was a clumsy cold introduction, do not repeat it, and do not make a big deal of it.",
    followup
      ? "Our last automated message to them, " + "${FOLLOW_UP_AFTER_DAYS}" + " days ago, got no answer. This is the ONE follow-up: do not repeat it and do not guilt them. Give them a different, lighter reason to answer, or a short tip, and make it easy to say no. There will be no other message after this one."
      : "",
    "",
    "HOW " + owner.toUpperCase() + " WRITES: learn it from HIS OWN MESSAGES below (to this person first, then to other people). Copy his length, his tone, his greeting habits (or the lack of them), his punctuation and capitalisation, his emoji use (none if he uses none), whether he signs. If he writes several short lines, you may too (separate them with a line break). Write in the language he uses with THIS person in the thread; with no thread, write in English.",
    "If an INSTRUCTION is given below, it is the campaign's own brief: follow it. It wins over the angle you would have picked, never over his voice. It was written for the whole campaign without knowing this person: where it assumes something THE THREAD or WHO THEY ARE TO US contradicts (that you never talked, that they are a stranger, that they just signed up, which language to use), THE THREAD and WHO THEY ARE TO US win.",
    "Keep it as short as he would, never more than 60 words. No sales pitch, no links unless the instruction gives one, no filler, no \\"I hope this finds you well\\".",
    "State only what the THREAD, the INSTRUCTION or the FACTS say. Never invent a figure, a price, a promise, a result or a customer.",
    "Never use an em dash or an en dash. Use a comma or a period.",
  ].filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\\n");

  const last = history.lastMessage;
  const message = [
    "TODAY: " + String(currentDate ?? new Date().toISOString().slice(0, 10)),
    "",
    "INSTRUCTION:",
    text || "(none: follow the strategy)",
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
    "THE THREAD with this person (oldest first; OWNER = " + owner + " typing himself):",
    ...(history.olderMessagesOmitted > 0 ? ["(" + history.olderMessagesOmitted + " older messages not shown)"] : []),
    ...(history.threadLines.length ? history.threadLines : ["(no message ever exchanged)"]),
    ...(history.eventLines?.length ? ["", "RECENT EVENTS:", ...history.eventLines] : []),
    ...(last ? ["", "THE CONVERSATION STOPPED HERE: " + last.from + " wrote last, " + String(last.at ?? "date unknown").slice(0, 10) + ": " + last.text] : []),
    "",
    "HIS OWN MESSAGES (how " + owner + " writes):",
    ...history.voiceLines.map((l) => "- " + l),
  ].join("\\n");

  return { systemPrompt, message };
}
`.trim();

/**
 * Holds the model to its contract before anything is sent: an empty message throws, any em/en dash is rewritten
 * (between digits a hyphen, otherwise a comma). Builds the send's idempotency key: one per person per step.
 */
export const FINALIZE_MESSAGE_CODE = `
export async function main(draft, person, campaignId) {
  const json = draft?.json ?? {};
  const undash = (s) => String(s ?? "")
    .replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-")
    .replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ")
    .trim();
  const text = undash(json.message);
  if (!text) throw new Error("finalize-message: the model returned an empty message");
  if (text !== String(json.message ?? "").trim()) {
    console.error("[cold-whatsapp-outreach] the draft used a dash the person must never read; rewritten before the send");
  }
  const who = person?.leadId ?? person?.email;
  if (!who) throw new Error("finalize-message: no person to key the send on");
  return {
    text,
    idempotencyKey: "cold-whatsapp-outreach:" + String(campaignId) + ":" + String(who) + ":" + String(person.step),
    // The follow-up is never sent to someone who wrote to us since, on any channel.
    skipIfReplied: person.kind === "followup",
  };
}
`.trim();

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
export async function main(person, send, currentDate) {
  const refused = send?.skipped === true;
  const code = refused ? String(send.code ?? "refused") : null;
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
    const due = new Date(Date.now() + ${FOLLOW_UP_AFTER_DAYS} * 24 * 3600 * 1000).toISOString();
    return { action: "schedule", outcome: "sent", dueAt: due, email: person.email };
  }
  if (person?.kind === "followup") {
    if (!refused) return { action: "record", outcome: "sent", body: { kind: "handed", reason: "${WHATSAPP_FOLLOW_UP_SENT_REASON}" } };
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
 * end the person, not the run. `person_replied` only comes back on the follow-up (`skipIfReplied`): they wrote on
 * any channel, so their thread is a person's. `send_in_progress` (409), `invalid_request` and `bridge_error` are
 * NOT here: they fail the run loud.
 */
export const WHATSAPP_REFUSAL_CODES = [
  "whatsapp_not_linked",
  "whatsapp_not_connected",
  "no_phone_known",
  "not_on_whatsapp",
  "person_replied",
] as const;

const PERSON = "results['pick-person']";
const WRITTEN = "results['prior-contact']?.alreadyWritten";
const VOICE_SLOTS = Array.from({ length: VOICE_SAMPLE_PEOPLE }, (_, i) => i + 1);
const endRun = (id: string, body: Record<string, unknown>) => ({
  id,
  type: "http.call" as const,
  config: { service: "campaign", method: "POST", path: "/end-run", body },
});

export function buildColdWhatsappOutreachDag(): DAG {
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" },
      },
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      // The one follow-up first: this campaign's own queue.
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
        },
      },
      // What this campaign already sent them, read BEFORE anything is paid for (and reused as the writer's history).
      {
        id: "prior-sends",
        type: "http.call",
        config: { service: "crm", method: "GET", path: "/orgs/whatsapp/messages" },
        retries: 0,
        inputMapping: {
          "query.brandId": "$ref:pick-person.output.brandId",
          "query.email": "$ref:pick-person.output.email",
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
        },
      },
      {
        id: "draft-message",
        type: "http.call",
        config: {
          service: "chat",
          method: "POST",
          path: "/complete",
          body: {
            provider: COLD_WHATSAPP_LLM.provider,
            model: COLD_WHATSAPP_LLM.model,
            responseFormat: "json",
            responseSchema: MESSAGE_RESPONSE_SCHEMA,
            maxTokens: CHAT_STEP_MAX_TOKENS,
          },
        },
        retries: 0,
        inputMapping: {
          "body.message": "$ref:compose-message.output.message",
          "body.systemPrompt": "$ref:compose-message.output.systemPrompt",
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
        },
      },
      {
        id: "send-whatsapp",
        type: "http.call",
        config: { ...CRM_WHATSAPP_SEND, skipOnRefusalCodes: [...WHATSAPP_REFUSAL_CODES] },
        retries: 0,
        inputMapping: {
          "body.email": "$ref:pick-person.output.email",
          "body.brandId": "$ref:pick-person.output.brandId",
          "body.text": "$ref:finalize-message.output.text",
          "body.idempotencyKey": "$ref:finalize-message.output.idempotencyKey",
          "body.skipIfReplied": "$ref:finalize-message.output.skipIfReplied",
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
      // A first message went out: the one follow-up is owed in FOLLOW_UP_AFTER_DAYS.
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
      // A follow-up (sent or refused): handed for good, never a second one.
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
      endRun("end-run", { success: true, stopCampaign: false }),
      endRun("end-run-followup", { success: true, stopCampaign: false }),
      endRun("end-run-unreachable", { success: true, stopCampaign: false }),
      // A re-served person this campaign already wrote to: nothing to do this run.
      endRun("end-run-already-written", { success: true, stopCampaign: false, noWorkAvailable: true }),
      endRun("end-run-no-lead", { success: true, stopCampaign: true }),
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "claim-followup" },
      { from: "claim-followup", to: "check-due" },
      { from: "check-due", to: "lead-detail", condition: "results['claim-followup']?.found == true" },
      { from: "check-due", to: "serve-lead", condition: "results['claim-followup']?.found != true" },
      { from: "lead-detail", to: "relationship-read" },
      { from: "relationship-read", to: "pick-person" },
      { from: "serve-lead", to: "pick-person" },
      { from: "claim-followup", to: "pick-person" },
      { from: "pick-person", to: "prior-sends" },
      { from: "prior-sends", to: "prior-contact" },
      { from: "prior-contact", to: "check-person" },
      { from: "check-person", to: "end-run-no-lead", condition: `${PERSON}?.kind == 'nobody'` },
      { from: "check-person", to: "end-run-already-written", condition: `${WRITTEN} == true` },
      {
        from: "check-person",
        to: "offer-economics",
        condition: `(${PERSON}?.kind == 'first' || ${PERSON}?.kind == 'followup') && ${WRITTEN} != true`,
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
      { from: "who-they-are", to: "compose-message" },
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
      { from: "release-person", to: "end-run-unreachable" },
      { from: "schedule-followup", to: "end-run" },
      { from: "record-followup", to: "end-run-followup" },
    ],
    onError: "end-run-error",
  };
}
