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

  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

  // workflows: created_for_brand_id is a single text column
  const workflowsResult = await db
    .update(workflows)
    .set({
      orgId: targetOrgId,
      ...(targetBrandId ? { createdForBrandId: targetBrandId } : {}),
    })
    .where(
      and(
        eq(workflows.orgId, sourceOrgId),
        eq(workflows.createdForBrandId, sourceBrandId),
      )
    );

  // workflow_runs: brand_ids is a text[] — only update solo-brand rows (array length = 1, element = sourceBrandId)
  const workflowRunsResult = await db.execute(
    targetBrandId
      ? sql`UPDATE workflow_runs
            SET org_id = ${targetOrgId}, brand_ids = ARRAY[${targetBrandId}]::text[]
            WHERE org_id = ${sourceOrgId}
              AND brand_ids = ARRAY[${sourceBrandId}]::text[]`
      : sql`UPDATE workflow_runs
            SET org_id = ${targetOrgId}
            WHERE org_id = ${sourceOrgId}
              AND brand_ids = ARRAY[${sourceBrandId}]::text[]`
  );

  const workflowsCount = (workflowsResult as unknown as { rowCount?: number }).rowCount ?? 0;
  const workflowRunsCount = (workflowRunsResult as unknown as { rowCount?: number }).rowCount ?? 0;

  console.log(
    `[workflow-service] transfer-brand: sourceBrandId=${sourceBrandId} targetBrandId=${targetBrandId ?? "none"} from=${sourceOrgId} to=${targetOrgId} — ` +
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
