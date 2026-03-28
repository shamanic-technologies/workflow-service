/**
 * Client for features-service dynasty resolution.
 *
 * Workflow-service needs the stable (unversioned) dynasty identifiers for a feature
 * to compose workflow names/slugs. Until features-service exposes
 * GET /features/dynasty?slug=..., we fall back to deriving them from the featureSlug.
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
 * Tries features-service first. Falls back to deriving from featureSlug:
 * - Strip trailing version suffixes like "-v2", "-v3"
 * - Capitalize words for the display name
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
          feature_dynasty_name?: string;
          feature_dynasty_slug?: string;
          featureDynastyName?: string;
          featureDynastySlug?: string;
        };

        const dynastyName = data.featureDynastyName ?? data.feature_dynasty_name;
        const dynastySlug = data.featureDynastySlug ?? data.feature_dynasty_slug;

        if (dynastyName && dynastySlug) {
          return { featureDynastyName: dynastyName, featureDynastySlug: dynastySlug };
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
  // Strip trailing version suffix like "-v2", "-v3"
  const dynastySlug = featureSlug.replace(/-v\d+$/, "");

  // Capitalize each word for display name
  const dynastyName = dynastySlug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return { featureDynastyName: dynastyName, featureDynastySlug: dynastySlug };
}
