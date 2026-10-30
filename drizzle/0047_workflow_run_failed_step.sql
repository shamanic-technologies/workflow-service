-- INCIDENT 2026-10-30 (FACTORY-P3): the step a failed run failed at (the leaf of its Windmill flow status) and that
-- step's error, so the script guard judges a switch only on failures at the steps it changed.
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "failed_step" text;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "failed_reason" text;
