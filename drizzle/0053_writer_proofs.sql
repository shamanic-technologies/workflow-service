-- PROVEN-BEFORE-PEOPLE-1116: a writer combination is proven on real recorded cases before it writes to real people.
-- writer_cases: what a production run of a script that writes to a person saw (request, materials, every vendor call
-- with its request and answer), one row per run that reached an LLM, newest kept per Engine (src/lib/scripts/writer-proof.ts).
CREATE TABLE IF NOT EXISTS "writer_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "outcome" text NOT NULL,
  "run_id" text NOT NULL,
  "recorded_from" text NOT NULL,
  "code_md5" text NOT NULL,
  "org_id" text NOT NULL,
  "body" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_writer_cases_run" ON "writer_cases" ("outcome", "run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_writer_cases_outcome" ON "writer_cases" ("outcome", "created_at");
--> statement-breakpoint
-- writer_proofs: one proof of one script VERSION (a combination) on a bounded sample of its Engine's cases.
CREATE TABLE IF NOT EXISTS "writer_proofs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "script_id" uuid NOT NULL,
  "outcome" text NOT NULL,
  "dynasty" text NOT NULL,
  "version" integer NOT NULL,
  "state" text NOT NULL,
  "trigger" text NOT NULL,
  "sample" integer DEFAULT 0 NOT NULL,
  "usable" integer DEFAULT 0 NOT NULL,
  "cases_available" integer DEFAULT 0 NOT NULL,
  "cases" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "run_id" text,
  "spend_cents" numeric,
  "ceiling_cents" numeric NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_writer_proofs_script" ON "writer_proofs" ("script_id", "created_at");
--> statement-breakpoint
-- writer_proof_engines: the Engines whose Rating draws only proven writer combinations (enforced = true).
CREATE TABLE IF NOT EXISTS "writer_proof_engines" (
  "outcome" text PRIMARY KEY NOT NULL,
  "enforced" boolean NOT NULL,
  "decided_by" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
