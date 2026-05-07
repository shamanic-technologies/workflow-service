-- Backfill creation_type + created_from_workflow from legacy upgraded_to + forked_from
-- pointers. Safe to re-run: only updates rows where creation_type is still the default 'scratch'.

-- 1. Forks: forked_from points to source workflow.
UPDATE "workflows" w
SET "creation_type" = 'fork',
    "created_from_workflow" = w."forked_from"
WHERE w."forked_from" IS NOT NULL
  AND w."creation_type" = 'scratch';
--> statement-breakpoint

-- 2. Upgrades: a predecessor s has s.upgraded_to = w.id.
--    Pick any one such predecessor (NOT NULL guard via the join).
UPDATE "workflows" w
SET "creation_type" = 'upgrade',
    "created_from_workflow" = s."id"
FROM "workflows" s
WHERE s."upgraded_to" = w."id"
  AND s."id" <> w."id"
  AND w."creation_type" = 'scratch'
  AND w."created_from_workflow" IS NULL;
