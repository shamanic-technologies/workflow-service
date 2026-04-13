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
  toResumeAt: string | null;
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
 * Returns the set of workflow slugs that are currently "in use" by a campaign.
 * A campaign is considered in-use if:
 *   - status is "active", OR
 *   - toResumeAt is non-null (periodic campaign scheduled to resume)
 */
export async function fetchActiveWorkflowSlugs(
  downstreamHeaders?: DownstreamHeaders,
): Promise<Set<string>> {
  const campaigns = await fetchAllCampaigns(downstreamHeaders);

  const activeSlugs = new Set<string>();
  for (const c of campaigns) {
    if (c.status === "active" || c.toResumeAt !== null) {
      activeSlugs.add(c.workflowSlug);
    }
  }

  return activeSlugs;
}
