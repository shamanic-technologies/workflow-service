import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { testNamer } from "../helpers/script-names.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { setScriptPickReader, setScriptStrategyReader } from "../../src/lib/scripts/engine.js";
import { setProofContext } from "../../src/lib/scripts/writer-proof.js";
import { executeEngineRun, planEngineRun, planTaskName, type EngineDispatch, type EngineRunDeps } from "../../src/lib/scripts/engine-runner.js";
import { reserveCampaignExecution } from "../../src/lib/execution-admission.js";
import { AnswerPendingError, PENDING_ANSWER_JOB_HEADER, mergePending, pendingOf, recheckDays } from "../../src/lib/scripts/pending-answer.js";
import { engineWaits, scriptRuns, scripts, workflowRuns } from "../../src/db/schema.js";

// SOLO-PLAN-1125: a founder's own Claude answers our LLM work about once an hour. A script whose LLM answer is not
// there yet WAITS (no worker held), and is resumed by the campaign's next dispatch, its call naming the job that holds
// the answer. Real Postgres (PGlite, real migrations), fictional data only.
const MIGRATIONS = join(__dirname, "../../drizzle");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

// The writer asks its model (the LLM completion Engine), which calls the completion door.
const WRITER = `export default function run(ctx) {
  const c = ctx.ask("llm_completion", { request: { message: "Write a hello to Ada", systemPrompt: "Be short" } });
  if (!c.content) return { unmade: "no completion: " + String(c.unmade) };
  return { content: { text: c.content.answer }, subject: { service: "lead-service", id: "lead-ada" } };
}`;
const COMPLETION = `export default function run(ctx) {
  const a = ctx.vendor.call("llm.complete", { message: ctx.request.message, systemPrompt: ctx.request.systemPrompt, provider: "anthropic", model: "sonnet" });
  if (!a.ok) throw new Error("completion refused: " + String(a.data.error));
  return { content: { answer: a.data.content } };
}`;

const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true, nameDynasties: testNamer() };
const ORG = "org-staff-test";

let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
  setScriptPickReader(fakeScriptPick());
  setScriptStrategyReader(async (_c, outcome) => (await db.select().from(scripts).where(eq(scripts.outcome, outcome))).map((r) => r.dynasty));
  setProofContext(null);
  await createScript(db, { outcome: "message_written", dynasty: "dy_writer", code: WRITER, description: "x" }, author, known);
  await createScript(db, { outcome: "llm_completion", dynasty: "dy_founder_claude", code: COMPLETION, description: "x" }, author, known);
}, 60_000);
afterEach(() => {
  setScriptPickReader(null);
  setScriptStrategyReader(null);
});

/** chat-service as a founder's hourly Claude makes it: job-1 queued at the first ask, answered at `answeredAt`. */
function slowClaude(answeredAt: number) {
  let clock = 0;
  const asks: Array<{ job: string | null; at: number }> = [];
  const complete: VendorDeps["complete"] = async (_body, headers) => {
    const job = headers[PENDING_ANSWER_JOB_HEADER] ?? null;
    asks.push({ job, at: clock });
    if (job === "job-1" && clock >= answeredAt) return { content: "Hello Ada!", model: "claude-sonnet-5-5", tokensInput: 10, tokensOutput: 3 };
    throw new AnswerPendingError({ jobId: job ?? "job-1", code: "local_runner_waiting", retryAfterSeconds: null }, "not there yet");
  };
  return { complete, asks, setClock: (m: number) => (clock = m) };
}

function world(complete: VendorDeps["complete"]) {
  const closed: Array<{ runId: string; status: string }> = [];
  const declared: Array<{ runId: string; body: unknown }> = [];
  const endRuns: Array<Record<string, unknown>> = [];
  let n = 0;
  const ledger: LedgerDeps = {
    async createRun() {
      return `run-${++n}`;
    },
    async declareOutcomes(runId, _o, body) {
      declared.push({ runId, body });
      return {};
    },
    async closeRun(runId, status) {
      closed.push({ runId, status });
    },
  };
  const vendors: VendorDeps = {
    complete,
    judge: async () => ({}),
    readSkill: async () => null,
    platformComplete: async () => ({}),
    platformJudge: async () => ({}),
    serviceDoor: async () => ({ status: 200, body: {} }),
  };
  const deps: EngineRunDeps = {
    ledger,
    campaign: {
      async call(path, _h, body) {
        if (path === "/gate-check") return { allowed: true };
        if (path === "/start-run") return { runId: "cs-run", brief: "Say hello" };
        if (path === "/end-run") endRuns.push(body);
        return { status: "ok" };
      },
    },
    runScript: (input, who, owned) => runStoredScript(db, { ...input, billing: "org" }, who, { ledger, vendors }, owned),
  };
  return { deps, closed, declared, endRuns };
}

const dispatch: EngineDispatch = {
  outcome: "message_written",
  fromOutcome: "start",
  orgId: ORG,
  userId: "user-1",
  callerRunId: "caller-run",
  campaignId: "camp-1",
  brandIdHeader: "brand-1",
  featureSlug: null,
  audienceId: null,
  inputs: {},
};

async function tick(w: ReturnType<typeof world>) {
  const reservation = await reserveCampaignExecution({
    database: db as never,
    workflow: null,
    orgId: ORG,
    userId: "user-1",
    campaignId: "camp-1",
    brandIds: ["brand-1"],
    featureSlug: "",
    inputs: { engineOutcome: dispatch.outcome },
    attributionContext: null,
    conflictPolicy: "reject",
    executionScope: "engine",
  });
  if (reservation.kind !== "reserved") throw new Error("conflict");
  const plan = await planEngineRun(db, dispatch);
  const runId = await w.deps.ledger.createRun({ parentRunId: "caller-run", orgId: ORG, userId: "user-1", taskName: planTaskName(dispatch, plan), headers: {} });
  await executeEngineRun(db, reservation.run.id, runId, dispatch, plan, w.deps);
  const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, reservation.run.id));
  return { plan, row: row! };
}

/** The campaign's dispatch comes back once the wait is due (the test moves the due date instead of the clock). */
async function makeWaitsDue() {
  await db.update(engineWaits).set({ dueAt: new Date(Date.now() - 1000) }).where(eq(engineWaits.status, "waiting"));
}

describe("a script whose LLM answer arrives 90 minutes later (SOLO-PLAN-1125)", () => {
  it("waits without failing, keeps the job, and completes its Unit with THAT job's answer once it lands", async () => {
    const claude = slowClaude(90);
    const w = world(claude.complete);

    // t = 0: the job is queued, nobody answered: the run waits, nothing failed, no Unit.
    const first = await tick(w);
    expect(first.plan.kind).toBe("pick");
    expect(w.closed.every((c) => c.status === "completed")).toBe(true);
    let [wait] = await db.select().from(engineWaits);
    expect(wait!.status).toBe("waiting");
    expect(wait!.pendingAnswers).toEqual([{ key: "llm_completion@0>llm.complete#0", jobId: "job-1", since: expect.any(String) }]);
    const since = (wait!.pendingAnswers as Array<{ since: string }>)[0]!.since;
    // looks again in about 10 minutes, never holds a worker
    expect(wait!.dueAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(w.endRuns[0]).toMatchObject({ noWorkAvailable: true });

    // t = 30 min: resumed, the same call names job-1: still not there, it waits again, from the same first wait.
    claude.setClock(30);
    await makeWaitsDue();
    const second = await tick(w);
    expect(second.plan.kind).toBe("resume");
    const waiting = await db.select().from(engineWaits).where(eq(engineWaits.status, "waiting"));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.pendingAnswers).toEqual([{ key: "llm_completion@0>llm.complete#0", jobId: "job-1", since }]);

    // t = 90 min: the founder's Claude answered job-1: the resumed run reads it and makes its Unit.
    claude.setClock(90);
    await makeWaitsDue();
    const third = await tick(w);
    expect(third.plan.kind).toBe("resume");
    expect(third.row.status).toBe("completed");
    expect(JSON.stringify(third.row.result)).toContain('"success":true');
    const made = (await db.select().from(scriptRuns)).filter((r) => r.status === "made");
    expect(made.map((r) => r.result)).toContainEqual({ outcome: "message_written", subject: { service: "lead-service", id: "lead-ada" }, content: { text: "Hello Ada!" } });
    expect(await db.select().from(engineWaits).where(eq(engineWaits.status, "waiting"))).toHaveLength(0);
    // ONE job for the whole wait: queued once, every later ask names it.
    expect(claude.asks).toEqual([
      { job: null, at: 0 },
      { job: "job-1", at: 30 },
      { job: "job-1", at: 90 },
    ]);
    // the Unit is declared on the ledger (the writer's message, about the lead)
    expect(JSON.stringify(w.declared)).toContain('"outcomeKey":"message_written"');
  });

  it("an answer there at once changes nothing: no wait, no job named", async () => {
    const asks: Array<string | undefined> = [];
    const w = world(async (_b, headers) => {
      asks.push(headers[PENDING_ANSWER_JOB_HEADER]);
      return { content: "Hi", model: "sonnet", tokensInput: 1, tokensOutput: 1 };
    });
    const { row } = await tick(w);
    expect(row.status).toBe("completed");
    expect(asks).toEqual([undefined]);
    expect(await db.select().from(engineWaits)).toHaveLength(0);
  });

  it("a run nothing can resume reads the pending answer as the refusal it was", async () => {
    const claude = slowClaude(90);
    const w = world(claude.complete);
    const out = await runStoredScript(
      db,
      { outcome: "llm_completion", dynasty: "dy_founder_claude", units: {}, request: { message: "m", systemPrompt: "s" }, fallbackSubject: { service: "runs-service", id: "r" } },
      { orgId: ORG, userId: "user-1", parentRunId: "p", headers: {} },
      { ledger: w.deps.ledger, vendors: { complete: claude.complete } as unknown as VendorDeps },
    ).catch((e: { result?: { status: string; error: string } }) => e.result);
    expect(out!.status).toBe("failed");
    expect(out!.error).toContain("not there yet");
  });
});

describe("reading a pending answer", () => {
  it("is a named state with a job, never any other refusal", () => {
    expect(pendingOf(503, { code: "local_runner_waiting", jobId: "j", retryable: true })).toEqual({ jobId: "j", code: "local_runner_waiting", retryAfterSeconds: null });
    expect(pendingOf(504, { code: "local_runner_timeout", jobId: "j", retryAfterSeconds: 3600 })).toMatchObject({ retryAfterSeconds: 3600 });
    expect(pendingOf(202, { status: "pending", jobId: "j" })).toMatchObject({ jobId: "j", code: "answer_pending" });
    expect(pendingOf(502, { code: "local_runner_failed", jobId: "j", retryable: false })).toBeNull();
    expect(pendingOf(503, { code: "local_runner_waiting", retryable: true })).toBeNull();
    expect(pendingOf(503, { code: "local_runner_waiting", jobId: "j", retryable: false })).toBeNull();
    expect(pendingOf(500, { error: "LLM call failed" })).toBeNull();
    expect(pendingOf(200, { content: "x", jobId: "j" })).toBeNull();
  });
  it("waits 10 minutes by default, the producer's own delay when stated (1 minute to 1 day)", () => {
    expect(recheckDays({ jobId: "j", code: "x", retryAfterSeconds: null }) * 1440).toBeCloseTo(10);
    expect(recheckDays({ jobId: "j", code: "x", retryAfterSeconds: 3600 }) * 24).toBeCloseTo(1);
    expect(recheckDays({ jobId: "j", code: "x", retryAfterSeconds: 5 }) * 1440).toBeCloseTo(1);
  });
  it("keeps every job of the run tree, the newest one at a place winning", () => {
    expect(mergePending([{ key: "a", jobId: "1", since: "s" }], [{ key: "b", jobId: "2", since: "t" }, { key: "a", jobId: "3", since: "s" }])).toEqual([
      { key: "a", jobId: "3", since: "s" },
      { key: "b", jobId: "2", since: "t" },
    ]);
  });
});
