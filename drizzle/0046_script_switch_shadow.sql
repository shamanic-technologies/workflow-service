-- FACTORY-P3 next outcomes (message_sent): a SERVICE switch can be in SHADOW first: the caller keeps sending its own
-- answer and asks the stored script the same question beside it, comparing both (the live proof before a switch).
ALTER TABLE "script_switches" DROP CONSTRAINT IF EXISTS "script_switches_state_check";
--> statement-breakpoint
ALTER TABLE "script_switches" ADD CONSTRAINT "script_switches_state_check" CHECK ("state" IN ('switched', 'rolled_back', 'shadow'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_script_switches_service_shadow" ON "script_switches" ("outcome", "caller_service") WHERE "caller_service" IS NOT NULL AND "state" = 'shadow';
