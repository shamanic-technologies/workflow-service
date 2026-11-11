import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readMonitoring, refreshMonitoring, type TaskOutcome } from "../../src/lib/scripts/script-monitoring.js";
import { createScript, putCases, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { switchService } from "../../src/lib/scripts/script-service-switch.js";
import { noAnswer } from "../../src/lib/scripts/script-guard.js";
import { scriptRuns } from "../../src/db/schema.js";

// FACTORY-P3 Monitoring series on a real Postgres: daily runs = the total's delta, ready to delete after 7 stored days
// with zero service runs. Red = the roll-back guard's rule on this service's own script runs (MON-SCRIPTS-RED-1111),
// never the raw daily series.
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
  it("stores both paths per day, serves runs as deltas, error rates and cost per run; the series alone is never red", async () => {
    const answers: Record<string, TaskOutcome[]> = {
      "content-generation-service": [task("single-generation", 1000, 99, 1, 200), task("other", 5, 5, 0, 1)],
      workflow: [task("script:message_written/dy_template_writer", 10, 9, 1, 30), task("execute-workflow", 9999, 10, 0, 1)],
    };
    const deps = { taskOutcomes: async (s: string) => answers[s] ?? [] };
    // Two rows (service, script) per outcome with a service path: message_written, lead_interested, email_found, lead_identified, lead_found, audience_built, message_sent, message_queued, reply_received.
    expect(await refreshMonitoring(db, deps, day(20))).toBe(18);
    answers["content-generation-service"] = [task("single-generation", 1100, 98, 2, 196)];
    answers.workflow = [task("script:message_written/dy_template_writer", 14, 12, 2, 28)];
    await refreshMonitoring(db, deps, day(21));
    const out = await readMonitoring(db, 30, day(21));
    const mw = out.outcomes.find((o) => o.outcome === "message_written")!;
    expect(mw.servicePath).toEqual({ serviceName: "content-generation-service", taskNames: ["single-generation"] });
    expect(mw.days.map((d) => [d.day, d.service?.runs, d.script?.runs])).toEqual([["2026-10-20", null, null], ["2026-10-21", 100, 4]]);
    expect(mw.days[1]!.service).toMatchObject({ errorRate: 0.02, avgCostCents: 1.96, tasks: ["single-generation"] });
    expect(mw.days[1]!.script).toMatchObject({ errorRate: 2 / 14, avgCostCents: 2 });
    // MON-SCRIPTS-RED-1111: the runs-service sample errs more than the service path, but no script run of ours failed.
    expect(mw.red).toBe(false);
    expect(mw.readyToDelete).toBe(false);
  });

  it("is ready to delete once the service path made zero runs on 7 stored days", async () => {
    const deps = { taskOutcomes: async (s: string) => (s === "workflow" ? [] : [task("single-generation", 500, 10, 0, 10)]) };
    for (let d = 1; d <= 8; d++) await refreshMonitoring(db, deps, day(d));
    const mw = (await readMonitoring(db, 30, day(8))).outcomes.find((o) => o.outcome === "message_written")!;
    expect(mw.readyToDelete).toBe(true);
    expect(mw.red).toBe(false);
  });

  describe("red = the guard's rule on our own script runs (MON-SCRIPTS-RED-1111)", () => {
    const CODE = `export default function run(ctx) { return { content: { ok: true } }; }`;
    async function switched() {
      await putCases(db, "lead_interested", "dy_judge", [{ id: "c1", units: {}, calls: [], expect: { content: { ok: true } } }], "test");
      const s = await createScript(db, { outcome: "lead_interested", dynasty: "dy_judge", code: CODE, description: "x" }, { orgId: "o", createdBy: "t" }, { isKnownOutcome: async () => true });
      await switchService(db, { outcome: "lead_interested", dynasty: "dy_judge", callerService: "instantly" });
      return s;
    }
    const runs = (scriptId: string, n: number, at: Date, error: string | null, status = error ? "failed" : "made") =>
      Array.from({ length: n }, (_, i) => ({ scriptId, orgId: "o", runId: `${at.getTime()}-${status}-${i}-${error ?? ""}`, parentRunId: "p", status, error, createdAt: at }));
    const red = async (now: Date) => (await readMonitoring(db, 30, now)).outcomes.find((o) => o.outcome === "lead_interested")!;

    it("a failure with no answer (a 5xx, our client's timeout) or a billing refusal is never red", async () => {
      const s = await switched();
      const now = new Date();
      expect(noAnswer("lead.serve: Internal server error")).toBe(true);
      expect(noAnswer("bounceverify: runs-service POST /v1/runs timed out after 30000ms")).toBe(true);
      expect(noAnswer("llm.complete failed: POST /complete gave no answer within 300 s")).toBe(true);
      expect(noAnswer('POST email-gateway/orgs/send failed (409): {"code":"email_not_verified"}')).toBe(false);
      await db.insert(scriptRuns).values([
        ...runs(s.id, 60, now, null),
        ...runs(s.id, 5, now, "lead.serve: Internal server error"),
        ...runs(s.id, 5, now, "bounceverify: runs-service POST /v1/runs timed out after 30000ms"),
        ...runs(s.id, 5, now, "llm.complete failed: chat-service POST /complete -> 402: Insufficient credits"),
      ]);
      const o = await red(now);
      expect(o.guard.lastDay).toMatchObject({ runs: 75, failed: 0, shared: 10 });
      expect(o.red).toBe(false);
    });

    it("a script error rate above the rule over the last 24 hours is red, though the last hour is quiet", async () => {
      const s = await switched();
      const now = new Date();
      const earlier = new Date(now.getTime() - 5 * 3_600_000);
      await db.insert(scriptRuns).values([...runs(s.id, 90, earlier, null), ...runs(s.id, 10, earlier, "TypeError: x is undefined")]);
      const o = await red(now);
      expect(o.guard.lastHour).toMatchObject({ runs: 0 });
      expect(o.guard.lastDay).toMatchObject({ runs: 100, failed: 10 });
      expect(o.red).toBe(true);
    });

    it("one script error in 400 runs is not red", async () => {
      const s = await switched();
      const now = new Date();
      await db.insert(scriptRuns).values([...runs(s.id, 399, now, null), ...runs(s.id, 1, now, "TypeError: x is undefined")]);
      expect((await red(now)).red).toBe(false);
    });
  });
});
