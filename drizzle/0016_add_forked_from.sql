-- Track fork lineage: forked workflow points back to the original it was forked from
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "forked_from" uuid;
