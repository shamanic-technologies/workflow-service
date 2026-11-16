-- CAMPAIGN-SCRIPTS-1113-NAMES: every script dynasty carries a short name a client reads on their campaign page, the
-- same on every version of the dynasty and unique within its outcome (checked in src/lib/scripts/script-names.ts).
-- Rows stored before it are named by the sweep a minute after boot.
ALTER TABLE "scripts" ADD COLUMN IF NOT EXISTS "name" text;
