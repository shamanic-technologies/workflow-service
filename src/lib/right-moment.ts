/**
 * THE RIGHT MOMENT OR LATER (RIGHT-MOMENT-OR-LATER-1014), shared by every writer that follows up ONE known person by
 * email (`ai-follow-up-email`, both prospect follow-ups). Owner Kevin, 2026-10-14, after a writer emailed a client
 * a second time about something he had already answered by hand in the Unibox: « si j'ai déjà répondu tu devrais le
 * savoir instantanément et ne pas envoyer une deuxième reply », and « elle n'est PAS TRAITÉE ! Tu remets une date
 * plus tard pour le followup, ou tu décides si c'est le bon moment de followup ».
 *
 * At each run the model reads the whole thread and the person's events and decides ONE of:
 *  - `write`: now is the right moment. The email goes out IN the thread they wrote in last (the send states
 *    `followUp: true`: the sender continues the brand's thread with them, same mailbox, `Re:` its subject), and the
 *    model states the next follow-up date.
 *  - `later`: not now (we already answered them, the point was already made, they have not answered our last
 *    message yet). NOTHING is sent and the model states a later date from the history. A later is never a stop:
 *    "already answered" never closes the person.
 *  - `stop`: only on the person's OWN words (they opted out / asked us to stop, or showed they are not a fit at all).
 *    Opt-outs, bounces, positive replies and meetings are also ended upstream by whoever owns them (lead-service's
 *    queue and verdict, the sender's refusals).
 *
 * A message a trigger OCCURRENCE made due plays the same game (TRIGGER-RIGHT-MOMENT-1016): a fact makes it owed,
 * never "now whatever the thread says", and THEIR LOCAL TIME (`localTimeStrategy` + `LOCAL_TIME_FN`) is part of the
 * moment for every writer that judges one.
 *
 * Generic: no branch per brand, per trigger or per writer, and one game for every channel (`rightMomentStrategy`, the
 * channel only names its message: email, WhatsApp); each writer only decides WHERE its date
 * lives (its own follow-up queue row, or the follow-up date trigger) and calls the same text and checks.
 */
import { REFUSAL_SKIP_CODES } from "./dag-to-openflow.js";

/**
 * Send refusals that are NOT a stop: a step of the brand's sequence to them is still queued (two of our emails would
 * race), the brand is in a thread with them right now, or their latest thread is in a connected Gmail mailbox whose
 * Google grant lacks send access (`google_send_permission_missing`: the org owner must reconnect Google; failing the
 * run instead would re-claim and re-draft them every hour). Nothing was sent; the person stays followed up at the
 * model's date.
 */
export const PASSING_REFUSAL_CODES = ["brand_sequence_queued", "recent_brand_contact", "google_send_permission_missing"] as const;

/** Every per-person refusal a follow-up send reads as an outcome: the passing ones, and the stops (opted out, not a prospect). */
export const FOLLOW_UP_SEND_REFUSAL_CODES = [...new Set([...REFUSAL_SKIP_CODES, ...PASSING_REFUSAL_CODES, "lead_not_a_prospect"])];

/** `results['<sendNode>']` refused for a passing reason (an expression for a DAG edge condition). */
export const passingRefusal = (sendNode: string): string =>
  PASSING_REFUSAL_CODES.map((c) => `results['${sendNode}']?.code == '${c}'`).join(" || ");

/** The decisions every right-moment writer's model may return (a writer may add its own, e.g. `cannot_write`). */
export const RIGHT_MOMENT_DECISIONS = ["write", "later", "stop"] as const;

/** The furthest a next follow-up date may be (lead-service refuses a due date more than a year out). */
export const MAX_NEXT_FOLLOW_UP_DAYS = 365;

/**
 * The words a channel puts in the shared game: the game itself is ONE text, whatever the channel (owner 2026-10-15,
 * WA-FOLLOWUP-LOOP-1015: a WhatsApp conversation is followed up exactly like an email one).
 */
export interface RightMomentMedium {
  /** What one message is called ("email", "WhatsApp message"). */
  message: string;
  /** The plural of an automated one ("automated email"). */
  automated: string;
  /** What to leave empty when nothing is sent. */
  emptyFields: string;
  /** Where a written message goes. */
  whereItGoes: string;
  /** Plural noun for the history ("emails", "messages"). */
  many: string;
}

export const EMAIL_MEDIUM: RightMomentMedium = {
  message: "email",
  automated: "automated email",
  emptyFields: "leave subject and bodyHtml empty",
  whereItGoes: "the email is a reply in the thread they wrote in last",
  many: "emails",
};

export const WHATSAPP_MEDIUM: RightMomentMedium = {
  message: "WhatsApp message",
  automated: "automated message",
  emptyFields: "leave message empty",
  whereItGoes: "the message continues the WhatsApp conversation we already have with them, from the same number",
  many: "messages",
};

/**
 * The game, word for word in every writer's system prompt. Kept free of em and en dashes: the model copies the
 * style of its prompt.
 */
export const rightMomentStrategy = (m: RightMomentMedium): string =>
  [
    "THE RIGHT MOMENT. Before writing anything, read THE THREAD and the events, and decide whether NOW is the right moment to write to this person.",
    "It is NOT the right moment when someone on our side already wrote to them after their last message and they have not answered it yet (a person of our team writing by hand counts exactly like an " + m.automated + "), or when what this " + m.message + " would say was already said to them. Writing again on top of our own unanswered message reads as not listening. Then set decision to later: nothing is sent, " + m.emptyFields + ", and choose nextFollowUpAt from the history (how recently we wrote, what we told them and when, anything they said about timing).",
    "It IS the right moment when they are waiting for us (their message is the last one and nobody on our side answered it), or when enough time passed since our last message for a new, useful follow-up. Then set decision to write: " + m.whereItGoes + ", so never re-introduce us and never repeat what the thread already says.",
    "later is never the end: the person stays followed up at the date you choose.",
  ].join("\n");

/** How the model picks the next date, word for word in every writer's system prompt (dash-free, see above). */
export const nextDateStrategy = (m: RightMomentMedium): string =>
  "THE NEXT DATE. Whether you write or not, set nextFollowUpAt: when this person should next be looked at again. " +
  "There is no fixed schedule. Decide it from the history: how many times we already wrote and how recently, whether " +
  "they did anything since (a click, a visit or a signup means they are warm: sooner), long silence after many " +
  m.many + " (wait longer, weeks or months), and anything they or we said about timing (honour it exactly). Pick a " +
  "working day and a working hour in their timezone when you know it. ISO 8601 date-time in UTC, strictly after " +
  "NOW, at most " + MAX_NEXT_FOLLOW_UP_DAYS + " days away. Say why in nextFollowUpWhy.";

/**
 * THEIR LOCAL TIME (TRIGGER-RIGHT-MOMENT-1016, owner Kevin 2026-10-16: « tu prends en compte la timezone du client
 * ????? », after a trigger WhatsApp landed at 08:27 on someone we had written to at midnight their time). A message
 * lands the moment it is sent, so the hour where THEY are is part of the right moment. Rendered beside
 * `LOCAL_TIME_FN`'s lines; no quiet-hours list per brand, the model judges the hour from their local time. Dash-free.
 */
export const localTimeStrategy = (m: RightMomentMedium): string =>
  "THEIR LOCAL TIME. A " + m.message + " reaches them the moment it is sent. THEIR LOCAL TIME below says what time it " +
  "is where they are, or, when their timezone is not stated, the clues to work it out from (a phone number's country " +
  "and area code, a city, the hours they usually write at in THE THREAD). Work out their local time first. Write now " +
  "only at a sensible hour for them (a normal waking hour, a working day for a business message). Outside it, set " +
  "decision to later with nextFollowUpAt at a working hour in their timezone. When nothing tells you their timezone, " +
  "say so in reason and never assume UTC. Any day or time you put in the " + m.message + " is in their timezone, never UTC.";

/**
 * `localTimeLines(nowIso, clues)`: the person's local time as plain lines. `clues`: `{timezone, city, country, phone}`.
 * A stated IANA timezone gives the exact local time; otherwise the clues are listed for the model and an unknown
 * timezone is said in words (never UTC silently). Script text, appended after `main` (function declarations hoist).
 */
export const LOCAL_TIME_FN = `
function localTimeLines(nowIso, clues) {
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const now = new Date(String(nowIso ?? ""));
  const at = Number.isFinite(now.getTime()) ? now : new Date();
  const tz = s(clues?.timezone);
  if (tz) {
    try {
      const local = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
      return ["Their local time now: " + local + " (" + tz + ")."];
    } catch {
      // Not an IANA name: read as a clue below.
    }
  }
  const found = [
    tz ? "timezone as stated: " + tz : null,
    s(clues?.phone) ? "phone " + s(clues.phone) : null,
    [s(clues?.city), s(clues?.country)].filter(Boolean).join(", ") || null,
  ].filter(Boolean);
  if (found.length) {
    return ["Their timezone is not stated. Clues: " + found.join("; ") + ". Work out their local time from them (now is " + at.toISOString() + " in UTC)."];
  }
  return ["Their timezone is unknown and nothing hints at it (no phone, no city). Judge from the hours they write at in THE THREAD, and never assume UTC."];
}
`.trim();

/** The email writers' game (ai-follow-up-email, both prospect follow-ups). */
export const RIGHT_MOMENT_STRATEGY = rightMomentStrategy(EMAIL_MEDIUM);

/** The email writers' next-date rule. */
export const NEXT_DATE_STRATEGY = nextDateStrategy(EMAIL_MEDIUM);

/** The schema properties every right-moment writer adds for the next date. */
export const NEXT_DATE_SCHEMA_PROPERTIES = {
  nextFollowUpAt: {
    type: "string",
    description: "When the NEXT follow-up is due (decision write or later), ISO 8601 date-time in UTC, strictly after now. Empty when decision is stop.",
  },
  nextFollowUpWhy: { type: "string", description: "One sentence: why that date, from the history." },
} as const;

/**
 * `nextDate(json, label)`: the model's next date held to its contract strictly BEFORE anything is sent or recorded:
 * a date, strictly in the future, at most a year out (lead-service refuses beyond). Throws otherwise: a write whose
 * next date cannot be recorded, or a later with no date, is the dead end this exists to prevent. Script text,
 * appended after `main` in a Windmill rawscript (function declarations hoist).
 */
export const NEXT_DATE_FN = `
function nextDate(json, label) {
  const at = Date.parse(String(json?.nextFollowUpAt ?? ""));
  if (!Number.isFinite(at)) throw new Error(label + ": the next follow-up date is not a date: " + JSON.stringify(json?.nextFollowUpAt));
  if (at <= Date.now()) throw new Error(label + ": the next follow-up date is not in the future: " + JSON.stringify(json?.nextFollowUpAt));
  if (at > Date.now() + ${MAX_NEXT_FOLLOW_UP_DAYS} * 86400000) {
    throw new Error(label + ": the next follow-up date is more than ${MAX_NEXT_FOLLOW_UP_DAYS} days away: " + JSON.stringify(json?.nextFollowUpAt));
  }
  return { nextFollowUpAt: new Date(at).toISOString(), nextFollowUpWhy: String(json?.nextFollowUpWhy ?? "") };
}
`.trim();
