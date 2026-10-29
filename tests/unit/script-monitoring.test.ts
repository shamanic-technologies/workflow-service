import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readMonitoring, refreshMonitoring, type TaskOutcome } from "../../src/lib/scripts/script-monitoring.js";
import type { AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";

// FACTORY-P3 Monitoring series on a real Postgres: daily runs = the total's delta, red when the script path errs more
// than the service path, ready to delete after 7 stored days with zero service runs.
async function freshDb() {
  const client = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

const task = (taskName: string, total: number, completed: number, failed: number, cost: number): TaskOutcome => ({
  taskName, totalRunCount: total, sampleSize: completed + failed, completedCount: completed, failedCount: failed, sumCostInUsdCents: String(cost),
});

let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
});

const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12));

describe("script monitoring series", () => {
  it("stores both paths per day, serves runs as deltas, error rates and cost per run, and flags red", async () => {
    const answers: Record<string, TaskOutcome[]> = {
      "content-generation-service": [task("single-generation", 1000, 99, 1, 200), task("other", 5, 5, 0, 1)],
      workflow: [task("script:message_written/dy_template_writer", 10, 9, 1, 30), task("execute-workflow", 9999, 10, 0, 1)],
    };
    const deps = { taskOutcomes: async (s: string) => answers[s] ?? [] };
    // Two rows (service, script) per outcome with a service path: message_written, lead_interested, email_found.
    expect(await refreshMonitoring(db, deps, day(20))).toBe(6);
    answers["content-generation-service"] = [task("single-generation", 1100, 98, 2, 196)];
    answers.workflow = [task("script:message_written/dy_template_writer", 14, 12, 2, 28)];
    await refreshMonitoring(db, deps, day(21));
    const out = await readMonitoring(db, 30, day(21));
    const mw = out.outcomes.find((o) => o.outcome === "message_written")!;
    expect(mw.servicePath).toEqual({ serviceName: "content-generation-service", taskNames: ["single-generation"] });
    expect(mw.days.map((d) => [d.day, d.service?.runs, d.script?.runs])).toEqual([["2026-10-20", null, null], ["2026-10-21", 100, 4]]);
    expect(mw.days[1]!.service).toMatchObject({ errorRate: 0.02, avgCostCents: 1.96, tasks: ["single-generation"] });
    expect(mw.days[1]!.script).toMatchObject({ errorRate: 2 / 14, avgCostCents: 2 });
    expect(mw.red).toBe(true);
    expect(mw.readyToDelete).toBe(false);
  });

  it("is ready to delete once the service path made zero runs on 7 stored days", async () => {
    const deps = { taskOutcomes: async (s: string) => (s === "workflow" ? [] : [task("single-generation", 500, 10, 0, 10)]) };
    for (let d = 1; d <= 8; d++) await refreshMonitoring(db, deps, day(d));
    const mw = (await readMonitoring(db, 30, day(8))).outcomes.find((o) => o.outcome === "message_written")!;
    expect(mw.readyToDelete).toBe(true);
    expect(mw.red).toBe(false);
  });
});
