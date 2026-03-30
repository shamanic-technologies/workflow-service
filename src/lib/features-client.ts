/**
 * Client for features-service dynasty resolution.
 *
 * Calls GET /features/dynasty?slug=<featureSlug> to get the stable (unversioned)
 * dynasty identifiers for a feature. Falls back to slug derivation if
 * features-service is not configured or unreachable.
 */

export interface FeatureDynasty {
  featureDynastyName: string;
  featureDynastySlug: string;
}

function getFeaturesServiceConfig(): { baseUrl: string; apiKey: string } | null {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

/**
 * Resolve the stable dynasty identifiers for a feature.
 *
 * Calls features-service GET /features/dynasty?slug=... which returns
 * { feature_dynasty_name, feature_dynasty_slug }.
 *
 * Falls back to deriving from featureSlug if features-service is
 * not configured or unreachable.
 */
export async function resolveFeatureDynasty(
  featureSlug: string,
): Promise<FeatureDynasty> {
  const config = getFeaturesServiceConfig();

  if (config) {
    try {
      const res = await fetch(
        `${config.baseUrl}/features/dynasty?slug=${encodeURIComponent(featureSlug)}`,
        {
          method: "GET",
          headers: { "x-api-key": config.apiKey },
        },
      );

      if (res.ok) {
        const data = (await res.json()) as {
          feature_dynasty_name: string;
          feature_dynasty_slug: string;
        };

        if (data.feature_dynasty_name && data.feature_dynasty_slug) {
          return {
            featureDynastyName: data.feature_dynasty_name,
            featureDynastySlug: data.feature_dynasty_slug,
          };
        }
      }

      console.warn(
        `[workflow-service] features-service dynasty lookup failed (${res.status}), falling back to slug derivation`,
      );
    } catch (err) {
      console.warn(
        "[workflow-service] features-service unreachable, falling back to slug derivation:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return deriveFromSlug(featureSlug);
}

/**
 * Fallback: derive dynasty identifiers from featureSlug.
 * Strips trailing -v{N} suffix and capitalizes words.
 */
function deriveFromSlug(featureSlug: string): FeatureDynasty {
  const dynastySlug = featureSlug.replace(/-v\d+$/, "");

  const dynastyName = dynastySlug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return { featureDynastyName: dynastyName, featureDynastySlug: dynastySlug };
}

/**
 * Resolve all versioned feature slugs belonging to a dynasty.
 *
 * Calls features-service GET /features/dynasty/slugs?dynastySlug=... which returns
 * { slugs: ['feature-slug', 'feature-slug-v2', ...] }.
 *
 * Throws if features-service is not configured or returns an error.
 */
export async function resolveFeatureDynastySlugs(
  dynastySlug: string,
): Promise<string[]> {
  const config = getFeaturesServiceConfig();
  if (!config) {
    throw new Error(
      "FEATURES_SERVICE_URL and FEATURES_SERVICE_API_KEY must be set to resolve dynasty slugs"
    );
  }

  const res = await fetch(
    `${config.baseUrl}/features/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`,
    {
      method: "GET",
      headers: { "x-api-key": config.apiKey },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `features-service error: GET /features/dynasty/slugs?dynastySlug=${dynastySlug} -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  const data = (await res.json()) as { slugs: string[] };
  return data.slugs;
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
      headers: { "x-api-key": config.apiKey },
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
export async function fetchStatsRegistry(): Promise<Record<string, StatsRegistryEntry>> {
  const config = getFeaturesServiceConfig();
  if (!config) {
    throw new Error(
      "FEATURES_SERVICE_URL and FEATURES_SERVICE_API_KEY must be set to fetch stats registry"
    );
  }

  const res = await fetch(`${config.baseUrl}/stats/registry`, {
    method: "GET",
    headers: { "x-api-key": config.apiKey },
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
