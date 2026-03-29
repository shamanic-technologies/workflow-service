-- Add dynasty_slug column: stable slug for the dynasty lineage.
-- Idempotent: uses IF NOT EXISTS / DO blocks so re-running is safe.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflows' AND column_name='dynasty_slug') THEN
    ALTER TABLE "workflows" ADD COLUMN "dynasty_slug" text;
  END IF;
END $$;
--> statement-breakpoint

-- Backfill: strip -v{N} suffix from slug to get the dynasty slug
UPDATE "workflows" SET "dynasty_slug" = REGEXP_REPLACE("slug", '-v\d+$', '') WHERE "dynasty_slug" IS NULL;
--> statement-breakpoint

-- Make NOT NULL after backfill
DO $$ BEGIN
  ALTER TABLE "workflows" ALTER COLUMN "dynasty_slug" SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;
--> statement-breakpoint

-- Index for lookup by dynasty_slug
CREATE INDEX IF NOT EXISTS "idx_workflows_dynasty_slug" ON "workflows" ("dynasty_slug");
