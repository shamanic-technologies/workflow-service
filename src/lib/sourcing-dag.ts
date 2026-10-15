/**
 * THE WORKFLOW OF A SOURCING PIPE (owner 2026-10-11: "the infra is homogeneous": every pipe runs a workflow
 * features-service chose, the sourcing pipes included; they used to run with none).
 *
 * A sourcing pipe performs Start -> Lead found for one sourcing channel: an origin (Apollo Cold Filters, Apollo
 * Buying Signals, LinkedIn Engagement Signals, Your CRM Contacts) or Lead Sourcing (human-service picks the
 * origins per brand). Owner 2026-10-12 (LEADS-ONLY-FUNNEL-CAMPAIGN): EVERY PIPE IS INDEPENDENT OF THE OTHERS, a
 * sourcing pipe finds leads ON ITS OWN inside its funnel campaign's caps, never waiting for a later pipe to ask
 * (a funnel can be Start -> Lead found -> Paid client with no email at all). So its workflow is a campaign run
 * like every other campaign DAG: campaign-service `/gate-check` (stop when not allowed) -> `/start-run` ->
 * lead-service `POST /orgs/buffer/next` (the find: lead-service files the person under the source campaign, buys
 * and qualifies them, and hands them to Lead found) -> campaign-service `/end-run` (found: success; nobody left:
 * `stopCampaign: true`, which marks the audience exhausted and stops nothing; any error: `success: false`).
 * No email or outreach node, ever: reaching the person is a later pipe's job.
 * The same DAG for every sourcing channel: what differs is the channel's own lists, never the step.
 *
 * Registered on its pipe (`<channel>|start_to_lead_found`) through features-service's register route like every
 * workflow (`scripts/seed-sourcing-workflows.mjs`, which also upgrades a stored DAG behind this one in its own
 * dynasty, so the dynasty slug units store keeps resolving forward to the current version).
 */
import type { DAG } from "./dag-validator.js";
import { FRESH_CONTACTS_FIELD, FRESH_CONTACTS_WINDOW, freshContactsDescription, isFreshContactsChannel } from "./fresh-contacts.js";

/** The sourcing channels, one workflow each (features-service `SOURCING_CHANNEL_SLUGS`, the live ones). */
export const SOURCING_CHANNEL_SLUGS = [
  "sourcing-apollo-cold-filters",
  "sourcing-apollo-buying-signals",
  "sourcing-linkedin-engagement-signals",
  "sourcing-crm-contacts",
  "lead-sourcing",
] as const;

/** The leg every sourcing pipe performs (features-service `SOURCE_LEG_KEY`). */
export const SOURCE_LEG_KEY = "start_to_lead_found";

export const sourcingPipeIdOf = (channelSlug: string): string => `${channelSlug}|${SOURCE_LEG_KEY}`;

export const SOURCING_DESCRIPTION =
  "Finds leads on its own, one per run, inside its campaign's caps: checks the campaign may run, serves the next " +
  "person from this source's lists (Lead Sourcing: from the sources human-service chose for the brand), qualified " +
  "before anything is paid, and hands them to Lead found. Emails nobody.";

/** The run-scoped identity headers every `/end-run` names (same mapping as every campaign DAG). */
const END_RUN_HEADERS = {
  "headers.x-org-id": "$ref:flow_input.orgId",
  "headers.x-run-id": "$ref:flow_input.runId",
  "headers.x-user-id": "$ref:flow_input.userId",
  "headers.x-campaign-id": "$ref:flow_input.campaignId",
  "headers.x-feature-slug": "$ref:flow_input.featureSlug",
  "headers.x-workflow-slug": "$ref:flow_input.workflowSlug",
};

function endRun(id: string, body: { success: boolean; stopCampaign: boolean }) {
  return {
    id,
    type: "http.call",
    config: { service: "campaign", method: "POST", path: "/end-run", body },
    retries: 0,
    inputMapping: { ...END_RUN_HEADERS },
  };
}

/**
 * The pipe's "business contacts only" play (RELATIONSHIP-TAGS-1014, owner 2026-10-14: who a campaign skips is the
 * PIPE's strategy, never a campaign rule). lead-service `POST /orgs/buffer/next` with `relationships: "business_only"`
 * hands out nobody tagged personal, investor, supplier, team, partner or advisor, and nobody whose thread was never
 * judged. It runs as its OWN dynasty, forked from the channel's default (`scripts/seed-sourcing-workflows.mjs`):
 * features-service judges the tactic "Business contacts only" on this DAG and a campaign picks it through the
 * strategy that requires it, while the default dynasty stays the default play. Only the CRM contacts channel has one
 * (`BUSINESS_ONLY_SOURCING_CHANNELS`): the other origins serve people the brand never met.
 */
export const BUSINESS_ONLY_RELATIONSHIPS = "business_only";

export const BUSINESS_ONLY_SOURCING_CHANNELS = ["sourcing-crm-contacts"] as const;

export const BUSINESS_ONLY_SOURCING_DESCRIPTION =
  SOURCING_DESCRIPTION +
  " Business contacts only: never serves a person the brand knows personally or as a team member, investor, " +
  "advisor, partner or supplier, nor anyone whose relationship to the brand was never judged.";

/** The serve's body change that makes a sourcing DAG business-only, as a JSON Patch on the default DAG. */
export const BUSINESS_ONLY_CHANGES = [
  { op: "add", path: "/nodes/serve-lead/config/body", value: { relationships: BUSINESS_ONLY_RELATIONSHIPS } },
] as const;

/** True when a stored sourcing DAG serves business contacts only. */
export function servesBusinessOnly(dag: { nodes?: Array<{ id?: string; config?: Record<string, unknown> }> } | null | undefined): boolean {
  const serve = (dag?.nodes ?? []).find((n) => n?.id === "serve-lead");
  const body = serve?.config?.body as { relationships?: unknown } | undefined;
  return body?.relationships === BUSINESS_ONLY_RELATIONSHIPS;
}

/**
 * The Lead Sourcing pipe's "contacted pure prospects" play (NEVER-NO-FOLLOWUP-1014, owner 2026-10-14): the people the
 * brand ALREADY contacted who are still pure prospects (no relationship tag but prospect, not opted out, never
 * disqualified, no positive reply, meeting or sale). lead-service serves that population when the source run states
 * it on `POST /orgs/buffer/next`; the follow-up pipe fed by this source writes them their first follow-up
 * (`prospect-follow-up-dag.ts`). Its OWN dynasty, a fork of the channel's generic workflow like the business-only one:
 * features-service judges the tactic "Contacted pure prospects" on this DAG and the strategy of that name requires it.
 */
export const CONTACTED_PURE_PROSPECTS_POPULATION = "contacted_pure_prospects";

export const CONTACTED_PROSPECTS_SOURCING_CHANNELS = ["lead-sourcing"] as const;

export const CONTACTED_PROSPECTS_SOURCING_DESCRIPTION =
  "Finds, one per run, inside its campaign's caps, a person the brand ALREADY contacted who is still a pure " +
  "prospect: no relationship to the brand but prospect, never opted out or unsubscribed, never disqualified, never " +
  "replied positively, booked or bought, and never handed to this population before. Buys nobody new and emails " +
  "nobody: hands them to Lead found, where the follow-up pipe writes to them.";

export const CONTACTED_PROSPECTS_CHANGES = [
  { op: "add", path: "/nodes/serve-lead/config/body", value: { population: CONTACTED_PURE_PROSPECTS_POPULATION } },
] as const;

/** True when a stored sourcing DAG serves the contacted pure prospects. */
export function servesContactedProspects(dag: { nodes?: Array<{ id?: string; config?: Record<string, unknown> }> } | null | undefined): boolean {
  const serve = (dag?.nodes ?? []).find((n) => n?.id === "serve-lead");
  const body = serve?.config?.body as { population?: unknown } | undefined;
  return body?.population === CONTACTED_PURE_PROSPECTS_POPULATION;
}

/**
 * Every play a sourcing channel runs as a FORK of its generic workflow (one stated serve-body change each). The seed
 * forks the missing ones; a new play = one more entry, never a branch in the seed.
 */
export const SOURCING_FORK_PLAYS = [
  {
    name: "business-only",
    channels: BUSINESS_ONLY_SOURCING_CHANNELS as readonly string[],
    changes: BUSINESS_ONLY_CHANGES,
    description: BUSINESS_ONLY_SOURCING_DESCRIPTION,
    serves: servesBusinessOnly,
  },
  {
    name: "contacted-pure-prospects",
    channels: CONTACTED_PROSPECTS_SOURCING_CHANNELS as readonly string[],
    changes: CONTACTED_PROSPECTS_CHANGES,
    description: CONTACTED_PROSPECTS_SOURCING_DESCRIPTION,
    serves: servesContactedProspects,
  },
] as const;

/** The generic description of a channel's sourcing workflow (a cold channel says it serves fresh contacts only). */
export function sourcingDescriptionOf(channelSlug: string): string {
  return isFreshContactsChannel(channelSlug) ? freshContactsDescription(SOURCING_DESCRIPTION) : SOURCING_DESCRIPTION;
}

/** The current DAG of one channel's generic sourcing workflow (a cold channel's serve states fresh contacts only). */
export function buildSourcingDagFor(channelSlug: string): DAG {
  return buildSourcingDag({ freshContacts: isFreshContactsChannel(channelSlug) });
}

/** The DAG of every sourcing pipe: a campaign run whose only work is the find. */
export function buildSourcingDag(opts: { businessOnly?: boolean; freshContacts?: boolean } = {}): DAG {
  const serveBody = {
    ...(opts.businessOnly ? { relationships: BUSINESS_ONLY_RELATIONSHIPS } : {}),
    ...(opts.freshContacts ? { [FRESH_CONTACTS_FIELD]: FRESH_CONTACTS_WINDOW } : {}),
  };
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" },
      },
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      {
        id: "serve-lead",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/buffer/next",
          ...(Object.keys(serveBody).length > 0 ? { body: serveBody } : {}),
        },
        retries: 0,
      },
      { id: "check-lead", type: "condition" },
      endRun("end-run", { success: true, stopCampaign: false }),
      endRun("end-run-no-lead", { success: true, stopCampaign: true }),
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "serve-lead" },
      { from: "serve-lead", to: "check-lead" },
      { from: "check-lead", to: "end-run", condition: "results['serve-lead'].found == true" },
      { from: "check-lead", to: "end-run-no-lead", condition: "results['serve-lead'].found == false" },
    ],
    onError: "end-run-error",
  };
}

/**
 * PURE: what the seed should store for an existing row of a sourcing channel: the current DAG, carrying over the
 * static body the row's OWN lead-serving node states. A copy differs from the generic workflow by exactly that body
 * (`reachableBy`, `acceptedEmails`: src/lib/reachable-by-copy.ts, a catch-all fork), so upgrading it to the bare
 * current DAG would silently turn it back into the generic one. The current DAG's own serve body (a cold channel's
 * `excludeEmailedWithin`) is kept under the copy's, except on a serve stating a `population` (people the brand already
 * contacted: a fresh-contacts skip would serve none of them). Returns `stated: false` for the generic row.
 */
export function sourcingTargetOf(storedDag: DAG, current: DAG = buildSourcingDag()): { dag: DAG; stated: boolean } {
  const storedServe = storedDag.nodes.find(
    (n) => n.type === "http.call" && (n.config as { path?: string } | undefined)?.path === "/orgs/buffer/next",
  );
  const body = (storedServe?.config as { body?: Record<string, unknown> } | undefined)?.body ?? {};
  const own = Object.keys(body).filter((k) => k !== FRESH_CONTACTS_FIELD);
  if (own.length === 0) return { dag: current, stated: false };
  const dag = structuredClone(current);
  const serve = dag.nodes.find((n) => n.id === "serve-lead");
  if (!serve) throw new Error("current sourcing DAG has no serve-lead node");
  const currentBody = (serve.config as { body?: Record<string, unknown> }).body ?? {};
  const merged: Record<string, unknown> = { ...structuredClone(currentBody), ...structuredClone(body) };
  if (merged.population !== undefined) delete merged[FRESH_CONTACTS_FIELD];
  else if (currentBody[FRESH_CONTACTS_FIELD] === undefined) delete merged[FRESH_CONTACTS_FIELD];
  (serve.config as Record<string, unknown>).body = merged;
  return { dag, stated: true };
}
