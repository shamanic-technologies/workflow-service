// Cross-environment URL guard — fails startup loudly when a staging
// container is configured with a production hostname (or vice-versa).
// Prevents the failure mode seen on 2026-05-11 where staging
// workflow-service had WINDMILL_SERVER_URL pointing at prod Windmill,
// causing prod DAG fires with staging-only runIds and FK violations
// downstream in runs-service.

const PROD_MARKERS = [/windmill-production/i];
const STAGING_MARKERS = [/staging/i];

type EnvLabel = "production" | "staging" | "unknown";

function envOfUrl(url: string): EnvLabel {
  if (STAGING_MARKERS.some((re) => re.test(url))) return "staging";
  if (PROD_MARKERS.some((re) => re.test(url))) return "production";
  return "unknown";
}

export function assertEnvironmentConsistency(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const railwayEnv = env.RAILWAY_ENVIRONMENT_NAME;
  if (railwayEnv !== "staging" && railwayEnv !== "production") return;

  const externalUrls: Record<string, string | undefined> = {
    WINDMILL_SERVER_URL: env.WINDMILL_SERVER_URL,
    API_REGISTRY_SERVICE_URL: env.API_REGISTRY_SERVICE_URL,
  };

  const mismatches: string[] = [];
  for (const [key, url] of Object.entries(externalUrls)) {
    if (!url) continue;
    const urlEnv = envOfUrl(url);
    if (urlEnv !== "unknown" && urlEnv !== railwayEnv) {
      mismatches.push(
        `${key}=${url} (looks ${urlEnv}, but RAILWAY_ENVIRONMENT_NAME=${railwayEnv})`,
      );
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `[env-safety] Cross-environment URL detected:\n  - ${mismatches.join(
        "\n  - ",
      )}\n\nAborting startup.`,
    );
  }
}
