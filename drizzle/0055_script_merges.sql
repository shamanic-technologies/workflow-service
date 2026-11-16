-- ONE-WRITER-N-MODELS-1116: a script dynasty MERGED into the one(s) it now runs as (a per-model copy of a writer becomes
-- the writer, asked by its sender, plus the model's LLM completion script, asked by that writer). The absorbed
-- dynasty is retired; its runs keep their names; features-service pools its history into each survivor at its place.
CREATE TABLE IF NOT EXISTS "script_merges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "absorbed_outcome" text NOT NULL,
  "absorbed_dynasty" text NOT NULL,
  "survivor_outcome" text NOT NULL,
  "survivor_dynasty" text NOT NULL,
  "asked_by" text,
  "reason" text NOT NULL,
  "merged_by" text NOT NULL,
  "merged_at" timestamp with time zone DEFAULT now() NOT NULL,
  "unmerged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_script_merges_absorbed" ON "script_merges" ("absorbed_outcome", "absorbed_dynasty");
