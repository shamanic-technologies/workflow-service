/**
 * Deprecates stale active workflows that have zero runs after 1 week of existence
 * and are not used by any active campaign.
 */

import { eq, inArray } from "drizzle-orm";
import { workflows, workflowRuns } from "../db/schema.js";
import type { db as DbInstance } from "../db/index.js";
import { fetchActiveWorkflowSlugs } from "./campaign-client.js";

type Database = typeof DbInstance;

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

interface DeprecationResult {
  deprecatedCount: number;
  keptByCampaign: number;
  skippedNoCampaignService: boolean;
}

/**
 * Deprecate workflows that are older than 1 week and have never been run.
 * Workflows used by an active campaign are always kept.
 *
 * Safe to call at startup and periodically — only deprecates, never deletes.
 */
export async function deprecateStaleWorkflows(
  database: Database,
): Promise<DeprecationResult> {
  const now = Date.now();

  // 1. Fetch all active workflows
  const activeWorkflows = await database
    .select()
    .from(workflows)
    .where(eq(workflows.status, "active"));

  if (activeWorkflows.length === 0) {
    return { deprecatedCount: 0, keptByCampaign: 0, skippedNoCampaignService: false };
  }

  // 2. Filter to workflows older than 1 week
  const oldEnough = activeWorkflows.filter((wf) => {
    const createdAt = wf.createdAt ? new Date(wf.createdAt).getTime() : now;
    return now - createdAt >= GRACE_PERIOD_MS;
  });

  if (oldEnough.length === 0) {
    return { deprecatedCount: 0, keptByCampaign: 0, skippedNoCampaignService: false };
  }

  // 3. Find which of these have at least one run
  const runRows = await database
    .select({ workflowId: workflowRuns.workflowId })
    .from(workflowRuns)
    .where(inArray(workflowRuns.workflowId, oldEnough.map((w) => w.id)));

  const hasRuns = new Set(runRows.map((r) => r.workflowId));

  // 4. Candidates = old enough + zero runs
  const candidates = oldEnough.filter((wf) => !hasRuns.has(wf.id));

  if (candidates.length === 0) {
    return { deprecatedCount: 0, keptByCampaign: 0, skippedNoCampaignService: false };
  }

  // 5. Check campaign-service for active campaigns
  let activeSlugs: Set<string>;
  try {
    activeSlugs = await fetchActiveWorkflowSlugs();
  } catch (err) {
    console.warn(
      "[workflow-service] Cannot check active campaigns — skipping stale workflow deprecation:",
      err instanceof Error ? err.message : err,
    );
    return {
      deprecatedCount: 0,
      keptByCampaign: 0,
      skippedNoCampaignService: true,
    };
  }

  // 6. Deprecate candidates not used by an active campaign
  let deprecatedCount = 0;
  let keptByCampaign = 0;

  for (const wf of candidates) {
    if (activeSlugs.has(wf.slug)) {
      keptByCampaign++;
      console.log(
        `[workflow-service] Keeping stale workflow "${wf.slug}" — active campaign exists`,
      );
      continue;
    }

    await database
      .update(workflows)
      .set({ status: "deprecated", updatedAt: new Date() })
      .where(eq(workflows.id, wf.id));

    deprecatedCount++;
    console.log(
      `[workflow-service] Deprecated stale workflow "${wf.slug}" (feature: ${wf.featureSlug}) — >1 week old, zero runs, no active campaign`,
    );
  }

  return { deprecatedCount, keptByCampaign, skippedNoCampaignService: false };
}
