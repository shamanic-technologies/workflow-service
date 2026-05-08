-- Add creation_type + created_from_workflow columns to workflows.
-- Replaces the upgraded_to + forked_from pointer model with a forward
-- pointer (created_from_workflow) tagged by creation_type.
-- Idempotent: re-running the migration is safe.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflows' AND column_name='created_from_workflow') THEN
    ALTER TABLE "workflows" ADD COLUMN "created_from_workflow" uuid;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflows' AND column_name='creation_type') THEN
    ALTER TABLE "workflows" ADD COLUMN "creation_type" text NOT NULL DEFAULT 'scratch';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name='workflows' AND constraint_name='workflows_creation_type_check'
  ) THEN
    ALTER TABLE "workflows"
      ADD CONSTRAINT "workflows_creation_type_check"
      CHECK ("creation_type" IN ('scratch','upgrade','fork'));
  END IF;
END $$;
