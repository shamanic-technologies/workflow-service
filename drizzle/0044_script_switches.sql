-- FACTORY-P3 fleet writer switch: one row per workflow dynasty switched from content-generation's writer to a stored
-- script (same dynasty, new version), so the roll-back guard knows which version to re-activate. Never in git: none.
CREATE TABLE IF NOT EXISTS "script_switches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "outcome" text NOT NULL,
  "dynasty" text NOT NULL,
  "workflow_dynasty_slug" text NOT NULL,
  "from_workflow_id" uuid NOT NULL,
  "from_version" integer NOT NULL,
  "to_workflow_id" uuid NOT NULL,
  "to_version" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'switched',
  "switched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "rolled_back_at" timestamp with time zone,
  "rollback_reason" text,
  CONSTRAINT "script_switches_state_check" CHECK ("state" IN ('switched', 'rolled_back'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_script_switches_to" ON "script_switches" ("to_workflow_id");
CREATE INDEX IF NOT EXISTS "idx_script_switches_outcome" ON "script_switches" ("outcome", "state");
