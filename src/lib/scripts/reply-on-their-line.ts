/**
 * LEAD-REPLY-CHANNEL-1127: a message of the person that WAITS on us is answered where they wrote it, or not at all.
 *
 * Owner rule 2026-10-13: « never another thread nor another persona ». Prod 2026-11-26 (brand Distribute.you): a
 * client's last message was on Telegram, to the founder's PERSONAL account (Unibox only, never written from by
 * automation); a hot lead event woke the follow-up and its channel plan, which always preferred the brand's WhatsApp,
 * answered him on WhatsApp from our AI line: another app and another persona. The same prompt also told the writer
 * "Messages of ours on record: 0 ... Their last message: never" beside a thread holding nine of ours and his reply:
 * the counts came from lead-service's history, the thread from crm-service.
 *
 * The edit is made on each sender's STORED code at its own lines, nothing else rewritten (`addReplyOnTheirLine`):
 * - WAITING = the latest message of the thread the writer reads is theirs (newer than every message of ours, on any
 *   channel, sent by a machine or by hand). Nothing of theirs waits (a visit, a signup, a date) = the run as before.
 * - It waits in a CONVERSATION of a bridged app (WhatsApp, Telegram, LinkedIn..., the thread item's
 *   `ref.conversationId`): crm-service is asked whether automation may write in THAT conversation and from which account
 *   (`crm.conversation.reach`: a personal line, automation off, a human typing there, the app logged out = refused by
 *   name). Reachable = the answer goes into that conversation from that account, with its persona
 *   (`crm.conversation.send`); refused = nothing on any app, the run says why (crm-service's words) and the person's
 *   next look is set (`LOOK_AGAIN_DAYS`): the thread stays with whoever holds that line. One path for every app: an
 *   app crm-service opens to automated sends later is picked up as writable with no change here.
 * - It waits by email and the sender can email: the answer continues that email thread, never WhatsApp instead.
 * - It waits anywhere else (no conversation this sender can answer in): nothing goes out on any other app or line.
 * - The writer's counts (ours, our last, their last) are read off the SAME thread it reads.
 */

/** The senders built on the follow-up channel plan (live dynasties). */
export const REPLY_ON_THEIR_LINE_SENDERS = [
  { outcome: "lead_interested", dynasty: "dy_follow_up_due" },
  { outcome: "paid_client", dynasty: "dy_client_check_in" },
  { outcome: "paid_client", dynasty: "dy_brand_team" },
  { outcome: "client_satisfied", dynasty: "dy_client_whatsapp" },
] as const;


/** The writers whose prompt names the chat app (message_written halves of the split senders). */
export const REPLY_ON_THEIR_LINE_WRITERS = [
  { outcome: "message_written", dynasty: "dy_follow_up_due" },
  { outcome: "message_written", dynasty: "dy_client_check_in" },
  { outcome: "message_written", dynasty: "dy_brand_team" },
] as const;

/** Marks the upgraded code (the edit is never applied twice). */
export const REPLY_ON_THEIR_LINE_MARK = "LEAD-REPLY-CHANNEL-1127";
/** The row reason when their message waits where we cannot answer. */
export const WAITS_ON_THEIR_LINE_REASON = "follow_up_waits_on_their_line";
/** When the person is looked at again: their line may have been answered by hand by then. */
export const LOOK_AGAIN_DAYS = 7;
export const CONVERSATION_REACH_DOOR = "crm.conversation.reach";
export const CONVERSATION_SEND_DOOR = "crm.conversation.send";
/** crm-service's named refusals of a conversation send (the reach answers the same codes). */
export const CONVERSATION_REFUSAL_CODES = [
  "no_conversation",
  "automation_not_allowed",
  "account_not_linked",
  "account_not_connected",
  "human_in_conversation",
  "stated_not_to_brand",
] as const;

/** The stored code's own lines (each found exactly once, else nothing is generated). */
export const REPLY_ON_THEIR_LINE_ANCHORS = {
  planStep: "const step_channel_plan = (function () {\n",
  planMain: "function main(person, plan, reach, timeline) {\n",
  lastWhere: '  const lastWhere = lastTheirs ? String(lastTheirs.channel ?? "unknown") : null;\n',
  planCall: "  results.channel_plan = step_channel_plan((results.resolve_person), (results.read_state), (results.reach_check), (results.person_thread));\n",
  sendWhatsapp: '  results.send_whatsapp = callStep(ctx, "crm.whatsapp.send", ',
  history: "  results.person_history = step_person_history((results.channel_plan), (results.history_read));\n",
  noChannel: "  if (channel?.noChannel === true) {\n",
  emailPlan: '      channel: "email",\n',
  chatLine: '"THE CHANNEL is WhatsApp: the message continues our WhatsApp conversation with them, from the same number, ',
  copilotMedium: '  const medium = channel?.channel === "whatsapp" ? "whatsapp" : channel?.channel === "email" ? "email" : null;\n',
};

/** Top-level helpers, placed before the channel plan step (every step closure and the flow see them). */
export const THEIR_LINE_FNS = `
// ${REPLY_ON_THEIR_LINE_MARK}: the thread's messages as the writer reads them (crm-service's person thread).
function threadMessagesOf(timeline) {
  const items = Array.isArray(timeline?.items) ? timeline.items : [];
  return items.filter((i) => i?.kind === "message" && i.source !== "api" && (i.direction === "inbound" || i.direction === "outbound"));
}
// Their message waiting on us: the latest dated message of the thread is theirs (newer than every message of ours).
function waitingOnUs(timeline) {
  let last = null;
  let lastAt = -Infinity;
  for (const m of threadMessagesOf(timeline)) {
    const t = Date.parse(String(m.at ?? ""));
    if (Number.isFinite(t) && t >= lastAt) { last = m; lastAt = t; }
  }
  return last && last.direction === "inbound" ? last : null;
}
function conversationOf(m) {
  const id = m && m.ref && typeof m.ref === "object" ? m.ref.conversationId : null;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}
// The counts the writer reads, off the same thread it reads (a thread not read keeps lead-service's).
function threadCounts(history, timeline) {
  if (!history || typeof history !== "object" || !timeline || !Array.isArray(timeline.items)) return history;
  const said = threadMessagesOf(timeline).filter((m) => String(m.text ?? "").trim() !== "");
  const ours = said.filter((m) => m.direction === "outbound");
  const theirs = said.filter((m) => m.direction === "inbound");
  const latest = (list) => list.reduce((a, m) => (typeof m.at === "string" && (a === null || Date.parse(m.at) > Date.parse(a)) ? m.at : a), null);
  return { ...history, ourMessages: ours.length, lastOursAt: latest(ours), lastTheirsAt: latest(theirs) };
}
function addressIn(text) {
  const m = String(text ?? "").match(/[^\\s<>"',;]+@[^\\s<>"',;]+\\.[^\\s<>"',;]+/);
  return m ? m[0].toLowerCase() : null;
}
// The answer into their own conversation: the written text, its key and quote, nothing else.
function conversationSendBody(w, plan) {
  const b = w && typeof w === "object" ? w : {};
  const body = { brandId: b.brandId, conversationId: plan.conversationId, idempotencyKey: b.idempotencyKey };
  if (Array.isArray(b.messages)) body.messages = b.messages; else body.text = b.text;
  if (b.replyToEventId) body.replyToEventId = b.replyToEventId;
  return body;
}
`.trim();

/** The plan block, right after `lastWhere`: the sender's own send doors decide what is writable. */
function planBlock(emails: boolean): string {
  return `
  // ${REPLY_ON_THEIR_LINE_MARK}: a message of theirs waiting on us is answered in the conversation it came in, or not at all.
  const waiting = reach.code === "stated_not_to_brand" ? null : waitingOnUs(timeline);
  if (waiting) {
    const where = String(waiting.channel ?? "unknown");
    const at = String(waiting.at ?? "");
    const held = (why) => {
      console.log("[follow-up] " + why);
      return { channel: null, skipModel: true, heldOnTheirLine: true, waitingOn: where, why };
    };
    const never = " The answer is never moved to another app or line: the thread stays with whoever holds it.";
    if (conversationOf(waiting)) {
      if (!conversation || conversation.ok === false || typeof conversation.reachable !== "boolean") {
        throw new Error("channel-plan: the conversation reach check did not answer: " + JSON.stringify(conversation).slice(0, 300));
      }
      if (conversation.code === "stated_not_to_brand") {
        return { channel: null, skipModel: true, notToBrand: true, why: "The brand stated this person is not someone of theirs" };
      }
      if (conversation.reachable !== true) {
        return held("Their " + where + " message of " + at + " waits on us, in a conversation automation cannot write in (" + String(conversation.code) + "): " + String(conversation.error ?? "") + never);
      }
      const app = String(conversation.conversation?.channel ?? where);
      const label = app === "whatsapp" ? null : app.charAt(0).toUpperCase() + app.slice(1);
      const acct = conversation.fromAccount ?? {};
      return {
        channel: "whatsapp",
        skipModel: false,
        email,
        phone: conversation.conversation?.phone ?? (app === "whatsapp" ? reach.to ?? person.phone ?? null : null),
        fromAccount: acct.account ?? null,
        persona: senderPersona({ persona: acct.persona }),
        conversationId: conversation.conversation?.conversationId ?? conversationOf(waiting),
        // The app for the writer's channel line (label) and the Copilot's medium (crm-service's own word, as is).
        ...(label ? { app: label, conversationApp: app } : {}),
        why: "Their " + (label ?? "WhatsApp") + " message of " + at + " waits on us: the answer continues that conversation, from the account they wrote to" + (acct.account ? " (" + acct.account + ")" : "") + ".",
      };
    }
    if (where === "email" && ${emails ? "true" : "false"}) {
      const to = addressIn(waiting.from) ?? email;
      if (!to) return held("Their email of " + at + " waits on us, from an address the thread does not state." + never);
      return {
        channel: "email",
        skipModel: false,
        email: to,
        phone: person.phone ?? null,
        why: "Their email of " + at + " waits on us: the answer continues that email thread.",
      };
    }
    return held("Their message of " + at + " waits on us on " + where + ", where this campaign cannot write." + never);
  }
`.replace(/^\n/, "");
}

const REACH_LINES =
  `  // ${REPLY_ON_THEIR_LINE_MARK}: a message of theirs waiting in a conversation of a bridged app: can automation answer IN it?\n` +
  "  const THEIR_WAITING: any = results.read_state?.proceed === true ? waitingOnUs(results.person_thread) : null;\n" +
  `  results.conversation_reach = THEIR_WAITING && conversationOf(THEIR_WAITING)\n` +
  `    ? callStep(ctx, "${CONVERSATION_REACH_DOOR}", { service: "crm", method: "POST", path: "/orgs/conversations/reach", body: (({brandId: results.resolve_person?.brandId, conversationId: conversationOf(THEIR_WAITING)})) }, 2)\n` +
  "    : { ok: false, skipped: true, notCalled: true };\n";

const OUTCOME_BLOCK =
  `  // ${REPLY_ON_THEIR_LINE_MARK}: their message waits where we cannot answer: nothing sent anywhere, a decision (no\n` +
  "  // delivery), looked at again later.\n" +
  "  if (channel?.heldOnTheirLine === true) {\n" +
  `    return { endKind: "later", ...row(${JSON.stringify(WAITS_ON_THEIR_LINE_REASON)}), ...date(new Date(now + ${LOOK_AGAIN_DAYS} * 86400000).toISOString(), channel.why), delivery: null };\n` +
  "  }\n";

export const CHAT_LINE_TO =
  '"THE CHANNEL is " + (channel.app || "WhatsApp") + ": the message continues our " + (channel.app || "WhatsApp") + " conversation with them, from the same " + (channel.app ? "account" : "number") + ", ';

function once(code: string, anchor: string, name: string): number {
  const at = code.indexOf(anchor);
  if (at < 0 || code.indexOf(anchor, at + 1) >= 0) {
    throw new Error(`reply-on-their-line: the stored code holds the ${name} line ${at < 0 ? "nowhere" : "more than once"}: nothing generated`);
  }
  return at;
}

function replaceOnce(code: string, anchor: string, name: string, to: string): string {
  const at = once(code, anchor, name);
  return code.slice(0, at) + to + code.slice(at + anchor.length);
}

/** Whether a sender's channel plan can choose email (the follow-up) or writes on chat apps only (client satisfied). */
export function plansEmail(code: string): boolean {
  const a = code.indexOf(REPLY_ON_THEIR_LINE_ANCHORS.planStep);
  const b = code.indexOf("\nfunction senderPersona", a);
  if (a < 0 || b < 0) throw new Error("reply-on-their-line: the stored code holds no channel plan step: nothing generated");
  return code.slice(a, b).includes(REPLY_ON_THEIR_LINE_ANCHORS.emailPlan);
}

/** The app named in a chat writer's channel line and the Copilot's medium (a sender that writes itself, or a writer half). Absent = left alone. */
function withChatApp(code: string): string {
  const A = REPLY_ON_THEIR_LINE_ANCHORS;
  let next = code;
  if (next.includes(A.chatLine)) next = replaceOnce(next, A.chatLine, "chat channel line", CHAT_LINE_TO);
  if (next.includes(A.copilotMedium)) {
    // chat-service's lead turn takes crm-service's conversation channel as its medium (LEAD-REPLY-CHANNEL-1127-CHAT).
    next = replaceOnce(next, A.copilotMedium, "Copilot medium", A.copilotMedium.replace('? "whatsapp" :', '? (channel.conversationApp || "whatsapp") :'));
  }
  return next;
}

/** The sender's stored code answering a waiting message in its own conversation. Throws when an anchor moved or it is already in. */
export function addReplyOnTheirLine(code: string): string {
  if (code.includes(REPLY_ON_THEIR_LINE_MARK)) throw new Error("reply-on-their-line: the stored code already carries it");
  const A = REPLY_ON_THEIR_LINE_ANCHORS;
  const emails = plansEmail(code);
  let next = code;
  next = replaceOnce(next, A.planStep, "channel plan step", THEIR_LINE_FNS + "\n\n" + A.planStep);
  next = replaceOnce(next, A.planMain, "channel plan signature", "function main(person, plan, reach, timeline, conversation) {\n");
  next = replaceOnce(next, A.lastWhere, "last-where", A.lastWhere + planBlock(emails));
  next = replaceOnce(next, A.planCall, "channel plan call", REACH_LINES + A.planCall.replace("(results.person_thread));", "(results.person_thread), (results.conversation_reach));"));
  next = replaceOnce(
    next,
    A.sendWhatsapp,
    "WhatsApp send",
    `  results.send_whatsapp = results.channel_plan?.conversationId\n` +
      `    ? callStep(ctx, "${CONVERSATION_SEND_DOOR}", { service: "crm", method: "POST", path: "/orgs/conversations/messages", body: conversationSendBody(results.finalize?.whatsappBody, results.channel_plan), skip: (results.finalize?.skipWhatsapp), skipOnRefusalCodes: ${JSON.stringify(CONVERSATION_REFUSAL_CODES)} }, 0)\n` +
      `    : callStep(ctx, "crm.whatsapp.send", `,
  );
  next = replaceOnce(next, A.history, "person history", A.history + "  results.person_history = threadCounts(results.person_history, results.person_thread);\n");
  next = replaceOnce(next, A.noChannel, "no-channel outcome", OUTCOME_BLOCK + A.noChannel);
  return withChatApp(next);
}

/** A writer half: its chat channel line names the app the conversation is on (WhatsApp when the plan names none). */
export function addChatAppToWriter(code: string): string {
  const A = REPLY_ON_THEIR_LINE_ANCHORS;
  if (!code.includes(A.chatLine) && !code.includes(A.copilotMedium)) throw new Error("reply-on-their-line: the writer holds no chat channel line nor Copilot medium (or already names the app)");
  return withChatApp(code);
}
