/**
 * MIGRATE-1105 S4: the pushed-email Engine run as ONE stored script, ported from the Email Sending workflow DAG
 * (`email-sending-steps.ts`, the deleted DAG's steps) step by step: a client pushed an email through the API; it is sent exactly as written
 * (no model anywhere), from our inboxes, to the person the push names.
 *
 *   lead-service    claims the pushed person on this campaign's own queue (only a run carrying a push claims);
 *   lead-service    their timezone (the send lands in their business hours);
 *   email-gateway   the broadcast send, verbatim, keyed on the occurrence (a redelivery never sends twice);
 *   lead-service    the row stopped `pushed_email_sent` / `_refused` / `_missing` strictly after the send.
 *
 * Answers: `null` = a run carrying no push (idle); `{content: {end}}` = sent; `unmade "<code>: <why>"` = the sender
 * refused (a final refusal the client reads); a throw = the run failed (redelivered), exactly the DAG's failures.
 * Tactics: `channel` email-sending, `recorded_by` email-gateway (the sender records the send).
 */
import { asFunction, PORT_HEAD } from "./port-kit.js";
import {
  EMAIL_SENDING_FEATURE_SLUG,
  PLAN_CLAIM_CODE,
  PUSHED_EMAIL_MISSING_REASON,
  PUSHED_EMAIL_REFUSED_REASON,
  PUSHED_EMAIL_SENT_REASON,
  RESOLVE_EMAIL_CODE,
} from "./email-sending-steps.js";

export const EMAIL_SENDING_OUTCOME = "conversation";
export const EMAIL_SENDING_DYNASTY = "dy_pushed_email";
export const EMAIL_SENDING_TACTICS = { channel: EMAIL_SENDING_FEATURE_SLUG, recorded_by: "email-gateway" };

export function buildEmailSendingSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** Email sending: the email a client pushed, sent exactly as written to the person it names (MIGRATE-1105 S4). */`,
    `const BRIEF_HEADER = "";`,
    PORT_HEAD,
    asFunction(PLAN_CLAIM_CODE, "planClaim"),
    asFunction(RESOLVE_EMAIL_CODE, "resolveEmail"),
    `
export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const trigger = R.trigger ?? null;
  const campaignId = R.campaignId;
  const plan = planClaim(trigger);
  if (plan.skip === true) return null;
  const claim = must(ctx, "lead.followup.claim", { params: { campaignId } });
  if (claim.found !== true) throw new Error("email-sending: the pushed person was made due but nobody could be claimed (" + String(claim.reason ?? "no reason") + ")");
  const detail = must(ctx, "lead.detail", { params: { id: claim.followup.id }, query: { campaignId } });
  const email = resolveEmail(claim, trigger);
  const stopRow = (reason: string) => must(ctx, "lead.followup.record", { params: { id: email.rowId }, body: { kind: "stopped", reason } });
  if (email.ok !== true) {
    if (email.stopRow === true) stopRow(${JSON.stringify(PUSHED_EMAIL_MISSING_REASON)});
    throw new Error("email-sending: nothing sent: " + String(email.why));
  }
  const sent: Answer = ctx.vendor.call("email.send", {
    body: {
      type: "broadcast",
      tag: ${JSON.stringify(EMAIL_SENDING_FEATURE_SLUG)},
      to: email.email,
      subject: email.subject,
      sequence: email.sequence,
      idempotencyKey: email.idempotencyKey,
      leadId: email.leadId,
      campaignId,
      timezone: detail?.leadDetail?.lead?.timezone,
    },
  });
  if (!sent.ok) {
    // Any 409 naming a code is the sender's final word for this person (PUSHED-TRUTH-1015); anything else fails.
    const code = sent.data.code;
    if (sent.data.status !== 409 || typeof code !== "string" || !code) throw new Error("email.send failed (" + String(sent.data.status ?? "") + "): " + String(sent.data.error ?? "").slice(0, 500));
    stopRow(${JSON.stringify(PUSHED_EMAIL_REFUSED_REASON)});
    return { unmade: code + ": " + String(sent.data.error ?? code) };
  }
  if (sent.data.success !== true) throw new Error("email.send answered without success: " + JSON.stringify(sent.data).slice(0, 300));
  stopRow(${JSON.stringify(PUSHED_EMAIL_SENT_REASON)});
  return { content: { end: { success: true, stopCampaign: false, delivery: { state: "delivered" } } } };
}
`,
  ].join("\n");
}
