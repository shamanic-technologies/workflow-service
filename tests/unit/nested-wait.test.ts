import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { ScriptRunFailed, runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { setScriptPickReader, setScriptStrategyReader } from "../../src/lib/scripts/engine.js";
import { setProofContext } from "../../src/lib/scripts/writer-proof.js";
import { scriptRuns, scripts } from "../../src/db/schema.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { testNamer } from "../helpers/script-names.js";

// HUMAN-VALIDATED-1124: a script any Engine asks may wait (a person's answer is pending): the Engine run's wait hook is
// handed down ask by ask, the ONE wait is recorded once, and every run of the chain ends `waiting`. Fictional data only.
const MIGRATIONS = join(__dirname, "../../drizzle");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true, nameDynasties: testNamer() };
const who = { orgId: "org-1", userId: "user-1", parentRunId: "run-parent", headers: { "x-brand-id": "brand-1", "x-campaign-id": "camp-1" } };
const noVendors = {} as unknown as VendorDeps;

function ledger() {
  const runs: Array<{ id: string; taskName: string; parentRunId: string }> = [];
  const closed: Array<{ runId: string; status: string }> = [];
  const l: LedgerDeps = {
    async createRun(opts) {
      runs.push({ id: `run-${runs.length + 1}`, taskName: opts.taskName, parentRunId: opts.parentRunId });
      return `run-${runs.length}`;
    },
    async declareOutcomes() {
      return {};
    },
    async closeRun(runId, status) {
      closed.push({ runId, status });
    },
  };
  return { l, runs, closed };
}

function hook() {
  const waits: number[] = [];
  return { waits, owned: { runId: "run-engine", onWait: async (days: number) => void waits.push(days) } };
}

let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
  setScriptPickReader(fakeScriptPick());
  setScriptStrategyReader(async (_c, outcome) => (await db.select().from(scripts).where(eq(scripts.outcome, outcome))).map((r) => r.dynasty));
  setProofContext(null);
}, 60_000);
afterEach(() => {
  setScriptPickReader(null);
  setScriptStrategyReader(null);
});

const add = (outcome: string, dynasty: string, code: string) => createScript(db, { outcome, dynasty, code, description: "x" }, author, known);

const asksDirect = (asked: string, made: string) => `export default function run(ctx) {
  const u = ctx.ask("${asked}", {});
  return { content: { made: "${made}", from: u.content }, subject: { service: "runs-service", id: "${made}-1" } };
}`;
const readsUnheld = (material: string, made: string) => `export default function run(ctx) {
  const u = ctx.get("${material}");
  return { content: { made: "${made}", from: u.content }, subject: { service: "runs-service", id: "${made}-1" } };
}`;
const waits = (days: number) => `export default function run(ctx) {
  ctx.wait(${days});
  return { content: { never: true }, subject: { service: "runs-service", id: "x" } };
}`;

describe("an asked script may wait when the run that asked it can", () => {
  it("an owned asker whose child waits ends waiting: one wait recorded, the child's run closed completed", async () => {
    await add("reel_published", "dy_publish", asksDirect("hook_added", "reel"));
    await add("hook_added", "dy_hook_validated", waits(0.01));
    const { l, runs, closed } = ledger();
    const h = hook();
    const result = await runStoredScript(db, { outcome: "reel_published", dynasty: "dy_publish", units: {} }, who, { ledger: l, vendors: noVendors }, h.owned);
    expect(result.status).toBe("waiting");
    expect(result.waitDays).toBe(0.01);
    expect(result.unit).toBeNull();
    expect(h.waits).toEqual([0.01]);
    // The child opened its own run (the asker's is the owned one) and closed it completed, never failed.
    expect(runs.map((r) => [r.taskName, r.parentRunId])).toEqual([["script:hook_added/dy_hook_validated", "run-engine"]]);
    expect(closed).toEqual([{ runId: "run-1", status: "completed" }]);
    const rows = await db.select({ runId: scriptRuns.runId, status: scriptRuns.status }).from(scriptRuns);
    expect(rows.sort((a, b) => a.runId.localeCompare(b.runId))).toEqual([
      { runId: "run-1", status: "waiting" },
      { runId: "run-engine", status: "waiting" },
    ]);
  });

  it("a grandchild's wait goes up two levels, recorded once", async () => {
    await add("reel_published", "dy_publish", asksDirect("hook_added", "reel"));
    await add("hook_added", "dy_hook", `export default function run(ctx) {
  ctx.ask({ units: {} });
  const u = ctx.get("clip_cut");
  return { content: { made: "hook", from: u.content }, subject: { service: "runs-service", id: "hook-1" } };
}`);
    await db.update(scripts).set({ tactics: { asks: ["clip_cut"] } }).where(eq(scripts.dynasty, "dy_hook"));
    await add("clip_cut", "dy_clip_validated", waits(0.5));
    const { l, closed } = ledger();
    const h = hook();
    const result = await runStoredScript(db, { outcome: "reel_published", dynasty: "dy_publish", units: {} }, who, { ledger: l, vendors: noVendors }, h.owned);
    expect(result.status).toBe("waiting");
    expect(result.waitDays).toBe(0.5);
    expect(h.waits).toEqual([0.5]);
    expect(closed.map((c) => c.status)).toEqual(["completed", "completed"]);
  });

  it("with no hook above (a step, a direct make) the child's wait is refused as before and the asker stops", async () => {
    await add("reel_published", "dy_publish", asksDirect("hook_added", "reel"));
    await add("hook_added", "dy_hook_validated", waits(0.01));
    const { l } = ledger();
    const run = runStoredScript(db, { outcome: "reel_published", dynasty: "dy_publish", units: {} }, who, { ledger: l, vendors: noVendors });
    await expect(run).rejects.toBeInstanceOf(ScriptRunFailed);
    const failed = (await run.catch((e) => e)) as ScriptRunFailed;
    expect(failed.result.status).toBe("stopped");
    expect(failed.result.error).toContain("does not wait");
  });

  it("a Unit read without holding it, whose Engine's script waits: the reader waits", async () => {
    await add("reel_published", "dy_publish", readsUnheld("hook_added", "reel"));
    await add("hook_added", "dy_hook_validated", waits(0.01));
    const { l } = ledger();
    const h = hook();
    const result = await runStoredScript(db, { outcome: "reel_published", dynasty: "dy_publish", units: {} }, who, { ledger: l, vendors: noVendors }, h.owned);
    expect(result.status).toBe("waiting");
    expect(h.waits).toEqual([0.01]);
  });
});
