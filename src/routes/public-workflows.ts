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
  SYSTEM_IDENTITY,
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
    const { orgId, category, channel, audienceType, objective, limit, groupBy } = query.data;

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgId) conditions.push(eq(workflows.orgId, orgId));
    if (category) conditions.push(eq(workflows.category, category));
    if (channel) conditions.push(eq(workflows.channel, channel));
    if (audienceType) conditions.push(eq(workflows.audienceType, audienceType));

    const allMatchingWorkflows = conditions.length > 0
      ? await db.select().from(workflows).where(and(...conditions))
      : await db.select().from(workflows);

    const activeWorkflows = allMatchingWorkflows.filter((w) => w.status === "active");
    const deprecatedWorkflows = allMatchingWorkflows.filter((w) => w.status === "deprecated");

    if (activeWorkflows.length === 0) {
      res.status(404).json({ error: "No workflows found matching the criteria" });
      return;
    }

    const scores = await computeWorkflowScores(activeWorkflows, deprecatedWorkflows, objective, SYSTEM_IDENTITY);

    if (groupBy === "section") {
      const sectionMap = new Map<string, WorkflowScore[]>();
      for (const score of scores) {
        const key = `${score.workflow.category}-${score.workflow.channel}-${score.workflow.audienceType}`;
        const arr = sectionMap.get(key) ?? [];
        arr.push(score);
        sectionMap.set(key, arr);
      }

      const sections = [...sectionMap.entries()].map(([sectionKey, sectionScores]) => {
        const ranked = rankScores(sectionScores).slice(0, limit);
        const sample = sectionScores[0].workflow;
        return {
          sectionKey,
          category: sample.category,
          channel: sample.channel,
          audienceType: sample.audienceType,
          stats: aggregateSectionStats(sectionScores),
          workflows: ranked.map(formatPublicScoreItem),
        };
      });

      res.json({ sections });
    } else {
      const ranked = rankScores(scores).slice(0, limit);
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
    const { orgId } = query.data;

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgId) conditions.push(eq(workflows.orgId, orgId));

    const allMatchingWorkflows = conditions.length > 0
      ? await db.select().from(workflows).where(and(...conditions))
      : await db.select().from(workflows);

    const activeWorkflows = allMatchingWorkflows.filter((w) => w.status === "active");
    const deprecatedWorkflows = allMatchingWorkflows.filter((w) => w.status === "deprecated");

    if (activeWorkflows.length === 0) {
      res.status(404).json({ error: "No active workflows found" });
      return;
    }

    const scores = await computeWorkflowScores(activeWorkflows, deprecatedWorkflows, "replies", SYSTEM_IDENTITY);

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
        workflowName: entry.score.workflow.name,
        displayName: entry.score.workflow.displayName,
        brandId: entry.score.workflow.brandId,
        value: Math.round(entry.value * 100) / 100,
      };
    }

    res.json({
      bestCostPerOpen: formatRecord(bestCostPerOpen),
      bestCostPerReply: formatRecord(bestCostPerReply),
    });
  } catch (err: unknown) {
    if (!handleExternalServiceError(err, res, "public/best")) {
      console.error("[workflow-service] GET public/best error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

export default router;
