/**
 * THE WORKFLOW OF A SOURCING PIPE (owner 2026-10-11: "the infra is homogeneous": every pipe runs a workflow
 * features-service chose, the sourcing pipes included; they used to run with none).
 *
 * A sourcing pipe performs Start -> Lead found for one sourcing channel: an origin (Apollo Cold Filters, Apollo
 * Buying Signals, LinkedIn Engagement Signals, Your CRM Contacts) or Lead Sourcing (human-service picks the
 * origins per brand). It is REACTIVE on the `lead_requested` trigger, which is INLINE: an outreach run asks for
 * a lead and the source answers inside that run. So its one step is the serve itself, lead-service
 * `POST /orgs/buffer/next`: lead-service files it under the ON source campaign of the audience's origin (or
 * under Lead Sourcing for an origin human-service chose), buys and qualifies the person, and hands them to Lead
 * found. The same DAG for every sourcing channel: what differs is the channel's own lists, never the step.
 *
 * Registered on its pipe (`<channel>|start_to_lead_found`) through features-service's register route like every
 * workflow (`scripts/seed-sourcing-workflows.mjs`), so features-service chooses workflows on sourcing pipes like
 * anywhere else. campaign-service never dispatches it on a timer: the trigger is inline.
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
  "Finds one person when an outreach campaign asks for a lead: serves the next person from this source's lists " +
  "(Lead Sourcing: from the sources human-service chose for the brand), qualified before anything is paid, and " +
  "hands them to Lead found. Runs inside the outreach run that asks (trigger: Lead Requested).";

/** The one-step DAG of every sourcing pipe: the serve. */
export function buildSourcingDag(): DAG {
  return {
    nodes: [
      {
        id: "serve-lead",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/buffer/next", body: {} },
      },
    ],
    edges: [],
  };
}
