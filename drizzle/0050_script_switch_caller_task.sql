-- MIGRATE-1105 S2b: a service can make ONE outcome through two decisions at different moments (instantly files each
-- message of a poll batch `reply_received` = `inbound-decision`, then judges which lead a stranger's message answers,
-- also `reply_received` = `orphan-judgment`). A service switch is then keyed by (outcome, caller, caller TASK): the
-- task the caller runs the decision under (its Monitoring service path). NULL = the outcome's only decision (every
-- switch before this one; a caller that states no task reads the latest row of the outcome, as before).
ALTER TABLE "script_switches" ADD COLUMN IF NOT EXISTS "caller_task" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_script_switches_service_live";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_script_switches_service_live" ON "script_switches" ("outcome", "caller_service", coalesce("org_id", ''), coalesce("caller_task", '')) WHERE "caller_service" IS NOT NULL AND "state" = 'switched';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_script_switches_service_shadow";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_script_switches_service_shadow" ON "script_switches" ("outcome", "caller_service", coalesce("org_id", ''), coalesce("caller_task", '')) WHERE "caller_service" IS NOT NULL AND "state" = 'shadow';
--> statement-breakpoint
-- The task each of instantly's existing decisions already runs under (its platform run's task name), so a caller that
-- names its task keeps reading its own row.
UPDATE "script_switches" SET "caller_task" = 'inbound-decision' WHERE "caller_service" = 'instantly' AND "outcome" = 'reply_received' AND "caller_task" IS NULL;
--> statement-breakpoint
UPDATE "script_switches" SET "caller_task" = 'queue-decision' WHERE "caller_service" = 'instantly' AND "outcome" = 'message_queued' AND "caller_task" IS NULL;
