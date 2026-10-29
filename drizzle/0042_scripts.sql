-- FACTORY-P2-ENGINES: a script is code stored as data. It makes one Unit of its outcome (a features-service step
-- key) or none; its versions form a dynasty (upgrade = new version, fork = new dynasty), like workflows.
CREATE TABLE IF NOT EXISTS "scripts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "outcome" text NOT NULL,
  "dynasty" text NOT NULL,
  "version" integer NOT NULL,
  "code" text NOT NULL,
  "materials" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "vendors" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "tactics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "description" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "dynasty_status" text DEFAULT 'active' NOT NULL,
  "creation_type" text NOT NULL,
  "created_from_script" uuid,
  "org_id" text NOT NULL,
  "created_by" text NOT NULL,
  "replay" jsonb,
  "deprecation_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scripts_status_check" CHECK ("status" IN ('active', 'deprecated')),
  CONSTRAINT "scripts_dynasty_status_check" CHECK ("dynasty_status" IN ('active', 'deprecated')),
  CONSTRAINT "scripts_creation_type_check" CHECK ("creation_type" IN ('scratch', 'upgrade', 'fork'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_scripts_version" ON "scripts" ("outcome", "dynasty", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_scripts_active" ON "scripts" ("outcome", "dynasty") WHERE "status" = 'active';
--> statement-breakpoint
-- Recorded production cases a PORTED dynasty must replay at 100 % before any version of it is stored. Real personal
-- data: kept here, never in git, never served by a public read (only their count is).
CREATE TABLE IF NOT EXISTS "script_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "outcome" text NOT NULL,
  "dynasty" text NOT NULL,
  "case_id" text NOT NULL,
  "body" jsonb NOT NULL,
  "source" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_script_cases_case" ON "script_cases" ("outcome", "dynasty", "case_id");
--> statement-breakpoint
-- An Engine's storage (its scripts' notes), per org: a script never reads another org's notes.
CREATE TABLE IF NOT EXISTS "script_storage" (
  "org_id" text NOT NULL,
  "outcome" text NOT NULL,
  "table_name" text NOT NULL,
  "key" text NOT NULL,
  "value" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "script_storage_pk" PRIMARY KEY ("org_id", "outcome", "table_name", "key")
);
--> statement-breakpoint
-- One production order of a script: what it was handed, every vendor call, what it made, its runs-service run.
CREATE TABLE IF NOT EXISTS "script_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "script_id" uuid NOT NULL,
  "org_id" text NOT NULL,
  "run_id" text NOT NULL,
  "parent_run_id" text NOT NULL,
  "subject" jsonb,
  "status" text NOT NULL,
  "result" jsonb,
  "error" text,
  "vendor_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "declared" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_script_runs_script" ON "script_runs" ("script_id", "created_at");
