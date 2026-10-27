/**
 * LEAD FOLLOW-UP, LEADS ONLY (LEAD-EVENT-LEADS-ONLY-1024). Owner Kevin, 2026-10-24: « À chaque fois qu'un lead a un
 * nouvel event dans son Unibox lié à SON action envers nous, ça trigger notre unique campagne réactive dédiée à nos
 * leads (non client, non perso), qui choisit de leur écrire ou non, ou de followup later. »
 *
 * The Lead event pipe (`ai-follow-up-email|start_to_paid_client`) carries two audiences: current clients (the client
 * check-in, its own dynasty, claim `current_client`) and LEADS (the follow-up's own reactive DAG). WHO each reaches is
 * stated on its claim and judged by lead-service, the two policies never admitting the same person (a payer is a
 * client, never a lead; staff, the brand's team and personal contacts are neither):
 *  - the claim states `relationships: LEADS_ONLY_POLICY` (features-service's tactic "Answers leads only" reads that
 *    literal; the strategy "Leads only" requires it);
 *  - a person lead-service refuses (staff, team member, a payer, a personal contact, anyone but a prospect) or keeps
 *    off the queue ends the run `personNotAdmitted` (final); one it cannot judge yet ends idle (redelivered);
 *  - everything else (state read, thread, channel, the game, right moment, next date) is the lead follow-up, byte for
 *    byte.
 * The seed (`seed-follow-up-workflows.mjs`) builds it for every dynasty on `LEADS_ONLY_LEG_KEYS` (an upgrade of the
 * dynasty, never a fork).
 */
import type { DAG } from "./dag-validator.js";
import {
  COMPOSE_FOLLOW_UP_CODE,
  FOLLOW_UP_REACTIVE_DESCRIPTION,
  READ_STATE_CODE,
  buildFollowUpReactiveDag,
  type FollowUpAudience,
} from "./follow-up-dag.js";
import { CLIENT_CHECK_IN_AUDIENCE, CLIENT_CHECK_IN_LEG_KEY, admissionResolveCode } from "./client-check-in-dag.js";

/** lead-service's claim policy "leads only" (the same literal ai-meeting-booking and ai-lead-proposal state). */
export const LEADS_ONLY_POLICY = "pure_prospect";

/** The follow-up legs whose reactive dynasty answers leads only: the Lead event pipe, where clients have their own play. */
export const LEADS_ONLY_LEG_KEYS: readonly string[] = [CLIENT_CHECK_IN_LEG_KEY];

/** The LLM the Lead event writer runs on when its leg ranks none (chat-service alias; never pinned past the pick). */
export const LEAD_EVENT_AGENT_LLM = { provider: "zai", model: "glm" } as const;

export const RESOLVE_LEAD_CODE = admissionResolveCode({ tag: "follow-up", noun: "a lead", defaultReason: "not_a_lead" });

export const LEADS_ONLY_AUDIENCE: FollowUpAudience = {
  claimBody: { relationships: LEADS_ONLY_POLICY },
  resolveClaimedCode: RESOLVE_LEAD_CODE,
  readStateCode: READ_STATE_CODE,
  composeCode: COMPOSE_FOLLOW_UP_CODE,
  // Not a lead: final, never redelivered. lead-service cannot say yet: idle, redelivered later. Same ends as the client.
  claimEnds: CLIENT_CHECK_IN_AUDIENCE.claimEnds,
  // Sophie (SOPHIE-LEAD-EVENT-AGENT-1027): before deciding write now / later / nothing, the writer reads the lead's
  // own account through tools (what they set up, their campaigns, their billing). GLM when the leg ranks no LLM
  // (owner: « Sophie runs on GLM »; the pipe's strategy narrows the leg's pick to GLM, as data in features-service).
  agentWriter: LEAD_EVENT_AGENT_LLM,
};

const LEADS_ONLY_SENTENCE =
  " It answers leads only, never a client, a personal contact, the brand's team or our staff, and first reads the lead's own account to see where they stand.";

export const FOLLOW_UP_REACTIVE_LEADS_DESCRIPTION = FOLLOW_UP_REACTIVE_DESCRIPTION + LEADS_ONLY_SENTENCE;

export function buildLeadFollowUpLeadsOnlyDag(opts: { readFigures: boolean }): DAG {
  return buildFollowUpReactiveDag({ readFigures: opts.readFigures, audience: LEADS_ONLY_AUDIENCE });
}

/** A stored DAG answers leads only when its claim states the policy (never told by description). */
export function isLeadsOnlyFollowUpDag(dag: unknown): boolean {
  const nodes = (dag as { nodes?: Array<{ id?: string; config?: { body?: { relationships?: unknown } } }> } | null)?.nodes;
  return Array.isArray(nodes) && nodes.some((n) => n.id === "claim-followup" && n.config?.body?.relationships === LEADS_ONLY_POLICY);
}
