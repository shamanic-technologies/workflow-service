import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createScript, putCases, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { serviceSwitchState, switchService } from "../../src/lib/scripts/script-service-switch.js";
import { campaignsWithoutOldPath, checkGuard, guardView, rollBackSwitches, scriptFailureKind, workflowFailureKind } from "../../src/lib/scripts/script-guard.js";
import { readMonitoring, SERVICE_PATHS } from "../../src/lib/scripts/script-monitoring.js";
import { scriptRuns, scriptSwitches, scripts, workflowRuns, workflows } from "../../src/db/schema.js";
import { switchEngine, engineState } from "../../src/lib/scripts/engine.js";
import type { ReplayCase } from "../../src/lib/scripts/replay.js";

// FACTORY-P3 next outcomes: a SERVICE switch (an outcome a service makes in its own code, no workflow step calls it:
// instantly's reply judge), its platform-billed door and its roll-back.
const MIGRATIONS = join(__dirname, "../../drizzle");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

const JUDGE = `
export default function run(ctx) {
  const reply = ctx.get("reply_received");
  const answer = ctx.vendor.call("llm.complete", { message: String(reply.content.text), systemPrompt: "SYS", provider: "deepseek", model: "deepseek-flash", responseFormat: "json", temperature: 0, disableThinking: true });
  if (!answer.ok) throw new Error("llm.complete failed: " + String(answer.data.error));
  const kind = answer.data.json && answer.data.json.classification;
  if (!kind) return null;
  return { content: { kind, classification: kind === "lead_interested" ? "positive" : "neutral", interested: kind === "lead_interested" } };
}`;
const CASE: ReplayCase = {
  id: "c1",
  units: { reply_received: { text: "Sounds good" } },
  calls: [
    {
      name: "llm.complete",
      args: { message: "Sounds good", systemPrompt: "SYS", provider: "deepseek", model: "deepseek-flash", responseFormat: "json", temperature: 0, disableThinking: true },
      answer: { ok: true, data: { content: "{}", json: { classification: "lead_interested" }, model: "deepseek-v4-flash", tokensInput: 1, tokensOutput: 1 } },
    },
  ],
  expect: { content: { kind: "lead_interested", classification: "positive", interested: true } },
};

let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
}, 60_000);
const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true };

async function provenJudge() {
  await putCases(db, "lead_interested", "dy_reply_judge", [CASE], "test");
  return createScript(db, { outcome: "lead_interested", dynasty: "dy_reply_judge", code: JUDGE, description: "x" }, author, known);
}

describe("a service switch", () => {
  it("is refused for an unknown caller and for a dynasty that is not a proven port", async () => {
    await expect(switchService(db, { outcome: "lead_interested", dynasty: "dy_reply_judge", callerService: "nobody" })).rejects.toThrow(/not a service/);
    await expect(switchService(db, { outcome: "lead_interested", dynasty: "dy_reply_judge", callerService: "instantly" })).rejects.toThrow(/no active version/);
    await createScript(db, { outcome: "lead_interested", dynasty: "dy_no_cases", code: JUDGE, description: "x" }, author, known);
    await expect(switchService(db, { outcome: "lead_interested", dynasty: "dy_no_cases", callerService: "instantly" })).rejects.toThrow(/not a proven port/);
  });

  it("switches once, is read by the service, and the roll-back sends the service back to its own code", async () => {
    expect(await serviceSwitchState(db, "lead_interested", "instantly")).toMatchObject({ switched: false, dynasty: null });
    await provenJudge();
    const row = await switchService(db, { outcome: "lead_interested", dynasty: "dy_reply_judge", callerService: "instantly" });
    expect(row).toMatchObject({ state: "switched", callerService: "instantly", scriptVersion: 1, workflowDynastySlug: null });
    expect((await switchService(db, { outcome: "lead_interested", dynasty: "dy_reply_judge", callerService: "instantly" })).id).toBe(row.id);
    expect(await serviceSwitchState(db, "lead_interested", "instantly")).toMatchObject({ switched: true, dynasty: "dy_reply_judge", scriptVersion: 1 });

    const view = await guardView(db, "lead_interested");
    expect(view).toMatchObject({ state: "watching", switches: [{ workflowDynastySlug: "service:instantly", fromVersion: 0, toVersion: 1, state: "switched", callerService: "instantly" }] });

    // A drill by name leaves another outcome's or another name alone, then rolls this one back.
    expect(await rollBackSwitches(db, { restoreFlow: async () => {} }, "lead_interested", "drill", "staff", ["service:other"])).toEqual({ rolledBack: [], skipped: [] });
    const out = await rollBackSwitches(db, { restoreFlow: async () => { throw new Error("a service switch restores no flow"); } }, "lead_interested", "drill", "staff", ["service:instantly"]);
    expect(out.rolledBack).toEqual([{ workflowDynastySlug: "service:instantly", fromVersion: 0, toVersion: 1 }]);
    expect(await serviceSwitchState(db, "lead_interested", "instantly")).toMatchObject({ switched: false, dynasty: null, rollbackReason: "drill" });

    // Switched again after the roll-back: a new row, the service reads the latest.
    await switchService(db, { outcome: "lead_interested", dynasty: "dy_reply_judge", callerService: "instantly" });
    expect((await serviceSwitchState(db, "lead_interested", "instantly")).switched).toBe(true);
  });

  it("a failure the old path shares (an upstream timeout) never rolls a script back on its own (INCIDENT 2026-11-06)", async () => {
    const script = await provenJudge();
    await switchService(db, { outcome: "lead_interested", dynasty: "dy_reply_judge", callerService: "instantly" });
    const now = new Date();
    expect(scriptFailureKind("lead.serve: Lead serve setup failed")).toBe("POST lead/orgs/buffer/next");
    expect(scriptFailureKind("lead.serve: fetch failed")).toBe("POST lead/orgs/buffer/next");
    expect(scriptFailureKind("llm.complete failed: 500")).toBeNull();
    expect(scriptFailureKind("TypeError: x is undefined")).toBeNull();
    expect(workflowFailureKind('POST lead/orgs/buffer/next failed (500): {"error":"Lead serve setup failed"}')).toBe("POST lead/orgs/buffer/next");
    expect(workflowFailureKind("GET lead/orgs/leads/{id}/history failed (502): x")).toBe("GET lead/orgs/leads/{id}/history");
    // The hour of 2026-11-06 16:52: 47 runs, 4 serve timeouts.
    await db.insert(scriptRuns).values(Array.from({ length: 47 }, (_, i) => ({ scriptId: script.id, orgId: "o", runId: `r${i}`, parentRunId: "p", status: i < 4 ? "failed" : "made", error: i < 4 ? "lead.serve: Lead serve setup failed" : null, createdAt: now })));
    // The old path never failed that call: the script's failures are its own, it rolls back.
    expect((await guardView(db, "lead_interested", now)).lastHour).toMatchObject({ runs: 47, failed: 4, shared: 0 });
    // The old path's workflows failed the same serve 3 days ago (a fresh read: the memo is per process, 30 min).
    await db.insert(workflowRuns).values({ orgId: "o2", status: "failed", failedStep: "fetch_lead", failedReason: 'POST lead/orgs/buffer/next failed (500): {"error":"Lead serve setup failed","detail":"The operation was aborted due to timeout"}', createdAt: new Date(now.getTime() - 3 * 86_400_000) });
    const { resetGuardMemo } = await import("../../src/lib/scripts/script-guard.js");
    resetGuardMemo();
    const out = await checkGuard(db, { restoreFlow: async () => {} }, "lead_interested", now);
    expect(out).toMatchObject({ checked: true, rollBack: false, result: null, window: { runs: 47, failed: 0, shared: 4 } });
    expect((await serviceSwitchState(db, "lead_interested", "instantly")).switched).toBe(true);
    // A failure only the script has still counts: 4 throws in its own code roll it back.
    await db.insert(scriptRuns).values(Array.from({ length: 4 }, (_, i) => ({ scriptId: script.id, orgId: "o", runId: `t${i}`, parentRunId: "p", status: "failed", error: "TypeError: reply.content is undefined", createdAt: now })));
    const bad = await checkGuard(db, { restoreFlow: async () => {} }, "lead_interested", now);
    expect(bad.result?.rolledBack).toHaveLength(1);
    expect((await serviceSwitchState(db, "lead_interested", "instantly")).rollbackReason).toMatch(/for dynasty dy_reply_judge \(4 of 51 runs; 4 more failed at a call the old path also fails or that got no answer, not counted\)/);
  });

  it("never rolls a campaign Engine back onto an old path that cannot run: held switched, red on Monitoring (INCIDENT 2026-11-06 18:05)", async () => {
    const script = await provenJudge();
    await switchEngine(db, { outcome: "lead_interested", dynasty: "dy_reply_judge", orgId: "org-a" });
    const now = new Date();
    // Campaign c1 ran on the Engine; its last workflow's dynasty is deprecated (its code deleted): nothing to go back to.
    const dag = { nodes: [], edges: [] };
    const base = { orgId: "org-a", workflowName: "w", workflowDynastyName: "w", featureSlug: "f", signature: "s", workflowDynastySignatureName: "s", dag };
    const [dead] = await db.insert(workflows).values({ ...base, workflowSlug: "sourcing-x-v3", workflowDynastySlug: "sourcing-x", version: 3, status: "deprecated", workflowDynastyStatus: "deprecated" } as typeof workflows.$inferInsert).returning();
    await db.insert(workflowRuns).values([
      { workflowId: dead!.id, orgId: "org-a", campaignId: "c1", status: "completed", createdAt: new Date(now.getTime() - 2 * 86_400_000) },
      { orgId: "org-a", campaignId: "c1", status: "completed", executionScope: "engine", inputs: { engineOutcome: "lead_interested" }, createdAt: now },
    ]);
    expect(await campaignsWithoutOldPath(db, "lead_interested", "org-a", now)).toEqual(["c1"]);
    // A bad hour (4 errors of the script's own) would roll it back.
    await db.insert(scriptRuns).values(Array.from({ length: 25 }, (_, i) => ({ scriptId: script.id, orgId: "org-a", runId: `r${i}`, parentRunId: "p", status: i < 4 ? "failed" : "made", error: i < 4 ? "TypeError: x" : null, createdAt: now })));
    const out = await checkGuard(db, { restoreFlow: async () => {} }, "lead_interested", now);
    expect(out.result?.rolledBack).toEqual([]);
    expect(out.result?.skipped[0]!.reason).toMatch(/held switched: the old path cannot run for 1 campaign\(s\) \(c1\)/);
    expect((await engineState(db, "lead_interested", "org-a")).live).toBe(true);
    const li = (await readMonitoring(db, 30, now)).outcomes.find((o) => o.outcome === "lead_interested")!;
    expect(li.red).toBe(true);
    // Its dynasty gets an active version again: the old path can run, the guard rolls back as before.
    await db.insert(workflows).values({ ...base, workflowSlug: "sourcing-x-v4", workflowDynastySlug: "sourcing-x", version: 4, status: "active", workflowDynastyStatus: "active" } as typeof workflows.$inferInsert);
    expect(await campaignsWithoutOldPath(db, "lead_interested", "org-a", now)).toEqual([]);
    const { resetGuardMemo } = await import("../../src/lib/scripts/script-guard.js");
    resetGuardMemo();
    const back = await checkGuard(db, { restoreFlow: async () => {} }, "lead_interested", now);
    expect(back.result?.rolledBack).toHaveLength(1);
    expect((await engineState(db, "lead_interested", "org-a")).live).toBe(false);
    expect((await db.select().from(scriptSwitches)).every((r) => r.state === "rolled_back")).toBe(true);
  });

  it("judges each campaign switch on its OWN org's runs; a call with no answer is never the script's (INCIDENT 2026-11-07 19:46, MIGRATE-1105 S6)", async () => {
    const script = await provenJudge();
    await switchEngine(db, { outcome: "lead_interested", dynasty: "dy_reply_judge", orgId: "org-bad" });
    await switchEngine(db, { outcome: "lead_interested", dynasty: "dy_reply_judge", orgId: "org-clean" });
    const now = new Date();
    // org-bad: 25 runs, 4 throws of the script's own + 3 calls with no answer. org-clean: 25 runs, nothing failed.
    await db.insert(scriptRuns).values([
      ...Array.from({ length: 25 }, (_, i) => ({ scriptId: script.id, orgId: "org-bad", runId: `b${i}`, parentRunId: "p", status: i < 7 ? "failed" : "made", error: i < 4 ? "TypeError: x" : i < 7 ? "ctx.get(message_written): fetch failed" : null, createdAt: now })),
      ...Array.from({ length: 25 }, (_, i) => ({ scriptId: script.id, orgId: "org-clean", runId: `c${i}`, parentRunId: "p", status: "made", createdAt: now })),
    ]);
    const { resetGuardMemo, lastHour } = await import("../../src/lib/scripts/script-guard.js");
    resetGuardMemo();
    expect(await lastHour(db, "lead_interested", now, { orgId: "org-bad" })).toMatchObject({ runs: 25, failed: 4, shared: 3 });
    const out = await checkGuard(db, { restoreFlow: async () => {} }, "lead_interested", now);
    expect(out.result?.rolledBack).toHaveLength(1);
    expect((await engineState(db, "lead_interested", "org-bad")).live).toBe(false);
    expect((await engineState(db, "lead_interested", "org-clean")).live).toBe(true);
    const bad = (await db.select().from(scriptSwitches)).find((r) => r.orgId === "org-bad")!;
    expect(bad.rollbackReason).toMatch(/for org org-bad \(4 of 25 runs; 3 more failed at a call the old path also fails or that got no answer, not counted\)/);
  });

  it("an upstream / transport failure is never the script's: no answer, a 5xx, an upstream error, nested in an asked Engine (MIGRATE-1105 S6)", async () => {
    const { noAnswer } = await import("../../src/lib/scripts/script-guard.js");
    for (const e of [
      "ctx.get(message_written): fetch failed",
      "who-they-are: the person's thread could not be read (no status fetch failed); nothing is written blind",
      "message_written/dy_template_writer_full/v2 (asked for message_written) failed: llm.complete failed: chat-service POST /complete -> 502: {}",
      "email.send: Upstream service error",
      "POST lead/orgs/buffer/next failed (503): busy",
      "connect ECONNREFUSED 10.0.0.4:8080",
    ]) expect(noAnswer(e)).toBe(true);
    for (const e of ["TypeError: reply.content is undefined", "llm.complete failed: chat-service POST /complete -> 402: max budget", "lead.serve: 400 bad request", null]) expect(noAnswer(e)).toBe(false);
  });

  it("the guard rolls a service switch back on a bad hour and Monitoring goes red", async () => {
    const script = await provenJudge();
    await switchService(db, { outcome: "lead_interested", dynasty: "dy_reply_judge", callerService: "instantly" });
    const now = new Date();
    await db.insert(scriptRuns).values(Array.from({ length: 25 }, (_, i) => ({ scriptId: script.id, orgId: "o", runId: `r${i}`, parentRunId: "p", status: i < 4 ? "failed" : "made", createdAt: now })));
    const out = await checkGuard(db, { restoreFlow: async () => {} }, "lead_interested", now);
    expect(out.result?.rolledBack).toEqual([{ workflowDynastySlug: "service:instantly", fromVersion: 0, toVersion: 1 }]);
    const state = await serviceSwitchState(db, "lead_interested", "instantly");
    expect(state.switched).toBe(false);
    expect(state.rollbackReason).toMatch(/^the stored script's error rate on lead_interested was 16\.0 %/);
    const li = (await readMonitoring(db, 30, now)).outcomes.find((o) => o.outcome === "lead_interested")!;
    expect(li.red).toBe(true);
    expect(li.servicePath).toEqual({ serviceName: "instantly-service", taskNames: ["reply-qualification"] });
  });

  it("names the reply judge's service path for Monitoring", () => {
    expect(SERVICE_PATHS.lead_interested).toEqual({ serviceName: "instantly-service", taskNames: ["reply-qualification"] });
  });

  it("names the queued steps' and the inbound reader's service paths for Monitoring (MIGRATE-1105 S2)", () => {
    expect(SERVICE_PATHS.message_queued).toEqual({ serviceName: "instantly-service", taskNames: ["queue-decision"] });
    expect(SERVICE_PATHS.reply_received).toEqual({ serviceName: "instantly-service", taskNames: ["inbound-decision", "orphan-judgment"] });
  });
});

describe("the platform-billed door (a service's own sweep)", () => {
  function ledger() {
    const calls: unknown[][] = [];
    const deps: LedgerDeps = {
      async createRun(o) { calls.push(["create", o]); return "run-script-9"; },
      async declareOutcomes(runId, orgId, body) { calls.push(["declare", { runId, orgId, body }]); return {}; },
      async closeRun(runId, status) { calls.push(["close", { runId, status }]); },
    };
    return { calls, deps };
  }
  function vendors() {
    const seen: Array<[string, Record<string, unknown>, Record<string, string>]> = [];
    const answer = { content: "{\"classification\":\"lead_interested\"}", json: { classification: "lead_interested" }, model: "deepseek-v4-flash", tokensInput: 9, tokensOutput: 3, runId: "chat-platform-run" };
    const deps: VendorDeps = {
      async complete(body, headers) { seen.push(["complete", body, headers]); return answer; },
      async platformComplete(body, headers) { seen.push(["platformComplete", body, headers]); return answer; },
      async judge(body, headers) { seen.push(["judge", body, headers]); return { answers: {} }; },
      async platformJudge(body, headers) { seen.push(["platformJudge", body, headers]); return { answers: {} }; },
      async readSkill() { return null; },
    };
    return { seen, deps };
  }
  const who = { orgId: "org-a", userId: "", parentRunId: "run-reply-judging", headers: {} };
  const input = {
    outcome: "lead_interested",
    dynasty: "dy_reply_judge",
    subject: { service: "instantly", id: "seq-1" },
    units: { reply_received: { content: { text: "Sounds good" } } },
    recordedBy: "instantly",
    trace: true,
  };

  it("bills the completion to the platform on the script's run, declares nothing, and traces the exact request", async () => {
    await provenJudge();
    const l = ledger();
    const v = vendors();
    const out = await runStoredScript(db, { ...input, billing: "platform" }, who, { ledger: l.deps, vendors: v.deps });
    expect(out.status).toBe("made");
    expect(out.unit?.content).toEqual({ kind: "lead_interested", classification: "positive", interested: true });
    expect(v.seen.map((s) => s[0])).toEqual(["platformComplete"]);
    // Only whose work it is: the script's run (chat-service's platform run becomes its child).
    expect(v.seen[0]![2]).toEqual({ "x-run-id": "run-script-9" });
    expect(v.seen[0]![1]).toEqual(CASE.calls[0]!.args);
    expect(l.calls.map((c) => c[0])).toEqual(["create", "close"]);
    expect(l.calls[0]![1]).toMatchObject({ parentRunId: "run-reply-judging", orgId: "org-a", userId: "", taskName: "script:lead_interested/dy_reply_judge" });
    expect(out.declared).toEqual({ produced: [], consumed: [] });
    expect(out.trace?.[0]).toMatchObject({ name: "llm.complete", sent: CASE.calls[0]!.args, raw: { runId: "chat-platform-run" } });
  });

  it("without billing the same run is org-billed through /complete (unchanged)", async () => {
    await provenJudge();
    const v = vendors();
    await runStoredScript(db, input, { ...who, userId: "u" }, { ledger: ledger().deps, vendors: v.deps });
    expect(v.seen.map((s) => s[0])).toEqual(["complete"]);
  });

  it("the stored judge is refused unproven like any port (one more case it misses)", async () => {
    await provenJudge();
    await putCases(db, "lead_interested", "dy_reply_judge", [{ ...CASE, id: "c2", expect: { nothing: true } }], "test");
    await expect(runStoredScript(db, input, who, { ledger: ledger().deps, vendors: vendors().deps })).rejects.toThrow(/not proven/);
    // The version itself is still active; only its proof is stale.
    expect((await db.select().from(scripts))[0]!.status).toBe("active");
  });
});

describe("apollo's verifier doors (email_found)", () => {
  async function call(name: string, args: Record<string, unknown>, ctx: Record<string, unknown>, answers: { verify?: { status: number; body: Record<string, unknown> }; apify?: { status: number; body: Record<string, unknown> } }) {
    const { callVendor } = await import("../../src/lib/scripts/vendors.js");
    const seen: unknown[] = [];
    const deps = {
      async complete() { return {}; },
      async judge() { return {}; },
      async readSkill() { return null; },
      async platformComplete() { return {}; },
      async platformJudge() { return {}; },
      async serviceDoor(service: string, method: string, path: string, body: Record<string, unknown> | null, headers: Record<string, string>) {
        seen.push([service, method, path, body, headers]);
        return (path.includes("/apify") ? answers.apify : answers.verify)!;
      },
    } as unknown as VendorDeps;
    const out = await callVendor(name, args, { headers: { "x-run-id": "script-run", "x-org-id": "org-a", "x-user-id": "u" }, tactics: {}, ...ctx }, deps);
    return { out, seen };
  }

  it("a verifier call names the script's run AND the caller's run (whose verification apollo has in flight)", async () => {
    const row = { verificationId: "v1", verifier: "contactout", verdict: "valid", error: null };
    const { out, seen } = await call("apollo.email.verify", { verifier: "contactout", email: "a@b.co" }, { callerRunId: "caller-run" }, { verify: { status: 200, body: row } });
    expect(out).toEqual({ ok: true, data: row });
    expect(seen).toEqual([["apollo", "POST", "/internal/email-verifier-calls", { verifier: "contactout", email: "a@b.co" }, { "x-run-id": "script-run", "x-org-id": "org-a", "x-user-id": "u", "x-caller-run-id": "caller-run" }]]);
  });

  it("a refusal is a refusal the script reads (never a verifier that did not answer)", async () => {
    const { out } = await call("apollo.email.verify", { verifier: "trykitt", email: "a@b.co" }, { callerRunId: "c" }, { verify: { status: 502, body: { error: "Insufficient credits" } } });
    expect(out).toEqual({ ok: false, data: { error: "Insufficient credits" } });
  });

  it("apify availability: ok = BounceVerify is asked now; no caller run = refused", async () => {
    expect((await call("apollo.apify.available", { email: "a@b.co" }, { callerRunId: "c" }, { apify: { status: 200, body: { available: true } } })).out).toEqual({ ok: true, data: {} });
    expect((await call("apollo.apify.available", { email: "a@b.co" }, { callerRunId: "c" }, { apify: { status: 200, body: { available: false } } })).out).toEqual({ ok: false, data: {} });
    expect((await call("apollo.apify.available", { email: "a@b.co" }, {}, {})).out.ok).toBe(false);
  });
});

describe("lead-service's candidate doors (lead_identified)", () => {
  it("each call is lead-service's door for the candidate in flight; a decline needs its reason", async () => {
    const { callVendor } = await import("../../src/lib/scripts/vendors.js");
    const seen: unknown[] = [];
    const deps = {
      async serviceDoor(service: string, method: string, path: string, body: unknown, headers: Record<string, string>) {
        seen.push([service, method, path, body, headers["x-caller-run-id"]]);
        return { status: 200, body: { status: "served" } };
      },
    } as unknown as VendorDeps;
    const ctx = { headers: { "x-run-id": "script-run", "x-org-id": "o" }, tactics: {}, callerRunId: "serve-run" };
    expect(await callVendor("lead.candidate.reveal", { candidateId: "c1" }, ctx, deps)).toEqual({ ok: true, data: { status: "served" } });
    expect((await callVendor("lead.candidate.decline", { candidateId: "c1" }, ctx, deps)).ok).toBe(false);
    expect(seen).toEqual([["lead", "POST", "/internal/candidate-decisions/reveal", { candidateId: "c1" }, "serve-run"]]);
  });
});

describe("the roll-back baseline is each outcome's own measured service rate; a failure the world gave is apart", () => {
  it("holds email_found to its measured ~1 % (threshold 4 %), not the writer's 0.5 %; unmade runs are not errors", async () => {
    const { measuredBaseline, checkGuard, guardView } = await import("../../src/lib/scripts/script-guard.js");
    const { scriptMonitoringDays } = await import("../../src/db/schema.js");
    expect(await measuredBaseline(db, "lead_interested")).toMatchObject({ source: "default", errorRate: 0.005 });
    await db.insert(scriptMonitoringDays).values({ day: "2026-10-29", outcome: "lead_interested", path: "service", serviceName: "instantly-service", taskNames: ["x"], totalRunCount: 500, sampleSize: 200, completedCount: 198, failedCount: 2, avgCostCents: null, computedAt: new Date() });
    expect(await measuredBaseline(db, "lead_interested")).toMatchObject({ source: "measured", errorRate: 0.01, day: "2026-10-29" });

    const script = await provenJudge();
    await switchService(db, { outcome: "lead_interested", dynasty: "dy_reply_judge", callerService: "instantly" });
    const now = new Date();
    // 100 runs: 3 script errors (3 %, under the 4 % threshold at a 1 % baseline) + 20 unmade (not errors).
    await db.insert(scriptRuns).values(Array.from({ length: 100 }, (_, i) => ({ scriptId: script.id, orgId: "o", runId: `r${i}`, parentRunId: "p", status: i < 3 ? "failed" : i < 23 ? "unmade" : "made", createdAt: now })));
    const out = await checkGuard(db, { restoreFlow: async () => {} }, "lead_interested", now);
    expect(out).toMatchObject({ checked: true, rollBack: false, window: { runs: 100, failed: 3, unmade: 20 } });
    expect(await guardView(db, "lead_interested", now)).toMatchObject({ baselineErrorRate: 0.01, baselineSource: "measured", thresholdErrorRate: 0.04 });
    // 3 more errors: 6 %, beyond chance at 1 %: rolled back.
    await db.insert(scriptRuns).values(Array.from({ length: 3 }, (_, i) => ({ scriptId: script.id, orgId: "o", runId: `x${i}`, parentRunId: "p", status: "failed", createdAt: now })));
    expect((await checkGuard(db, { restoreFlow: async () => {} }, "lead_interested", now)).result?.rolledBack).toHaveLength(1);
  });

  it("a script answering `unmade` closes its run completed, throws nothing, and replays against a recorded failure", async () => {
    const code = `export default function run(ctx) { ctx.get("reply_received"); return { unmade: "bounceban: no verdict" }; }`;
    const { replayCase } = await import("../../src/lib/scripts/replay.js");
    expect((await replayCase(code, { id: "u", units: { reply_received: {} }, calls: [], expect: { fails: "bounceban:" } })).match).toBe(true);
    expect((await replayCase(code, { id: "u", units: { reply_received: {} }, calls: [], expect: { fails: "trykitt:" } })).match).toBe(false);
    await putCases(db, "lead_interested", "dy_unmade", [{ id: "u", units: { reply_received: {} }, calls: [], expect: { fails: "bounceban:" } }], "t");
    await createScript(db, { outcome: "lead_interested", dynasty: "dy_unmade", code, description: "x" }, author, known);
    const closed: string[] = [];
    const ledger: LedgerDeps = { async createRun() { return "r-u"; }, async declareOutcomes() { return {}; }, async closeRun(_r, status) { closed.push(status); } };
    const out = await runStoredScript(db, { outcome: "lead_interested", dynasty: "dy_unmade", subject: { service: "s", id: "1" }, units: { reply_received: { content: {} } } }, { orgId: "o", userId: "u", parentRunId: "p", headers: {} }, { ledger, vendors: {} as VendorDeps });
    expect(out).toMatchObject({ status: "unmade", error: "bounceban: no verdict", unit: null });
    expect(closed).toEqual(["completed"]);
  });
});

describe("human-service's walk doors (lead_found)", () => {
  it("a page asks with a number, a decision with a list; both reach human-service's door as stated", async () => {
    const { callVendor } = await import("../../src/lib/scripts/vendors.js");
    const seen: unknown[] = [];
    const deps = {
      async serviceDoor(service: string, method: string, path: string, body: unknown) {
        seen.push([service, method, path, body]);
        return { status: 200, body: { ok: 1 } };
      },
    } as unknown as VendorDeps;
    const ctx = { headers: { "x-run-id": "script-run" }, tactics: {}, callerRunId: "serve-run" };
    expect((await callVendor("human.walk.page", { walk: "w1", limit: 20 }, ctx, deps)).ok).toBe(true);
    expect((await callVendor("human.walk.decide", { walk: "w1", verdicts: [{ ref: "p1", verdict: "offer" }] }, ctx, deps)).ok).toBe(true);
    expect((await callVendor("human.walk.page", { walk: "w1" }, ctx, deps)).ok).toBe(false);
    expect(seen).toEqual([
      ["human", "POST", "/internal/candidate-walks/page", { walk: "w1", limit: 20 }],
      ["human", "POST", "/internal/candidate-walks/decide", { walk: "w1", verdicts: [{ ref: "p1", verdict: "offer" }] }],
    ]);
  });
});

describe("human-service's split doors (audience_built)", () => {
  it("the completion passes its optional fields as stated and the message byte for byte", async () => {
    const { callVendor } = await import("../../src/lib/scripts/vendors.js");
    const seen: unknown[] = [];
    const deps = { async serviceDoor(service: string, method: string, path: string, body: unknown) { seen.push([path, body]); return { status: 200, body: { axes: [] } }; } } as unknown as VendorDeps;
    const ctx = { headers: { "x-run-id": "script-run" }, tactics: {}, callerRunId: "caller" };
    await callVendor("human.split.complete", { proposal: "p", message: " Clinics ", systemPrompt: "S", provider: "anthropic", disableThinking: true }, ctx, deps);
    expect(seen).toEqual([["/internal/audience-splits/complete", { proposal: "p", message: " Clinics ", systemPrompt: "S", provider: "anthropic", disableThinking: true }]]);
  });
});

describe("a SHADOW before a switch (message_sent)", () => {
  it("needs no proof, is read as shadow, and becomes the switch once proven", async () => {
    const { createScript: create } = await import("../../src/lib/scripts/script-catalogue.js");
    await create(db, { outcome: "message_sent", dynasty: "dy_select", code: "export default function run(ctx) { return null; }", description: "x" }, author, known);
    instantlyCaller();
    const shadow = await switchService(db, { outcome: "message_sent", dynasty: "dy_select", callerService: "instantly", mode: "shadow" });
    expect(shadow.state).toBe("shadow");
    expect(await serviceSwitchState(db, "message_sent", "instantly")).toMatchObject({ switched: false, shadow: true, dynasty: "dy_select" });
    // A switch still needs the proven port.
    await expect(switchService(db, { outcome: "message_sent", dynasty: "dy_select", callerService: "instantly" })).rejects.toThrow(/not a proven port/);
    // The guard never acts on a shadow.
    const { checkGuard } = await import("../../src/lib/scripts/script-guard.js");
    expect((await checkGuard(db, { restoreFlow: async () => {} }, "message_sent")).checked).toBe(false);
  });
});

function instantlyCaller() {
  /* instantly is a known caller */
}

describe("a run with no org (fleet work): a platform run", () => {
  it("opens and closes on runs-service's platform doors, child of the caller's platform run; declares nothing", async () => {
    const { productionLedgerDeps } = await import("../../src/lib/scripts/script-runner.js");
    process.env.RUNS_SERVICE_URL = "http://runs";
    process.env.RUNS_SERVICE_API_KEY = "k";
    const calls: Array<[string, RequestInit]> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ id: "plat-run" }), { status: 200 });
    }) as typeof fetch;
    try {
      const ledger = productionLedgerDeps();
      expect(await ledger.createRun({ parentRunId: "sel-run", orgId: "", userId: "", taskName: "script:message_sent/dy", headers: {} })).toBe("plat-run");
      await ledger.closeRun("plat-run", "completed", "");
      await expect(ledger.declareOutcomes("plat-run", "", { produced: [], consumed: [] })).rejects.toThrow(/declares nothing/);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls.map(([u, i]) => [u, i.method])).toEqual([["http://runs/v1/platform-runs", "POST"], ["http://runs/v1/platform-runs/plat-run", "PATCH"]]);
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ serviceName: "workflow", taskName: "script:message_sent/dy", parentRunId: "sel-run" });
  });
});

describe("a service's material may be large (the send selection's whole queue)", () => {
  it("the script run and the cases routes take 32 MB; the rest keeps 2 MB", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(src.indexOf('app.use(["/internal/scripts/run", "/internal/scripts/dynasty"], express.json({ limit: "32mb" }));')).toBeGreaterThan(-1);
    expect(src.indexOf('express.json({ limit: "32mb" })')).toBeLessThan(src.indexOf('express.json({ limit: "2mb" })'));
  });
});
