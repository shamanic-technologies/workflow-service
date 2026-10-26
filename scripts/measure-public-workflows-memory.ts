/**
 * BOX-OVERLOAD-1026-WORKFLOW: measures what one feature's GET /public/workflows read costs the
 * process, before (every column, DAG included) and after (PUBLIC_WORKFLOW_COLUMNS).
 * In-process Postgres (PGlite) with the service's migrations, seeded at the production size of
 * sales-cold-email-outreach on 2026-10-26 (908 versions, ~5.7 MB of DAG text).
 *
 *   node --expose-gc --import tsx scripts/measure-public-workflows-memory.ts before|after
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { inArray } from "drizzle-orm";
import { workflows } from "../src/db/schema.js";
import { listPublicWorkflowRows } from "../src/lib/public-workflows-list.js";

const ROWS = 908;
const DAG_BYTES = 6_500;
const CALLS = 200;
const CONCURRENCY = 4;

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

async function main() {
  const client = new PGlite();
  const dir = join(import.meta.dirname, "../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }
  const db = drizzle(client);
  const node = (i: number) => ({ id: `n${i}`, type: "http.call", config: { service: "x", path: "/y", body: { text: "z".repeat(200) } } });
  const nodesPerDag = Math.floor(DAG_BYTES / JSON.stringify(node(0)).length);
  const dag = JSON.stringify({ nodes: Array.from({ length: nodesPerDag }, (_, i) => node(i)), edges: [] });
  for (let i = 0; i < ROWS; i++) {
    await client.query(
      `INSERT INTO workflows (org_id, workflow_slug, workflow_name, workflow_dynasty_slug, workflow_dynasty_name,
         feature_slug, signature, workflow_dynasty_signature_name, dag, description)
       VALUES ('org', $1, $1, $1, $1, 'sales-cold-email-outreach', $1, $1, $2::jsonb, 'desc')`,
      [`wf-${i}`, dag],
    );
  }
  console.log(`seeded ${ROWS} rows, ${mb(ROWS * dag.length)} of DAG text`);

  const variants: Record<string, () => Promise<unknown[]>> = {
    before: () => db.select().from(workflows).where(inArray(workflows.featureSlug, ["sales-cold-email-outreach"])),
    after: () => listPublicWorkflowRows(db, ["sales-cold-email-outreach"], { kind: "all" }),
  };

  // One variant per process: RSS never shrinks, so a second variant would start on the first's peak.
  const name = process.argv[2] === "before" ? "before" : "after";
  const read = variants[name];
  {
    global.gc!();
    const base = process.memoryUsage();
    let peakHeap = base.heapUsed;
    let peakRss = base.rss;
    let bytes = 0;
    const t0 = performance.now();
    for (let done = 0; done < CALLS; done += CONCURRENCY) {
      const results = await Promise.all(Array.from({ length: CONCURRENCY }, () => read()));
      bytes += results.reduce((s, r) => s + JSON.stringify(r).length, 0);
      const m = process.memoryUsage();
      peakHeap = Math.max(peakHeap, m.heapUsed);
      peakRss = Math.max(peakRss, m.rss);
    }
    const ms = (performance.now() - t0) / CALLS;
    console.log(
      `${name}: ${mb(bytes / CALLS)} materialised per call, ${ms.toFixed(1)} ms per call, ` +
        `peak heap +${mb(peakHeap - base.heapUsed)}, peak rss +${mb(peakRss - base.rss)}`,
    );
  }
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
