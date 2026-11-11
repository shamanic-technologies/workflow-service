-- MON-SCRIPTS-FOLLOWUP-DYNASTIES-1111: a campaign Engine's failed runs split by WHOSE failure it is. `failed` = the
-- run's own failures; `unanswered` = runs failed because a call got no answer (an upstream 5xx, a reset or timed-out
-- connection, "Upstream service error") or billing refused it, counted apart like the roll-back guard counts them.
-- Rows are recounted from workflow_runs on the next refresh, so the column starts at 0 and fills itself.
ALTER TABLE "engine_monitoring_days" ADD COLUMN IF NOT EXISTS "unanswered" integer DEFAULT 0 NOT NULL;
