/**
 * MIGRATE-1105 S4b: the follow-up DAGs (`follow-up-dag.ts`) as stored scripts, through the generic DAG port
 * (`dag-port.ts`): the steps, their text and their order are the old DAG's own:
 *  - the lead follow-up when a lead's follow-up date passed (`conversation/dy_follow_up_due`, proactive: lead-service
 *    serves the person), the "Lead follow-up due" campaigns;
 *  - the client WhatsApp look (`client_satisfied/dy_client_whatsapp`): a current client due on the campaign's own queue.
 * The signup follow-up (the same DAG, reactive, reading figures) is not stored: its Engine (Paid client) and channel are
 * shared with the Lead event answering campaigns, which would then run it.
 * The runner declares nothing for them: the sender (crm-service on WhatsApp, the email gateway by email) records what
 * went out. The ledger steps of the old DAG (`pipe-of-run`, `declare-*`) are the runner's, left out.
 */
import { buildFollowUpProactiveDag, FOLLOW_UP_FEATURE_SLUG } from "../../src/lib/follow-up-dag.js";
import { buildClientSatisfiedDag, CLIENT_SATISFIED_FEATURE_SLUG } from "../../src/lib/client-satisfied-dag.js";
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

