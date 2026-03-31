-- Migrate workflow_runs.brand_id (single text) to brand_ids (text array)
-- for multi-brand campaign support.

ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS brand_ids text[];
--> statement-breakpoint
UPDATE workflow_runs SET brand_ids = ARRAY[brand_id] WHERE brand_id IS NOT NULL AND brand_ids IS NULL;
--> statement-breakpoint
ALTER TABLE workflow_runs DROP COLUMN IF EXISTS brand_id;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflow_runs_brand_ids ON workflow_runs USING GIN (brand_ids);
