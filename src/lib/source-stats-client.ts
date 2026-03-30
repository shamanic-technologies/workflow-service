/**
 * Fetches stats from source services (lead, journalists, outlets) grouped by workflow slug.
 * Each source returns metrics in its own format — this module normalizes them into
 * a uniform Map<workflowSlug, Record<statsKey, number>>.
 *
 * The `source` field from the features-service stats registry determines which
 * service to call: "email-gateway", "leads", "journalists", "outlets".
 * Email-gateway stats are handled separately in stats-client.ts.
 */

import type { IdentityHeaders } from "./key-service-client.js";

function getServiceConfig(envPrefix: string): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env[`${envPrefix}_SERVICE_URL`];
  const apiKey = process.env[`${envPrefix}_SERVICE_API_KEY`];
  if (!baseUrl || !apiKey) {
    throw new Error(
      `${envPrefix}_SERVICE_URL and ${envPrefix}_SERVICE_API_KEY must be set`
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

/** Uniform return type: map of workflowSlug → { statsKey: count } */
export type SourceStatsMap = Map<string, Record<string, number>>;

// --- Lead service ---

export async function fetchLeadStats(
  workflowSlugs: string[],
  identity: IdentityHeaders,
): Promise<SourceStatsMap> {
  if (workflowSlugs.length === 0) return new Map();
  const { baseUrl, apiKey } = getServiceConfig("LEAD");
  const params = new URLSearchParams({
    groupBy: "workflowSlug",
    workflowSlugs: workflowSlugs.join(","),
  });

  const res = await fetch(`${baseUrl}/stats?${params}`, {
    headers: {
      "x-api-key": apiKey,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      "x-run-id": identity.runId,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`lead-service error: GET /stats -> ${res.status} ${res.statusText}: ${text}`);
  }

  const body = (await res.json()) as {
    groups: Array<{ key: string; served: number; contacted: number; buffered: number; skipped: number }>;
  };

  const result: SourceStatsMap = new Map();
  for (const g of body.groups) {
    result.set(g.key, {
      leadsServed: g.served,
      leadsContacted: g.contacted,
    });
  }
  return result;
}

// --- Journalists service ---

export async function fetchJournalistStats(
  workflowSlugs: string[],
  identity: IdentityHeaders,
): Promise<SourceStatsMap> {
  if (workflowSlugs.length === 0) return new Map();
  const { baseUrl, apiKey } = getServiceConfig("JOURNALISTS");
  const params = new URLSearchParams({ groupBy: "workflowSlug" });

  const res = await fetch(`${baseUrl}/stats?${params}`, {
    headers: {
      "x-api-key": apiKey,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      "x-run-id": identity.runId,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`journalists-service error: GET /stats -> ${res.status} ${res.statusText}: ${text}`);
  }

  const body = (await res.json()) as {
    groupedBy?: Record<string, { totalJournalists: number; byStatus: Record<string, number> }>;
  };

  const result: SourceStatsMap = new Map();
  if (body.groupedBy) {
    for (const [slug, stats] of Object.entries(body.groupedBy)) {
      if (!workflowSlugs.includes(slug)) continue;
      result.set(slug, {
        journalistsFound: stats.totalJournalists,
        journalistsContacted: stats.byStatus?.contacted ?? 0,
      });
    }
  }
  return result;
}

// --- Outlets service ---

export async function fetchOutletStats(
  workflowSlugs: string[],
  identity: IdentityHeaders,
): Promise<SourceStatsMap> {
  if (workflowSlugs.length === 0) return new Map();
  const { baseUrl, apiKey } = getServiceConfig("OUTLETS");
  const params = new URLSearchParams({ groupBy: "workflowSlug" });

  const res = await fetch(`${baseUrl}/outlets/stats?${params}`, {
    headers: {
      "x-api-key": apiKey,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      "x-run-id": identity.runId,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`outlets-service error: GET /outlets/stats -> ${res.status} ${res.statusText}: ${text}`);
  }

  const body = (await res.json()) as {
    groups: Array<{ key: string; outletsDiscovered: number; avgRelevanceScore: number; searchQueriesUsed: number }>;
  };

  const result: SourceStatsMap = new Map();
  for (const g of body.groups) {
    if (!workflowSlugs.includes(g.key)) continue;
    result.set(g.key, {
      outletsDiscovered: g.outletsDiscovered,
      searchQueriesUsed: g.searchQueriesUsed,
    });
  }
  return result;
}

// --- Dispatcher ---

/**
 * Fetches stats from the appropriate source service based on the registry `source` field.
 * Returns a map of workflowSlug → Record<statsKey, count>.
 *
 * Sources "email-gateway" and "runs" are handled by stats-client.ts — this module
 * handles "leads", "journalists", and "outlets".
 */
export async function fetchSourceStats(
  source: string,
  workflowSlugs: string[],
  identity: IdentityHeaders,
): Promise<SourceStatsMap> {
  switch (source) {
    case "leads":
      return fetchLeadStats(workflowSlugs, identity);
    case "journalists":
      return fetchJournalistStats(workflowSlugs, identity);
    case "outlets":
      return fetchOutletStats(workflowSlugs, identity);
    default:
      throw new Error(
        `[workflow-service] Unknown stats source: "${source}". Known sources: leads, journalists, outlets (email-gateway and runs are handled separately)`
      );
  }
}
