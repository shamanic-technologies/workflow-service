/**
 * MIGRATE-1105 S1b: the rep call as ONE stored script, ported from the AI Instant Call workflow DAG
 * (`ai-instant-call-dag.ts`) step by step. A lead replied with interest or filled in a form: the brand's sales rep is
 * rung about them (who they are, what they wrote) and bridged to them on a keypress when their number is known.
 *
 *   lead-service    claims the occurrence's person on this campaign's queue;
 *   lead-service    who they are (tolerated: a rep is rung about an unidentified buyer rather than not at all);
 *   brand-service   the brand, its sales rep;
 *   apollo-service  the phone reveal, asked once then waited for at most 90 s (tolerated: costs the bridge, never the call);
 *   twilio-service  the call (never retried; idempotent on the occurrence);
 *   lead-service    the row stopped `instant_call_placed` / `no_sales_rep_phone` / `reply_not_by_email`.
 *
 * The Unit it makes: a booking call (`booking_call`), about the lead. Its ends, the runner's way: `null` = nobody due
 * (no occurrence, nobody claimed); `unmade "no_sales_rep_phone: <why>"` = the brand states no rep phone, nobody rung;
 * `unmade "person_not_admitted: <why>"` = the email-only copy and a reply not received by email (final); a throw = the
 * run claimed someone the occurrence does not name (redelivered), exactly the DAG's ends.
 *
 * ASKED by the answering script (`message_sent/dy_answer_lead`, `ctx.ask` then `ctx.get("booking_call")`): the asker
 * already holds the person's row on ITS campaign and hands it as `request.claimed` (the claim answer): this script then
 * claims nothing and stops no row (the asker owns it and closes it with its own answer); everything else is the same.
 */
import { asFunction, PORT_HEAD } from "./port-kit.js";
import {
  AI_INSTANT_CALL_DESCRIPTION,
  BUILD_CALL_CODE,
  EMAIL_REPLIES_ONLY_DESCRIPTION,
  INSTANT_CALL_PLACED_REASON,
  NO_SALES_REP_PHONE_REASON,
  PHONE_REVEAL_POLL_SECONDS,
  PHONE_REVEAL_WAIT_SECONDS,
  PLAN_CLAIM_CODE,
  REPLY_CHANNEL_CODE,
  RESOLVE_CALL_CODE,
} from "../../src/lib/ai-instant-call-dag.js";
import { LEAD_SUBJECT_SERVICE } from "../../src/lib/message-written-outcome.js";

export const AI_INSTANT_CALL_OUTCOME = "booking_call";
export const AI_INSTANT_CALL_DYNASTY = "dy_ring_rep";
export const AI_INSTANT_CALL_EMAIL_ONLY_DYNASTY = "dy_ring_rep_email_replies";
/** No channel: the Lead event campaign's answering script asks for it; the campaign's strategy keeps it or not. */
export const AI_INSTANT_CALL_TACTICS = {};

export const AI_INSTANT_CALL_PORT_DESCRIPTION = `${AI_INSTANT_CALL_DESCRIPTION} Ported from the AI Instant Call workflow.`;
export const AI_INSTANT_CALL_EMAIL_ONLY_PORT_DESCRIPTION = `${EMAIL_REPLIES_ONLY_DESCRIPTION} Ported from the AI Instant Call workflow (email replies only).`;

/** Said when the brand states no rep phone (the row's stop reason, verbatim, then why). */
export const NO_REP_UNMADE = `${NO_SALES_REP_PHONE_REASON}: the brand states no sales rep phone, nobody rung`;

export function buildAiInstantCallSource(opts: { emailRepliesOnly?: boolean } = {}): string {
  const emailOnly = opts.emailRepliesOnly === true;
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** AI instant call: rings the brand's sales rep about a lead who replied with interest or filled in a form (MIGRATE-1105 S1b). */`,
    `const BRIEF_HEADER = "";`,
    PORT_HEAD,
    asFunction(PLAN_CLAIM_CODE, "planClaim"),
    asFunction(RESOLVE_CALL_CODE, "resolveCall"),
    asFunction(BUILD_CALL_CODE, "buildCall"),
    emailOnly ? asFunction(REPLY_CHANNEL_CODE, "replyChannel") : "",
    `
export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const trigger = R.trigger ?? null;
  const campaignId = R.campaignId;
  // Handed by an asking script that already holds the person's row (it owns the row: no claim, no stop here).
  const handed = R.claimed && typeof R.claimed === "object" && R.claimed.found === true ? R.claimed : null;
  let claim: any;
  if (handed) claim = handed;
  else {
    const plan = planClaim(trigger);
    if (plan.skip === true) return null;
    claim = must(ctx, "lead.followup.claim", { params: { campaignId } });
  }
  if (claim?.found !== true) return null;
  const f = claim.followup ?? {};
  const leadDetail = tolerated(ctx, "lead.detail", { params: { id: f.id }, query: { campaignId } });
  const brand = must(ctx, "brand.profile", { params: { id: f.brandId } });
  const rep = must(ctx, "brand.sales_rep", { params: { brandId: f.brandId } });
  const person = resolveCall(claim, trigger, leadDetail, rep, brand);
  if (person.ok !== true) throw new Error("[ai-instant-call] claimed someone the occurrence does not name: their row is left alone");
  const stopRow = (reason: string, tolerate = false) => {
    if (handed) return;
    const args = { params: { id: person.rowId }, body: { kind: "stopped", reason } };
    if (tolerate) tolerated(ctx, "lead.followup.record", args);
    else must(ctx, "lead.followup.record", args);
  };${
      emailOnly
        ? `
  const channel = replyChannel(trigger);
  if (channel.allowed !== true) {
    if (!handed) must(ctx, "lead.followup.record", { params: { id: person.rowId }, body: channel.stop });
    return { unmade: "person_not_admitted: " + String(channel.notAdmitted?.reason ?? "") };
  }`
        : ""
    }
  if (person.hasRep !== true) {
    stopRow(${JSON.stringify(NO_SALES_REP_PHONE_REASON)});
    return { unmade: ${JSON.stringify(NO_REP_UNMADE)} };
  }
  const reveal = person.skipReveal === true
    ? { skipped: true, notCalled: true }
    : (tolerated(ctx, "apollo.phone.reveal", { params: { apolloPersonId: person.apolloPersonId }, body: {} }),
      tolerated(ctx, "apollo.phone.read", {
        params: { apolloPersonId: person.apolloPersonId },
        pollWhile: { field: "status", equals: "pending", intervalSeconds: ${PHONE_REVEAL_POLL_SECONDS}, timeoutSeconds: ${PHONE_REVEAL_WAIT_SECONDS} },
      }));
  // The run the call files under is the script's: the door fills it (twilio's parentRunId).
  const call = buildCall(person, reveal, campaignId, null);
  // Never retried: a call that may have rung is never placed a second time by this run.
  must(ctx, "twilio.call.place", { body: call.body });
  // Strictly AFTER the call, and tolerated: nothing after a placed call may fail the run (a redelivery would ring again).
  stopRow(${JSON.stringify(INSTANT_CALL_PLACED_REASON)}, true);
  const leadId = typeof f.leadId === "string" && f.leadId ? f.leadId : null;
  return {
    content: { end: { success: true, stopCampaign: false, delivery: { state: "delivered" } } },
    ...(leadId ? { subject: { service: ${JSON.stringify(LEAD_SUBJECT_SERVICE)}, id: leadId } } : {}),
  };
}
`,
  ].join("\n");
}
