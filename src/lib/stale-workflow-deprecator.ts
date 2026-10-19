/**
 * Deprecates stale active workflows that have zero runs after 1 week of existence
 * and are not used by any active campaign.
 */

import { stopExecutable } from "./executable-until.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { workflows, workflowRuns } from "../db/schema.js";
import type { db as DbInstance } from "../db/index.js";
import { fetchActiveWorkflowSlugs } from "./campaign-client.js";
import { listLegAssignments, type LegAssignment } from "./catalogue-client.js";

type Database = typeof DbInstance;

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

interface DeprecationResult {
  deprecatedCount: number;
  keptByCampaign: number;
  skippedNoCampaignService: boolean;
  /** features-service's pipe assignments could not be read: nothing was deprecated (a pipe could lose its workflow). */
  skippedNoAssignments?: boolean;
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

  // 3. Find which active workflows have at least one run (all of them, not only the old ones: step 6 asks whether
  // ANY workflow on a candidate's pipe ever ran).
  const runRows = await database
    .select({ workflowId: workflowRuns.workflowId })
    .from(workflowRuns)
    .where(inArray(workflowRuns.workflowId, activeWorkflows.map((w) => w.id)));

  const hasRuns = new Set(runRows.map((r) => r.workflowId));

  // 4. Candidates = old enough + zero runs, on the version AND on every earlier version of its dynasty. A version
  // born by an upgrade starts at zero runs while its lineage carries thousands: judged alone it reads as stale, and
  // deprecating it leaves the dynasty with no runnable version and no successor (2026-10-06 16:26:48 UTC: 19
  // sales-cold-email-outreach heads upgraded on 09-29 went this way, Nobelium v5 and Ballad v6 among them, the
  // cheapest per positive reply). This sweep retires workflows NOBODY ever ran, never a lineage that ran.
  const unrun = oldEnough.filter((wf) => !hasRuns.has(wf.id));
  const ranLineages = new Set<string>();
  if (unrun.length > 0) {
    const rows = await database
      .select({ dynasty: workflows.workflowDynastySlug })
      .from(workflows)
      .where(
        and(
          inArray(workflows.workflowDynastySlug, [...new Set(unrun.map((wf) => wf.workflowDynastySlug))]),
          sql`EXISTS (SELECT 1 FROM workflow_runs r WHERE r.workflow_id = ${workflows.id})`,
        ),
      );
    for (const r of rows) ranLineages.add(r.dynasty);
  }
  for (const wf of unrun.filter((w) => ranLineages.has(w.workflowDynastySlug))) {
    console.log(`[workflow-service] Keeping stale workflow "${wf.workflowSlug}" — an earlier version of its dynasty ran`);
  }
  const candidates = unrun.filter((wf) => !ranLineages.has(wf.workflowDynastySlug));

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

  // 6. Which pipe each candidate serves (features-service owns the link). A channel runs several pipes, and a pipe
  // whose ONLY workflow is a candidate would be left with none ("every pipe in prod HAS a workflow", owner
  // 2026-10-11): a reactive pipe nobody has bought yet records no run, so "zero runs" says nothing there either.
  const assignmentsBySlug = new Map<string, LegAssignment[]>();
  try {
    for (const slug of new Set(candidates.map((wf) => wf.featureSlug))) {
      assignmentsBySlug.set(slug, await listLegAssignments(slug));
    }
  } catch (err) {
    console.warn(
      "[workflow-service] Cannot read pipe assignments — skipping stale workflow deprecation:",
      err instanceof Error ? err.message : err,
    );
    return { deprecatedCount: 0, keptByCampaign: 0, skippedNoCampaignService: false, skippedNoAssignments: true };
  }
  const liveDynasties = new Set(activeWorkflows.map((wf) => wf.workflowDynastySlug));
  /** A pipe this workflow serves that no OTHER live dynasty serves, or null. */
  const soleWorkflowOfPipe = (wf: (typeof candidates)[number]): string | null => {
    const rows = (assignmentsBySlug.get(wf.featureSlug) ?? []).filter((a) => a.state === "active");
    for (const leg of rows.filter((a) => a.workflowDynastySlug === wf.workflowDynastySlug)) {
      const others = rows.filter(
        (a) => a.legKey === leg.legKey && a.workflowDynastySlug !== wf.workflowDynastySlug && liveDynasties.has(a.workflowDynastySlug),
      );
      if (others.length === 0) return `${wf.featureSlug}|${leg.legKey}`;
    }
    return null;
  };
  // A pipe on which NO live workflow ever ran was bought by nobody yet: "zero runs" compares nothing there, so it is
  // no evidence this one is stale (LEAK-1012: the CRM contacts sourcing pipe carries the generic workflow and two
  // copies stating who they find, `reachableBy`; none runs until a funnel buys the pipe, and all must still be there).
  const ranDynasties = new Set(activeWorkflows.filter((wf) => hasRuns.has(wf.id)).map((wf) => wf.workflowDynastySlug));
  /** A pipe this workflow serves on which no live workflow ever ran, or null. */
  const pipeNobodyRan = (wf: (typeof candidates)[number]): string | null => {
    const rows = (assignmentsBySlug.get(wf.featureSlug) ?? []).filter((a) => a.state === "active");
    for (const leg of rows.filter((a) => a.workflowDynastySlug === wf.workflowDynastySlug)) {
      const onPipe = rows.filter((a) => a.legKey === leg.legKey && liveDynasties.has(a.workflowDynastySlug));
      if (!onPipe.some((a) => ranDynasties.has(a.workflowDynastySlug))) return `${wf.featureSlug}|${leg.legKey}`;
    }
    return null;
  };

  // 7. Deprecate candidates not used by an active campaign — but NEVER the last active workflow of a channel: a
  // channel with no active workflow can no longer be launched (campaign-service 409 `no_workflow`). A pipe that
  // runs inside another run (a sourcing pipe on the inline `lead_requested` trigger, src/lib/sourcing-dag.ts) never
  // records a run of its own, so "zero runs" says nothing about whether it is used.
  let deprecatedCount = 0;
  let keptByCampaign = 0;
  const remaining = new Map<string, number>();
  for (const wf of activeWorkflows) remaining.set(wf.featureSlug, (remaining.get(wf.featureSlug) ?? 0) + 1);
  const newestFirst = [...candidates].sort(
    (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
  );

  for (const wf of newestFirst.reverse()) {
    if (activeSlugs.has(wf.workflowSlug)) {
      keptByCampaign++;
      console.log(
        `[workflow-service] Keeping stale workflow "${wf.workflowSlug}" — active campaign exists`,
      );
      continue;
    }
    if ((remaining.get(wf.featureSlug) ?? 0) <= 1) {
      console.log(
        `[workflow-service] Keeping stale workflow "${wf.workflowSlug}" — the last active workflow of channel ${wf.featureSlug}`,
      );
      continue;
    }
    const pipe = soleWorkflowOfPipe(wf);
    if (pipe) {
      console.log(`[workflow-service] Keeping stale workflow "${wf.workflowSlug}" — the last active workflow of pipe ${pipe}`);
      continue;
    }
    const unbought = pipeNobodyRan(wf);
    if (unbought) {
      console.log(`[workflow-service] Keeping stale workflow "${wf.workflowSlug}" — no workflow ever ran on pipe ${unbought}`);
      continue;
    }
    remaining.set(wf.featureSlug, (remaining.get(wf.featureSlug) ?? 0) - 1);
    if (!activeWorkflows.some((o) => o.id !== wf.id && o.workflowDynastySlug === wf.workflowDynastySlug && o.status === "active")) {
      liveDynasties.delete(wf.workflowDynastySlug);
    }

    await database
      .update(workflows)
      .set({ status: "deprecated", ...stopExecutable(), updatedAt: new Date() })
      .where(eq(workflows.id, wf.id));
    wf.status = "deprecated";

    deprecatedCount++;
    console.log(
      `[workflow-service] Deprecated stale workflow "${wf.workflowSlug}" (feature: ${wf.featureSlug}) — >1 week old, zero runs, no active campaign`,
    );
  }

  return { deprecatedCount, keptByCampaign, skippedNoCampaignService: false };
}
