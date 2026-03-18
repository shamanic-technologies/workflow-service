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

// --- Fetch run costs from runs-service ---

export async function fetchRunCosts(runIds: string[], identity: IdentityHeaders): Promise<RunCost[]> {
  if (runIds.length === 0) return [];

  const { baseUrl, apiKey } = getRunsServiceConfig();
  const costs: RunCost[] = [];

  await Promise.all(
    runIds.map(async (runId) => {
      const res = await fetch(`${baseUrl}/v1/runs/${runId}`, {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "x-org-id": identity.orgId,
          "x-user-id": identity.userId,
          "x-run-id": identity.runId,
        },
      });
      if (!res.ok) {
        console.warn(
          `[stats-client] Failed to fetch run ${runId}: ${res.status}`
        );
        return;
      }
      const body = (await res.json()) as {
        id: string;
        totalCostInUsdCents: string;
      };
      costs.push({
        runId: body.id,
        totalCostInUsdCents: Number(body.totalCostInUsdCents) || 0,
      });
    })
  );

  return costs;
}

// --- Public: fetch aggregated costs from runs-service (no identity) ---

export interface WorkflowNameCost {
  workflowName: string;
  totalCostInUsdCents: number;
  runCount: number;
}

export async function fetchRunCostsPublic(filters?: {
  brandId?: string;
  orgId?: string;
}): Promise<WorkflowNameCost[]> {
  const { baseUrl, apiKey } = getRunsServiceConfig();
  const params = new URLSearchParams({ groupBy: "workflowName" });
  if (filters?.brandId) params.set("brandId", filters.brandId);
  if (filters?.orgId) params.set("orgId", filters.orgId);

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
    .filter((g) => g.dimensions.workflowName != null)
    .map((g) => ({
      workflowName: g.dimensions.workflowName!,
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

export async function fetchEmailStats(
  runIds: string[],
  identity: IdentityHeaders,
): Promise<EmailStatsResponse> {
  if (runIds.length === 0) {
    return { transactional: { ...EMPTY_STATS }, broadcast: { ...EMPTY_STATS } };
  }

  const { baseUrl, apiKey } = getEmailGatewayConfig();

  const res = await fetch(
    `${baseUrl}/stats?runIds=${runIds.join(",")}`,
    {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "x-org-id": identity.orgId,
        "x-user-id": identity.userId,
        "x-run-id": identity.runId,
      },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `email-gateway-service error: GET /stats -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  const body = (await res.json()) as Record<string, unknown>;
  const rawTransactional = (body.transactional ?? {}) as Record<string, unknown>;
  const rawBroadcast = (body.broadcast ?? {}) as Record<string, unknown>;

  return {
    transactional: mapGatewayStats(rawTransactional),
    broadcast: mapGatewayStats(rawBroadcast),
  };
}

// --- Public: fetch email stats (no identity) ---

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

export async function fetchEmailStatsPublic(
  runIds: string[],
): Promise<EmailStatsResponse> {
  if (runIds.length === 0) {
    return { transactional: { ...EMPTY_STATS }, broadcast: { ...EMPTY_STATS } };
  }

  const { baseUrl, apiKey } = getEmailGatewayConfig();

  const res = await fetch(
    `${baseUrl}/stats/public?runIds=${runIds.join(",")}`,
    {
      method: "GET",
      headers: { "x-api-key": apiKey },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `email-gateway-service error: GET /stats/public -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  const body = (await res.json()) as Record<string, unknown>;
  const rawTransactional = (body.transactional ?? {}) as Record<string, unknown>;
  const rawBroadcast = (body.broadcast ?? {}) as Record<string, unknown>;

  return {
    transactional: mapGatewayStats(rawTransactional),
    broadcast: mapGatewayStats(rawBroadcast),
  };
}

