-- Migration: Dynasty naming model
-- Renames name→slug, display_name→name, adds dynasty_name + version columns.

-- 1. Add new columns (before rename to avoid conflicts)
ALTER TABLE workflows ADD COLUMN dynasty_name text;
ALTER TABLE workflows ADD COLUMN version integer NOT NULL DEFAULT 1;

-- 2. Rename columns
ALTER TABLE workflows RENAME COLUMN name TO slug;
ALTER TABLE workflows RENAME COLUMN display_name TO name;

-- 3. Backfill dynasty_name from existing data (featureSlug + signatureName capitalized)
UPDATE workflows SET dynasty_name = CONCAT(
  INITCAP(REPLACE(feature_slug, '-', ' ')),
  ' ',
  INITCAP(signature_name)
);

-- 4. Backfill name (old display_name) where it was NULL — use dynasty_name
UPDATE workflows SET name = dynasty_name WHERE name IS NULL;

-- 5. Make dynasty_name NOT NULL after backfill
ALTER TABLE workflows ALTER COLUMN dynasty_name SET NOT NULL;
ALTER TABLE workflows ALTER COLUMN name SET NOT NULL;

-- 6. Add unique indexes
CREATE UNIQUE INDEX idx_workflows_slug_unique ON workflows (slug);
CREATE UNIQUE INDEX idx_workflows_name_unique ON workflows (name);

-- 7. Partial unique indexes for active workflows
CREATE UNIQUE INDEX idx_workflows_active_sig
  ON workflows (feature_slug, signature) WHERE status = 'active';
CREATE UNIQUE INDEX idx_workflows_active_signame
  ON workflows (feature_slug, signature_name) WHERE status = 'active';

-- 8. Rename in workflow_runs
ALTER TABLE workflow_runs RENAME COLUMN workflow_name TO workflow_slug;
