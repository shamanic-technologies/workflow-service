-- Drop legacy lineage pointer columns, replaced by created_from_workflow + creation_type.
-- Idempotent: IF EXISTS guards make re-runs safe.

ALTER TABLE "workflows" DROP COLUMN IF EXISTS "upgraded_to";
--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "forked_from";
