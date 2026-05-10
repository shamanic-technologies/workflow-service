-- Rename dynasty_slug, dynasty_name, signature_name to workflow_dynasty_*
-- and drop style_name. Idempotent: re-runs are no-ops.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflows' AND column_name = 'dynasty_slug'
  ) THEN
    ALTER TABLE "workflows" RENAME COLUMN "dynasty_slug" TO "workflow_dynasty_slug";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflows' AND column_name = 'dynasty_name'
  ) THEN
    ALTER TABLE "workflows" RENAME COLUMN "dynasty_name" TO "workflow_dynasty_name";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflows' AND column_name = 'signature_name'
  ) THEN
    ALTER TABLE "workflows" RENAME COLUMN "signature_name" TO "workflow_dynasty_signature_name";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "style_name";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_workflows_style";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_workflows_feature_signature";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflows_feature_signature" ON "workflows" ("feature_slug", "workflow_dynasty_signature_name");
