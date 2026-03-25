-- Add feature_slug column to workflows so each workflow can be directly linked to a feature.
-- The dashboard uses this to list workflows for a given feature instead of filtering by category.

ALTER TABLE "workflows" ADD COLUMN "feature_slug" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflows_feature_slug" ON "workflows" ("feature_slug");
