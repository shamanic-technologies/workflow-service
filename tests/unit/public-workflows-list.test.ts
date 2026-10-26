import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { listPublicWorkflowRows, PUBLIC_WORKFLOW_COLUMNS } from "../../src/lib/public-workflows-list.js";

// BOX-OVERLOAD-1026-WORKFLOW: GET /public/workflows read every column, the DAG included, on the
// most frequent query of the box. Real Postgres (PGlite) with the service's own migrations, so the
// SQL is executed and the served columns are what Postgres returns, not a mock's echo.
const MIGRATIONS = join(__dirname, "../../drizzle");

let client: PGlite;
let db: ReturnType<typeof drizzle>;

async function insert(o: { slug: string; feature: string; status: string; dynastyStatus: string; from?: string; type?: string }) {
  const res = await client.query<{ id: string }>(
    `INSERT INTO workflows (org_id, workflow_slug, workflow_name, workflow_dynasty_slug, workflow_dynasty_name,
       feature_slug, signature, workflow_dynasty_signature_name, dag, description, status, workflow_dynasty_status,
       creation_type, created_from_workflow)
     VALUES ('org', $1, $1, $1, $1, $2, $1, $1, $3::jsonb, 'a long description', $4, $5, $6, $7) RETURNING id`,
    [o.slug, o.feature, JSON.stringify({ nodes: [{ id: "n", type: "script", config: { code: "x".repeat(10_000) } }], edges: [] }),
      o.status, o.dynastyStatus, o.type ?? "scratch", o.from ?? null],
  );
  return res.rows[0].id;
}

let v1: string;
let v2: string;

beforeAll(async () => {
  client = new PGlite();
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }
  db = drizzle(client);
  v1 = await insert({ slug: "f-a", feature: "f", status: "deprecated", dynastyStatus: "active" });
  v2 = await insert({ slug: "f-a-v2", feature: "f", status: "active", dynastyStatus: "active", from: v1, type: "upgrade" });
  await insert({ slug: "f-b", feature: "f", status: "active", dynastyStatus: "deprecated" });
  await insert({ slug: "g-a", feature: "g", status: "active", dynastyStatus: "active" });
});

describe("listPublicWorkflowRows", () => {
  it("never reads the DAG nor the description", async () => {
    const rows = await listPublicWorkflowRows(db, ["f"], { kind: "all" });
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).not.toHaveProperty("dag");
      expect(r).not.toHaveProperty("description");
      expect(Object.keys(r).sort()).toEqual(Object.keys(PUBLIC_WORKFLOW_COLUMNS).sort());
    }
    expect(Object.keys(PUBLIC_WORKFLOW_COLUMNS)).not.toContain("dag");
  });

  it("serves the lineage fields the upgradedTo map is built from", async () => {
    const rows = await listPublicWorkflowRows(db, ["f"], { kind: "all" });
    const head = rows.find((r) => r.id === v2)!;
    expect(head.creationType).toBe("upgrade");
    expect(head.createdFromWorkflow).toBe(v1);
  });

  it("keeps the status partition: executable = both axes active, retired = its complement", async () => {
    const executable = await listPublicWorkflowRows(db, ["f", "g"], { kind: "executable" });
    expect(executable.map((r) => r.workflowSlug).sort()).toEqual(["f-a-v2", "g-a"]);
    const retired = await listPublicWorkflowRows(db, ["f", "g"], { kind: "retired" });
    expect(retired.map((r) => r.workflowSlug).sort()).toEqual(["f-a", "f-b"]);
    const all = await listPublicWorkflowRows(db, ["f", "g"], { kind: "all" });
    expect(all).toHaveLength(executable.length + retired.length);
  });
});
