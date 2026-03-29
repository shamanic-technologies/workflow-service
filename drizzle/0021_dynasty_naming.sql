-- Dynasty naming model: rename columns, add dynasty_name + version.
-- Idempotent: uses IF NOT EXISTS / DO blocks so re-running is safe.

-- 1. Add new columns (before rename to avoid conflicts)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflows' AND column_name='dynasty_name') THEN
    ALTER TABLE "workflows" ADD COLUMN "dynasty_name" text;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflows' AND column_name='version') THEN
    ALTER TABLE "workflows" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
  END IF;
END $$;
--> statement-breakpoint

-- 2. Rename columns (only if old names still exist)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflows' AND column_name='name')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflows' AND column_name='slug') THEN
    ALTER TABLE "workflows" RENAME COLUMN "name" TO "slug";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflows' AND column_name='display_name') THEN
    ALTER TABLE "workflows" RENAME COLUMN "display_name" TO "name";
  END IF;
END $$;
--> statement-breakpoint

-- 3. Backfill dynasty_name from existing data
UPDATE "workflows" SET "dynasty_name" = CONCAT(
  INITCAP(REPLACE("feature_slug", '-', ' ')),
  ' ',
  INITCAP("signature_name")
) WHERE "dynasty_name" IS NULL;
--> statement-breakpoint

-- 4. Backfill name where NULL (from old display_name)
UPDATE "workflows" SET "name" = "dynasty_name" WHERE "name" IS NULL;
--> statement-breakpoint

-- 5. Make columns NOT NULL after backfill
DO $$ BEGIN
  ALTER TABLE "workflows" ALTER COLUMN "dynasty_name" SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "workflows" ALTER COLUMN "name" SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;
--> statement-breakpoint

-- 6. Add unique indexes
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_slug_unique" ON "workflows" ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_name_unique" ON "workflows" ("name");
--> statement-breakpoint

-- 7. Partial unique indexes for active workflows
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_active_sig" ON "workflows" ("feature_slug", "signature") WHERE "status" = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_active_signame" ON "workflows" ("feature_slug", "signature_name") WHERE "status" = 'active';
--> statement-breakpoint

-- 8. Rename in workflow_runs
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflow_runs' AND column_name='workflow_name')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflow_runs' AND column_name='workflow_slug') THEN
    ALTER TABLE "workflow_runs" RENAME COLUMN "workflow_name" TO "workflow_slug";
  END IF;
END $$;
