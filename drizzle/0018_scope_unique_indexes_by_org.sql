-- Fix: unique indexes on name/signature/signatureName must be scoped by org_id.
-- Without org_id, two different orgs cannot have active workflows with the same
-- generated name (e.g. "sales-email-cold-outreach-roman"), which causes 500 errors.

DROP INDEX IF EXISTS "idx_workflows_name_active";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_workflows_signature_active";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_workflows_signature_name_active";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_name_active" ON "workflows" ("org_id", "name") WHERE "status" = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_signature_active" ON "workflows" ("org_id", "signature") WHERE "status" = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_signature_name_active" ON "workflows" ("org_id", "signature_name") WHERE "status" = 'active';
