DROP INDEX IF EXISTS "idx_workflows_status";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_workflows_app_name_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_workflows_app_signature_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_workflows_app_signature_name_unique";
--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "status";
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflows_app_name_unique" ON "workflows" ("app_id", "name");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflows_app_signature_unique" ON "workflows" ("app_id", "signature");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflows_app_signature_name_unique" ON "workflows" ("app_id", "signature_name");
