/**
 * CLIENT SATISFIED (CLIENT-SATISFIED-1027-WF). Owner Kevin, 2026-10-27: « il nous manque un outcome "Client Satisfied"
 * qu'on extrait de l'Unibox. On détecte le Client Sentiment de chaque message, et on compte le nombre de sentiments
 * positifs [...] Ainsi ce serait un nouveau pipe qui cherche à maximiser la client satisfaction. »
 *
 * The workflow of the pipe `cold-whatsapp-outreach|paid_client_to_client_satisfied` (Paid client -> Client Satisfied,
 * reactive on ⚡ Lead event). It is the follow-up channel's reactive DAG (`follow-up-dag.ts`) with the client audience
 * of the client check-in (`client-check-in-dag.ts`: claim `current_client`, judged by lead-service; the client's own
 * stops only), and three differences, all stated here:
 *  - THE GAME is the owner's client strategy (`CLIENT_SATISFIED_GAME`): value with the least disturbance, done for
 *    them, only useful news (asked, necessary, good news, an improvement; a budget suggestion only on a positive ROI
 *    with outcomes on record); write now, later or nothing.
 *  - WhatsApp only (`WHATSAPP_ONLY_CHANNEL_PLAN_CODE`): the pipe is a WhatsApp pipe. crm-service picks the sending
 *    account (only an account the brand allows automation on, never a personal one) and states its persona (Sophie);
 *    no reach = nothing drafted, the next look in `NO_CHANNEL_RECHECK_DAYS`.
 *  - The writer is a GLM agent turn (owner: « laisse uniquement GLM »; `agentWriter`, its fallback while the leg is not
 *    ranked): it may read the client's own account (spend, outcomes) before it writes.
 * Every act (sent, later, stop) is on lead-service's follow-up ledger (the claimed row closed, the next date stated):
 * that is how features-service measures the pipe. Who is a positive client message is lead-service's judgment, never
 * this workflow's.
 */
import type { DAG } from "./dag-validator.js";
import { buildFollowUpReactiveDag, composeFollowUpCode, type FollowUpAudience, type FollowUpGame } from "./follow-up-dag.js";
import { CLIENT_CHECK_IN_AUDIENCE, CURRENT_CLIENTS_POLICY } from "./client-check-in-dag.js";
import { SENDER_PERSONA_FN } from "./sender-persona.js";

export const CLIENT_SATISFIED_FEATURE_SLUG = "cold-whatsapp-outreach";
export const CLIENT_SATISFIED_LEG_KEY = "paid_client_to_client_satisfied";
export const CLIENT_SATISFIED_PIPE_ID = `${CLIENT_SATISFIED_FEATURE_SLUG}|${CLIENT_SATISFIED_LEG_KEY}`;

/** chat-service's GLM alias (Z.ai GLM-5.3). */
export const CLIENT_SATISFIED_LLM = { provider: "zai", model: "glm" } as const;

export const CLIENT_SATISFIED_DESCRIPTION =
  "Looks after one current client of the brand each time something happens with them, on WhatsApp only: it reads their whole thread and writes now only what is useful to them (an answer, something they need to know, good news, one improvement), or sets a later look and writes nothing. It serves only current clients of the brand, never a prospect, a personal contact or the brand's own team: its follow-up claim states current clients only.";

/**
 * THE CHANNEL for a WhatsApp pipe: WhatsApp when the brand's WhatsApp reaches them (crm-service picks the account and
 * states its persona), else nothing (never an email: this pipe writes on WhatsApp).
 */
export const WHATSAPP_ONLY_CHANNEL_PLAN_CODE = `
export async function main(person, plan, reach, timeline) {
  if (plan?.proceed !== true) return { channel: null, skipModel: true };
  if (!reach || reach.ok === false || typeof reach.reachable !== "boolean") {
    throw new Error("channel-plan: the WhatsApp reach check did not answer: " + JSON.stringify(reach).slice(0, 300));
  }
  const items = Array.isArray(timeline?.items) ? timeline.items : [];
  const msgs = items.filter((i) => i?.kind === "message" && i.source !== "api");
  const lastTheirs = [...msgs].reverse().find((i) => i.direction === "inbound") ?? null;
  const emails = Array.isArray(timeline?.person?.emails) ? timeline.person.emails.filter((e) => typeof e === "string" && e.includes("@")) : [];
  const email = person.email ?? emails[0] ?? null;
  const lastWhere = lastTheirs ? String(lastTheirs.channel ?? "unknown") : null;
  if (reach.reachable === true) {
    return {
      channel: "whatsapp",
      skipModel: false,
      email,
      phone: reach.to ?? person.phone ?? null,
      fromAccount: reach.fromAccount ?? null,
      persona: senderPersona(reach),
      why: "The brand's WhatsApp reaches them (" + String(reach.to) + ")" + (lastWhere && lastWhere !== "whatsapp" ? "; their last message came by " + lastWhere : "") + ".",
    };
  }
  console.error("[client-satisfied] WhatsApp cannot reach " + String(person.phone ?? person.email ?? "this client") + " (" + String(reach.code) + "): nothing drafted");
  return { channel: null, skipModel: true, noChannel: true, why: "WhatsApp " + String(reach.code) };
}

${SENDER_PERSONA_FN}
`.trim();

/** THE GAME for a current client, the owner's strategy (2026-10-27), as four prompt lines. */
const line = (text: string) => `    ${JSON.stringify(text)},\n`;
export const CLIENT_SATISFIED_GAME: FollowUpGame = {
  occurrenceItem: true,
  intro:
    '    "You look after ONE current client of " + brandName + ": they already pay us. Something just happened with them, and you decide whether to write to them now, later, or not at all. The thread below is everything that passed between us on every channel, our automatic messages and our transactional emails included.",\n',
  game: line(
    "THE GAME. The goal is to give this client value while disturbing them as little as possible, doing the maximum for them so there is nothing left for them to do, and telling them only what is useful. A message is useful for one of these reasons only: they asked for it; they need to know it; it is good news, positive and optimistic (a result, a meeting, a step that worked); it suggests one improvement, such as a better offer or a better way to use what they already have; or it is about their budget, and a budget suggestion is allowed ONLY when the thread, the events or the facts show a positive return on what they spend AND real outcomes behind it, never otherwise. Anything else is noise, so choose later. Do the work for them: never hand them a task we could do ourselves, never a generic \"how is it going\", never a reminder of an earlier message, never sell them what they already have. When there is a next step on their side, it is ONE concrete step, with its link when the thread or the FACTS hold one.",
  ),
  read: line(
    "Read the thread like the person on our side who knows them. A client who just asked us something (their message, or the form or event that brought this run, is the last word and nobody on our side answered it) is waiting for us right now: write NOW, on any day. Answer it when the FACTS hold the answer; when they do not, say we are on it and ask the ONE question that lets us do it for them, never a promise we cannot keep. Never repeat what one of our messages or transactional emails already told them, and never contradict anything we already told them. When nothing in the event is useful to them, or we wrote recently and they have not answered, choose later and write nothing.",
  ),
  stop: line(
    "STOP only on the client's OWN words asking us to stop writing to them, unsubscribe or never write again. Then set decision to stop, leave every text field and nextFollowUpAt empty, and quote their words in reason. A complaint, a \"not now\" or a quiet stretch is NOT a stop: answer what they said, or choose later. Silence is never a reason to stop.",
  ),
};

export const COMPOSE_CLIENT_SATISFIED_CODE = composeFollowUpCode(CLIENT_SATISFIED_GAME);

export const CLIENT_SATISFIED_AUDIENCE: FollowUpAudience = {
  ...CLIENT_CHECK_IN_AUDIENCE,
  composeCode: COMPOSE_CLIENT_SATISFIED_CODE,
  channelPlanCode: WHATSAPP_ONLY_CHANNEL_PLAN_CODE,
  // GLM as an agent turn: it reads the client's own account (spend, outcomes) before advising on a budget.
  agentWriter: CLIENT_SATISFIED_LLM,
};

/** The DAG; the seed creates it on its pipe as its own dynasty, and upgrades it in place. */
export function buildClientSatisfiedDag(): DAG {
  return buildFollowUpReactiveDag({ readFigures: false, audience: CLIENT_SATISFIED_AUDIENCE });
}

/**
 * A stored cold WhatsApp DAG is the client-satisfied one when its follow-up claim states the current clients policy
 * (the cold WhatsApp writers never claim with a policy). Never told by its description.
 */
export function isClientSatisfiedDag(dag: unknown): boolean {
  const nodes = (dag as { nodes?: Array<{ id?: string; config?: { body?: { relationships?: unknown } } }> } | null)?.nodes;
  return Array.isArray(nodes) && nodes.some((n) => n.id === "claim-followup" && n.config?.body?.relationships === CURRENT_CLIENTS_POLICY);
}
