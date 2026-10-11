/**
 * THE WORKFLOW OF THE AI INSTANT CALL PIPE (owner 2026-10-11: "every pipe in production must have a workflow";
 * "the infra is homogeneous"). Same move as the sourcing pipes (src/lib/sourcing-dag.ts).
 *
 * The pipe is `ai-instant-call|conversation_to_booking_call`: REACTIVE on the positive-reply trigger. When a
 * prospect's reply is qualified as a sales interest, instantly-service rings the brand's sales rep (gated on the
 * offer's ONGOING AI Instant Call campaign, billed to it, at most once per lead, a do-not-call number never
 * dialled) and offers to bridge them to the prospect. All of that stays instantly-service's: it runs inside the
 * reply's ingestion, on its own root run, and campaign-service never dispatches this channel (it resolves its
 * workflow to NULL without asking us). So this workflow DESCRIBES the step rather than driving it: its one node is
 * the call instantly-service places, twilio-service `POST /calls`, fed by what the reply event carries.
 *
 * Registered on its pipe through features-service's register route like every workflow
 * (`scripts/seed-ai-instant-call-workflow.mjs`), so features-service lists it as the pipe's workflow. It records no
 * run of its own, which is why the stale deprecator never deprecates a channel's last active workflow.
 */
import type { DAG } from "./dag-validator.js";

export const AI_INSTANT_CALL_FEATURE_SLUG = "ai-instant-call";

/** The leg the AI Instant Call pipe performs (Positive reply -> Booking call). */
export const AI_INSTANT_CALL_LEG_KEY = "conversation_to_booking_call";

export const AI_INSTANT_CALL_PIPE_ID = `${AI_INSTANT_CALL_FEATURE_SLUG}|${AI_INSTANT_CALL_LEG_KEY}`;

export const AI_INSTANT_CALL_DESCRIPTION =
  "Rings the brand's sales rep the moment a prospect replies with interest: says who replied and what they wrote, " +
  "and connects the rep to the prospect on a keypress when we have their number. Runs when a reply is qualified " +
  "as a sales interest (trigger: Positive Reply), only while the offer's AI Instant Call campaign is on.";

/** The one-step DAG of the AI Instant Call pipe: the call to the rep. */
export function buildAiInstantCallDag(): DAG {
  return {
    nodes: [
      {
        id: "ring-rep",
        type: "http.call",
        config: { service: "twilio", method: "POST", path: "/calls" },
        inputMapping: {
          "body.to": "$ref:flow_input.salesRepPhone",
          "body.reply": "$ref:flow_input.reply",
          "body.brandName": "$ref:flow_input.brandName",
          "body.connectTo": "$ref:flow_input.prospectPhone",
          "body.priorMessages": "$ref:flow_input.priorMessages",
          "body.brandId": "$ref:flow_input.brandId",
          "body.campaignId": "$ref:flow_input.campaignId",
        },
      },
    ],
    edges: [],
  };
}
