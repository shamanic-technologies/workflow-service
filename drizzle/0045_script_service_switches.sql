-- FACTORY-P3 next outcomes: a SERVICE switch. An outcome a service makes inside its own code (the reply judge in
-- instantly-service: no workflow step calls it) is switched by that service asking this one whether the outcome is
-- switched, then calling the stored script door instead of its own code. One row per (outcome, caller service) while
-- switched; the roll-back guard marks it rolled_back exactly like a workflow switch, and the service reads it.
ALTER TABLE "script_switches" ADD COLUMN IF NOT EXISTS "caller_service" text;
--> statement-breakpoint
ALTER TABLE "script_switches" ALTER COLUMN "workflow_dynasty_slug" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "script_switches" ALTER COLUMN "from_workflow_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "script_switches" ALTER COLUMN "from_version" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "script_switches" ALTER COLUMN "to_workflow_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "script_switches" ALTER COLUMN "to_version" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "script_switches" ADD COLUMN IF NOT EXISTS "script_version" integer;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "script_switches" ADD CONSTRAINT "script_switches_kind_check" CHECK (
    ("caller_service" IS NULL AND "workflow_dynasty_slug" IS NOT NULL AND "from_workflow_id" IS NOT NULL AND "from_version" IS NOT NULL AND "to_workflow_id" IS NOT NULL AND "to_version" IS NOT NULL)
    OR ("caller_service" IS NOT NULL AND "workflow_dynasty_slug" IS NULL AND "from_workflow_id" IS NULL AND "to_workflow_id" IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_script_switches_service_live" ON "script_switches" ("outcome", "caller_service") WHERE "caller_service" IS NOT NULL AND "state" = 'switched';
