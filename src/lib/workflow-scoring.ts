import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows, workflowRuns } from "../db/schema.js";
import { fetchRunCosts, fetchEmailStats } from "./stats-client.js";
import type { IdentityHeaders } from "./key-service-client.js";

export const EMPTY_EMAIL_STATS = {
  sent: 0, delivered: 0, opened: 0, clicked: 0,
  replied: 0, bounced: 0, unsubscribed: 0, recipients: 0,
};

export interface WorkflowScore {
  workflow: typeof workflows.$inferSelect;
  totalCost: number;
  totalOutcomes: number;
  costPerOutcome: number | null;
  completedRuns: number;
  emailStats: { transactional: typeof EMPTY_EMAIL_STATS; broadcast: typeof EMPTY_EMAIL_STATS };
}

export function getUpgradeChainIds(
  activeWorkflowId: string,
  deprecatedWorkflows: { id: string; upgradedTo: string | null }[],
): string[] {
  const predecessorMap = new Map<string, string[]>();
  for (const d of deprecatedWorkflows) {
    if (!d.upgradedTo) continue;
    const existing = predecessorMap.get(d.upgradedTo) ?? [];
    existing.push(d.id);
    predecessorMap.set(d.upgradedTo, existing);
  }

  const chainIds: string[] = [activeWorkflowId];
  const queue = [activeWorkflowId];
  const visited = new Set<string>([activeWorkflowId]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const preds = predecessorMap.get(current) ?? [];
    for (const predId of preds) {
      if (!visited.has(predId)) {
        visited.add(predId);
        chainIds.push(predId);
        queue.push(predId);
      }
    }
  }

  return chainIds;
}

export async function computeWorkflowScores(
  activeWorkflows: (typeof workflows.$inferSelect)[],
  deprecatedWorkflows: { id: string; upgradedTo: string | null }[],
  objective: "replies" | "clicks",
  identity: IdentityHeaders,
): Promise<WorkflowScore[]> {
  // 1. For each active workflow, get completed runs across entire upgrade chain
  const workflowRunsByWfId: Record<string, string[]> = {};
  const allRunIds: string[] = [];

  for (const wf of activeWorkflows) {
    const chainIds = getUpgradeChainIds(wf.id, deprecatedWorkflows);

    const runs = chainIds.length === 1
      ? await db
          .select()
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.workflowId, chainIds[0]),
              eq(workflowRuns.status, "completed"),
            )
          )
      : await db
          .select()
          .from(workflowRuns)
          .where(
            and(
              inArray(workflowRuns.workflowId, chainIds),
              eq(workflowRuns.status, "completed"),
            )
          );

    const runIds = runs
      .map((r) => r.runId)
      .filter((id): id is string => id !== null);

    workflowRunsByWfId[wf.id] = runIds;
    allRunIds.push(...runIds);
  }

  // 2. Batch fetch costs from runs-service (only if there are runs)
  const costByRunId = new Map<string, number>();
  if (allRunIds.length > 0) {
    const runCosts = await fetchRunCosts(allRunIds, identity);
    for (const c of runCosts) {
      costByRunId.set(c.runId, c.totalCostInUsdCents);
    }
  }

  // 3. Per-workflow: compute cost + fetch email stats
  const scores: WorkflowScore[] = [];

  for (const wf of activeWorkflows) {
    const runIds = workflowRunsByWfId[wf.id] ?? [];

    if (runIds.length === 0) {
      scores.push({
        workflow: wf,
        totalCost: 0,
        totalOutcomes: 0,
        costPerOutcome: null,
        completedRuns: 0,
        emailStats: { transactional: { ...EMPTY_EMAIL_STATS }, broadcast: { ...EMPTY_EMAIL_STATS } },
      });
      continue;
    }

    const totalCost = runIds.reduce(
      (sum, id) => sum + (costByRunId.get(id) ?? 0),
      0
    );

    const stats = await fetchEmailStats(runIds, identity);
    const outcomes =
      objective === "replies"
        ? (stats.transactional?.replied ?? 0) + (stats.broadcast?.replied ?? 0)
        : (stats.transactional?.clicked ?? 0) + (stats.broadcast?.clicked ?? 0);

    const costPerOutcome = outcomes > 0 ? totalCost / outcomes : null;

    scores.push({
      workflow: wf,
      totalCost,
      totalOutcomes: outcomes,
      costPerOutcome,
      completedRuns: runIds.length,
      emailStats: {
        transactional: stats.transactional ?? { ...EMPTY_EMAIL_STATS },
        broadcast: stats.broadcast ?? { ...EMPTY_EMAIL_STATS },
      },
    });
  }

  return scores;
}

export function rankScores(scores: WorkflowScore[]): WorkflowScore[] {
  return [...scores].sort((a, b) => {
    if (a.costPerOutcome !== null && b.costPerOutcome !== null) {
      return a.costPerOutcome - b.costPerOutcome;
    }
    if (a.costPerOutcome !== null) return -1;
    if (b.costPerOutcome !== null) return 1;
    return b.completedRuns - a.completedRuns;
  });
}

export function formatScoreItem(entry: WorkflowScore) {
  return {
    workflow: {
      id: entry.workflow.id,
      name: entry.workflow.name,
      displayName: entry.workflow.displayName,
      brandId: entry.workflow.brandId,
      category: entry.workflow.category,
      channel: entry.workflow.channel,
      audienceType: entry.workflow.audienceType,
      signature: entry.workflow.signature,
      signatureName: entry.workflow.signatureName,
    },
    dag: entry.workflow.dag,
    stats: formatStats(entry),
  };
}

export function formatPublicScoreItem(entry: WorkflowScore) {
  return {
    workflow: {
      id: entry.workflow.id,
      name: entry.workflow.name,
      displayName: entry.workflow.displayName,
      brandId: entry.workflow.brandId,
      category: entry.workflow.category,
      channel: entry.workflow.channel,
      audienceType: entry.workflow.audienceType,
      signature: entry.workflow.signature,
      signatureName: entry.workflow.signatureName,
    },
    stats: formatStats(entry),
  };
}

function formatStats(entry: WorkflowScore) {
  return {
    totalCostInUsdCents: entry.totalCost,
    totalOutcomes: entry.totalOutcomes,
    costPerOutcome: entry.costPerOutcome,
    completedRuns: entry.completedRuns,
    email: entry.emailStats,
  };
}

export function aggregateSectionStats(scores: WorkflowScore[]) {
  const totalCost = scores.reduce((s, e) => s + e.totalCost, 0);
  const totalOutcomes = scores.reduce((s, e) => s + e.totalOutcomes, 0);
  const completedRuns = scores.reduce((s, e) => s + e.completedRuns, 0);
  const costPerOutcome = totalOutcomes > 0 ? totalCost / totalOutcomes : null;
  const transactional = { ...EMPTY_EMAIL_STATS };
  const broadcast = { ...EMPTY_EMAIL_STATS };
  for (const e of scores) {
    for (const key of Object.keys(EMPTY_EMAIL_STATS) as (keyof typeof EMPTY_EMAIL_STATS)[]) {
      transactional[key] += e.emailStats.transactional[key];
      broadcast[key] += e.emailStats.broadcast[key];
    }
  }
  return { totalCostInUsdCents: totalCost, totalOutcomes, costPerOutcome, completedRuns, email: { transactional, broadcast } };
}

export function handleExternalServiceError(err: unknown, res: import("express").Response, label: string) {
  if (err instanceof Error && err.name === "ZodError") {
    res.status(400).json({ error: "Validation error", details: err });
    return true;
  }
  if (
    err instanceof Error &&
    (err.message.includes("RUNS_SERVICE_URL") ||
      err.message.includes("EMAIL_GATEWAY_SERVICE_URL") ||
      err.message.startsWith("email-gateway-service error:"))
  ) {
    console.error(`[workflow-service] ${label}: external service error:`, err.message);
    res.status(502).json({ error: err.message });
    return true;
  }
  return false;
}

/** System identity for public endpoints — used only for logging by downstream services */
export const SYSTEM_IDENTITY = {
  orgId: "system",
  userId: "system",
  runId: "system-public",
};
