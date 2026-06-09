-- Reserve campaign-scoped workflow executions before Windmill dispatch.
-- This prevents concurrent active executions for the same org + campaign.

ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "execution_scope" text;
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "execution_key" text;
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "conflict_policy" text;
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "reserved_at" timestamp with time zone;
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "dispatch_started_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_execution_key" ON "workflow_runs" ("execution_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflow_runs_active_execution_key_unique"
  ON "workflow_runs" ("execution_key")
  WHERE "execution_key" IS NOT NULL
    AND "status" IN ('dispatching', 'queued', 'running');
