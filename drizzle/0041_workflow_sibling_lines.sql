-- WF-SHORT-LINE-1023: one short line per workflow dynasty per pipe, saying what sets it apart from its siblings on
-- that pipe (display only, the description is untouched). Written by src/lib/sibling-line-refresher.ts; a pipe's
-- lines are rewritten whenever its sibling set changes (`siblings_key`).
CREATE TABLE IF NOT EXISTS "workflow_sibling_lines" (
  "feature_slug" text NOT NULL,
  "leg_key" text NOT NULL,
  "workflow_dynasty_slug" text NOT NULL,
  "line" text NOT NULL,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("feature_slug", "leg_key", "workflow_dynasty_slug")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sibling_lines_dynasty" ON "workflow_sibling_lines" ("workflow_dynasty_slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_sibling_line_pipes" (
  "feature_slug" text NOT NULL,
  "leg_key" text NOT NULL,
  "siblings_key" text NOT NULL,
  "state" text NOT NULL,
  "problem" text,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("feature_slug", "leg_key"),
  CONSTRAINT "workflow_sibling_line_pipes_state_check" CHECK ("state" IN ('written', 'single', 'failed'))
);
