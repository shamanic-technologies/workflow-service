/**
 * EVERY WHATSAPP WRITER SENDS SEVERAL SHORT BUBBLES, NEVER ONE COMPOSED BLOCK (WA-BUBBLES-1023, owner 2026-10-23,
 * about a one-block welcome sent to a signup: « c'est quoi cette merde de WA message […] Tu ne peux pas envoyer des
 * multi messages pour faire plus naturel ? »).
 *
 * One text for the fleet, whatever the writer (cold WhatsApp outreach, the follow-up channel, the meeting-booking
 * responder, the form responder):
 *  - the model writes the message as the bubbles the person will receive, in order, separated by ONE EMPTY LINE
 *    (`whatsappBubblesStrategy`): its rhythm is copied from what the owner typed himself on WhatsApp;
 *  - `BUBBLES_FN` splits that text on empty lines (a single line break stays inside a bubble), mechanically: no
 *    count check, no length check, no retry on shape (the model is trusted);
 *  - crm-service delivers them as separate WhatsApp messages, in order, paced like a person typing, each bubble
 *    idempotent on its own (`WHATSAPP_BUBBLES_FIELD`, crm-service's contract).
 *
 * Never a per-writer variant of this text, a per-brand rule, or a canned split.
 */

/** Where the voice to copy comes from, said to the model. */
export type BubbleVoiceSource = "owner" | "persona";

/** How the model marks where one bubble ends: an empty line in plain text, or one `<p>` per bubble in HTML. */
export type BubbleSplit = "empty-line" | "paragraph";

/** How the message lands on their phone: the bubbles, one idea each, in the rhythm the owner texts in. */
export const whatsappBubblesStrategy = (voice: BubbleVoiceSource, split: BubbleSplit = "empty-line"): string =>
  [
    "HOW IT LANDS ON THEIR PHONE: on WhatsApp people text in several short bubbles, never one composed block. Write the message as the bubbles they will receive, in order, " +
      (split === "empty-line" ? "separated by ONE EMPTY LINE" : "each bubble in its own <p>") +
      ": each bubble arrives as its own WhatsApp message, a few seconds after the one before.",
    "One idea per bubble, casual, as short as a text typed on a phone. " +
      (voice === "owner"
        ? "Copy the rhythm of HIS OWN MESSAGES: how many bubbles he sends in a row, how long each one is, how he opens, his punctuation and capitalisation (often no final period), his emojis (none unless he uses them)."
        : "Text like a person on their phone: no greeting paragraph, emojis only if the thread uses them. When messages typed by people of the brand are shown, copy their rhythm (bubble count, length, punctuation), never their identity."),
    "Usually 2 to 4 bubbles; a one-line answer can be one bubble. " +
      (split === "empty-line"
        ? "A single line break inside a bubble is fine (a short list); an empty line always starts a new bubble."
        : "A <br> inside a <p> is fine (a short list); a new <p> always starts a new bubble.") +
      " Never an em dash or an en dash.",
  ].join(" ");

/**
 * The bubbles of a written message, in order: split on empty lines, each trimmed, empty ones dropped. Mechanical only:
 * a message with no empty line is one bubble.
 */
export const BUBBLES_FN = `
function bubblesOf(text) {
  return String(text ?? "").replace(/\\r\\n/g, "\\n").split(/\\n[ \\t]*\\n/).map((b) => b.trim()).filter((b) => b !== "");
}
`.trim();

/** crm-service's cap on the messages of one send (`messages`, 1 to 5). */
export const MAX_BUBBLES = 5;


/** A JS mirror of `BUBBLES_FN` for tests and scripts. */
export function bubblesOf(text: unknown): string[] {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((b) => b.trim())
    .filter((b) => b !== "");
}

/**
 * Owner messages typed within this many seconds of the previous or next outbound message of the same thread are an
 * AUTOMATED burst (an agent writing through his account sends a bubble every ~1.5 s), never his hand: they are left
 * out of the voice the writers copy. His own bubbles land several seconds apart at the least.
 */
export const BURST_GAP_SECONDS = 4;

/**
 * Keeps only the messages a person typed by hand from a thread's outbound messages (each with `at`): any message
 * within `BURST_GAP_SECONDS` of its outbound neighbour is part of an automated burst and dropped.
 */
export const HAND_TYPED_FN = `
function handTyped(outbound) {
  const t = (i) => Date.parse(String(i?.at ?? ""));
  const sorted = [...outbound].sort((a, b) => (t(a) || 0) - (t(b) || 0));
  return sorted.filter((i, k) => {
    const at = t(i);
    if (!Number.isFinite(at)) return true;
    const near = (j) => j >= 0 && j < sorted.length && Number.isFinite(t(sorted[j])) && Math.abs(t(sorted[j]) - at) < ${BURST_GAP_SECONDS} * 1000;
    return !near(k - 1) && !near(k + 1);
  });
}
`.trim();

/**
 * The text fields of a crm-service WhatsApp send for a written message: one bubble = `text` (the single-text send,
 * byte-identical to before), several = `messages` (crm-service delivers them in order, paced like a person typing,
 * idempotent per bubble). Bubbles past crm-service's cap are folded into the last one, mechanically.
 */
export const BUBBLE_SEND_FN = `
function bubbleSendFields(text) {
  const all = bubblesOf(text);
  if (all.length <= 1) return { text: all[0] ?? "" };
  if (all.length <= ${MAX_BUBBLES}) return { messages: all };
  return { messages: [...all.slice(0, ${MAX_BUBBLES} - 1), all.slice(${MAX_BUBBLES} - 1).join("\\n\\n")] };
}

${BUBBLES_FN}
`.trim();
