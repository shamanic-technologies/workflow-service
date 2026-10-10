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
    signal: AbortSignal.timeout(600_000),
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
      signal: AbortSignal.timeout(600_000),
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
    signal: AbortSignal.timeout(600_000),
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

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      specs.set(result.value.name, result.value.spec);
    } else {
      console.warn(`[workflow-service] Failed to fetch spec for "${unique[i]}" — service may no longer exist: ${result.reason}`);
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
      signal: AbortSignal.timeout(600_000),
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

// --- Agent discovery (api-registry GET /discover/*, three levels) ---------------------------
//
// Level 1 lists every service in one line, level 2 one service's endpoints with their measured
// cost, duration, success rate and ROI, level 3 the full doc of ONE endpoint. The workflow
// generator walks them in that order so the model only ever reads the docs of the endpoints it
// picked, instead of every service's full spec (7.7M characters on 2026-10-10).

export interface DiscoveredService {
  name: string;
  description: string;
  endpoints: number | null;
  error?: string;
}

export interface DiscoverServicesResponse {
  serviceCount: number;
  services: DiscoveredService[];
}

export interface DiscoveredEndpoint {
  method: string;
  path: string;
  summary: string;
  stats?: unknown;
  roi?: unknown;
}

export interface DiscoverServiceEndpointsResponse {
  service: string;
  description: string;
  endpointCount: number;
  endpoints: DiscoveredEndpoint[];
}

/** Level 3 body: the endpoint's full doc (request body, responses) plus its run stats and ROI. */
export type DiscoverEndpointResponse = Record<string, unknown> & {
  service: string;
  method: string;
  path: string;
};

async function discoverGet<T>(path: string, downstreamHeaders?: DownstreamHeaders): Promise<T> {
  const { baseUrl, apiKey } = getApiRegistryConfig();
  const res = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: buildHeaders(apiKey, downstreamHeaders),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`api-registry error: GET ${path} -> ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/** Level 1: every registered service, one line each. */
export function discoverServices(downstreamHeaders?: DownstreamHeaders): Promise<DiscoverServicesResponse> {
  return discoverGet<DiscoverServicesResponse>("/discover/services", downstreamHeaders);
}

/** Level 2: every endpoint of one service (limit 200 = the registry's max), most used first. */
export function discoverServiceEndpoints(
  service: string,
  downstreamHeaders?: DownstreamHeaders,
): Promise<DiscoverServiceEndpointsResponse> {
  return discoverGet<DiscoverServiceEndpointsResponse>(
    `/discover/services/${encodeURIComponent(service)}/endpoints?limit=200`,
    downstreamHeaders,
  );
}

/** Level 3: the full doc of one endpoint. */
export function discoverEndpoint(
  service: string,
  method: string,
  path: string,
  downstreamHeaders?: DownstreamHeaders,
): Promise<DiscoverEndpointResponse> {
  const q = `method=${encodeURIComponent(method.toUpperCase())}&path=${encodeURIComponent(path)}`;
  return discoverGet<DiscoverEndpointResponse>(
    `/discover/services/${encodeURIComponent(service)}/endpoint?${q}`,
    downstreamHeaders,
  );
}
