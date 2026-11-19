-- DISTRY-PRINCIPAL-1119: one Engine call by a caller that is not a campaign (Distry): pick, run, result.
CREATE TABLE IF NOT EXISTS "engine_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "outcome" text NOT NULL,
  "org_id" text NOT NULL,
  "caller_run_id" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "pick" jsonb NOT NULL,
  "unit" jsonb,
  "error" text,
  "tried" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_engine_calls_org" ON "engine_calls" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_engine_calls_running" ON "engine_calls" ("status");
