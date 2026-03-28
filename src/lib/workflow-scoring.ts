import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows, workflowRuns } from "../db/schema.js";
import { fetchRunCostsAuth, fetchRunCostsPublic, fetchEmailStatsAuth, fetchEmailStatsPublic } from "./stats-client.js";
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

type ScoreMode =
  | { kind: "auth"; identity: IdentityHeaders }
  | { kind: "public"; brandId?: string; orgId?: string };

export interface ScoreResult {
  scores: WorkflowScore[];
  /** Maps runId → brandId (from workflow_runs table) for brand-level aggregation */
  runBrandMap: Map<string, string>;
  /** Maps workflowId → runIds for cross-referencing */
  workflowRunIds: Record<string, string[]>;
}

export async function computeWorkflowScores(
  activeWorkflows: (typeof workflows.$inferSelect)[],
  deprecatedWorkflows: (typeof workflows.$inferSelect)[],
  objective: "replies" | "clicks",
  mode: ScoreMode,
): Promise<ScoreResult> {
  // 1. Build dynasty chains: for each active workflow, collect all workflow names in its upgrade chain
  const chainWorkflowsById: Record<string, (typeof workflows.$inferSelect)[]> = {};

  for (const wf of activeWorkflows) {
    const chainIds = getUpgradeChainIds(wf.id, deprecatedWorkflows);
    chainWorkflowsById[wf.id] = [
      wf,
      ...deprecatedWorkflows.filter((d) => chainIds.includes(d.id) && d.id !== wf.id),
    ];
  }

  // 2. Collect all unique workflow slugs across all dynasty chains
  const allChainNames = [
    ...new Set(
      Object.values(chainWorkflowsById).flatMap((wfs) => wfs.map((w) => w.slug))
    ),
  ];

  // 3. Fetch costs aggregated by workflowSlug, filtered to dynasty slugs only
  const costGroups =
    mode.kind === "auth"
      ? await fetchRunCostsAuth(mode.identity, allChainNames)
      : await fetchRunCostsPublic({ brandId: mode.brandId, orgId: mode.orgId, workflowSlugs: allChainNames });

  const costBySlug = new Map(costGroups.map((g) => [g.workflowSlug, g.totalCostInUsdCents]));

  // 4. Fetch email stats grouped by workflowSlug (1 call for all dynasty slugs)
  const emailGroups =
    mode.kind === "auth"
      ? await fetchEmailStatsAuth(allChainNames, mode.identity)
      : await fetchEmailStatsPublic(allChainNames);

  const emailBySlug = new Map(emailGroups.map((g) => [g.workflowSlug, g]));

  // 5. For each active workflow, aggregate costs + email stats across dynasty chain + build brand map
  const workflowRunsByWfId: Record<string, string[]> = {};
  const runBrandMap = new Map<string, string>();
  const scores: WorkflowScore[] = [];

  for (const wf of activeWorkflows) {
    const chainWfs = chainWorkflowsById[wf.id] ?? [];
    const chainIds = chainWfs.map((w) => w.id);
    const chainNames = new Set(chainWfs.map((w) => w.slug));

    // Costs: aggregate across all dynasty workflow slugs
    let totalCost = 0;
    for (const name of chainNames) {
      totalCost += costBySlug.get(name) ?? 0;
    }

    // Email stats: aggregate across all dynasty workflow slugs
    const transactional = { ...EMPTY_EMAIL_STATS };
    const broadcast = { ...EMPTY_EMAIL_STATS };
    for (const name of chainNames) {
      const eg = emailBySlug.get(name);
      if (!eg) continue;
      for (const key of Object.keys(EMPTY_EMAIL_STATS) as (keyof typeof EMPTY_EMAIL_STATS)[]) {
        transactional[key] += eg.transactional[key];
        broadcast[key] += eg.broadcast[key];
      }
    }

    // Run IDs + brand map: still from local workflow_runs table (needed for brand grouping)
    const runs = chainIds.length === 1
      ? await db.select().from(workflowRuns).where(
          and(eq(workflowRuns.workflowId, chainIds[0]), eq(workflowRuns.status, "completed")))
      : await db.select().from(workflowRuns).where(
          and(inArray(workflowRuns.workflowId, chainIds), eq(workflowRuns.status, "completed")));
    const runIds = runs.filter((r) => r.runId).map((r) => r.runId!);
    for (const r of runs) {
      if (r.runId && r.brandId) runBrandMap.set(r.runId, r.brandId);
    }
    workflowRunsByWfId[wf.id] = runIds;

    const outcomes =
      objective === "replies"
        ? transactional.replied + broadcast.replied
        : transactional.clicked + broadcast.clicked;

    const costPerOutcome = outcomes > 0 ? totalCost / outcomes : null;

    scores.push({
      workflow: wf,
      totalCost,
      totalOutcomes: outcomes,
      costPerOutcome,
      completedRuns: runIds.length,
      emailStats: { transactional, broadcast },
    });
  }

  return { scores, runBrandMap, workflowRunIds: workflowRunsByWfId };
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
      slug: entry.workflow.slug,
      name: entry.workflow.name,
      dynastyName: entry.workflow.dynastyName,
      version: entry.workflow.version,
      createdForBrandId: entry.workflow.createdForBrandId,
      featureSlug: entry.workflow.featureSlug,
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
      slug: entry.workflow.slug,
      name: entry.workflow.name,
      dynastyName: entry.workflow.dynastyName,
      version: entry.workflow.version,
      createdForBrandId: entry.workflow.createdForBrandId,
      featureSlug: entry.workflow.featureSlug,
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

