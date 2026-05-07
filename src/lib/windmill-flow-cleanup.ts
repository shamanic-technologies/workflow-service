/**
 * Sweep deprecated workflows and delete their Windmill flows when no active
 * campaign still references them. Used at startup to garbage-collect orphan
 * flows that accumulated before the deprecation path managed Windmill state.
 */

import { isNotNull } from "drizzle-orm";
import { workflows } from "../db/schema.js";
import type { db as DbInstance } from "../db/index.js";
import type { WindmillClient } from "./windmill-client.js";

type Database = typeof DbInstance;

export interface CleanupResult {
  deleted: number;
  kept: number;
  failed: number;
}

export async function cleanupOrphanedWindmillFlows(
  database: Database,
  windmillClient: WindmillClient,
  activeCampaignSlugs: Set<string>,
): Promise<CleanupResult> {
  const rows = await database
    .select({
      id: workflows.id,
      workflowSlug: workflows.workflowSlug,
      status: workflows.status,
      windmillFlowPath: workflows.windmillFlowPath,
    })
    .from(workflows)
    .where(isNotNull(workflows.windmillFlowPath));

  let deleted = 0;
  let kept = 0;
  let failed = 0;

  for (const row of rows) {
    if (row.status === "active") {
      kept++;
      continue;
    }
    if (activeCampaignSlugs.has(row.workflowSlug)) {
      kept++;
      continue;
    }
    if (!row.windmillFlowPath) {
      kept++;
      continue;
    }

    try {
      await windmillClient.deleteFlow(row.windmillFlowPath);
      deleted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404")) {
        // Flow already gone — count as kept (nothing to delete).
        kept++;
        continue;
      }
      failed++;
      console.warn(
        `[workflow-service] Cleanup: failed to delete "${row.windmillFlowPath}" for "${row.workflowSlug}":`,
        msg,
      );
    }
  }

  return { deleted, kept, failed };
}
