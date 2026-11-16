-- ONE-WRITER-N-MODELS-1116-ANSWERER: a writer that asks its model is proven per (writer version, LLM completion
-- script); null = a version proven alone (its own LLM).
ALTER TABLE "writer_proofs" ADD COLUMN IF NOT EXISTS "completion_script_id" uuid;
--> statement-breakpoint
ALTER TABLE "writer_proofs" ADD COLUMN IF NOT EXISTS "completion_dynasty" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_writer_proofs_pair" ON "writer_proofs" ("script_id", "completion_script_id", "created_at");
