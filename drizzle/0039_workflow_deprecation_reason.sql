-- DEPRECATION-REASON-1020: every deprecation states WHY, WHO decided it and WHEN, so staff
-- reading a deprecated workflow months later know why it stopped. NULL while executable.
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "deprecation_reason" text;
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "deprecated_by" text;
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "deprecated_at" timestamp with time zone;
--> statement-breakpoint
-- The 16 catch-all copies retired on 2026-10-20 (owner decision, DOTTEREL-EMAIL-FILTER-1020):
-- every version, decided by the owner, at the instant the dynasty was retired.
UPDATE "workflows" w
SET
  "deprecation_reason" = 'Catch-all copy of ' || COALESCE(
      (SELECT t."workflow_dynasty_name" FROM "workflows" t
        WHERE t."workflow_dynasty_slug" = 'sales-cold-email-outreach-' || v.twin LIMIT 1),
      'sales-cold-email-outreach-' || v.twin)
    || ': the Cold Email pipe never chooses which emails to keep, the Lead Sourcing pipe does (owner 2026-10-20).',
  "deprecated_by" = 'kevin@distribute.you',
  "deprecated_at" = (SELECT max(x."executable_until") FROM "workflows" x
    WHERE x."workflow_dynasty_slug" = w."workflow_dynasty_slug")
FROM (VALUES
  ('pleione', 'azha'), ('taiyi', 'concerto'), ('atakoraka', 'castula'), ('acamar', 'rampart'),
  ('alcyone', 'compass'), ('aldhanab', 'lyonesse'), ('alphard', 'marfik'), ('amansinaya', 'osprey'),
  ('chamukuy', 'fuyue'), ('chertan', 'estuary'), ('denebola', 'geyser'), ('guniibuu', 'belel'),
  ('iklil', 'pelican'), ('liesma', 'ainalrami'), ('mesarthim', 'keel'), ('moldoveanu', 'raven')
) AS v(copy, twin)
WHERE w."workflow_dynasty_slug" = 'sales-cold-email-outreach-' || v.copy
  AND w."workflow_dynasty_status" = 'deprecated'
  AND w."deprecation_reason" IS NULL;
--> statement-breakpoint
-- Every other row deprecated before this ship: the reason was never recorded. No who/when invented.
UPDATE "workflows"
SET "deprecation_reason" = 'Not specified'
WHERE "deprecation_reason" IS NULL
  AND ("status" = 'deprecated' OR "workflow_dynasty_status" = 'deprecated');
