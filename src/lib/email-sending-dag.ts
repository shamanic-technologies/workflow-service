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
 *  - The person is CLAIMED from this campaign's own queue (`claim-next`, atomic, at most one, exactly once), like
 *    every reactive campaign. Nobody due ends the run idle.
 *  - The email is read off `flow_input.trigger`, and ONLY when the trigger names the person claimed (email,
 *    case-folded). A claimed person this run carries no email for is never written to: the row is stopped
 *    (`pushed_email_missing`), named in the log, and the run fails, since there is nothing we may invent for them.
 *  - Subject and body go to email-gateway's BROADCAST send verbatim, the same path every cold-email workflow uses
 *    (Instantly, our inboxes): deliverability, tracking, the Unibox, threaded replies and stats are unchanged, and
 *    a positive reply fires `positive_reply_received` like any campaign reply. A body pushed as text only gets an
 *    HTML twin made by escaping it and turning line breaks into `<br>`; the text itself is sent as `bodyText`.
 *  - The send's idempotency key names the occurrence (`eventId`), so a re-run never sends the same push twice.
 *  - A send email-gateway REFUSES for this person (`lead_opted_out`, `recent_brand_contact`) sends nothing and
 *    stops the row (`pushed_email_refused`), named in the log.
 *  - Strictly AFTER the send, the row is marked `stopped` (`pushed_email_sent`): not a tombstone, so the next email
 *    the client pushes to the same person is sent too.
 */
import type { DAG } from "./dag-validator.js";
import { REFUSAL_SKIP_CODES } from "./dag-to-openflow.js";

export const EMAIL_SENDING_FEATURE_SLUG = "email-sending";

/**
 * The leg this pipe performs (features-service catalogue). Owner 2026-10-13: a campaign always ends at Paid client and
 * its outcome is a positive reply, like cold email, so the leg is Start -> conversation, never "email sent".
 */
export const EMAIL_SENDING_LEG_KEY = "start_to_conversation";

export const EMAIL_SENDING_PIPE_ID = `${EMAIL_SENDING_FEATURE_SLUG}|${EMAIL_SENDING_LEG_KEY}`;

export const EMAIL_SENDING_DESCRIPTION =
  "Sends an email the client wrote and pushed through the API, exactly as written (their subject, their body), " +
  "to the person they named, from our domains and inboxes. Nothing is rewritten. Replies land in the Unibox like " +
  "any campaign reply.";

/** Stored on the queue row once the email went out: stopped, so the next pushed email to them is sent too. */
export const PUSHED_EMAIL_SENT_REASON = "pushed_email_sent";

/** Stored when email-gateway refused the email for this person (opted out, or already in a thread with the brand). */
export const PUSHED_EMAIL_REFUSED_REASON = "pushed_email_refused";

/** Stored when this run carries no pushed email for the person it claimed: nothing was sent. */
export const PUSHED_EMAIL_MISSING_REASON = "pushed_email_missing";

/**
 * The claimed person and the email pushed for them, untouched. Returns `ok: false` (never throws) when the trigger
 * names someone else or carries no usable email, so the row can be stopped rather than handed out again.
 */
export const RESOLVE_EMAIL_CODE = `
export async function main(claim, trigger) {
  const f = claim?.followup ?? {};
  if (!f.id || !f.email) throw new Error("resolve-email: a claimed row carries no id or email");
  const fold = (s) => typeof s === "string" ? s.trim().toLowerCase() : null;
  const t = trigger && typeof trigger === "object" ? trigger : null;
  const base = { rowId: f.id, leadId: f.leadId ?? null, email: f.email };
  const missing = (why) => {
    console.error("[email-sending] nothing sent to " + String(f.email) + ": " + why);
    return { ...base, ok: false, why };
  };
  if (!t) return missing("this run carries no trigger");
  if (fold(t.person?.email) === null || fold(t.person?.email) !== fold(f.email)) {
    return missing("this run's trigger names " + String(t.person?.email ?? "nobody"));
  }
  const item = t.item && typeof t.item === "object" ? t.item : {};
  const filled = (v) => typeof v === "string" && v.trim() !== "";
  if (!filled(item.subject)) return missing("the pushed email has no subject");
  if (!filled(item.bodyHtml) && !filled(item.bodyText)) return missing("the pushed email has no body");
  if (!t.eventId) return missing("the trigger carries no eventId to key the send on");
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

const endRun = (id: string, body: Record<string, unknown>) => ({
  id,
  type: "http.call" as const,
  config: { service: "campaign", method: "POST", path: "/end-run", body },
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
/** The run claimed someone it carries no pushed email for. */
export const NO_EMAIL = "results['resolve-email']?.ok == false";
/** The email went out: the send returned without a refusal. */
export const SENT = "results['resolve-email']?.ok == true && results['send-email'] != null && results['send-email']?.skipped != true";
/** email-gateway refused the email for this person. */
export const REFUSED = "results['resolve-email']?.ok == true && results['send-email']?.skipped == true";

export function buildEmailSendingDag(): DAG {
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" },
      },
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      // THIS campaign's own queue: campaign-service made the pushed person due on it right before the dispatch.
      {
        id: "claim-followup",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/campaigns/{campaignId}/followups/claim-next" },
        retries: 0,
        inputMapping: { "params.campaignId": "$ref:flow_input.campaignId" },
      },
      { id: "check-claim", type: "condition" },
      // The person's timezone, so the send lands in their business hours like every cold email.
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
        id: "resolve-email",
        type: "script",
        config: { code: RESOLVE_EMAIL_CODE },
        retries: 0,
        inputMapping: { claim: "$ref:claim-followup.output", trigger: "$ref:flow_input.trigger" },
      },
      // Converges (edge from claim-followup, outside check-claim's branch) so it is a top-level branchone.
      { id: "check-email", type: "condition" },
      // The client's email, verbatim, from our sending infra: lands in the Unibox, the reply is threaded there.
      {
        id: "send-email",
        type: "http.call",
        config: {
          service: "email-gateway",
          method: "POST",
          path: "/orgs/send",
          body: { type: "broadcast", tag: "email-sending" },
          validateResponse: { field: "success", equals: true },
          // Read, not thrown: an opted-out person or one the brand already talks to is an outcome (check-sent).
          skipOnRefusalCodes: [...REFUSAL_SKIP_CODES],
        },
        retries: 0,
        inputMapping: {
          "body.to": "$ref:resolve-email.output.email",
          "body.subject": "$ref:resolve-email.output.subject",
          "body.sequence": "$ref:resolve-email.output.sequence",
          "body.idempotencyKey": "$ref:resolve-email.output.idempotencyKey",
          "body.leadId": "$ref:resolve-email.output.leadId",
          "body.campaignId": "$ref:flow_input.campaignId",
          "body.workflowSlug": "$ref:start-run.output.workflowSlug",
          "body.timezone": "$ref:lead-detail.output.leadDetail.lead.timezone",
        },
      },
      // Converges (edge from claim-followup) so it is top level; reads positive evidence of each outcome.
      { id: "check-sent", type: "condition" },
      // Strictly AFTER the send. Stopped, not handed: the next email pushed to the same person is sent too.
      stopRow("record-sent", PUSHED_EMAIL_SENT_REASON),
      stopRow("record-refused", PUSHED_EMAIL_REFUSED_REASON),
      stopRow("record-missing", PUSHED_EMAIL_MISSING_REASON),
      endRun("end-run", { success: true, stopCampaign: false }),
      endRun("end-run-refused", { success: true, stopCampaign: false }),
      endRun("end-run-missing", { success: false, stopCampaign: false }),
      endRun("end-run-nobody-due", { success: true, stopCampaign: false, noWorkAvailable: true }),
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "claim-followup" },
      { from: "claim-followup", to: "check-claim" },
      { from: "check-claim", to: "lead-detail", condition: "results['claim-followup']?.found == true" },
      { from: "check-claim", to: "end-run-nobody-due", condition: "results['claim-followup']?.found != true" },
      { from: "lead-detail", to: "resolve-email" },
      { from: "resolve-email", to: "check-email" },
      { from: "claim-followup", to: "check-email" },
      { from: "check-email", to: "send-email", condition: HAS_EMAIL },
      { from: "check-email", to: "record-missing", condition: NO_EMAIL },
      { from: "record-missing", to: "end-run-missing" },
      { from: "send-email", to: "check-sent" },
      { from: "claim-followup", to: "check-sent" },
      { from: "check-sent", to: "record-sent", condition: SENT },
      { from: "check-sent", to: "record-refused", condition: REFUSED },
      { from: "record-sent", to: "end-run" },
      { from: "record-refused", to: "end-run-refused" },
    ],
    onError: "end-run-error",
  };
}
