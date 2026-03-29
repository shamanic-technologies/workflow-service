-- Fix dynasty backfill: correct dynasty_name, dynasty_slug, version, name.
-- The original 0021/0022 migrations used INITCAP(feature_slug) which produces
-- wrong capitalization (e.g. "Pr" instead of "PR") and set all versions to 1.
-- This migration fixes the data using features-service dynasty names and
-- computes proper version numbers from the upgrade chain.
-- Idempotent: safe to re-run (overwrites all dynasty columns).

-- 1. Fix name unique constraint: global → active-only (deprecated workflows can share names across converged dynasties)
DROP INDEX IF EXISTS "idx_workflows_name_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_name_active_unique" ON "workflows" ("name") WHERE "status" = 'active';
--> statement-breakpoint

-- 2. Compute correct version numbers from upgrade chains
WITH RECURSIVE chain AS (
  SELECT w.id, w.upgraded_to, 1 as computed_version
  FROM "workflows" w
  WHERE NOT EXISTS (SELECT 1 FROM "workflows" w2 WHERE w2.upgraded_to = w.id)
  UNION ALL
  SELECT w.id, w.upgraded_to, c.computed_version + 1
  FROM "workflows" w
  JOIN chain c ON c.upgraded_to = w.id
)
UPDATE "workflows" SET "version" = chain.computed_version
FROM chain WHERE "workflows".id = chain.id;
--> statement-breakpoint

-- 3. Fix dynasty_name using correct feature dynasty names
UPDATE "workflows" SET "dynasty_name" = CASE
  WHEN "feature_slug" = 'pr-cold-email-outreach' THEN 'PR Cold Email Outreach ' || INITCAP("signature_name")
  WHEN "feature_slug" = 'sales-cold-email-outreach' THEN 'Sales Cold Email Outreach ' || INITCAP("signature_name")
  WHEN "feature_slug" = 'press-kit-page-generation' THEN 'Press Kit Page Generation ' || INITCAP("signature_name")
  ELSE INITCAP(REPLACE("feature_slug", '-', ' ')) || ' ' || INITCAP("signature_name")
END;
--> statement-breakpoint

-- 4. Fix dynasty_slug: feature_dynasty_slug + "-" + signature_name
UPDATE "workflows" SET "dynasty_slug" = CASE
  WHEN "feature_slug" = 'pr-cold-email-outreach' THEN 'pr-cold-email-outreach-' || "signature_name"
  WHEN "feature_slug" = 'sales-cold-email-outreach' THEN 'sales-cold-email-outreach-' || "signature_name"
  WHEN "feature_slug" = 'press-kit-page-generation' THEN 'press-kit-page-generation-' || "signature_name"
  ELSE REPLACE("feature_slug", '-v\d+$', '') || '-' || "signature_name"
END;
--> statement-breakpoint

-- 5. Fix name: dynasty_name [+ " v{N}" if N >= 2]
UPDATE "workflows" SET "name" = CASE
  WHEN "version" = 1 THEN "dynasty_name"
  ELSE "dynasty_name" || ' v' || "version"
END;
