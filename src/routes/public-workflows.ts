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

    res.json({
      workflows: rows.map((w) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        version: w.version,
        status: w.status,
        featureSlug: w.featureSlug,
        createdForBrandId: w.createdForBrandId ?? null,
        upgradedTo: w.upgradedTo ?? null,
      })),
    });
  } catch (err: unknown) {
    console.error("[workflow-service] GET /public/workflows error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
