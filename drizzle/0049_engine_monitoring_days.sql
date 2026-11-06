-- MIGRATE-1105 S2b: Monitoring for CAMPAIGN Engines. One stored row per UTC day x Engine outcome x path x org:
-- 'script' = the campaign's run executed its Engine's stored script with no workflow (workflow_runs rows of
-- execution_scope 'engine'), 'workflow' = the campaign still ran a workflow (its dynasty's leg reaches that outcome).
-- Counts are recomputed from workflow_runs; the cost sample (runs-service subtree costs of up to N finished runs) is
-- read once per completed day.
CREATE TABLE IF NOT EXISTS "engine_monitoring_days" (
  "day" date NOT NULL,
  "outcome" text NOT NULL,
  "path" text NOT NULL,
  "org_id" text NOT NULL,
  "runs" integer NOT NULL,
  "completed" integer NOT NULL,
  "failed" integer NOT NULL,
  "cost_sample_runs" integer,
  "cost_sample_cents" numeric,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "engine_monitoring_days_pk" PRIMARY KEY ("day", "outcome", "path", "org_id"),
  CONSTRAINT "engine_monitoring_days_path_check" CHECK ("path" IN ('script', 'workflow'))
);
