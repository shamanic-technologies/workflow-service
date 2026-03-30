import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows } from "../db/schema.js";
import {
  RankedWorkflowQuerySchema,
  BestWorkflowQuerySchema,
} from "../schemas.js";
import {
  computeWorkflowScores,
  rankScores,
  rescoreForObjective,
  formatPublicScoreItem,
  aggregateSectionStats,
  handleExternalServiceError,
  type WorkflowScore,
} from "../lib/workflow-scoring.js";
import { fetchFeatureOutputs, fetchStatsRegistry } from "../lib/features-client.js";

const router = Router();

const DEFAULT_OBJECTIVES = ["emailsReplied"];

async function resolveObjectives(
  objective: string | undefined,
  featureSlug: string | undefined,
): Promise<string[]> {
  if (objective) return [objective];
  if (featureSlug) {
    const [outputs, registry] = await Promise.all([
      fetchFeatureOutputs(featureSlug),
      fetchStatsRegistry(),
    ]);
    const countMetrics = outputs
      .map((o) => o.key)
      .filter((key) => {
        const entry = registry[key];
        return entry && entry.type === "count";
      });
    if (countMetrics.length > 0) return countMetrics;
  }
  return DEFAULT_OBJECTIVES;
}

// GET /public/workflows/ranked — Public ranked workflows (no auth, no DAG)
router.get("/public/workflows/ranked", async (req, res) => {
  try {
    const query = RankedWorkflowQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Validation error", details: query.error });
      return;
    }
    const { orgId, brandId, featureSlug, objective, limit, groupBy } = query.data;

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgId) conditions.push(eq(workflows.orgId, orgId));
    if (featureSlug) conditions.push(eq(workflows.featureSlug, featureSlug));

    const allMatchingWorkflows = conditions.length > 0
      ? await db.select().from(workflows).where(and(...conditions))
      : await db.select().from(workflows);

    const activeWorkflows = allMatchingWorkflows.filter((w) => w.status === "active");

    if (activeWorkflows.length === 0) {
      res.json({ results: [] });
      return;
    }

    const objectives = await resolveObjectives(objective, featureSlug);
    const { scores, runBrandMap, workflowRunIds } = await computeWorkflowScores(activeWorkflows, [], objectives[0], { kind: "public" as const, brandId, orgId });

    function rankForObjectives(inputScores: WorkflowScore[]) {
      if (objectives.length === 1) {
        const rescored = rescoreForObjective(inputScores, objectives[0]);
        return rankScores(rescored).slice(0, limit).map(formatPublicScoreItem);
      }
      const rankings: Record<string, ReturnType<typeof formatPublicScoreItem>[]> = {};
      for (const obj of objectives) {
        const rescored = rescoreForObjective(inputScores, obj);
        rankings[obj] = rankScores(rescored).slice(0, limit).map(formatPublicScoreItem);
      }
      return rankings;
    }

    if (groupBy === "feature") {
      const featureMap = new Map<string, WorkflowScore[]>();
      for (const score of scores) {
        const key = score.workflow.featureSlug;
        const arr = featureMap.get(key) ?? [];
        arr.push(score);
        featureMap.set(key, arr);
      }

      const features = [...featureMap.entries()].map(([featureSlug, featureScores]) => ({
        featureSlug,
        stats: aggregateSectionStats(featureScores),
        workflows: rankForObjectives(featureScores),
      }));

      res.json({ features });
    } else if (groupBy === "brand") {
      const brandRunIds = new Map<string, Set<string>>();
      const brandWorkflowIds = new Map<string, Set<string>>();

      for (const score of scores) {
        const runIds = workflowRunIds[score.workflow.id] ?? [];
        for (const runId of runIds) {
          const bId = runBrandMap.get(runId);
          if (!bId) continue;
          if (!brandRunIds.has(bId)) brandRunIds.set(bId, new Set());
          if (!brandWorkflowIds.has(bId)) brandWorkflowIds.set(bId, new Set());
          brandRunIds.get(bId)!.add(runId);
          brandWorkflowIds.get(bId)!.add(score.workflow.id);
        }
      }

      const brandEntries = brandId
        ? [...brandRunIds.entries()].filter(([bId]) => bId === brandId)
        : [...brandRunIds.entries()];

      const brands = brandEntries.map(([bId]) => {
        const wfIds = brandWorkflowIds.get(bId)!;
        const brandScores = scores.filter((s) => wfIds.has(s.workflow.id));
        return {
          brandId: bId,
          stats: aggregateSectionStats(brandScores),
          workflows: rankForObjectives(brandScores),
        };
      });

      res.json({ brands });
    } else {
      let filteredScores = scores;
      if (brandId) {
        const wfIdsForBrand = new Set<string>();
        for (const score of scores) {
          const runIds = workflowRunIds[score.workflow.id] ?? [];
          for (const runId of runIds) {
            if (runBrandMap.get(runId) === brandId) {
              wfIdsForBrand.add(score.workflow.id);
              break;
            }
          }
        }
        filteredScores = scores.filter((s) => wfIdsForBrand.has(s.workflow.id));
      }

      if (objectives.length === 1) {
        const rescored = rescoreForObjective(filteredScores, objectives[0]);
        const ranked = rankScores(rescored).slice(0, limit);
        res.json({ results: ranked.map(formatPublicScoreItem) });
      } else {
        const rankings: Record<string, ReturnType<typeof formatPublicScoreItem>[]> = {};
        for (const obj of objectives) {
          const rescored = rescoreForObjective(filteredScores, obj);
          rankings[obj] = rankScores(rescored).slice(0, limit).map(formatPublicScoreItem);
        }
        res.json({ rankings });
      }
    }
  } catch (err: unknown) {
    if (!handleExternalServiceError(err, res, "public/ranked")) {
      console.error("[workflow-service] GET public/ranked error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// GET /public/workflows/best — Public hero records: best cost-per-metric
router.get("/public/workflows/best", async (req, res) => {
  try {
    const query = BestWorkflowQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Validation error", details: query.error });
      return;
    }
    const { orgId, brandId, featureSlug, by } = query.data;

    const objectives = await resolveObjectives(undefined, featureSlug);

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgId) conditions.push(eq(workflows.orgId, orgId));
    if (featureSlug) conditions.push(eq(workflows.featureSlug, featureSlug));

    const allMatchingWorkflows = conditions.length > 0
      ? await db.select().from(workflows).where(and(...conditions))
      : await db.select().from(workflows);

    const activeWorkflows = allMatchingWorkflows.filter((w) => w.status === "active");

    if (activeWorkflows.length === 0) {
      const best: Record<string, null> = {};
      for (const obj of objectives) best[obj] = null;
      res.json({ best });
      return;
    }

    const { scores, runBrandMap, workflowRunIds } = await computeWorkflowScores(activeWorkflows, [], objectives[0], { kind: "public" as const, brandId, orgId });

    if (by === "brand") {
      const brandScoresMap = new Map<string, WorkflowScore[]>();
      for (const s of scores) {
        const runIds = workflowRunIds[s.workflow.id] ?? [];
        for (const runId of runIds) {
          const bId = runBrandMap.get(runId);
          if (!bId) continue;
          if (!brandScoresMap.has(bId)) brandScoresMap.set(bId, []);
          const arr = brandScoresMap.get(bId)!;
          if (!arr.some((existing) => existing.workflow.id === s.workflow.id)) {
            arr.push(s);
          }
        }
      }

      const brandEntries = brandId
        ? [...brandScoresMap.entries()].filter(([bId]) => bId === brandId)
        : [...brandScoresMap.entries()];

      const best: Record<string, { brandId: string; workflowCount: number; value: number } | null> = {};
      for (const obj of objectives) {
        let bestForMetric: { brandId: string; workflowCount: number; value: number } | null = null;
        for (const [bId, brandScores] of brandEntries) {
          const totalCost = brandScores.reduce((s, e) => s + e.totalCost, 0);
          const hasRuns = brandScores.some((s) => s.completedRuns > 0);
          if (!hasRuns) continue;
          const rescored = rescoreForObjective(brandScores, obj);
          const totalOutcomes = rescored.reduce((s, e) => s + e.totalOutcomes, 0);
          if (totalOutcomes > 0) {
            const costPer = totalCost / totalOutcomes;
            if (!bestForMetric || costPer < bestForMetric.value) {
              bestForMetric = { brandId: bId, workflowCount: brandScores.length, value: Math.round(costPer * 100) / 100 };
            }
          }
        }
        best[obj] = bestForMetric;
      }

      res.json({ best });
    } else {
      const best: Record<string, { workflowId: string; workflowSlug: string; workflowName: string; createdForBrandId: string | null; value: number } | null> = {};

      for (const obj of objectives) {
        let bestForMetric: { score: WorkflowScore; value: number } | null = null;
        const rescored = rescoreForObjective(scores, obj);
        for (const s of rescored) {
          if (s.completedRuns === 0) continue;
          if (s.totalOutcomes > 0) {
            const costPer = s.totalCost / s.totalOutcomes;
            if (!bestForMetric || costPer < bestForMetric.value) {
              bestForMetric = { score: s, value: costPer };
            }
          }
        }
        best[obj] = bestForMetric
          ? {
              workflowId: bestForMetric.score.workflow.id,
              workflowSlug: bestForMetric.score.workflow.slug,
              workflowName: bestForMetric.score.workflow.name,
              createdForBrandId: bestForMetric.score.workflow.createdForBrandId,
              value: Math.round(bestForMetric.value * 100) / 100,
            }
          : null;
      }

      res.json({ best });
    }
  } catch (err: unknown) {
    if (!handleExternalServiceError(err, res, "public/best")) {
      console.error("[workflow-service] GET public/best error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

export default router;
