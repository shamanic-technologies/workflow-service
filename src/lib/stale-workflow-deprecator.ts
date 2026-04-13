/**
 * Deprecates stale active workflows to reduce LLM upgrade costs.
 *
 * For each feature_slug, keeps only the 3 most recently used workflows.
 * Workflows outside the top 3 are deprecated UNLESS they are currently
 * used by an active campaign in campaign-service.
 */

import { eq, sql, inArray } from "drizzle-orm";
import { workflows, workflowRuns } from "../db/schema.js";
import type { db as DbInstance } from "../db/index.js";
import { fetchActiveWorkflowSlugs } from "./campaign-client.js";

type Database = typeof DbInstance;

const KEEP_TOP_N = 3;
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

interface DeprecationResult {
  deprecatedCount: number;
  keptByRecency: number;
  keptByCampaign: number;
  skippedNoCampaignService: boolean;
}

/**
 * Deprecate stale workflows that are not in the top N most recently used
 * per feature_slug and are not used by any active campaign.
 *
 * Safe to call at startup and periodically — only deprecates, never deletes.
 */
export async function deprecateStaleWorkflows(
  database: Database,
): Promise<DeprecationResult> {
  const now = Date.now();

  // 1. Fetch all active workflows
  const allActiveWorkflows = await database
    .select()
    .from(workflows)
    .where(eq(workflows.status, "active"));

  if (allActiveWorkflows.length === 0) {
    return { deprecatedCount: 0, keptByRecency: 0, keptByCampaign: 0, skippedNoCampaignService: false };
  }

  // 1b. Exclude workflows created less than 1 week ago — they haven't had a chance to run yet
  const activeWorkflows = allActiveWorkflows.filter((wf) => {
    const createdAt = wf.createdAt ? new Date(wf.createdAt).getTime() : now;
    return now - createdAt >= GRACE_PERIOD_MS;
  });

  // 2. Get last run date for each active workflow
  const lastRunRows = await database
    .select({
      workflowId: workflowRuns.workflowId,
      lastRun: sql<string>`max(${workflowRuns.createdAt})`.as("last_run"),
    })
    .from(workflowRuns)
    .where(inArray(workflowRuns.workflowId, activeWorkflows.map((w) => w.id)))
    .groupBy(workflowRuns.workflowId);

  const lastRunByWorkflowId = new Map(
    lastRunRows.map((r) => [r.workflowId, new Date(r.lastRun).getTime()]),
  );

  // 3. Group by featureSlug
  const byFeature = new Map<string, typeof activeWorkflows>();
  for (const wf of activeWorkflows) {
    const arr = byFeature.get(wf.featureSlug) ?? [];
    arr.push(wf);
    byFeature.set(wf.featureSlug, arr);
  }

  // 4. For each feature, identify workflows outside the top N
  const candidatesForDeprecation: typeof activeWorkflows = [];
  let keptByRecency = 0;

  for (const [, featureWorkflows] of byFeature) {
    if (featureWorkflows.length <= KEEP_TOP_N) {
      keptByRecency += featureWorkflows.length;
      continue;
    }

    // Sort by most recent run (descending). Workflows with no runs go last.
    featureWorkflows.sort((a, b) => {
      const aTime = lastRunByWorkflowId.get(a.id) ?? 0;
      const bTime = lastRunByWorkflowId.get(b.id) ?? 0;
      return bTime - aTime;
    });

    const kept = featureWorkflows.slice(0, KEEP_TOP_N);
    const stale = featureWorkflows.slice(KEEP_TOP_N);

    keptByRecency += kept.length;
    candidatesForDeprecation.push(...stale);
  }

  if (candidatesForDeprecation.length === 0) {
    return { deprecatedCount: 0, keptByRecency, keptByCampaign: 0, skippedNoCampaignService: false };
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
      keptByRecency,
      keptByCampaign: 0,
      skippedNoCampaignService: true,
    };
  }

  // 6. Deprecate candidates that are NOT used by an active campaign
  let deprecatedCount = 0;
  let keptByCampaign = 0;

  for (const wf of candidatesForDeprecation) {
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
      `[workflow-service] Deprecated stale workflow "${wf.slug}" (feature: ${wf.featureSlug}) — not in top ${KEEP_TOP_N} and no active campaign`,
    );
  }

  return { deprecatedCount, keptByRecency, keptByCampaign, skippedNoCampaignService: false };
}
