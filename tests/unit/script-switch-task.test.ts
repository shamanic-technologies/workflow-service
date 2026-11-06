import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createScript, putCases, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { serviceSwitchState, switchService } from "../../src/lib/scripts/script-service-switch.js";
import { callVendor, type VendorDeps } from "../../src/lib/scripts/vendors.js";
import { scriptSwitches } from "../../src/db/schema.js";
import type { ReplayCase } from "../../src/lib/scripts/replay.js";

// MIGRATE-1105 S2b: one service makes ONE outcome through two decisions (instantly: each poll batch's filing, then the
// orphan-reply judgment, both reply_received). A switch is keyed by the caller's TASK; a caller naming no task reads the
// outcome's latest row as before. And `jev.choice`, the Jev choice judgment the orphan-reply script calls.
async function freshDb() {
  const client = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return { db: drizzle(client) as unknown as AnyPgDb, client };
}

const PURE = `export default function run(ctx) { return { content: { kind: ctx.get("message_sent").content.kind } }; }`;
const CASE: ReplayCase = { id: "c1", units: { message_sent: { kind: "reply" } }, calls: [], expect: { content: { kind: "reply" } } };
const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true };

let db: AnyPgDb;
beforeEach(async () => {
  ({ db } = await freshDb());
  for (const d of ["dy_inbound_decision", "dy_orphan_reply"]) {
    await putCases(db, "reply_received", d, [CASE], "test");
    await createScript(db, { outcome: "reply_received", dynasty: d, code: PURE, description: "x" }, author, known);
  }
}, 60_000);

describe("a service switch keyed by the caller's task", () => {
  it("holds two decisions of one outcome side by side, each read by its task", async () => {
    await switchService(db, { outcome: "reply_received", dynasty: "dy_inbound_decision", callerService: "instantly", callerTask: "inbound-decision" });
    await switchService(db, { outcome: "reply_received", dynasty: "dy_orphan_reply", callerService: "instantly", callerTask: "orphan-judgment", mode: "shadow" });
    expect(await serviceSwitchState(db, "reply_received", "instantly", "inbound-decision")).toMatchObject({ switched: true, shadow: false, dynasty: "dy_inbound_decision", callerTask: "inbound-decision" });
    expect(await serviceSwitchState(db, "reply_received", "instantly", "orphan-judgment")).toMatchObject({ switched: false, shadow: true, dynasty: "dy_orphan_reply" });
    // The shadow is promoted by its own task's switch; the other task's switch is untouched.
    const promoted = await switchService(db, { outcome: "reply_received", dynasty: "dy_orphan_reply", callerService: "instantly", callerTask: "orphan-judgment" });
    expect(promoted).toMatchObject({ state: "switched", callerTask: "orphan-judgment" });
    expect((await serviceSwitchState(db, "reply_received", "instantly", "inbound-decision")).dynasty).toBe("dy_inbound_decision");
    expect((await db.select().from(scriptSwitches)).length).toBe(2);
  });

  it("a task with no row is the service's own code; no task reads the outcome's latest row (callers from before)", async () => {
    await switchService(db, { outcome: "reply_received", dynasty: "dy_inbound_decision", callerService: "instantly", callerTask: "inbound-decision" });
    expect(await serviceSwitchState(db, "reply_received", "instantly", "orphan-judgment")).toMatchObject({ switched: false, shadow: false, dynasty: null });
    expect(await serviceSwitchState(db, "reply_received", "instantly")).toMatchObject({ switched: true, dynasty: "dy_inbound_decision" });
  });

  it("the migration names the task of instantly's switches made before tasks existed", async () => {
    const { client } = await freshDb();
    // Re-run the backfill on a row as 0045-0049 wrote it (no task).
    await client.exec(`INSERT INTO script_switches (outcome, dynasty, caller_service, from_version, to_version, script_version, state) VALUES ('reply_received', 'dy_inbound_decision', 'instantly', 0, 1, 1, 'switched'), ('message_queued', 'dy_queue_decision', 'instantly', 0, 1, 1, 'shadow'), ('lead_interested', 'dy_reply_judge', 'instantly', 0, 2, 2, 'switched')`);
    const sql = readFileSync(join(__dirname, "../../drizzle/0050_script_switch_caller_task.sql"), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint").filter((s) => s.includes("UPDATE"))) await client.exec(stmt);
    const rows = (await client.query<{ outcome: string; caller_task: string | null }>("SELECT outcome, caller_task FROM script_switches ORDER BY outcome")).rows;
    expect(rows).toEqual([
      { outcome: "lead_interested", caller_task: null },
      { outcome: "message_queued", caller_task: "queue-decision" },
      { outcome: "reply_received", caller_task: "inbound-decision" },
    ]);
  });
});

describe("jev.choice", () => {
  const seen: Array<[string, Record<string, unknown>, Record<string, string>]> = [];
  const answer = { model: "jev-1", answers: { orphan_reply: { type: "choice", choice: "none", confidence: 0.9, probabilities: { lead_1: 0.05, none: 0.95 } } }, usage: { inputTokens: 812 } };
  const deps: VendorDeps = {
    async complete() { throw new Error("no"); },
    async platformComplete() { throw new Error("no"); },
    async judge(body, headers) { seen.push(["judge", body, headers]); return answer; },
    async platformJudge(body, headers) { seen.push(["platformJudge", body, headers]); return answer; },
    async readSkill() { return null; },
  };
  const questions = { orphan_reply: { type: "choice", instructions: "Which lead?", criteria: { lead_1: { what: "A", examples: ["x"] }, none: { what: "None" } } } };

  it("sends the question exactly as stated, platform-billed on the script's run, and answers chat's answers", async () => {
    const out = await callVendor("jev.choice", { state: "From: a@b.c", questions }, { headers: { "x-run-id": "script-run", "x-org-id": "o" }, tactics: {}, billing: "platform" }, deps);
    expect(seen[0]).toEqual(["platformJudge", { state: "From: a@b.c", questions }, { "x-run-id": "script-run" }]);
    expect(out).toEqual({ ok: true, data: { answers: answer.answers, model: "jev-1", usage: { inputTokens: 812 } } });
  });

  it("refuses a question that is not a choice with two options", async () => {
    const ctx = { headers: { "x-run-id": "r" }, tactics: {} };
    expect((await callVendor("jev.choice", { questions: { q: { type: "noul", instructions: "x", criteria: { a: "a", b: "b" } } } }, ctx, deps)).data.error).toMatch(/must be type choice/);
    expect((await callVendor("jev.choice", { questions: { q: { type: "choice", instructions: "x", criteria: { a: "a" } } } }, ctx, deps)).data.error).toMatch(/two criteria/);
  });
});
