-- WF-VERSION-DATES-1019: the instant each version stopped being executable (version
-- deprecated OR dynasty retired), so a fleet reader can rebuild "what could run at the
-- end of day D" without guessing from cost rows. NULL while the version is executable.
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "executable_until" timestamp with time zone;
--> statement-breakpoint
-- How reliable executable_until is: 'recorded' (written at the transition by this
-- service), 'successor_created' (backfill: creation of the upgrade that replaced it,
-- the instant the upgrade deprecated it), 'last_update' (backfill: updated_at, which a
-- later edit of a deprecated row could have moved LATER than the real stop).
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "executable_until_source" text;
--> statement-breakpoint
UPDATE "workflows" w
SET
  "executable_until" = COALESCE(
    (SELECT min(s."created_at") FROM "workflows" s
      WHERE s."created_from_workflow" = w."id" AND s."creation_type" = 'upgrade'),
    w."updated_at"
  ),
  "executable_until_source" = CASE
    WHEN EXISTS (SELECT 1 FROM "workflows" s
      WHERE s."created_from_workflow" = w."id" AND s."creation_type" = 'upgrade')
    THEN 'successor_created' ELSE 'last_update' END
WHERE w."executable_until" IS NULL
  AND (w."status" = 'deprecated' OR w."workflow_dynasty_status" = 'deprecated');
