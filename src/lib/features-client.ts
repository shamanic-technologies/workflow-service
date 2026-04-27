/**
 * Client for features-service.
 */

import type { DownstreamHeaders } from "./downstream-headers.js";

function getFeaturesServiceConfig(): { baseUrl: string; apiKey: string } | null {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

// --- Feature outputs (for dynamic ranking metrics) ---

export interface FeatureOutput {
  key: string;
  displayOrder: number;
  defaultSort?: boolean;
  sortDirection?: "asc" | "desc";
}

/**
 * Fetch the outputs array for a feature from features-service.
 * Throws if features-service is not configured or returns an error.
 */
export async function fetchFeatureOutputs(
  featureSlug: string,
  downstreamHeaders?: DownstreamHeaders,
): Promise<FeatureOutput[]> {
  const config = getFeaturesServiceConfig();
  if (!config) {
    throw new Error(
      "FEATURES_SERVICE_URL and FEATURES_SERVICE_API_KEY must be set to resolve feature outputs"
    );
  }

  const res = await fetch(
    `${config.baseUrl}/features/${encodeURIComponent(featureSlug)}`,
    {
      method: "GET",
      headers: { "x-api-key": config.apiKey, ...downstreamHeaders },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `features-service error: GET /features/${featureSlug} -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  const data = (await res.json()) as { feature: { outputs: FeatureOutput[] } };
  return data.feature.outputs;
}

// --- Stats registry ---

export interface StatsRegistryEntry {
  type: string;
  label: string;
  source?: string;
}

/**
 * Fetch the stats key registry from features-service.
 * Returns a map of stats key → { type, label }.
 * Throws if features-service is not configured or returns an error.
 */
export async function fetchStatsRegistry(
  downstreamHeaders?: DownstreamHeaders,
): Promise<Record<string, StatsRegistryEntry>> {
  const config = getFeaturesServiceConfig();
  if (!config) {
    throw new Error(
      "FEATURES_SERVICE_URL and FEATURES_SERVICE_API_KEY must be set to fetch stats registry"
    );
  }

  const res = await fetch(`${config.baseUrl}/stats/registry`, {
    method: "GET",
    headers: { "x-api-key": config.apiKey, ...downstreamHeaders },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `features-service error: GET /stats/registry -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  const data = (await res.json()) as { registry: Record<string, StatsRegistryEntry> };
  return data.registry;
}
