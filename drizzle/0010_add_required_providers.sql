ALTER TABLE "workflows" ADD COLUMN "required_providers" text[] NOT NULL DEFAULT '{}'::text[];
