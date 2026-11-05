-- MIGRATE-1105 S0: a campaign run executes its Engine's stored script, with no workflow.
-- (1) An Engine is LIVE for campaigns through a switch row (caller_service = 'campaign'), for ONE org first (org_id)
--     and then for every org (org_id NULL): a client is switched only on proof. The live/shadow uniqueness now holds
--     per org.
ALTER TABLE "script_switches" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_script_switches_service_live";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_script_switches_service_live" ON "script_switches" ("outcome", "caller_service", coalesce("org_id", '')) WHERE "caller_service" IS NOT NULL AND "state" = 'switched';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_script_switches_service_shadow";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_script_switches_service_shadow" ON "script_switches" ("outcome", "caller_service", coalesce("org_id", '')) WHERE "caller_service" IS NOT NULL AND "state" = 'shadow';
--> statement-breakpoint
-- (2) A script that asks to wait (`ctx.wait(days)`) stops; its run ends and is resumed at a later dispatch of the same
--     campaign once due, under the same pick (same version, same materials). Nothing holds a worker meanwhile.
CREATE TABLE IF NOT EXISTS "engine_waits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "campaign_id" text NOT NULL,
  "outcome" text NOT NULL,
  "script_id" uuid NOT NULL,
  "subject" jsonb,
  "units" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'waiting' NOT NULL,
  "claimed_at" timestamp with time zone,
  "from_run_id" text NOT NULL,
  "resumed_run_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "engine_waits_status_check" CHECK ("status" IN ('waiting', 'claimed', 'resumed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_engine_waits_due" ON "engine_waits" ("org_id", "campaign_id", "outcome", "status", "due_at");
