import { Router } from "express";
import { db } from "../db/index.js";
import { transferBrand } from "../lib/transfer-brand.js";
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
  const result = await transferBrand(db, { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

  console.log(
    `[workflow-service] transfer-brand: sourceBrandId=${sourceBrandId} targetBrandId=${targetBrandId ?? "none"} from=${sourceOrgId} to=${targetOrgId} — ` +
    result.updatedTables.map((t) => `${t.tableName}=${t.count}`).join(", ")
  );

  res.json(result);
});

export default router;
