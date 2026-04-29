-- Restore dynasty columns (incorrectly dropped in 0026) and rename slug/name for clarity
-- dynasty_slug and dynasty_name are workflow-level concepts, not feature-level

-- Step 1: Rename slug -> workflow_slug, name -> workflow_name
ALTER TABLE "workflows" RENAME COLUMN "slug" TO "workflow_slug";
--> statement-breakpoint
ALTER TABLE "workflows" RENAME COLUMN "name" TO "workflow_name";
--> statement-breakpoint

-- Step 2: Re-add dynasty columns
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "dynasty_slug" text;
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "dynasty_name" text;
--> statement-breakpoint

-- Step 3: Backfill dynasty columns from workflow_slug/workflow_name by stripping version suffix
UPDATE "workflows" SET
  "dynasty_slug" = regexp_replace("workflow_slug", '-v\d+$', ''),
  "dynasty_name" = regexp_replace("workflow_name", ' v\d+$', '')
WHERE "dynasty_slug" IS NULL;
--> statement-breakpoint

-- Step 4: Make dynasty columns NOT NULL after backfill
ALTER TABLE "workflows" ALTER COLUMN "dynasty_slug" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "dynasty_name" SET NOT NULL;
--> statement-breakpoint

-- Step 5: Update indexes
-- The old idx_workflows_slug_unique was auto-renamed by Postgres when we renamed the column.
-- But let's be explicit: drop old name if it exists, create with new name.
DROP INDEX IF EXISTS "idx_workflows_slug_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_workflow_slug_unique" ON "workflows" ("workflow_slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflows_dynasty_slug" ON "workflows" ("dynasty_slug");
