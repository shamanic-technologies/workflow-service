-- SOLO-PLAN-1125: a wait on LLM answers still to come (a founder's own Claude answers hourly) keeps the jobs holding them.
ALTER TABLE "engine_waits" ADD COLUMN IF NOT EXISTS "pending_answers" jsonb;
