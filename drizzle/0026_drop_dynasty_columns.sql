-- Drop dynasty columns (concept removed from features-service)
-- dynasty_slug and dynasty_name are now derivable from feature_slug + signature_name
DROP INDEX IF EXISTS "idx_workflows_dynasty_slug";
--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "dynasty_name";
--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "dynasty_slug";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflows_feature_signature" ON "workflows" ("feature_slug", "signature_name");
