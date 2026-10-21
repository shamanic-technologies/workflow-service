-- TPL-DYNASTY-1021-WF: a workflow dynasty merged into another one on the SAME pipe (same template dynasty, same
-- writer model). Non-destructive: no historical row is rewritten. The absorbed dynasty's versions are deprecated
-- with the survivor as their successor, and `absorbed_prior_state` keeps every version's status fields as they
-- were, so an un-merge restores them exactly. One OPEN merge (unmerged_at NULL) per absorbed dynasty.
CREATE TABLE IF NOT EXISTS "workflow_dynasty_merges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "absorbed_dynasty_slug" text NOT NULL,
  "survivor_dynasty_slug" text NOT NULL,
  "feature_slug" text NOT NULL,
  "leg_keys" jsonb NOT NULL,
  "reason" text NOT NULL,
  "decided_by" text,
  "merged_at" timestamp with time zone DEFAULT now() NOT NULL,
  "absorbed_prior_state" jsonb NOT NULL,
  "unmerged_at" timestamp with time zone,
  "unmerged_by" text,
  "unmerge_reason" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_dynasty_merges_open_absorbed" ON "workflow_dynasty_merges" ("absorbed_dynasty_slug") WHERE "unmerged_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dynasty_merges_survivor" ON "workflow_dynasty_merges" ("survivor_dynasty_slug");
