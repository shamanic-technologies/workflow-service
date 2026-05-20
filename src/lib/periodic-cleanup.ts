import type { db as DbInstance } from "../db/index.js";
import type { WindmillClient } from "./windmill-client.js";
import { deprecateStaleWorkflows } from "./stale-workflow-deprecator.js";
import { cleanupOrphanedWindmillFlows } from "./windmill-flow-cleanup.js";
import { fetchActiveWorkflowSlugs } from "./campaign-client.js";

type Database = typeof DbInstance;

/**
 * Periodically re-runs the same cleanup the boot path runs once:
 *   1. Deprecate stale active workflows (>1 week old, zero runs, no active campaign).
 *   2. Delete Windmill flows of deprecated workflows no longer referenced by a campaign.
 *
 * Both steps independently survive failures of their downstream dependencies
 * (DB hiccup, campaign-service unreachable) — one bad tick must not stop the loop.
 */
export class PeriodicCleanup {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private windmillClient: WindmillClient,
    private intervalMs: number,
  ) {}

  start(): void {
    if (this.intervalId) return;
    console.log(
      `[workflow-service] PeriodicCleanup starting (every ${this.intervalMs}ms)`,
    );
    this.intervalId = setInterval(() => {
      this.runOnce().catch((err) => {
        console.error(
          "[workflow-service] PeriodicCleanup tick failed:",
          err instanceof Error ? err.message : err,
        );
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[workflow-service] PeriodicCleanup stopped");
    }
  }

  async runOnce(): Promise<void> {
    try {
      const result = await deprecateStaleWorkflows(this.db);
      if (result.deprecatedCount > 0) {
        console.log(
          `[workflow-service] PeriodicCleanup: deprecated ${result.deprecatedCount} stale workflows, kept ${result.keptByCampaign} by active campaign`,
        );
      }
      if (result.skippedNoCampaignService) {
        console.warn(
          "[workflow-service] PeriodicCleanup: stale deprecation skipped — campaign-service unreachable",
        );
      }
    } catch (err) {
      console.error(
        "[workflow-service] PeriodicCleanup: deprecateStaleWorkflows failed:",
        err instanceof Error ? err.message : err,
      );
    }

    let activeSlugs: Set<string>;
    try {
      activeSlugs = await fetchActiveWorkflowSlugs();
    } catch (err) {
      console.warn(
        "[workflow-service] PeriodicCleanup: cannot fetch active campaign slugs — skipping orphan-flow cleanup this tick:",
        err instanceof Error ? err.message : err,
      );
      return;
    }

    try {
      const result = await cleanupOrphanedWindmillFlows(
        this.db,
        this.windmillClient,
        activeSlugs,
      );
      if (result.deleted > 0 || result.failed > 0) {
        console.log(
          `[workflow-service] PeriodicCleanup: Windmill cleanup deleted=${result.deleted} kept=${result.kept} failed=${result.failed}`,
        );
      }
    } catch (err) {
      console.error(
        "[workflow-service] PeriodicCleanup: cleanupOrphanedWindmillFlows failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
