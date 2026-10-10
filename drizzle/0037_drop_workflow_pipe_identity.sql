-- Owner 2026-10-10: the pipe <-> workflow link lives in features-service only
-- (`/internal/workflow-leg-assignments`). workflow-service writes it there at create/fork and
-- reads it back; it no longer keeps its own copy (added by 0036 the same day, read by no one).
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "pipe_id";
--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "produces_step";
