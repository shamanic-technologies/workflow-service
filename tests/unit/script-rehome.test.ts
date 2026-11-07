import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { ScriptCatalogueError, activeVersion, caseCount, createScript, putCases, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { rehomeScript } from "../../src/lib/scripts/script-rehome.js";
import { engineState, pickScript, servesChannel, setScriptStrategyReader, switchEngine, switchEngineOff } from "../../src/lib/scripts/engine.js";
import { engineWaits, scriptRuns, scriptStorage, scriptSwitches } from "../../src/db/schema.js";
import type { ReplayCase } from "../../src/lib/scripts/replay.js";

// MIGRATE-1105 S5 (owner 2026-11-06: the outcome is the WHAT, as fine as possible): a live script under a family
// outcome with its channel as a tactic moves onto its fine outcome by UPGRADE, proven, nothing switched or un-switched.
const MIGRATIONS = join(__dirname, "../../drizzle");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

const POSTER = `
import type { ScriptContext, ScriptResult } from "@gtm-factory/core";
export default function run(ctx: ScriptContext): ScriptResult {
  const r = ctx.vendor.call("threads.post", { text: "hello" });
  if (!r.ok) return { status: "unmade", reason: "refused" };
  return { content: { id: String(r.data.id) } };
}`;
const POSTER_FINE = POSTER.replace('{ text: "hello" }', '{ text: "hello", outcomeKey: "threads_post_published" }');
const CASE: ReplayCase = {
  id: "fictional-1",
  units: {},
  calls: [{ name: "threads.post", args: { text: "hello" }, answer: { ok: true, data: { id: "p1" } } }],
  expect: { content: { id: "p1" } },
};
const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const deps = { isKnownOutcome: async (o: string) => ["post_published", "threads_post_published"].includes(o) };

let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
  setScriptStrategyReader(null);
  await putCases(db, "post_published", "dy_thread", [CASE], "test");
  await createScript(db, { outcome: "post_published", dynasty: "dy_thread", code: POSTER, description: "Posts", tactics: { channel: "threads-post", recorded_by: "meta" } }, author, deps);
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ScriptCatalogueError ? `${e.status} ${e.code}` : String(e);
  }
}

describe("re-homing a dynasty onto its fine outcome", () => {
  it("stores the next version under the fine outcome, proven on the dynasty's cases, without the channel tactic", async () => {
    const family = (await activeVersion(db, "post_published", "dy_thread"))!;
    const out = await rehomeScript(db, "post_published", "dy_thread", { toOutcome: "threads_post_published" }, author, deps);
    expect(out.script).toMatchObject({ outcome: "threads_post_published", dynasty: "dy_thread", version: 2, creationType: "upgrade", tactics: { recorded_by: "meta" }, replay: { cases: 1, matches: 1 } });
    expect(out.script.createdFromScript).toBe(family.id);
    expect(await caseCount(db, "threads_post_published", "dy_thread")).toBe(1);
    // The family version stays live until the pipe names the fine outcome.
    expect((await activeVersion(db, "post_published", "dy_thread"))!.version).toBe(1);
    expect(await code(rehomeScript(db, "post_published", "dy_thread", { toOutcome: "threads_post_published" }, author, deps))).toBe("409 dynasty_exists");
    expect(await code(rehomeScript(db, "post_published", "dy_thread", { toOutcome: "made_up" }, author, deps))).toBe("400 unknown_outcome");
  });

  it("refuses a code its recorded cases do not replay", async () => {
    expect(await code(rehomeScript(db, "post_published", "dy_thread", { toOutcome: "threads_post_published", code: POSTER_FINE }, author, deps))).toBe("422 replay_failed");
  });

  it("copies every campaign switch scope in its state, the stored state, and moves the open waits", async () => {
    await switchEngine(db, { outcome: "post_published", dynasty: "dy_thread", orgId: "org-a" });
    await switchEngine(db, { outcome: "post_published", dynasty: "dy_thread", orgId: "org-b" });
    await switchEngineOff(db, { outcome: "post_published", orgId: "org-b", reason: "guard" });
    await db.insert(scriptStorage).values({ orgId: "org-a", outcome: "post_published", tableName: "accounts", key: "acc1", value: { lastPostAt: "x" } });
    const family = (await activeVersion(db, "post_published", "dy_thread"))!;
    await db.insert(engineWaits).values({ orgId: "org-a", campaignId: "c1", outcome: "post_published", scriptId: family.id, dueAt: new Date(), fromRunId: "r0" });

    const out = await rehomeScript(db, "post_published", "dy_thread", { toOutcome: "threads_post_published" }, author, deps);
    expect(out.switchesCopied.sort((a, b) => String(a.orgId).localeCompare(String(b.orgId)))).toEqual([
      { orgId: "org-a", state: "switched" },
      { orgId: "org-b", state: "rolled_back" },
    ]);
    expect((await engineState(db, "threads_post_published", "org-a")).live).toBe(true);
    expect((await engineState(db, "threads_post_published", "org-b")).live).toBe(false);
    expect((await engineState(db, "threads_post_published", "org-c")).live).toBe(false);
    expect(out.storageRowsCopied).toBe(1);
    expect((await db.select().from(scriptStorage).where(eq(scriptStorage.outcome, "threads_post_published")))[0]!.value).toEqual({ lastPostAt: "x" });
    expect(out.waitsMoved).toBe(1);
    expect((await db.select().from(engineWaits))[0]!.outcome).toBe("threads_post_published");
    expect(await db.select().from(scriptSwitches).where(and(eq(scriptSwitches.outcome, "threads_post_published"), eq(scriptSwitches.orgId, "org-a")))).toHaveLength(1);
  });

  it("copies each service switch of the dynasty (caller x task) in its state", async () => {
    await db.insert(scriptSwitches).values({ outcome: "post_published", dynasty: "dy_thread", callerService: "instantly", callerTask: "inbound-decision", scriptVersion: 1, fromVersion: 0, toVersion: 1, state: "switched" });
    await db.insert(scriptSwitches).values({ outcome: "post_published", dynasty: "dy_thread", callerService: "instantly", callerTask: "orphan", scriptVersion: 1, fromVersion: 0, toVersion: 1, state: "shadow" });
    const out = await rehomeScript(db, "post_published", "dy_thread", { toOutcome: "threads_post_published" }, author, deps);
    expect(out.serviceSwitchesCopied.sort((a, b) => String(a.callerTask).localeCompare(String(b.callerTask)))).toEqual([
      { callerService: "instantly", callerTask: "inbound-decision", state: "switched" },
      { callerService: "instantly", callerTask: "orphan", state: "shadow" },
    ]);
    const rows = await db.select().from(scriptSwitches).where(and(eq(scriptSwitches.outcome, "threads_post_published"), eq(scriptSwitches.callerService, "instantly")));
    expect(rows.map((r) => [r.callerTask, r.state, r.scriptVersion])).toEqual(expect.arrayContaining([["inbound-decision", "switched", 2], ["orphan", "shadow", 2]]));
  });

  it("serves any campaign asking the fine Engine (no channel), and the Rating keeps the dynasty's record", async () => {
    const family = (await activeVersion(db, "post_published", "dy_thread"))!;
    await db.insert(scriptRuns).values({ scriptId: family.id, orgId: "org-a", runId: "r1", parentRunId: "p1", status: "made" });
    await rehomeScript(db, "post_published", "dy_thread", { toOutcome: "threads_post_published" }, author, deps);
    expect(await servesChannel(db, "threads_post_published", "threads-post")).toBe(true);
    // The family Engine still serves only its channel.
    expect(await servesChannel(db, "post_published", "social-post")).toBe(false);
    const pick = await pickScript(db, { outcome: "threads_post_published", servable: [], channel: "threads-post" }, () => 0.5);
    expect(pick!.draws).toEqual([expect.objectContaining({ dynasty: "dy_thread", version: 2, made: 1, runs: 1 })]);
  });
});
