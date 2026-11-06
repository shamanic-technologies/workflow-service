import type { ScriptContext, ScriptResult } from "@gtm-factory/core";

/**
 * Reply received · distribute.you orphan-reply judgment (which lead a message from ANOTHER address answers).
 *
 * One run per message the poller filed `unrelated` and kept as a possible prospect answer (no In-Reply-To to any send
 * of ours: a prospect writing from their personal account, a colleague after a forward). instantly-service hands the
 * message (sender, recipients, subject, headers, body, received time), our own mail domains, our staff addresses and
 * domains, and the leads this mailbox had written to BEFORE the message arrived. This script decides, in order:
 *   1. excluded: structural noise that must never reach a paid judgment (our fleet, staff, automated mail, a list,
 *      a system sender, Instantly's warmup tag in the subject or the body);
 *   2. no_candidate_lead: no lead shares a distinctive token with the message (their name, their company domain, our
 *      subject), so there is nobody to attach it to;
 *   3. a Jev choice (`jev.choice`): one option per offered lead (at most 8, best first) plus `none`; a lead is matched
 *      only at 0.75 or more, else low_confidence. An unknown option is a failure, never a guess.
 * instantly-service persists the verdict on the message and, on a match, files it as that lead's reply.
 *
 * Provenance: instantly-service src/lib/self-send/orphan-reply.ts (orphanReplyExclusion, rankOrphanReplyLeads,
 * buildOrphanReplyQuestion, buildOrphanReplyState, readOrphanReplyVerdict, orphanJudgmentOrg), orphan-reply-sweep.ts
 * (the decision's order), inbound.ts (isAutoReply, isDeliveryStatusNotification), staff-senders.ts (bareAddress,
 * isStaffSender), byte for byte.
 */
type Headers = Record<string, string | undefined>;
interface Lead {
  instantlyCampaignId: string;
  leadEmail: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  subject: string | null;
  excerpt: string | null;
  lastStep: number;
  firstSentAt: string;
  lastSentAt: string;
  orgId: string | null;
}
interface Material {
  message: { fromAddress: string | null; toAddress: string; subject: string | null; headers: Headers; text: string | null; receivedAt: string; recipients: string[] };
  ownMailDomains: string[];
  staffAddresses: string[];
  staffDomains: string[];
  leads: Lead[];
}

const INSTANTLY_WARMUP_TAGS = ["WNT6JJB"];
const SYSTEM_LOCAL_PART = /^(mailer-daemon|postmaster|no-?reply[\w.-]*|do-?not-?reply|notifications?|bounces?[\w.+-]*|dmarc[\w.-]*)$/i;
const LIST_HEADERS = ["list", "list-id", "list-unsubscribe", "list-unsubscribe-post", "feedback-id"];
const FREEMAIL = new Set([
  "gmail", "googlemail", "yahoo", "hotmail", "outlook", "live", "msn", "aol",
  "icloud", "me", "mac", "proton", "protonmail", "gmx", "mail", "yandex", "zoho",
  "comcast", "verizon", "att", "sbcglobal", "bellsouth",
]);
const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "with", "that", "this", "from", "have",
  "are", "our", "can", "will", "about", "quick", "question", "re", "fwd", "fw",
  "hello", "thanks", "thank", "regards", "best", "just", "what", "when", "how",
  "into", "more", "help", "team", "company", "group", "inc", "llc", "ltd", "corp",
  "practice", "business", "growing", "idea", "ideas", "call", "time", "today",
]);
const ORPHAN_REPLY_MIN_SCORE = 2;
const ORPHAN_REPLY_MAX_LEADS = 8;
const ORPHAN_REPLY_NONE = "none";
const ORPHAN_REPLY_QUESTION_KEY = "orphan_reply";
const ORPHAN_REPLY_MIN_PROBABILITY = 0.75;

export default function run(ctx: ScriptContext): ScriptResult {
  const m = ctx.get("message_sent").content as Material;
  const msg = m.message;
  const own = new Set(m.ownMailDomains);
  const isStaffSender = (from: string | null | undefined): boolean => {
    const address = bareAddress(from);
    if (!address) return false;
    if (m.staffAddresses.includes(address)) return true;
    const domain = address.split("@")[1];
    return domain !== undefined && m.staffDomains.includes(domain);
  };

  const reason = orphanReplyExclusion(msg.fromAddress, msg.subject, msg.headers, msg.text, own, isStaffSender);
  if (reason) return { content: { outcome: "excluded", reason } };

  const ranked = rankOrphanReplyLeads(msg, m.leads);
  if (ranked.length === 0) return { content: { outcome: "no_candidate_lead" } };
  // Whose reply-judging run the judgment is for: the likeliest lead's org (none = the judgment is not made).
  if (!ranked.some((r) => r.lead.orgId)) throw new Error("no candidate lead carries an org: no reply-judging run to judge it for");

  const answer = ctx.vendor.call("jev.choice", {
    state: buildOrphanReplyState(msg),
    questions: { [ORPHAN_REPLY_QUESTION_KEY]: buildOrphanReplyQuestion(ranked) },
  });
  if (!answer.ok) throw new Error("jev.choice failed: " + String(answer.data.error));
  const answers = answer.data.answers as Record<string, { choice: string; confidence: number; probabilities: Record<string, number> }>;
  const a = answers[ORPHAN_REPLY_QUESTION_KEY];
  if (!a) throw new Error("judgment returned no answer for the orphan-reply question");
  const usage = (answer.data.usage ?? null) as { inputTokens?: number } | null;

  const probability = a.probabilities[a.choice] ?? 0;
  let outcome: "matched" | "none" | "low_confidence";
  let matched: Lead | null = null;
  if (a.choice === ORPHAN_REPLY_NONE) outcome = "none";
  else {
    const index = ranked.findIndex((_, i) => `lead_${i + 1}` === a.choice);
    if (index < 0) throw new Error(`orphan-reply judgment answered an unknown option "${a.choice}"`);
    if (probability < ORPHAN_REPLY_MIN_PROBABILITY) outcome = "low_confidence";
    else {
      outcome = "matched";
      matched = ranked[index]!.lead;
    }
  }
  return {
    content: {
      outcome,
      model: answer.data.model ?? null,
      choice: a.choice,
      probability,
      confidence: a.confidence,
      probabilities: a.probabilities,
      inputTokens: usage?.inputTokens ?? 0,
      candidates: ranked.map(({ lead, score }) => ({ instantlyCampaignId: lead.instantlyCampaignId, leadEmail: lead.leadEmail, score })),
      ...(matched ? { instantlyCampaignId: matched.instantlyCampaignId, leadEmail: matched.leadEmail } : {}),
    },
  };
}

function bareAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const angled = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  const raw = angled ? angled[1] : value.match(/[^\s<>"',;]+@[^\s<>"',;]+/)?.[0];
  return raw ? raw.trim().toLowerCase() : null;
}

function isAutoReply(headers: Headers): boolean {
  const autoSubmitted = headers["auto-submitted"]?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (headers["x-autoreply"] || headers["x-autorespond"]) return true;
  if (headers["x-auto-response-suppress"]) return true;
  const precedence = headers["precedence"]?.trim().toLowerCase();
  if (precedence === "auto_reply" || precedence === "bulk" || precedence === "junk") return true;
  const autoreply = headers["x-auto-reply"]?.trim().toLowerCase();
  return autoreply === "yes" || autoreply === "true";
}

function isDeliveryStatusNotification(headers: Headers): boolean {
  const contentType = headers["content-type"]?.toLowerCase() ?? "";
  if (contentType.includes("report-type=delivery-status")) return true;
  if (headers["return-path"]?.trim() === "<>" && !isAutoReply(headers)) return true;
  const from = headers["from"]?.toLowerCase() ?? "";
  return from.includes("mailer-daemon") || from.includes("postmaster@");
}

function carriesWarmupTag(text: string | null | undefined): boolean {
  if (!text) return false;
  const upper = text.toUpperCase();
  return INSTANTLY_WARMUP_TAGS.some((tag) => upper.includes(tag));
}

function orphanReplyExclusion(
  fromAddress: string | null,
  subject: string | null,
  headers: Headers,
  text: string | null,
  ownDomains: Set<string>,
  isStaffSender: (from: string | null | undefined) => boolean,
): string | null {
  const address = bareAddress(fromAddress ?? headers["from"]);
  if (!address) return "no_sender";
  const domain = address.split("@")[1] ?? "";
  if (ownDomains.has(domain)) return "own_domain";
  if (isStaffSender(address)) return "staff";
  if (isDeliveryStatusNotification(headers) || isAutoReply(headers)) return "automated";
  const contentType = headers["content-type"]?.toLowerCase() ?? "";
  if (contentType.includes("multipart/report")) return "automated";
  if (LIST_HEADERS.some((name) => headers[name] !== undefined)) return "mailing_list";
  const precedence = headers["precedence"]?.trim().toLowerCase();
  if (precedence === "list") return "mailing_list";
  if (SYSTEM_LOCAL_PART.test(address.split("@")[0] ?? "")) return "system_sender";
  if (carriesWarmupTag(subject) || carriesWarmupTag(text)) return "instantly_warmup";
  return null;
}

function words(text: string | null | undefined, minLength: number): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const token of text.toLowerCase().split(/[^a-z0-9à-ÿ]+/)) {
    if (token.length >= minLength && !STOPWORDS.has(token)) out.add(token);
  }
  return out;
}

function domainRoot(address: string): string | null {
  const labels = (address.split("@")[1] ?? "").split(".");
  const root = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  if (!root || root.length < 3 || FREEMAIL.has(root)) return null;
  return root;
}

function leadSignals(lead: Lead): Array<{ token: string; weight: number }> {
  // A plain lookup in insertion order, never a Map.
  const signals: Record<string, number> = {};
  const order: string[] = [];
  const add = (token: string | null | undefined, weight: number) => {
    if (!token) return;
    const key = token.toLowerCase();
    if (key.length < 2 || STOPWORDS.has(key)) return;
    if (!Object.hasOwn(signals, key)) order.push(key);
    signals[key] = Math.max(Object.hasOwn(signals, key) ? signals[key]! : 0, weight);
  };
  for (const w of words(lead.firstName, 2)) add(w, 2);
  for (const w of words(lead.lastName, 2)) add(w, 3);
  for (const w of words(bareAddress(lead.leadEmail)?.split("@")[0] ?? "", 3)) add(w, 2);
  add(domainRoot(lead.leadEmail), 3);
  for (const w of words(lead.companyName, 4)) add(w, 2);
  for (const w of words(lead.subject, 5)) add(w, 1);
  return order.map((token) => ({ token, weight: signals[token]! }));
}

function rankOrphanReplyLeads(message: Material["message"], leads: Lead[]): Array<{ lead: Lead; score: number }> {
  const address = bareAddress(message.fromAddress) ?? "";
  const recipients = new Set((message.recipients ?? []).map((r) => r.trim().toLowerCase()));
  const tokens = new Set<string>([
    ...words(message.fromAddress, 2),
    ...words(address.split("@")[0] ?? "", 2),
    ...words(message.subject, 2),
    ...words(message.text, 2),
  ]);
  const senderRoot = domainRoot(address);
  if (senderRoot) tokens.add(senderRoot);
  const receivedAt = Date.parse(message.receivedAt);
  const ranked: Array<{ lead: Lead; score: number }> = [];
  for (const lead of leads) {
    if (Date.parse(lead.firstSentAt) > receivedAt) continue;
    if (recipients.has(lead.leadEmail.trim().toLowerCase())) continue;
    let score = 0;
    for (const { token, weight } of leadSignals(lead)) {
      if (tokens.has(token)) score += weight;
    }
    if (score >= ORPHAN_REPLY_MIN_SCORE) ranked.push({ lead, score });
  }
  ranked.sort((a, b) => b.score - a.score || Date.parse(b.lead.lastSentAt) - Date.parse(a.lead.lastSentAt));
  return ranked.slice(0, ORPHAN_REPLY_MAX_LEADS);
}

function describeLead(lead: Lead): string {
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "(no name)";
  const company = lead.companyName ? ` at ${lead.companyName}` : "";
  const subject = lead.subject ? `"${lead.subject}"` : "(no subject)";
  const excerpt = lead.excerpt ? ` It began: "${lead.excerpt}"` : "";
  return `We cold-emailed ${name}${company} <${lead.leadEmail}> from this mailbox, first on ${lead.firstSentAt.slice(0, 10)}, subject ${subject}.${excerpt}`;
}

function buildOrphanReplyQuestion(ranked: Array<{ lead: Lead; score: number }>) {
  const criteria: Record<string, { what: string; examples: string[] }> = {};
  ranked.forEach(({ lead }, index) => {
    criteria[`lead_${index + 1}`] = {
      what: `A person answering our email to this lead. ${describeLead(lead)}`,
      examples: [
        "The lead writing back from a personal or other work address",
        "A colleague or assistant the lead forwarded our email to, answering us",
      ],
    };
  });
  criteria[ORPHAN_REPLY_NONE] = {
    what: "Not an answer to any of the emails above.",
    examples: [
      "Someone pitching their own product or service to us",
      "A newsletter, promotion, notification or automated message",
      "A warmup or test email",
      "A person writing about something none of our emails were about",
    ],
  };
  return {
    type: "choice",
    instructions:
      "This email arrived in a mailbox we use for cold outreach. It is NOT threaded onto any email we sent, so it may be: a prospect answering our pitch from ANOTHER address (their personal account, another job), a colleague they forwarded our email to who now writes to us, or ordinary unrelated mail (pitches to us, spam, newsletters, warmup traffic). Pick the lead it answers only when the email itself shows it is that person, or someone acting for them, responding to our email: their name or signature, a reference to what we wrote, a quoted copy of our email. A shared first name alone is not enough. When in doubt, answer none.",
    criteria,
  };
}

function buildOrphanReplyState(message: Material["message"]): string {
  const body = message.text?.trim()
    ? message.text.trim().slice(0, 3000)
    : "(the body of this email could not be read; judge from the sender and subject)";
  return [
    `From: ${message.fromAddress ?? "(unknown)"}`,
    `To: ${message.toAddress}`,
    `Date: ${message.receivedAt}`,
    `Subject: ${message.subject ?? "(none)"}`,
    "",
    body,
  ].join("\n");
}
