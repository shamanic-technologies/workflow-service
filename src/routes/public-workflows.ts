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
  formatPublicScoreItem,
  aggregateSectionStats,
  handleExternalServiceError,
  type WorkflowScore,
} from "../lib/workflow-scoring.js";

const router = Router();

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
    const deprecatedWorkflows = allMatchingWorkflows.filter((w) => w.status === "deprecated");

    if (activeWorkflows.length === 0) {
      res.json({ results: [] });
      return;
    }

    const { scores, runBrandMap, workflowRunIds } = await computeWorkflowScores(activeWorkflows, deprecatedWorkflows, objective, { kind: "public" as const, brandId, orgId });

    if (groupBy === "feature") {
      const featureMap = new Map<string, WorkflowScore[]>();
      for (const score of scores) {
        const key = score.workflow.featureSlug;
        const arr = featureMap.get(key) ?? [];
        arr.push(score);
        featureMap.set(key, arr);
      }

      const features = [...featureMap.entries()].map(([featureSlug, featureScores]) => {
        const ranked = rankScores(featureScores).slice(0, limit);
        return {
          featureSlug,
          stats: aggregateSectionStats(featureScores),
          workflows: ranked.map(formatPublicScoreItem),
        };
      });

      res.json({ features });
    } else if (groupBy === "brand") {
      // Group by brandId from runs
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
          workflows: rankScores(brandScores).slice(0, limit).map(formatPublicScoreItem),
        };
      });

      res.json({ brands });
    } else {
      // If brandId filter is set, only include workflows that have runs for that brand
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
      const ranked = rankScores(filteredScores).slice(0, limit);
      res.json({ results: ranked.map(formatPublicScoreItem) });
    }
  } catch (err: unknown) {
    if (!handleExternalServiceError(err, res, "public/ranked")) {
      console.error("[workflow-service] GET public/ranked error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// GET /public/workflows/best — Public hero records (no auth, no DAG)
router.get("/public/workflows/best", async (req, res) => {
  try {
    const query = BestWorkflowQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Validation error", details: query.error });
      return;
    }
    const { orgId, brandId, by } = query.data;

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgId) conditions.push(eq(workflows.orgId, orgId));

    const allMatchingWorkflows = conditions.length > 0
      ? await db.select().from(workflows).where(and(...conditions))
      : await db.select().from(workflows);

    const activeWorkflows = allMatchingWorkflows.filter((w) => w.status === "active");
    const deprecatedWorkflows = allMatchingWorkflows.filter((w) => w.status === "deprecated");

    if (activeWorkflows.length === 0) {
      res.json({ bestCostPerOpen: null, bestCostPerReply: null });
      return;
    }

    const { scores, runBrandMap, workflowRunIds } = await computeWorkflowScores(activeWorkflows, deprecatedWorkflows, "replies", { kind: "public" as const, brandId, orgId });

    if (by === "brand") {
      // Aggregate by brandId from runs
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

      let bestCostPerOpen: { brandId: string; workflowCount: number; value: number } | null = null;
      let bestCostPerReply: { brandId: string; workflowCount: number; value: number } | null = null;

      for (const [bId, brandScores] of brandEntries) {
        const totalCost = brandScores.reduce((s, e) => s + e.totalCost, 0);
        const hasRuns = brandScores.some((s) => s.completedRuns > 0);
        if (!hasRuns) continue;

        const totalOpened = brandScores.reduce(
          (s, e) => s + e.emailStats.transactional.opened + e.emailStats.broadcast.opened,
          0,
        );
        if (totalOpened > 0) {
          const costPerOpen = totalCost / totalOpened;
          if (!bestCostPerOpen || costPerOpen < bestCostPerOpen.value) {
            bestCostPerOpen = { brandId: bId, workflowCount: brandScores.length, value: Math.round(costPerOpen * 100) / 100 };
          }
        }

        const totalReplied = brandScores.reduce(
          (s, e) => s + e.emailStats.transactional.replied + e.emailStats.broadcast.replied,
          0,
        );
        if (totalReplied > 0) {
          const costPerReply = totalCost / totalReplied;
          if (!bestCostPerReply || costPerReply < bestCostPerReply.value) {
            bestCostPerReply = { brandId: bId, workflowCount: brandScores.length, value: Math.round(costPerReply * 100) / 100 };
          }
        }
      }

      res.json({ bestCostPerOpen, bestCostPerReply });
    } else {
      // by=workflow (default)
      let bestCostPerOpen: { score: WorkflowScore; value: number } | null = null;
      let bestCostPerReply: { score: WorkflowScore; value: number } | null = null;

      for (const s of scores) {
        if (s.completedRuns === 0) continue;

        const totalOpened = s.emailStats.transactional.opened + s.emailStats.broadcast.opened;
        if (totalOpened > 0) {
          const costPerOpen = s.totalCost / totalOpened;
          if (!bestCostPerOpen || costPerOpen < bestCostPerOpen.value) {
            bestCostPerOpen = { score: s, value: costPerOpen };
          }
        }

        const totalReplied = s.emailStats.transactional.replied + s.emailStats.broadcast.replied;
        if (totalReplied > 0) {
          const costPerReply = s.totalCost / totalReplied;
          if (!bestCostPerReply || costPerReply < bestCostPerReply.value) {
            bestCostPerReply = { score: s, value: costPerReply };
          }
        }
      }

      function formatRecord(entry: { score: WorkflowScore; value: number } | null) {
        if (!entry) return null;
        return {
          workflowId: entry.score.workflow.id,
          workflowSlug: entry.score.workflow.slug,
          workflowName: entry.score.workflow.name,
          createdForBrandId: entry.score.workflow.createdForBrandId,
          value: Math.round(entry.value * 100) / 100,
        };
      }

      res.json({
        bestCostPerOpen: formatRecord(bestCostPerOpen),
        bestCostPerReply: formatRecord(bestCostPerReply),
      });
    }
  } catch (err: unknown) {
    if (!handleExternalServiceError(err, res, "public/best")) {
      console.error("[workflow-service] GET public/best error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

export default router;
