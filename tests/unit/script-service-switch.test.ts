import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createScript, putCases, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { serviceSwitchState, switchService } from "../../src/lib/scripts/script-service-switch.js";
import { checkGuard, guardView, rollBackSwitches } from "../../src/lib/scripts/script-guard.js";
import { readMonitoring, SERVICE_PATHS } from "../../src/lib/scripts/script-monitoring.js";
import { scriptRuns, scripts } from "../../src/db/schema.js";
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
