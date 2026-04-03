-- Drop unused and redundant indexes from workflows and workflow_runs tables.
--
-- workflows: 20 indexes for 475 rows is excessive. Dropping 7:
--   - idx_workflows_name_active: (org_id, slug WHERE active) — redundant with globally-unique idx_workflows_slug_unique
--   - idx_workflows_signature_active: (org_id, signature WHERE active) — replaced by idx_workflows_active_sig (feature_slug, signature WHERE active)
--   - idx_workflows_signature_name_active: (org_id, signature_name WHERE active) — replaced by idx_workflows_active_signame (feature_slug, signature_name WHERE active)
--   - idx_workflows_name_active_unique: (name WHERE active) — 0 scans
--   - idx_workflows_org_style: (org_id, style_name) — 0 scans
--   - idx_workflows_campaign: (campaign_id) — 1 scan
--   - idx_workflows_org: (org_id) — 24 scans, covered by composites
--
-- workflow_runs: Dropping 3 zero-scan indexes:
--   - idx_workflow_runs_brand_ids: GIN on brand_ids — 0 scans
--   - idx_workflow_runs_windmill_job: windmill_job_id — 0 scans
--   - idx_workflow_runs_org: org_id — 0 scans

DROP INDEX IF EXISTS idx_workflows_name_active;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_workflows_signature_active;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_workflows_signature_name_active;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_workflows_name_active_unique;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_workflows_org_style;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_workflows_campaign;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_workflows_org;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_workflow_runs_brand_ids;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_workflow_runs_windmill_job;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_workflow_runs_org;
