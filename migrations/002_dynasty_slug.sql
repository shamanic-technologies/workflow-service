-- Migration: Add dynasty_slug column
-- Stable slug for the dynasty lineage, derived from slug by stripping version suffix.

-- 1. Add column (nullable first for backfill)
ALTER TABLE workflows ADD COLUMN dynasty_slug text;

-- 2. Backfill: strip -v{N} suffix from slug to get the dynasty slug
UPDATE workflows SET dynasty_slug = REGEXP_REPLACE(slug, '-v\d+$', '');

-- 3. Make NOT NULL after backfill
ALTER TABLE workflows ALTER COLUMN dynasty_slug SET NOT NULL;

-- 4. Index for lookup by dynasty_slug
CREATE INDEX idx_workflows_dynasty_slug ON workflows (dynasty_slug);
