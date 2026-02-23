CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_app_signature_unique"
  ON "workflows" ("app_id", "signature")
  WHERE status != 'deleted';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_app_signature_name_unique"
  ON "workflows" ("app_id", "signature_name")
  WHERE status != 'deleted';
