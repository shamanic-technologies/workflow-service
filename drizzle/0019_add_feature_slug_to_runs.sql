-- Add feature_slug column to workflow_runs for per-feature analytics.
-- Propagated via x-feature-slug header from campaign-service / features-service.

ALTER TABLE "workflow_runs" ADD COLUMN "feature_slug" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_feature_slug" ON "workflow_runs" ("feature_slug");
