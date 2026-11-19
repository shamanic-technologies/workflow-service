-- DISTRY-ENGINES-1119: why an Engine holds no script that can make its outcome on demand, in plain words, stated by
-- staff as data (no branch on an outcome in code). Shown on the Engine list while the Engine is not callable.
CREATE TABLE IF NOT EXISTS "engine_reasons" (
  "outcome" text PRIMARY KEY NOT NULL,
  "reason" text NOT NULL,
  "stated_by" text NOT NULL,
  "stated_at" timestamp with time zone DEFAULT now() NOT NULL
);
