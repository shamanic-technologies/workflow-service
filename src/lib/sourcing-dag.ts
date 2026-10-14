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

/** The DAG of every sourcing pipe: a campaign run whose only work is the find. */
export function buildSourcingDag(): DAG {
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
        config: { service: "lead", method: "POST", path: "/orgs/buffer/next" },
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
 * current DAG would silently turn it back into the generic one. Returns `stated: false` for the generic row.
 */
export function sourcingTargetOf(storedDag: DAG, current: DAG = buildSourcingDag()): { dag: DAG; stated: boolean } {
  const storedServe = storedDag.nodes.find(
    (n) => n.type === "http.call" && (n.config as { path?: string } | undefined)?.path === "/orgs/buffer/next",
  );
  const body = (storedServe?.config as { body?: Record<string, unknown> } | undefined)?.body;
  if (body === undefined || Object.keys(body).length === 0) return { dag: current, stated: false };
  const dag = structuredClone(current);
  const serve = dag.nodes.find((n) => n.id === "serve-lead");
  if (!serve) throw new Error("current sourcing DAG has no serve-lead node");
  (serve.config as Record<string, unknown>).body = structuredClone(body);
  return { dag, stated: true };
}
