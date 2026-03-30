import type { DownstreamHeaders } from "./downstream-headers.js";

export interface LlmServiceSummary {
  service: string;
  description?: string;
  endpointCount: number;
}

export interface LlmContextResponse {
  _description: string;
  _usage: string;
  services: LlmServiceSummary[];
}

export interface LlmServiceEndpoint {
  method: string;
  path: string;
  summary: string;
  responseFields?: string[];
}

export interface LlmServiceEndpointsResponse {
  service: string;
  description?: string;
  endpoints: LlmServiceEndpoint[];
}

function getApiRegistryConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.API_REGISTRY_SERVICE_URL;
  const apiKey = process.env.API_REGISTRY_SERVICE_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "API_REGISTRY_SERVICE_URL and API_REGISTRY_SERVICE_API_KEY must be set"
    );
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

function buildHeaders(apiKey: string, downstreamHeaders?: DownstreamHeaders): Record<string, string> {
  return { "x-api-key": apiKey, ...downstreamHeaders };
}

/** GET /llm-context — compact summary of all services and endpoints for LLM consumption */
export async function fetchLlmContext(downstreamHeaders?: DownstreamHeaders): Promise<LlmContextResponse> {
  const { baseUrl, apiKey } = getApiRegistryConfig();

  const res = await fetch(`${baseUrl}/llm-context`, {
    method: "GET",
    headers: buildHeaders(apiKey, downstreamHeaders),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `api-registry error: GET /llm-context -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<LlmContextResponse>;
}

/** GET /llm-context/:service — endpoints for a specific service (method, path, summary) */
export async function fetchServiceEndpoints(
  serviceName: string,
  downstreamHeaders?: DownstreamHeaders,
): Promise<LlmServiceEndpointsResponse> {
  const { baseUrl, apiKey } = getApiRegistryConfig();

  const res = await fetch(
    `${baseUrl}/llm-context/${encodeURIComponent(serviceName)}`,
    {
      method: "GET",
      headers: buildHeaders(apiKey, downstreamHeaders),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `api-registry error: GET /llm-context/${serviceName} -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<LlmServiceEndpointsResponse>;
}

/** GET /services — list all registered services (used for health check + enumeration) */
export async function fetchServiceList(
  downstreamHeaders?: DownstreamHeaders,
): Promise<Array<{ service: string }>> {
  const { baseUrl, apiKey } = getApiRegistryConfig();

  const res = await fetch(`${baseUrl}/services`, {
    method: "GET",
    headers: buildHeaders(apiKey, downstreamHeaders),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `api-registry error: GET /services -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<Array<{ service: string }>>;
}

/** Fetch OpenAPI specs for multiple services (deduplicated). Returns Map<serviceName, spec> */
export async function fetchSpecsForServices(
  serviceNames: string[],
  downstreamHeaders?: DownstreamHeaders,
): Promise<Map<string, Record<string, unknown>>> {
  const unique = [...new Set(serviceNames)];
  const specs = new Map<string, Record<string, unknown>>();

  const results = await Promise.allSettled(
    unique.map(async (name) => {
      const spec = await fetchServiceSpec(name, downstreamHeaders);
      return { name, spec };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      specs.set(result.value.name, result.value.spec);
    } else {
      console.warn(`[api-registry] Failed to fetch spec: ${result.reason}`);
    }
  }

  return specs;
}

/** GET /openapi/:service — full OpenAPI spec for one service */
export async function fetchServiceSpec(
  serviceName: string,
  downstreamHeaders?: DownstreamHeaders,
): Promise<Record<string, unknown>> {
  const { baseUrl, apiKey } = getApiRegistryConfig();

  const res = await fetch(
    `${baseUrl}/openapi/${encodeURIComponent(serviceName)}`,
    {
      method: "GET",
      headers: buildHeaders(apiKey, downstreamHeaders),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `api-registry error: GET /openapi/${serviceName} -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<Record<string, unknown>>;
}
