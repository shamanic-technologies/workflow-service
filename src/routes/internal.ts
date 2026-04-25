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

  // Step 1: Move rows to the target org (filter by sourceOrgId + sourceBrandId)
  const workflowsStep1 = await db
    .update(workflows)
    .set({ orgId: targetOrgId })
    .where(
      and(
        eq(workflows.orgId, sourceOrgId),
        eq(workflows.createdForBrandId, sourceBrandId),
      )
    );

  const workflowRunsStep1 = await db.execute(
    sql`UPDATE workflow_runs
        SET org_id = ${targetOrgId}
        WHERE org_id = ${sourceOrgId}
          AND brand_ids = ARRAY[${sourceBrandId}]::text[]`
  );

  // Step 2: Rewrite brand references (no org filter — catches all remaining refs to sourceBrandId)
  let workflowsStep2Count = 0;
  let workflowRunsStep2Count = 0;
  if (targetBrandId) {
    const workflowsStep2 = await db
      .update(workflows)
      .set({ createdForBrandId: targetBrandId })
      .where(eq(workflows.createdForBrandId, sourceBrandId));

    const workflowRunsStep2 = await db.execute(
      sql`UPDATE workflow_runs
          SET brand_ids = ARRAY[${targetBrandId}]::text[]
          WHERE brand_ids = ARRAY[${sourceBrandId}]::text[]`
    );

    workflowsStep2Count = (workflowsStep2 as unknown as { rowCount?: number }).rowCount ?? 0;
    workflowRunsStep2Count = (workflowRunsStep2 as unknown as { rowCount?: number }).rowCount ?? 0;
  }

  const workflowsStep1Count = (workflowsStep1 as unknown as { rowCount?: number }).rowCount ?? 0;
  const workflowRunsStep1Count = (workflowRunsStep1 as unknown as { rowCount?: number }).rowCount ?? 0;

  // When targetBrandId is present, step 2 rewrites brand refs (superset of step 1 rows). Report the higher count.
  const workflowsCount = Math.max(workflowsStep1Count, workflowsStep2Count);
  const workflowRunsCount = Math.max(workflowRunsStep1Count, workflowRunsStep2Count);

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
