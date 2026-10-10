-- A workflow runs on ONE features-service pipe (`<channel slug>|<leg key>`) and produces that
-- pipe's toStep (owner vocabulary 2026-10-10). Both are written by the generator. Nullable: rows
-- written before, or from a client-supplied DAG, do not state them, and nothing is backfilled by guess.
ALTER TABLE "workflows" ADD COLUMN "pipe_id" text;
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "produces_step" text;
