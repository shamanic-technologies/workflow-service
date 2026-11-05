// MIGRATE-1105 S4b: the old workflow's step code, kept only as what the stored script conversation/dy_pushed_email was generated from.
// The DAG and its workflow are gone (retired 2026-11-05, the script live since); fix the script by an UPGRADE of its dynasty.
/**
 * The DAG of the `email-sending|start_to_conversation` pipe (Start -> Positive reply, REACTIVE on the
 * `email_pushed_via_api` trigger): a client wrote an email themselves and pushed it through the API (their own key,
 * the distribute MCP, or Claude Code). We SEND it exactly as written, from our domains and inboxes; nothing is
 * written, rewritten or judged by a model.
 *
 * How the person gets here: api-service forwards the push to campaign-service's generic trigger door
 * (`POST /internal/trigger-events`, the same door every reactive trigger uses) with `person: {email, name?}` and
 * `item: {subject, bodyHtml?, bodyText?}` (at least one body). campaign-service files the person on the campaign's
 * own lead-service follow-up queue, due now, and dispatches this workflow with the occurrence as
 * `flow_input.trigger` (`{ eventId, triggerId, leadId, person, item }`).
 *
 * One run sends EXACTLY ONE email:
 *
 *  - Only a run CARRYING a pushed email claims anyone. campaign-service also dispatches reactive campaigns on its own
 *    schedule, with no trigger; such a run claims nobody and ends idle. (It used to claim the person a push had made
 *    due two seconds earlier, find no email on itself, and stop them: DefiniteJobs' first push, 2026-10-13.)
 *  - A run carrying a push CLAIMS from this campaign's own queue (`claim-next`, atomic, at most one, exactly once).
 *    Nobody claimable FAILS the run (its person was made due right before the dispatch), so campaign-service
 *    redelivers the occurrence.
 *  - The email is used ONLY when the trigger names the person claimed (email, case-folded). Claimed someone else:
 *    nothing is sent, their row is left alone (the claim lapses after an hour, their own occurrence answers them),
 *    and the run fails so this occurrence is redelivered. The trigger names the person but carries no usable
 *    subject or body: nothing may be invented, the row is stopped (`pushed_email_missing`) and the run fails.
 *  - Subject and body go to email-gateway's BROADCAST send verbatim, the same path every cold-email workflow uses
 *    (Instantly, our inboxes): deliverability, tracking, the Unibox, threaded replies and stats are unchanged, and
 *    a positive reply fires `positive_reply_received` like any campaign reply. A body pushed as text only gets an
 *    HTML twin made by escaping it and turning line breaks into `<br>`; the text itself is sent as `bodyText`.
 *  - The send's idempotency key names the occurrence (`eventId`), so a re-run never sends the same push twice.
 *  - A send the sender REFUSES with a 409 naming a code (`lead_opted_out`, `recent_brand_contact`,
 *    `email_not_verified`, any code it names) sends nothing, stops the row (`pushed_email_refused`) and ends the run
 *    as a normal run telling campaign-service `delivery: {state: "refused", code, reason}` (verbatim): the occurrence
 *    ends at once and the client reads why (PUSHED-TRUTH-1015, `occurrence-delivery.ts`). A 5xx, transport error or
 *    402 still fails the run (redelivered, bounded). A sent email ends with `delivery: {state: "delivered"}`.
 *  - Strictly AFTER the send, the row is marked `stopped` (`pushed_email_sent`): not a tombstone, so the next email
 *    the client pushes to the same person is sent too.
 */
import { DELIVERED, OCCURRENCE_SEND_REFUSAL_CODES, refusedDelivery } from "../../src/lib/occurrence-delivery.js";

export const EMAIL_SENDING_FEATURE_SLUG = "email-sending";

/**
 * The leg this pipe performs (features-service catalogue). Owner 2026-10-13: a campaign always ends at Paid client and
 * its outcome is a positive reply, like cold email, so the leg is Start -> conversation, never "email sent".
 */
export const EMAIL_SENDING_LEG_KEY = "start_to_conversation";

export const EMAIL_SENDING_PIPE_ID = `${EMAIL_SENDING_FEATURE_SLUG}|${EMAIL_SENDING_LEG_KEY}`;

export const EMAIL_SENDING_DESCRIPTION =
  "Sends an email the client wrote and pushed through the API, exactly as written, to the person they named from our inboxes, with replies landing in the Unibox like any campaign reply.";

/** Stored on the queue row once the email went out: stopped, so the next pushed email to them is sent too. */
export const PUSHED_EMAIL_SENT_REASON = "pushed_email_sent";

/** Stored when email-gateway refused the email for this person (opted out, or already in a thread with the brand). */
export const PUSHED_EMAIL_REFUSED_REASON = "pushed_email_refused";

/** Stored when this run carries no pushed email for the person it claimed: nothing was sent. */
export const PUSHED_EMAIL_MISSING_REASON = "pushed_email_missing";

/** Whether this run carries a pushed email for someone: a run that does not claims nobody. Pure. */
export const PLAN_CLAIM_CODE = `
export async function main(trigger) {
  const email = trigger && typeof trigger === "object" ? trigger.person?.email : null;
  const carries = typeof email === "string" && email.trim() !== "";
  if (!carries) console.log("[email-sending] this run carries no pushed email: nobody is claimed");
  return { skip: !carries };
}
`.trim();

/**
 * The claimed person and the email pushed for them, untouched. Returns `ok: false` (never throws) when the trigger
 * names someone else (`stopRow: false`: their row is not ours to touch) or carries no usable email for them
 * (`stopRow: true`).
 */
export const RESOLVE_EMAIL_CODE = `
export async function main(claim, trigger) {
  const f = claim?.followup ?? {};
  if (!f.id || !f.email) throw new Error("resolve-email: a claimed row carries no id or email");
  const fold = (s) => typeof s === "string" ? s.trim().toLowerCase() : null;
  const t = trigger && typeof trigger === "object" ? trigger : null;
  const base = { rowId: f.id, leadId: f.leadId ?? null, email: f.email };
  const missing = (why, stopRow) => {
    console.error("[email-sending] nothing sent to " + String(f.email) + ": " + why);
    return { ...base, ok: false, stopRow, why };
  };
  if (!t) return missing("this run carries no trigger", false);
  if (fold(t.person?.email) === null || fold(t.person?.email) !== fold(f.email)) {
    return missing("this run's trigger names " + String(t.person?.email ?? "nobody"), false);
  }
  const item = t.item && typeof t.item === "object" ? t.item : {};
  const filled = (v) => typeof v === "string" && v.trim() !== "";
  if (!filled(item.subject)) return missing("the pushed email has no subject", true);
  if (!filled(item.bodyHtml) && !filled(item.bodyText)) return missing("the pushed email has no body", true);
  if (!t.eventId) return missing("the trigger carries no eventId to key the send on", true);
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const bodyHtml = filled(item.bodyHtml) ? item.bodyHtml : escape(item.bodyText).replace(/\\r?\\n/g, "<br>");
  const step = { step: 1, bodyHtml, daysSinceLastStep: 0 };
  if (filled(item.bodyText)) step.bodyText = item.bodyText;
  return {
    ...base,
    ok: true,
    subject: item.subject,
    sequence: [step],
    idempotencyKey: "email-sending:" + t.eventId,
  };
}
`.trim();

const endRun = (id: string, body: Record<string, unknown>, inputMapping?: Record<string, string>) => ({
  id,
  type: "http.call" as const,
  config: { service: "campaign", method: "POST", path: "/end-run", body },
  ...(inputMapping ? { inputMapping } : {}),
});

const stopRow = (id: string, reason: string) => ({
  id,
  type: "http.call" as const,
  config: { service: "lead", method: "POST", path: "/orgs/leads/{id}/followups", body: { kind: "stopped", reason } },
  retries: 0,
  inputMapping: { "params.id": "$ref:resolve-email.output.rowId" },
});

/** The run has a pushed email for the person it claimed. */
export const HAS_EMAIL = "results['resolve-email']?.ok == true";
/** The trigger names the claimed person but carries no usable email: the row is stopped. */
export const NO_EMAIL = "results['resolve-email']?.ok == false && results['resolve-email']?.stopRow == true";
/** The run claimed someone its trigger does not name: their row is left alone. */
export const OTHER_PERSON = "results['resolve-email']?.ok == false && results['resolve-email']?.stopRow != true";
/** A run carrying no push: it claimed nobody on purpose. */
export const NOBODY_DUE = "results['claim-followup']?.found != true && results['plan-claim']?.skip == true";
/** A run carrying a push found nobody claimable: fails, so the occurrence is redelivered. */
export const UNCLAIMED = "results['claim-followup']?.found != true && results['plan-claim']?.skip != true";
/** The email went out: the send returned without a refusal. */
export const SENT = "results['resolve-email']?.ok == true && results['send-email'] != null && results['send-email']?.skipped != true";
/** The sender refused the email for this person (any 409 naming a code). */
export const REFUSED = "results['resolve-email']?.ok == true && results['send-email']?.skipped == true";
