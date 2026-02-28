ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "human_id" text;
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "style_name" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflows_style" ON "workflows" ("app_id", "style_name");
