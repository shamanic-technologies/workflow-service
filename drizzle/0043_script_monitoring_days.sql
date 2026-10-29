-- FACTORY-P3: one stored row per day x outcome x path ('script' = our stored scripts, 'service' = the service task
-- that makes the outcome today), read from runs-service's task outcomes. Daily runs = the total's day-over-day delta.
CREATE TABLE IF NOT EXISTS "script_monitoring_days" (
  "day" date NOT NULL,
  "outcome" text NOT NULL,
  "path" text NOT NULL,
  "service_name" text NOT NULL,
  "task_names" jsonb NOT NULL,
  "total_run_count" bigint NOT NULL,
  "sample_size" integer NOT NULL,
  "completed_count" integer NOT NULL,
  "failed_count" integer NOT NULL,
  "avg_cost_cents" numeric,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "script_monitoring_days_pk" PRIMARY KEY ("day", "outcome", "path"),
  CONSTRAINT "script_monitoring_days_path_check" CHECK ("path" IN ('script', 'service'))
);
