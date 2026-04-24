import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows, workflowRuns } from "../db/schema.js";
import { TransferBrandRequestSchema } from "../schemas.js";
import { requireApiKey } from "../middleware/auth.js";

const router = Router();

// POST /internal/transfer-brand — Re-assign solo-brand rows between orgs
router.post("/internal/transfer-brand", requireApiKey, async (req, res) => {
  const parsed = TransferBrandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: parsed.error });
    return;
  }

  const { brandId, sourceOrgId, targetOrgId } = parsed.data;

  // workflows: created_for_brand_id is a single text column
  const workflowsResult = await db
    .update(workflows)
    .set({ orgId: targetOrgId })
    .where(
      and(
        eq(workflows.orgId, sourceOrgId),
        eq(workflows.createdForBrandId, brandId),
      )
    );

  // workflow_runs: brand_ids is a text[] — only update solo-brand rows (array length = 1, element = brandId)
  const workflowRunsResult = await db.execute(
    sql`UPDATE workflow_runs
        SET org_id = ${targetOrgId}
        WHERE org_id = ${sourceOrgId}
          AND brand_ids = ARRAY[${brandId}]::text[]`
  );

  const workflowsCount = (workflowsResult as unknown as { rowCount?: number }).rowCount ?? 0;
  const workflowRunsCount = (workflowRunsResult as unknown as { rowCount?: number }).rowCount ?? 0;

  console.log(
    `[workflow-service] transfer-brand: brandId=${brandId} from=${sourceOrgId} to=${targetOrgId} — ` +
    `workflows=${workflowsCount}, workflow_runs=${workflowRunsCount}`
  );

  res.json({
    updatedTables: [
      { tableName: "workflows", count: workflowsCount },
      { tableName: "workflow_runs", count: workflowRunsCount },
    ],
  });
});

export default router;
