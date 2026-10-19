import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { workflows } from "../../src/db/schema.js";
import { stopExecutable, STILL_EXECUTABLE, executableUntilAtBirth } from "../../src/lib/executable-until.js";

// WF-VERSION-DATES-1019: real Postgres (PGlite) so the backfill SQL and the COALESCE
// writes are executed, not string-matched.
const MIGRATIONS = join(__dirname, "../../drizzle");
const BACKFILL = "0038_workflow_executable_until.sql";

async function apply(client: PGlite, f: string) {
  for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) {
    if (stmt.trim()) await client.exec(stmt);
  }
}

async function migrated(upTo: "before-backfill" | "all") {
  const client = new PGlite();
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (upTo === "before-backfill" && f >= BACKFILL) break;
    await apply(client, f);
  }
  return client;
}

async function insert(
  client: PGlite,
  o: {
    slug: string;
    dynasty: string;
    version: number;
    status: "active" | "deprecated";
    dynastyStatus?: "active" | "deprecated";
    createdAt: string;
    updatedAt: string;
    upgradeOf?: string;
  },
) {
  const res = await client.query<{ id: string }>(
    `INSERT INTO workflows (org_id, workflow_slug, workflow_name, workflow_dynasty_slug, workflow_dynasty_name,
       feature_slug, signature, workflow_dynasty_signature_name, dag, version, status, workflow_dynasty_status,
       creation_type, created_from_workflow, created_at, updated_at)
     VALUES ('org', $1, $1, $2, $2, 'sales-cold-email-outreach', $1, $2, '{}'::jsonb, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      o.slug, o.dynasty, o.version, o.status, o.dynastyStatus ?? "active",
      o.upgradeOf ? "upgrade" : "scratch", o.upgradeOf ?? null, o.createdAt, o.updatedAt,
    ],
  );
  return res.rows[0].id;
}

async function stop(client: PGlite, slug: string) {
  const r = await client.query<{ executable_until: Date | null; executable_until_source: string | null }>(
    `SELECT executable_until, executable_until_source FROM workflows WHERE workflow_slug = $1`,
    [slug],
  );
  const row = r.rows[0];
  return { at: row.executable_until ? new Date(row.executable_until).toISOString() : null, source: row.executable_until_source };
}

describe("0038 backfill of executable_until", () => {
  it("dates prod-shaped rows: successor creation when replaced, updated_at for a dynasty's last version, nothing while executable", async () => {
    const client = await migrated("before-backfill");
    // arcadia v1 was deprecated by the v2 upgrade on 08-26 and later touched by a bulk edit on 09-24.
    const a1 = await insert(client, { slug: "arcadia", dynasty: "arcadia", version: 1, status: "deprecated", createdAt: "2026-05-21T06:43:14Z", updatedAt: "2026-09-24T10:46:20.978Z" });
    await insert(client, { slug: "arcadia-v2", dynasty: "arcadia", version: 2, status: "deprecated", createdAt: "2026-08-26T06:45:13.619Z", updatedAt: "2026-09-24T10:46:19.905Z", upgradeOf: a1 });
    const b5 = await insert(client, { slug: "ballad-v5", dynasty: "ballad", version: 5, status: "deprecated", createdAt: "2026-09-28T19:20:07Z", updatedAt: "2026-09-29T04:40:05.837Z" });
    await insert(client, { slug: "ballad-v6", dynasty: "ballad", version: 6, status: "deprecated", createdAt: "2026-09-29T04:40:05.836Z", updatedAt: "2026-10-06T16:26:48.131Z", upgradeOf: b5 });
    await insert(client, { slug: "azalea-v8", dynasty: "azalea", version: 8, status: "active", createdAt: "2026-10-17T15:31:22Z", updatedAt: "2026-10-17T15:31:22Z" });
    await insert(client, { slug: "retired-head", dynasty: "retired", version: 1, status: "active", dynastyStatus: "deprecated", createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" });

    await apply(client, BACKFILL);

    expect(await stop(client, "arcadia")).toEqual({ at: "2026-08-26T06:45:13.619Z", source: "successor_created" });
    expect(await stop(client, "arcadia-v2")).toEqual({ at: "2026-09-24T10:46:19.905Z", source: "last_update" });
    expect(await stop(client, "ballad-v5")).toEqual({ at: "2026-09-29T04:40:05.836Z", source: "successor_created" });
    expect(await stop(client, "ballad-v6")).toEqual({ at: "2026-10-06T16:26:48.131Z", source: "last_update" });
    expect(await stop(client, "azalea-v8")).toEqual({ at: null, source: null });
    expect(await stop(client, "retired-head")).toEqual({ at: "2026-07-01T00:00:00.000Z", source: "last_update" });

    // Re-running the migration moves nothing.
    await client.exec(`UPDATE workflows SET updated_at = '2026-10-19T00:00:00Z'`);
    await apply(client, BACKFILL);
    expect(await stop(client, "ballad-v6")).toEqual({ at: "2026-10-06T16:26:48.131Z", source: "last_update" });
  });
});

describe("executable_until writes", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  beforeEach(async () => {
    client = await migrated("all");
    db = drizzle(client);
  });

  it("records the first stop, keeps it on a later one, clears it on re-activation", async () => {
    const id = await insert(client, { slug: "w", dynasty: "w", version: 1, status: "active", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
    expect(await stop(client, "w")).toEqual({ at: null, source: null });

    await db.update(workflows).set({ status: "deprecated", ...stopExecutable() }).where(eq(workflows.id, id));
    const first = await stop(client, "w");
    expect(first.source).toBe("recorded");
    expect(first.at).not.toBeNull();

    await client.exec(`UPDATE workflows SET executable_until = '2026-10-02T00:00:00Z'`);
    await db.update(workflows).set({ workflowDynastyStatus: "deprecated", ...stopExecutable() }).where(eq(workflows.id, id));
    expect(await stop(client, "w")).toEqual({ at: "2026-10-02T00:00:00.000Z", source: "recorded" });

    await db.update(workflows).set({ status: "active", workflowDynastyStatus: "active", ...STILL_EXECUTABLE }).where(eq(workflows.id, id));
    expect(await stop(client, "w")).toEqual({ at: null, source: null });
  });

  it("a version born under a retired dynasty is non-executable from birth", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    expect(executableUntilAtBirth(false, now)).toEqual({ executableUntil: now, executableUntilSource: "recorded" });
    expect(executableUntilAtBirth(true, now)).toEqual({ executableUntil: null, executableUntilSource: null });
  });
});
