/**
 * Client for campaign-service.
 *
 * Used to check whether workflows are currently in use by active campaigns.
 */

import type { DownstreamHeaders } from "./downstream-headers.js";

interface Campaign {
  id: string;
  workflowSlug: string;
  status: string;
  nextRunAt: string | null;
}

/**
 * Fetch all campaigns from campaign-service.
 * Requires CAMPAIGN_SERVICE_URL and CAMPAIGN_SERVICE_API_KEY env vars.
 */
export async function fetchAllCampaigns(
  downstreamHeaders?: DownstreamHeaders,
): Promise<Campaign[]> {
  const baseUrl = process.env.CAMPAIGN_SERVICE_URL?.replace(/\/$/, "");
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "CAMPAIGN_SERVICE_URL and CAMPAIGN_SERVICE_API_KEY must be set to check active campaigns",
    );
  }

  const res = await fetch(`${baseUrl}/campaigns/list`, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "x-service-name": "workflow-service",
      ...downstreamHeaders,
    },
    signal: AbortSignal.timeout(600_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `campaign-service error: GET /campaigns/list -> ${res.status} ${res.statusText}: ${text}`,
    );
  }

  const data = (await res.json()) as { campaigns: Campaign[] };
  return data.campaigns;
}

/**
 * Returns the set of workflow slugs currently in use by a campaign.
 *
 * A campaign is in-use iff its status is "ongoing". Campaign-service uses two
 * statuses: "ongoing" and "stopped". Gate-blocked campaigns (e.g. waiting for a
 * budget window) stay "ongoing" with `nextRunAt` set, so a single status check
 * covers them.
 */
export async function fetchActiveWorkflowSlugs(
  downstreamHeaders?: DownstreamHeaders,
): Promise<Set<string>> {
  const campaigns = await fetchAllCampaigns(downstreamHeaders);

  const activeSlugs = new Set<string>();
  for (const c of campaigns) {
    if (c.status === "ongoing") {
      activeSlugs.add(c.workflowSlug);
    }
  }

  return activeSlugs;
}
