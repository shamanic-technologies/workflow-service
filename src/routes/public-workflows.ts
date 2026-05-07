import { Router } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows } from "../db/schema.js";
import {
  PublicWorkflowsQuerySchema,
} from "../schemas.js";
import { requireApiKey } from "../middleware/auth.js";

const router = Router();

// GET /public/workflows — Workflow metadata by feature slugs (x-api-key, no identity)
router.get("/public/workflows", requireApiKey, async (req, res) => {
  try {
    const query = PublicWorkflowsQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Validation error", details: query.error });
      return;
    }

    const featureSlugs = query.data.featureSlugs.split(",").map((s) => s.trim()).filter(Boolean);
    if (featureSlugs.length === 0) {
      res.status(400).json({ error: "featureSlugs must contain at least one slug" });
      return;
    }

    const statusFilter = query.data.status ?? "active";

    const conditions = [inArray(workflows.featureSlug, featureSlugs)];
    if (statusFilter !== "all") {
      conditions.push(eq(workflows.status, statusFilter));
    }

    const rows = await db.select().from(workflows).where(and(...conditions));

    // Build a forward map: deprecated row id -> successor id (whichever upgrade
    // points back via created_from_workflow). Computed from the same row set so
    // a single query covers it; deprecated rows whose successor is outside the
    // filtered set will get null, which matches the legacy behaviour for
    // already-pruned chains.
    const upgradedToById = new Map<string, string>();
    for (const w of rows) {
      if (w.creationType === "upgrade" && w.createdFromWorkflow) {
        upgradedToById.set(w.createdFromWorkflow, w.id);
      }
    }

    res.json({
      workflows: rows.map((w) => ({
        id: w.id,
        workflowSlug: w.workflowSlug,
        workflowName: w.workflowName,
        workflowDynastySlug: w.dynastySlug,
        workflowDynastyName: w.dynastyName,
        version: w.version,
        status: w.status,
        featureSlug: w.featureSlug,
        createdForBrandId: w.createdForBrandId ?? null,
        upgradedTo: upgradedToById.get(w.id) ?? null,
      })),
    });
  } catch (err: unknown) {
    console.error("[workflow-service] GET /public/workflows error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
