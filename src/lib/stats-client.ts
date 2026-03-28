import type { IdentityHeaders } from "./key-service-client.js";

// --- Config helpers (same pattern as key-service-client.ts) ---

function getRunsServiceConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be set to fetch run costs"
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

function getEmailGatewayConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "EMAIL_GATEWAY_SERVICE_URL and EMAIL_GATEWAY_SERVICE_API_KEY must be set to fetch email stats"
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

// --- Types ---

export interface RunCost {
  runId: string;
  totalCostInUsdCents: number;
}

export interface EmailStats {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
  recipients: number;
}

export interface EmailStatsResponse {
  transactional: EmailStats;
  broadcast: EmailStats;
}

// --- Fetch aggregated costs from runs-service (auth) ---

export async function fetchRunCostsAuth(
  identity: IdentityHeaders,
  workflowSlugs?: string[],
): Promise<WorkflowSlugCost[]> {
  const { baseUrl, apiKey } = getRunsServiceConfig();
  const params = new URLSearchParams({ groupBy: "workflowSlug" });
  if (workflowSlugs?.length) params.set("workflowSlugs", workflowSlugs.join(","));

  const res = await fetch(`${baseUrl}/v1/stats/costs?${params}`, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      "x-run-id": identity.runId,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `runs-service error: GET /v1/stats/costs -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  const body = (await res.json()) as {
    groups: Array<{
      dimensions: Record<string, string | null>;
      totalCostInUsdCents: string;
      runCount: number;
    }>;
  };

  return body.groups
    .filter((g) => g.dimensions.workflowSlug != null)
    .map((g) => ({
      workflowSlug: g.dimensions.workflowSlug!,
      totalCostInUsdCents: Number(g.totalCostInUsdCents) || 0,
      runCount: g.runCount,
    }));
}

// --- Public: fetch aggregated costs from runs-service (no identity) ---

export interface WorkflowSlugCost {
  workflowSlug: string;
  totalCostInUsdCents: number;
  runCount: number;
}

export async function fetchRunCostsPublic(filters?: {
  brandId?: string;
  orgId?: string;
  workflowSlugs?: string[];
}): Promise<WorkflowSlugCost[]> {
  const { baseUrl, apiKey } = getRunsServiceConfig();
  const params = new URLSearchParams({ groupBy: "workflowSlug" });
  if (filters?.brandId) params.set("brandId", filters.brandId);
  if (filters?.orgId) params.set("orgId", filters.orgId);
  if (filters?.workflowSlugs?.length) params.set("workflowSlugs", filters.workflowSlugs.join(","));

  const res = await fetch(`${baseUrl}/v1/stats/public/costs?${params}`, {
    method: "GET",
    headers: { "x-api-key": apiKey },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `runs-service error: GET /v1/stats/public/costs -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  const body = (await res.json()) as {
    groups: Array<{
      dimensions: Record<string, string | null>;
      totalCostInUsdCents: string;
      runCount: number;
    }>;
  };

  return body.groups
    .filter((g) => g.dimensions.workflowSlug != null)
    .map((g) => ({
      workflowSlug: g.dimensions.workflowSlug!,
      totalCostInUsdCents: Number(g.totalCostInUsdCents) || 0,
      runCount: g.runCount,
    }));
}

// --- Fetch email stats from email-gateway-service ---

const EMPTY_STATS: EmailStats = {
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  replied: 0,
  bounced: 0,
  unsubscribed: 0,
  recipients: 0,
};

/** Map email-gateway field names (emailsOpened etc.) to our internal names (opened etc.) */
export function mapGatewayStats(raw: Record<string, unknown>): EmailStats {
  return {
    sent: Number(raw.emailsSent ?? 0),
    delivered: Number(raw.emailsDelivered ?? 0),
    opened: Number(raw.emailsOpened ?? 0),
    clicked: Number(raw.emailsClicked ?? 0),
    replied: Number(raw.emailsReplied ?? 0),
    bounced: Number(raw.emailsBounced ?? 0),
    unsubscribed: Number(raw.repliesUnsubscribe ?? 0),
    recipients: Number(raw.recipients ?? 0),
  };
}

// --- Fetch email stats grouped by workflowSlug ---

export interface EmailStatsGroup {
  workflowSlug: string;
  transactional: EmailStats;
  broadcast: EmailStats;
}

export async function fetchEmailStatsAuth(
  workflowSlugs: string[],
  identity: IdentityHeaders,
): Promise<EmailStatsGroup[]> {
  if (workflowSlugs.length === 0) return [];

  const { baseUrl, apiKey } = getEmailGatewayConfig();
  const params = new URLSearchParams({
    groupBy: "workflowSlug",
    workflowSlugs: workflowSlugs.join(","),
  });

  const res = await fetch(`${baseUrl}/stats?${params}`, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      "x-run-id": identity.runId,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `email-gateway-service error: GET /stats -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return parseEmailStatsGroups(await res.json());
}

export async function fetchEmailStatsPublic(
  workflowSlugs: string[],
): Promise<EmailStatsGroup[]> {
  if (workflowSlugs.length === 0) return [];

  const { baseUrl, apiKey } = getEmailGatewayConfig();
  const params = new URLSearchParams({
    groupBy: "workflowSlug",
    workflowSlugs: workflowSlugs.join(","),
  });

  const res = await fetch(`${baseUrl}/stats/public?${params}`, {
    method: "GET",
    headers: { "x-api-key": apiKey },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `email-gateway-service error: GET /stats/public -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return parseEmailStatsGroups(await res.json());
}

function parseEmailStatsGroups(body: unknown): EmailStatsGroup[] {
  const { groups } = body as {
    groups: Array<{
      key: string;
      transactional?: Record<string, unknown>;
      broadcast?: Record<string, unknown>;
    }>;
  };

  return (groups ?? []).map((g) => ({
    workflowSlug: g.key,
    transactional: mapGatewayStats(g.transactional ?? {}),
    broadcast: mapGatewayStats(g.broadcast ?? {}),
  }));
}

