/**
 * THE BRAND'S TEAM on the Lead event pipe (ONE-AI-CONVERSES-1029). Owner Kevin, 2026-10-29: « ON VEUT UNE IA QUI
 * CONVERSE AVEC LES LEADS ET LES CLIENTS AU BON MOMENT ET DE LA BONNE FAÇON », « Quand un lead nous écrit c'est un lead
 * event non ? », « tu veux faire un cas particulier ? WTF ».
 *
 * Every message a person writes to the brand is a Lead event. Leads have their play (`lead-follow-up-leads-dag.ts`,
 * claim `pure_prospect`), current clients theirs (`client-check-in-dag.ts`, claim `current_client`); the brand's OWN
 * TEAM (its members, our staff, anyone tagged team) was refused by both and got no answer (prod 2026-10-29: a staff test
 * on the distribute.you assistant line, refused `not_a_lead` and `team_member`). This is the third audience of the same
 * follow-up channel's reactive DAG, its own dynasty on `ai-follow-up-email|start_to_paid_client`:
 *  - WHO: the claim states `relationships: OWN_TEAM_POLICY` (features-service's tactic "Answers the brand's team only"
 *    reads that literal; the strategy requiring it is the play). lead-service admits exactly who the two others refuse
 *    as staff or team, so a person lands in ONE of the three; a refused person ends `personNotAdmitted` (final).
 *  - The follow-up STATE: what a team member IS (team, no prospect, a test sale, a live conversation) is never a reason
 *    to stay silent; only their own stops hold (opted out, do not contact, unsubscribed, bounced). A queued message of
 *    another campaign is never theirs to wait on: they wrote, they are answered.
 *  - THE GAME: help them with their own work, as their assistant; never a sale, a check-in or a buyer's next step.
 *  - The writer is the Copilot (one AI), with the person's own account in reach; everything else (thread, channel,
 *    persona of the sending line, right moment, next date) is the follow-up's.
 */
import type { DAG } from "./dag-validator.js";
import { buildFollowUpReactiveDag, composeFollowUpCode, type FollowUpAudience, type FollowUpGame } from "./follow-up-dag.js";
import { CLIENT_CHECK_IN_AUDIENCE, CLIENT_CHECK_IN_LEG_KEY, CLIENT_CHECK_IN_PIPE_ID, admissionResolveCode } from "./client-check-in-dag.js";

/** Same pipe as the client check-in: Lead event heads it. */
export const BRAND_TEAM_LEG_KEY = CLIENT_CHECK_IN_LEG_KEY;
export const BRAND_TEAM_PIPE_ID = CLIENT_CHECK_IN_PIPE_ID;

/** lead-service's claim policy "the brand's own team only" (staff, members of the org owning the brand, tagged team). */
export const OWN_TEAM_POLICY = "own_team";

/** The follow-up state reasons that are the team member's OWN stop: everything else only says what they are. */
export const TEAM_STOP_REASONS = ["opted_out", "do_not_contact", "unsubscribed", "bounced"] as const;

export const BRAND_TEAM_DESCRIPTION =
  "Answers the brand's own team (its members, our staff, anyone known as team) each time one of them writes to the brand or something happens with them: it reads their whole thread and helps them with their own work as their assistant, on WhatsApp when the brand reaches them there or else by email in their last thread, and never sells to them. Its follow-up claim states the brand's team only.";

export const RESOLVE_TEAM_CODE = admissionResolveCode({ tag: "brand-team", noun: "the brand's team", defaultReason: "not_team" });

/**
 * lead-service's follow-up state for a TEAM MEMBER: their own stops hold (nothing written, no date); anything else
 * lead-service names (team member, not a prospect, customer, in conversation, a sequence or another campaign's row) is
 * what they are, read as owed. An unknown kind or a stop without a reason fails loud.
 */
export const READ_TEAM_STATE_CODE = `
export async function main(person, state, nowIso) {
  if (person?.ok !== true) return { proceed: false, kind: "none", skip: true };
  const owed = state?.owed;
  const kind = owed?.kind;
  if (kind !== "owed" && kind !== "stop" && kind !== "not_yet") {
    throw new Error("follow-up-state: lead-service answered no follow-up kind: " + JSON.stringify(state).slice(0, 300));
  }
  const reasons = Array.isArray(owed.reasons) ? owed.reasons : [];
  if (kind !== "owed" && reasons.length === 0) {
    throw new Error("follow-up-state: lead-service said " + kind + " without naming a reason");
  }
  const own = reasons.filter((r) => ${JSON.stringify(TEAM_STOP_REASONS)}.includes(r));
  if (own.length > 0) {
    console.log("[brand-team] their own stop (" + own.join(", ") + "): nothing written, no next date");
    return { proceed: false, kind: "stop", reason: own[0], skip: true };
  }
  return { proceed: true, kind: "owed", reason: null, skip: false };
}
`.trim();

/** THE GAME for a member of the brand's own team: four prompt lines (JS string literals of the generated script). */
const line = (text: string) => `    ${JSON.stringify(text)},\n`;
export const BRAND_TEAM_GAME: FollowUpGame = {
  occurrenceItem: true,
  intro:
    '    "You are the assistant of ONE person on the team at " + brandName + ": they work with us, on our side. They just wrote to us or something just happened with them, and you decide what to answer now, or that nothing is needed. The thread below is everything that passed between us on every channel.",\n',
  game: line(
    "THE GAME. Help them with their own work, as their assistant would: do what they ask with your tools when you can, answer their question, give them the draft, the figure or the status they need, in as few words as it takes. They are not a lead and not a client: never sell to them, never pitch the offer, never push a buyer's next step, never a check-in. When they ask for something you cannot do, say so in one line and offer what you can do instead.",
  ),
  read: line(
    "Read the thread like their assistant who knows them. Their last message is what this answer is about: when they wrote last and nobody on our side answered, write NOW, on any day and at any hour. Build on everything already said in the thread and never contradict it. When the event asks nothing of us (only a thanks, an ok, or a fact with nothing to do), choose later and write nothing.",
  ),
  stop: line(
    "STOP only on their OWN words asking us to stop writing to them. Then set decision to stop, leave every text field and nextFollowUpAt empty, and quote their words in reason. Silence is never a reason to stop.",
  ),
};

export const COMPOSE_BRAND_TEAM_CODE = composeFollowUpCode(BRAND_TEAM_GAME);

export const BRAND_TEAM_AUDIENCE: FollowUpAudience = {
  claimBody: { relationships: OWN_TEAM_POLICY },
  resolveClaimedCode: RESOLVE_TEAM_CODE,
  readStateCode: READ_TEAM_STATE_CODE,
  composeCode: COMPOSE_BRAND_TEAM_CODE,
  // Not the brand's team: final. lead-service cannot say yet: idle, redelivered. Same ends as the client check-in.
  claimEnds: CLIENT_CHECK_IN_AUDIENCE.claimEnds,
  // The Copilot writes (ONE-AI-CONVERSES-1029): the same AI as on the web and the assistant line, with their account.
  copilotWriter: true,
};

/** The DAG; the seed creates it on its pipe as its own dynasty, and upgrades it in place. */
export function buildBrandTeamDag(): DAG {
  return buildFollowUpReactiveDag({ readFigures: false, audience: BRAND_TEAM_AUDIENCE });
}

/** A stored DAG answers the brand's team when its claim states the own team policy (never told by description). */
export function isBrandTeamDag(dag: unknown): boolean {
  const nodes = (dag as { nodes?: Array<{ id?: string; config?: { body?: { relationships?: unknown } } }> } | null)?.nodes;
  return Array.isArray(nodes) && nodes.some((n) => n.id === "claim-followup" && n.config?.body?.relationships === OWN_TEAM_POLICY);
}
