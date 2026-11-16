-- PROVEN-BEFORE-PEOPLE-1116: whether the production run of a case WROTE to a person (a sending door after its LLM).
-- Kept apart when pruning and tried first by a proof: only a written case exercises a writer. Rows before this column
-- are read from their calls once.
ALTER TABLE "writer_cases" ADD COLUMN IF NOT EXISTS "wrote" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "writer_cases" SET "wrote" = true WHERE "body"::text ~ '"name": ?"(instantly\.reply\.send|instantly\.reply\.escalate|email\.send|crm\.whatsapp\.send)"';
