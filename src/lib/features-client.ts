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
