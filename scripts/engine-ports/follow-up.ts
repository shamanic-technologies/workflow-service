/**
 * MIGRATE-1105 S4b: the follow-up DAGs (`follow-up-dag.ts`) as stored scripts, through the generic DAG port
 * (`dag-port.ts`): the steps, their text and their order are the old DAG's own:
 *  - the lead follow-up when a lead's follow-up date passed (`conversation/dy_follow_up_due`, proactive: lead-service
 *    serves the person), the "Lead follow-up due" campaigns;
 *  - the client WhatsApp look (`client_satisfied/dy_client_whatsapp`): a current client due on the campaign's own queue.
 *  - MIGRATE-1105 S7: the Lead event answers for a CURRENT CLIENT (`paid_client/dy_client_check_in`) and for the brand's
 *    own TEAM (`paid_client/dy_brand_team`), the reactive DAG with its claim policy. WHO each answers is the claim's
 *    `relationships` (lead-service judges the person), stated again as the tactic `relationships` the campaign's strategy
 *    keeps ("Script: current clients only", "Script: answers the brand's team only"); the leads are
 *    `message_sent/dy_answer_lead`'s. Never a branch on an audience here: the strategy picks among them;
 *  - MIGRATE-1105 S7: the signup follow-up (`paid_client/dy_signup_follow_up`, the reactive DAG reading the account's
 *    figures), which reads the run's signup Unit (`reads`), so only a campaign whose run holds a signup is offered it.
 * The runner declares nothing for them: the sender (crm-service on WhatsApp, the email gateway by email) records what
 * went out. The ledger steps of the old DAG (`pipe-of-run`, `declare-*`) are the runner's, left out.
 */
import { buildFollowUpProactiveDag, FOLLOW_UP_FEATURE_SLUG } from "./follow-up-steps.js";
import { buildClientSatisfiedDag, CLIENT_SATISFIED_FEATURE_SLUG } from "./client-satisfied-steps.js";
import { buildClientCheckInDag, CURRENT_CLIENTS_POLICY } from "./client-check-in-steps.js";
import { buildBrandTeamDag, OWN_TEAM_POLICY } from "./brand-team-steps.js";
import { portDag } from "./dag-port.js";

const LEDGER_STEPS = ["pipe-of-run", "declare-consumed-lead", "declare-message-written"];

export const FOLLOW_UP_DUE = {
  outcome: "conversation",
  dynasty: "dy_follow_up_due",
  tactics: { channel: FOLLOW_UP_FEATURE_SLUG, recorded_by: "sender" },
  dag: buildFollowUpProactiveDag,
  build: () => portDag(buildFollowUpProactiveDag(), { title: "Follow-up of a lead whose follow-up date passed", runnerSteps: LEDGER_STEPS }),
  description:
    "Follows up each lead whose follow-up date has passed, one per run, on WhatsApp when the brand can reach them there, else by email in their last thread, at the moment their thread says is right, always leaving their next follow-up date. Only their own no, an unsubscribe, a disqualification or a payment ends the follow-ups. Ported from the Follow-up workflow.",
};

export const CLIENT_WHATSAPP = {
  outcome: "client_satisfied",
  dynasty: "dy_client_whatsapp",
  tactics: { channel: CLIENT_SATISFIED_FEATURE_SLUG, recorded_by: "sender" },
  dag: buildClientSatisfiedDag,
  build: () => portDag(buildClientSatisfiedDag(), { title: "WhatsApp look after one current client when something happens with them", runnerSteps: LEDGER_STEPS }),
  description:
    "Looks after one current client of the brand each time something happens with them, on WhatsApp only: it reads their whole thread and writes now only what is useful to them (an answer, something they need to know, good news, one improvement), or sets a later look and writes nothing. Current clients only. Ported from the Client WhatsApp workflow.",
};


/** The Lead event answer of the brand's current clients (the client check-in workflow, `ai-follow-up-email-intan`). */
export const CLIENT_CHECK_IN = {
  outcome: "paid_client",
  dynasty: "dy_client_check_in",
  tactics: { channel: FOLLOW_UP_FEATURE_SLUG, recorded_by: "sender", relationships: CURRENT_CLIENTS_POLICY },
  dag: buildClientCheckInDag,
  build: () => portDag(buildClientCheckInDag(), { title: "Answer of one current client of the brand when something happens with them", runnerSteps: LEDGER_STEPS }),
  description:
    "Answers every event of a current client of the brand (someone who paid the brand, never a personal contact, a prospect or the brand's own team): it reads their whole thread and either writes now, on WhatsApp when the brand reaches them there or else by email in their last thread, with a short check-in or one concrete way to get more from the service, or sets a later follow-up date and writes nothing. Current clients only: its follow-up claim asks lead-service for current clients only. Ported from the Client Lead Follow-up workflow.",
};

/** The Lead event answer of the brand's own team (the brand team workflow, `ai-follow-up-email-muliphein`). */
export const BRAND_TEAM = {
  outcome: "paid_client",
  dynasty: "dy_brand_team",
  tactics: { channel: FOLLOW_UP_FEATURE_SLUG, recorded_by: "sender", relationships: OWN_TEAM_POLICY },
  dag: buildBrandTeamDag,
  build: () => portDag(buildBrandTeamDag(), { title: "Answer of one member of the brand's own team when they write or something happens with them", runnerSteps: LEDGER_STEPS }),
  description:
    "Answers the brand's own team only (its members, our staff, anyone known as team) each time one of them writes to the brand or something happens with them: it reads their whole thread and helps them with their own work as their assistant, on WhatsApp when the brand reaches them there or else by email in their last thread, and never sells to them. Its follow-up claim asks lead-service for the brand's team only. Ported from the Lead Deals workflow.",
};
