import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { workflows } from "../../src/db/schema.js";
import {
  recordDeprecation,
  CLEAR_DEPRECATION,
  NOT_SPECIFIED,
  servedDeprecation,
  deprecationAtBirth,
} from "../../src/lib/deprecation.js";

// DEPRECATION-REASON-1020: real Postgres (PGlite) so the backfill SQL and the COALESCE writes run.
const MIGRATIONS = join(__dirname, "../../drizzle");
const BACKFILL = "0039_workflow_deprecation_reason.sql";

async function apply(client: PGlite, f: string) {
  for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) {
    if (stmt.trim()) await client.exec(stmt);
  }
}

async function migrated(upTo: "before-backfill" | "all") {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (upTo === "before-backfill" && f >= BACKFILL) break;
    await apply(client, f);
  }
  return client;
}

async function insert(
  client: PGlite,
  o: { slug: string; dynasty: string; version?: number; status: string; dynastyStatus?: string; name?: string; stoppedAt?: string },
) {
  const res = await client.query<{ id: string }>(
    `INSERT INTO workflows (org_id, workflow_slug, workflow_name, workflow_dynasty_slug, workflow_dynasty_name,
       feature_slug, signature, workflow_dynasty_signature_name, dag, version, status, workflow_dynasty_status, executable_until)
     VALUES ('org', $1, $1, $2, $3, 'sales-cold-email-outreach', $1, $2, '{}'::jsonb, $4, $5, $6, $7) RETURNING id`,
    [o.slug, o.dynasty, o.name ?? o.dynasty, o.version ?? 1, o.status, o.dynastyStatus ?? "active", o.stoppedAt ?? null],
  );
  return res.rows[0].id;
}

async function deprecationOf(client: PGlite, slug: string) {
  const r = await client.query<{ deprecation_reason: string | null; deprecated_by: string | null; deprecated_at: Date | null }>(
    `SELECT deprecation_reason, deprecated_by, deprecated_at FROM workflows WHERE workflow_slug = $1`,
    [slug],
  );
  const row = r.rows[0];
  return {
    reason: row.deprecation_reason,
    by: row.deprecated_by,
    at: row.deprecated_at ? new Date(row.deprecated_at).toISOString() : null,
  };
}

describe("0039 backfill of deprecation reasons", () => {
  it("states the owner's reason on every version of the 16 catch-all copies, 'Not specified' on every other deprecated row", async () => {
    const client = await migrated("before-backfill");
    const P = "sales-cold-email-outreach-";
    await insert(client, { slug: `${P}azha-v2`, dynasty: `${P}azha`, status: "active", name: "Sales Cold Email Outreach Azha" });
    await insert(client, { slug: `${P}pleione`, dynasty: `${P}pleione`, status: "deprecated", dynastyStatus: "deprecated", stoppedAt: "2026-10-15T10:00:00Z" });
    await insert(client, { slug: `${P}pleione-v2`, dynasty: `${P}pleione`, version: 2, status: "deprecated", dynastyStatus: "deprecated", stoppedAt: "2026-10-20T17:14:41.1114Z" });
    // Twin row absent from the table: the reason names its slug.
    await insert(client, { slug: `${P}moldoveanu`, dynasty: `${P}moldoveanu`, status: "deprecated", dynastyStatus: "deprecated", stoppedAt: "2026-10-20T17:14:42Z" });
    await insert(client, { slug: "old-v1", dynasty: "old", status: "deprecated", stoppedAt: "2026-08-01T00:00:00Z" });
    await insert(client, { slug: "retired-head", dynasty: "retired", status: "active", dynastyStatus: "deprecated" });
    await insert(client, { slug: "live", dynasty: "live", status: "active" });

    await apply(client, BACKFILL);

    const tail = ": the Cold Email pipe never chooses which emails to keep, the Lead Sourcing pipe does (owner 2026-10-20).";
    for (const slug of [`${P}pleione`, `${P}pleione-v2`]) {
      expect(await deprecationOf(client, slug)).toEqual({
        reason: `Catch-all copy of Sales Cold Email Outreach Azha${tail}`,
        by: "kevin@distribute.you",
        at: "2026-10-20T17:14:41.111Z",
      });
    }
    expect((await deprecationOf(client, `${P}moldoveanu`)).reason).toBe(`Catch-all copy of ${P}raven${tail}`);
    expect(await deprecationOf(client, "old-v1")).toEqual({ reason: NOT_SPECIFIED, by: null, at: null });
    expect(await deprecationOf(client, "retired-head")).toEqual({ reason: NOT_SPECIFIED, by: null, at: null });
    expect(await deprecationOf(client, "live")).toEqual({ reason: null, by: null, at: null });
    expect(await deprecationOf(client, `${P}azha-v2`)).toEqual({ reason: null, by: null, at: null });

    // Re-running moves nothing.
    await apply(client, BACKFILL);
    expect((await deprecationOf(client, `${P}pleione-v2`)).by).toBe("kevin@distribute.you");
  });
});

describe("deprecation writes", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  beforeEach(async () => {
    client = await migrated("all");
    db = drizzle(client);
  });

  it("records reason, who and when; a later deprecation without a reason keeps it; re-activation clears it", async () => {
    const id = await insert(client, { slug: "w", dynasty: "w", status: "active" });

    await db
      .update(workflows)
      .set({ status: "deprecated", ...recordDeprecation({ reason: "Replaced by Vega", decidedBy: "staff@distribute.you" }) })
      .where(eq(workflows.id, id));
    const first = await deprecationOf(client, "w");
    expect(first.reason).toBe("Replaced by Vega");
    expect(first.by).toBe("staff@distribute.you");
    expect(first.at).not.toBeNull();

    await db
      .update(workflows)
      .set({ workflowDynastyStatus: "deprecated", ...recordDeprecation({ reason: undefined, decidedBy: "someone-else" }) })
      .where(eq(workflows.id, id));
    expect(await deprecationOf(client, "w")).toEqual(first);

    await db.update(workflows).set({ status: "active", workflowDynastyStatus: "active", ...CLEAR_DEPRECATION }).where(eq(workflows.id, id));
    expect(await deprecationOf(client, "w")).toEqual({ reason: null, by: null, at: null });
  });

  it("a deprecation without a reason on a row with none records 'Not specified' with the real who and when", async () => {
    const id = await insert(client, { slug: "w", dynasty: "w", status: "active" });
    await db
      .update(workflows)
      .set({ status: "deprecated", ...recordDeprecation({ reason: undefined, decidedBy: "user:abc" }) })
      .where(eq(workflows.id, id));
    const d = await deprecationOf(client, "w");
    expect(d.reason).toBe(NOT_SPECIFIED);
    expect(d.by).toBe("user:abc");
    expect(d.at).not.toBeNull();
  });
});

describe("servedDeprecation", () => {
  const base = { deprecationReason: null, deprecatedBy: null, deprecatedAt: null };
  it("is null while the row is executable", () => {
    expect(servedDeprecation({ ...base, status: "active", workflowDynastyStatus: "active" })).toBeNull();
  });
  it("serves the decision on either axis", () => {
    const at = new Date("2026-10-20T17:14:41Z");
    expect(
      servedDeprecation({ status: "active", workflowDynastyStatus: "deprecated", deprecationReason: "Why", deprecatedBy: "k@d.you", deprecatedAt: at }),
    ).toEqual({ reason: "Why", decidedBy: "k@d.you", decidedAt: "2026-10-20T17:14:41.000Z" });
  });
  it("reads 'Not specified' for a deprecated row with no recorded reason", () => {
    expect(servedDeprecation({ ...base, status: "deprecated", workflowDynastyStatus: "active" })).toEqual({
      reason: NOT_SPECIFIED,
      decidedBy: null,
      decidedAt: null,
    });
  });
  it("a version born under a retired dynasty inherits its decision", () => {
    const at = new Date("2026-10-20T00:00:00Z");
    expect(deprecationAtBirth(false, { deprecationReason: "Why", deprecatedBy: "k", deprecatedAt: at })).toEqual({
      deprecationReason: "Why",
      deprecatedBy: "k",
      deprecatedAt: at,
    });
    expect(deprecationAtBirth(true, { deprecationReason: "Why", deprecatedBy: "k", deprecatedAt: at })).toEqual(CLEAR_DEPRECATION);
  });
});
