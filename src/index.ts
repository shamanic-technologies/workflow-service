import express from "express";
import cors from "cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db/index.js";
import { workflowRuns } from "./db/schema.js";
import { getWindmillClient } from "./lib/windmill-client.js";
import { JobPoller } from "./lib/job-poller.js";
import { PeriodicCleanup } from "./lib/periodic-cleanup.js";
import { requireIdentity } from "./middleware/auth.js";
import { checkApiRegistryHealth, validateAndUpgradeWorkflows } from "./lib/startup-validator.js";
import { assertEnvironmentConsistency } from "./lib/env-safety.js";
import { deployNodes } from "./lib/deploy-nodes.js";
import { SpecWatcher } from "./lib/spec-watcher.js";
import healthRoutes from "./routes/health.js";
import workflowsRoutes from "./routes/workflows.js";
import workflowRunsRoutes from "./routes/workflow-runs.js";
import openapiRoutes from "./routes/openapi.js";
import publicWorkflowsRoutes from "./routes/public-workflows.js";
import internalRoutes from "./routes/internal.js";

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors());
app.use(express.json());

// Public routes (no identity required)
app.use(healthRoutes);
app.use(openapiRoutes);
app.use(publicWorkflowsRoutes);

// Internal routes (x-api-key only, no identity headers)
app.use(internalRoutes);

// Identity-gated routes
app.use(requireIdentity);
app.use(workflowsRoutes);
app.use(workflowRunsRoutes);

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

if (process.env.NODE_ENV !== "test") {
  (async () => {
    try {
      // Fail loud before any side-effect if env URLs cross production/staging boundaries.
      assertEnvironmentConsistency();

      // Run migrations
      await migrate(db, { migrationsFolder: "./drizzle" });
      console.log("Migrations complete");

      // Verify API Registry is reachable — fail fast if not
      if (process.env.API_REGISTRY_SERVICE_URL && process.env.API_REGISTRY_SERVICE_API_KEY) {
        try {
          await checkApiRegistryHealth();
          console.log("API Registry health check passed");
        } catch (err) {
          console.error("API Registry is unreachable — aborting startup:", err);
          process.exit(1);
        }
      } else {
        console.warn("API_REGISTRY_SERVICE_URL / API_REGISTRY_SERVICE_API_KEY not set — skipping API Registry health check");
      }

      // Start job poller (only if Windmill is configured)
      const windmillClient = getWindmillClient();
      let periodicCleanup: PeriodicCleanup | null = null;
      if (windmillClient) {
        // Set instance-wide retention for Windmill completed_job rows.
        // 7 days = 604_800 s. CE caps at 30 days; our value is well under.
        // Requires the API token to be superadmin — fail loud (warn) if not,
        // but do not block boot: cleanup still works without retention set.
        try {
          await windmillClient.setGlobalSetting("retention_period_secs", 604800);
          console.log("[workflow-service] Windmill retention_period_secs set to 604800 (7 days)");
        } catch (err) {
          console.warn(
            "[workflow-service] Failed to set Windmill retention_period_secs — token may not be superadmin:",
            err instanceof Error ? err.message : err,
          );
        }

        // Sync node scripts to Windmill — idempotent, skips unchanged scripts
        try {
          const deployed = await deployNodes(windmillClient);
          if (deployed.length > 0) {
            console.log(`[workflow-service] Deployed ${deployed.length} node script(s) to Windmill`);
          }
        } catch (err) {
          console.error("[workflow-service] Failed to deploy node scripts to Windmill:", err);
          process.exit(1);
        }

        const poller = new JobPoller(db, windmillClient, workflowRuns);
        poller.start();

        // Periodic cleanup: re-runs stale-deprecation + Windmill orphan-flow
        // cleanup every 24h. Boot already runs them once in validateAndUpgradeWorkflows;
        // this keeps the system tidy without requiring service restarts.
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        periodicCleanup = new PeriodicCleanup(db, windmillClient, ONE_DAY_MS);
        periodicCleanup.start();
      } else {
        console.log("Windmill not configured (WINDMILL_SERVER_URL / WINDMILL_SERVER_API_KEY missing) — job poller disabled");
      }

      const shutdown = (signal: string) => {
        console.log(`[workflow-service] ${signal} received — shutting down`);
        periodicCleanup?.stop();
        process.exit(0);
      };
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));

      app.listen(Number(PORT), "::", () => {
        console.log(`workflow-service running on port ${PORT}`);
      });

      // Validate & upgrade workflows AFTER listening — so the service can serve
      // health checks and traffic while upgrades run (avoids Railway 502s)
      if (process.env.API_REGISTRY_SERVICE_URL && process.env.API_REGISTRY_SERVICE_API_KEY) {
        try {
          await validateAndUpgradeWorkflows({ db, windmillClient });
        } catch (err) {
          console.error("[workflow-service] Workflow validation/upgrade failed:", err);
          // Don't crash — workflows with issues are kept active and logged above
        }

        // Start SpecWatcher — checks every 5 min if OpenAPI specs changed,
        // triggers workflow upgrades only when a spec change breaks a workflow.
        // The check itself is free (HTTP + hash comparison), LLM only on upgrade.
        const specWatcher = new SpecWatcher({ db, windmillClient });
        await specWatcher.check(); // Store baseline hash (no-op on first call)
        specWatcher.start();
      }
    } catch (err) {
      console.error("Startup failed:", err);
      process.exit(1);
    }
  })();
}

export default app;
