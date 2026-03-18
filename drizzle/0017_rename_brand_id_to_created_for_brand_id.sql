-- Rename brand_id to created_for_brand_id on workflows table
-- This column only records which brand context created the workflow,
-- not the execution-context brand (which lives on workflow_runs.brand_id).
ALTER TABLE "workflows" RENAME COLUMN "brand_id" TO "created_for_brand_id";
