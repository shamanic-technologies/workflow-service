import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, forkScript, putCases, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { engineState, pickScript, servesChannel, setScriptPickReader, setScriptStrategyReader, switchEngine, switchEngineOff } from "../../src/lib/scripts/engine.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { MAX_SCRIPTS_PER_RUN, endRunBodyOf, executeEngineRun, fallsThrough, planEngineRun, planTaskName, type EngineDispatch, type EngineRunDeps } from "../../src/lib/scripts/engine-runner.js";
import { reserveCampaignExecution } from "../../src/lib/execution-admission.js";
import { engineWaits, scriptRuns, scripts, workflowRuns } from "../../src/db/schema.js";

// MIGRATE-1105 S0: a campaign run executes its Engine's stored script, with no workflow: the SAME path for a proactive
// tick and a reactive occurrence, run on real Postgres (PGlite, real migrations).
const MIGRATIONS = join(__dirname, "../../drizzle");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

// A proactive find: asks lead-service for one person, names them in its Unit (lead-service records the find).
const SERVE = `
export default function run(ctx) {
  const r = ctx.vendor.call("lead.serve", ctx.tactics.serve || {});
  if (!r.ok) throw new Error("serve refused: " + String(r.data.error));
  if (r.data.found !== true) return { unmade: String(r.data.reason || "nobody") };
  return { content: { email: r.data.lead.email, brief: ctx.request.brief }, subject: { service: "lead-service", id: r.data.lead.leadId } };
}`;
// The same serve, stating an unfinished look as one to ask again soon.
const AGAIN_SERVE = `
export default function run(ctx) {
  const r = ctx.vendor.call("lead.serve", ctx.tactics.serve || {});
  if (!r.ok) throw new Error("serve refused: " + String(r.data.error));
  if (r.data.found !== true) return { unmade: String(r.data.reason || "nobody"), again: r.data.reason === "serve_timed_out" };
  return { content: { email: r.data.lead.email }, subject: { service: "lead-service", id: r.data.lead.leadId } };
}`;
// A reactive answer: reads the Unit a trigger pushed; waits when the person asked for later.
const ANSWER = `
export default function run(ctx) {
  const reply = ctx.get("conversation");
  if (reply.content.item && reply.content.item.later) ctx.wait(2);
  return { content: { answered: String(reply.content.item && reply.content.item.text) } };
}`;

const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true };
const ORG = "org-1";

let db: AnyPgDb;
let strategyAsks: Array<{ campaignId: string; outcome: string }> = [];
let picks = fakeScriptPick();
beforeEach(async () => {
  db = await freshDb();
  strategyAsks = [];
  // features-service's Rating: the candidates in the order asked unless a test scores them.
  picks = fakeScriptPick();
  setScriptPickReader(picks);
  // No strategy: the campaign keeps every script of the Engine (features-service's answer for a default play).
  setScriptStrategyReader(async (campaignId, outcome) => {
    strategyAsks.push({ campaignId, outcome });
    const rows = await db.select().from(scripts).where(eq(scripts.outcome, outcome));
    return rows.map((r) => r.dynasty);
  });
}, 60_000);

function world(serve: Record<string, unknown> = { found: true, lead: { leadId: "lead-9", email: "a@staff.test" } }) {
  const calls: Array<{ path: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const runs: Array<{ taskName: string; headers: Record<string, string> }> = [];
  const closed: Array<{ runId: string; status: string }> = [];
  const declared: Array<{ runId: string; body: unknown }> = [];
  const doors: Array<{ path: string; headers: Record<string, string>; body: unknown }> = [];
  const marks: Array<Record<string, unknown>> = [];
  let gateAllowed = true;
  const ledger: LedgerDeps = {
    async createRun(opts) {
      runs.push({ taskName: opts.taskName, headers: opts.headers });
      return `run-${runs.length}`;
    },
    async declareOutcomes(runId, _org, body) {
      declared.push({ runId, body });
      return {};
    },
    async closeRun(runId, status) {
      closed.push({ runId, status });
    },
    async markSupport(runId, mark) {
      marks.push({ runId, ...mark });
    },
  };
  const vendors: VendorDeps = {
    complete: async () => ({}),
    judge: async () => ({}),
    readSkill: async () => null,
    platformComplete: async () => ({}),
    platformJudge: async () => ({}),
    serviceDoor: async (_s, _m, path, body, headers) => {
      doors.push({ path, headers, body });
      return { status: 200, body: serve };
    },
  };
  const deps: EngineRunDeps = {
    ledger,
    campaign: {
      async call(path, headers, body) {
        calls.push({ path, headers, body });
        if (path === "/gate-check") return gateAllowed ? { allowed: true } : { allowed: false, reason: "Insufficient credits" };
        if (path === "/start-run") return { runId: "cs-run", audienceId: "aud-1", brief: "Book meetings with dentists", offerId: "offer-1" };
        return { status: "ok" };
      },
    },
    runScript: (input, who, owned) => runStoredScript(db, { ...input, billing: "org" }, who, { ledger, vendors }, owned),
  };
  return { deps, calls, runs, closed, declared, doors, marks, refuseGate: () => (gateAllowed = false) };
}

const dispatch = (over: Partial<EngineDispatch> = {}): EngineDispatch => ({
  outcome: "lead_found",
  fromOutcome: "start",
  orgId: ORG,
  userId: "user-1",
  callerRunId: "caller-run",
  campaignId: "camp-1",
  brandIdHeader: "brand-1",
  featureSlug: "lead-sourcing",
  audienceId: null,
  inputs: {},
  ...over,
});

/** What the execute route does: reserve, plan, open the run named by the plan, execute. */
async function runOnce(d: EngineDispatch, w: ReturnType<typeof world>) {
  const reservation = await reserveCampaignExecution({
    database: db as never,
    workflow: null,
    orgId: d.orgId,
    userId: d.userId,
    campaignId: d.campaignId,
    brandIds: [d.brandIdHeader],
    featureSlug: d.featureSlug ?? "",
    inputs: { ...d.inputs, engineOutcome: d.outcome },
    attributionContext: null,
    conflictPolicy: "reject",
    executionScope: "engine",
  });
  if (reservation.kind !== "reserved") throw new Error("conflict");
  const plan = await planEngineRun(db, d);
  const runId = await w.deps.ledger.createRun({ parentRunId: d.callerRunId, orgId: d.orgId, userId: d.userId, taskName: planTaskName(d, plan), headers: { "x-campaign-id": d.campaignId } });
  await executeEngineRun(db, reservation.run.id, runId, d, plan, w.deps);
  const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, reservation.run.id));
  return { plan, runId, row: row! };
}

async function addScript(outcome: string, dynasty: string, code: string, tactics: Record<string, unknown> = {}) {
  const row = await createScript(db, { outcome, dynasty, code, description: "x" }, author, known);
  if (Object.keys(tactics).length) await db.update(scripts).set({ tactics }).where(eq(scripts.id, row.id));
  return row;
}

const noWorkflowSlugAnywhere = (w: ReturnType<typeof world>) => {
  for (const c of w.calls) expect(c.headers["x-workflow-slug"]).toBeUndefined();
  for (const r of w.runs) expect(r.headers["x-workflow-slug"]).toBeUndefined();
  for (const d of w.doors) expect(d.headers["x-workflow-slug"]).toBeUndefined();
};

describe("an Engine switch", () => {
  it("lets one org in first, needs a proven port (or a script created from scratch) for every org, and an org's own row wins", async () => {
    expect(await engineState(db, "lead_found", ORG)).toMatchObject({ live: false, scope: null });
    await addScript("lead_found", "dy_serve", SERVE);
    // A port carrying cases it does not prove is refused for every org.
    await putCases(db, "lead_found", "dy_serve", [{ id: "c1", units: {}, calls: [{ name: "lead.serve", args: {}, answer: { ok: true, data: { found: false, reason: "audience_exhausted" } } }], expect: { fails: "audience_exhausted" } }], "test");
    await expect(switchEngine(db, { outcome: "lead_found", dynasty: "dy_serve" })).rejects.toThrow(/not proven/);
    await db.update(scripts).set({ replay: { cases: 1, matches: 1 } }).where(eq(scripts.dynasty, "dy_serve"));
    await switchEngine(db, { outcome: "lead_found", dynasty: "dy_serve", orgId: ORG });
    expect(await engineState(db, "lead_found", ORG)).toMatchObject({ live: true, scope: "org", provenOn: "dy_serve" });
    expect(await engineState(db, "lead_found", "org-2")).toMatchObject({ live: false });

    // A proven port goes to every org; the first org switched off stays off (its own row wins).
    await switchEngine(db, { outcome: "lead_found", dynasty: "dy_serve" });
    await switchEngineOff(db, { outcome: "lead_found", orgId: ORG, reason: "held back for a test" });
    expect(await engineState(db, "lead_found", "org-2")).toMatchObject({ live: true, scope: "fleet" });
    expect(await engineState(db, "lead_found", ORG)).toMatchObject({ live: false, scope: "org", rollbackReason: "held back for a test" });
  });

  it("switches every org on a script created from scratch with no case (SCRIPT-VALUE-RATING-1113-WF1), never on a fork without proof", async () => {
    await addScript("meeting_booked", "dy_path", SERVE);
    await switchEngine(db, { outcome: "meeting_booked", dynasty: "dy_path" });
    expect(await engineState(db, "meeting_booked", "org-2")).toMatchObject({ live: true, scope: "fleet", provenOn: "dy_path" });
    await forkScript(db, "meeting_booked", "dy_path", { dynasty: "dy_path_fork", description: "x" }, author);
    await expect(switchEngine(db, { outcome: "meeting_booked", dynasty: "dy_path_fork" })).rejects.toThrow(/created from scratch/);
  });

  it("refuses a port that does not replay all its cases", async () => {
    await addScript("lead_found", "dy_serve", SERVE);
    await putCases(db, "lead_found", "dy_serve", [{ id: "c1", units: {}, calls: [], expect: { content: {} } }], "test");
    await expect(switchEngine(db, { outcome: "lead_found", dynasty: "dy_serve", orgId: ORG })).rejects.toThrow(/not proven/);
  });
});

describe("a campaign run executes its Engine's script, with no workflow", () => {
  it("a proactive tick: gate, start, the script finds its subject, end-run, run named by the script", async () => {
    await addScript("lead_found", "dy_serve", SERVE, { recorded_by: "lead", serve: { relationships: "business_only" } });
    const w = world();
    const { plan, runId, row } = await runOnce(dispatch(), w);
    expect(plan.kind).toBe("pick");
    expect(w.runs[0]!.taskName).toBe("script:lead_found/dy_serve");
    expect(w.calls.map((c) => c.path)).toEqual(["/gate-check", "/start-run", "/end-run"]);
    expect(w.calls[0]!.headers).toMatchObject({ "x-run-id": runId, "x-campaign-id": "camp-1", "x-engine-outcome": "lead_found" });
    expect(w.calls[2]!.body).toEqual({ success: true, stopCampaign: false });
    // The script's vendor runs on the Engine run, with the audience start-run chose, and its tactic body.
    expect(w.doors[0]).toMatchObject({ path: "/orgs/buffer/next", body: { relationships: "business_only" } });
    expect(w.doors[0]!.headers).toMatchObject({ "x-run-id": runId, "x-audience-id": "aud-1", "x-campaign-id": "camp-1" });
    // lead-service records the find: the run declares nothing itself, then closes after the end-run.
    expect(w.declared).toEqual([]);
    expect(w.closed).toEqual([{ runId, status: "completed" }]);
    expect(row).toMatchObject({ status: "completed", workflowId: null, workflowSlug: null, windmillJobId: null, executionScope: "engine" });
    const [sr] = await db.select().from(scriptRuns);
    expect(sr).toMatchObject({ runId, parentRunId: "caller-run", status: "made" });
    noWorkflowSlugAnywhere(w);
  });

  it("says x-no-audience to /start-run only, when campaign-service decided no audience at its trigger (BOX-LOAD-1107)", async () => {
    await addScript("lead_found", "dy_serve", SERVE, { recorded_by: "lead" });
    const w = world();
    await runOnce(dispatch({ inputs: { noAudience: true } }), w);
    const byPath = Object.fromEntries(w.calls.map((c) => [c.path, c.headers]));
    expect(byPath["/start-run"]!["x-no-audience"]).toBe("true");
    expect(byPath["/gate-check"]!["x-no-audience"]).toBeUndefined();
    expect(byPath["/end-run"]!["x-no-audience"]).toBeUndefined();
    expect(w.doors[0]!.headers["x-no-audience"]).toBeUndefined();
  });

  it("says nothing extra when no decision rode the dispatch, or an audience did", async () => {
    await addScript("lead_found", "dy_serve", SERVE, { recorded_by: "lead" });
    for (const over of [{}, { audienceId: "aud-9", inputs: { noAudience: true } }]) {
      const w = world();
      await runOnce(dispatch(over), w);
      expect(w.calls.find((c) => c.path === "/start-run")!.headers["x-no-audience"]).toBeUndefined();
    }
  });

  it("a script stating a support function marks its run once it made its Unit (and the request carries the run's clock)", async () => {
    await addScript("lead_found", "dy_serve", SERVE, { recorded_by: "lead", support: { kind: "copilot", reason: "no outcome by design" } });
    const w = world();
    const { runId } = await runOnce(dispatch(), w);
    expect(w.marks).toEqual([{ runId, kind: "copilot", reason: "no outcome by design", markedBy: "workflow-service engine script:lead_found/dy_serve" }]);
    const none = world({ found: false, reason: "nobody" });
    await runOnce(dispatch({ campaignId: "camp-2" }), none);
    expect(none.marks).toEqual([]);
  });

  it("a population that ran out stops the audience; nobody else idles", async () => {
    await addScript("lead_found", "dy_serve", SERVE, { recorded_by: "lead" });
    const w = world({ found: false, reason: "audience_exhausted" });
    await runOnce(dispatch(), w);
    expect(w.calls[2]!.body).toEqual({ success: true, stopCampaign: true });
    expect(endRunBodyOf({ status: "unmade", error: "credit_insufficient" }, false)).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
    expect(endRunBodyOf({ status: "failed", error: "x" }, true)).toEqual({ success: false, stopCampaign: false });
  });

  it("an unfinished look (`again`) is a normal run, never idle; on an occurrence it states nothing about the person", async () => {
    await addScript("lead_found", "dy_serve", AGAIN_SERVE, { recorded_by: "lead" });
    const w = world({ found: false, reason: "serve_timed_out" });
    await runOnce(dispatch(), w);
    expect(w.calls[2]!.body).toEqual({ success: true, stopCampaign: false });
    expect(endRunBodyOf({ status: "unmade", error: "serve_timed_out", again: true }, true)).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
    expect(endRunBodyOf({ status: "unmade", error: "audience_exhausted", again: true }, false)).toEqual({ success: true, stopCampaign: true });
    expect(endRunBodyOf({ status: "unmade", error: "credit_insufficient" }, false)).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
  });

  it("a reactive occurrence: the SAME path, the pushed Unit is the script's material, the lead its subject", async () => {
    await addScript("meeting_booked", "dy_answer", ANSWER);
    const w = world();
    const trigger = { eventId: "ev-1", triggerId: "positive_reply_received", leadId: "lead-7", item: { text: "Friday 3pm works" } };
    const { runId } = await runOnce(dispatch({ outcome: "meeting_booked", fromOutcome: "conversation", featureSlug: "ai-meeting-booking", inputs: { trigger } }), w);
    expect(w.runs[0]!.taskName).toBe("script:meeting_booked/dy_answer");
    expect(w.calls[2]!.body).toEqual({ success: true, stopCampaign: false, delivery: { state: "delivered" } });
    expect(w.declared).toEqual([
      {
        runId,
        body: {
          produced: [{ outcomeKey: "meeting_booked", subjectService: "lead-service", subjectId: "lead-7" }],
          consumed: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "lead-7" }],
        },
      },
    ]);
    noWorkflowSlugAnywhere(w);
  });

  it("a reactive run with nothing pushed has no script it can run: it ends idle", async () => {
    await addScript("meeting_booked", "dy_answer", ANSWER);
    const w = world();
    const { plan } = await runOnce(dispatch({ outcome: "meeting_booked", fromOutcome: "conversation" }), w);
    expect(plan.kind).toBe("none");
    expect(w.runs[0]!.taskName).toBe("engine:meeting_booked");
    expect(w.calls.map((c) => c.path)).toEqual(["/gate-check", "/start-run", "/end-run"]);
    expect(w.calls[2]!.body).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
  });

  it("a gate refusal ends the run there, with no start and no end-run", async () => {
    await addScript("lead_found", "dy_serve", SERVE, { recorded_by: "lead" });
    const w = world();
    w.refuseGate();
    const { row, runId } = await runOnce(dispatch(), w);
    expect(w.calls.map((c) => c.path)).toEqual(["/gate-check"]);
    expect(w.doors).toEqual([]);
    expect(w.closed).toEqual([{ runId, status: "completed" }]);
    expect(row.status).toBe("completed");
  });

  it("a script that waits stops, holds no worker, and is resumed once due under the same pick", async () => {
    await addScript("meeting_booked", "dy_answer", ANSWER);
    const w = world();
    const trigger = { eventId: "ev-2", leadId: "lead-8", item: { text: "next month", later: true } };
    await runOnce(dispatch({ outcome: "meeting_booked", fromOutcome: "conversation", inputs: { trigger } }), w);
    expect(w.calls[2]!.body).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
    const [wait] = await db.select().from(engineWaits);
    expect(wait).toMatchObject({ status: "waiting", campaignId: "camp-1", subject: { service: "lead-service", id: "lead-8" } });
    expect(w.closed[0]!.status).toBe("completed");

    // Not due yet: the next dispatch (nothing pushed) does not take it.
    const early = await runOnce(dispatch({ outcome: "meeting_booked", fromOutcome: "conversation" }), world());
    expect(early.plan.kind).toBe("none");

    // Due: the next dispatch resumes it, on the same version and materials.
    await db.update(engineWaits).set({ dueAt: new Date(Date.now() - 1000) });
    const w2 = world();
    const later = await runOnce(dispatch({ outcome: "meeting_booked", fromOutcome: "conversation" }), w2);
    expect(later.plan.kind).toBe("resume");
    expect(w2.runs[0]!.taskName).toBe("script:meeting_booked/dy_answer");
    const [resumed] = await db.select().from(engineWaits).where(eq(engineWaits.id, wait!.id));
    expect(resumed).toMatchObject({ status: "resumed", resumedRunId: later.runId });
    // It asked to wait again (same materials): a new wait, the first one is done.
    expect((await db.select().from(engineWaits).where(eq(engineWaits.status, "waiting"))).length).toBe(1);
  });
});

describe("the Rating", () => {
  it("only offers scripts the run can feed and whose channel is the campaign's", async () => {
    await addScript("meeting_booked", "dy_answer", ANSWER);
    await addScript("meeting_booked", "dy_other_channel", ANSWER, { channel: "cold-whatsapp-outreach" });
    expect(await pickScript(db, { outcome: "meeting_booked", servable: [], channel: "ai-meeting-booking" })).toBeNull();
    const pick = await pickScript(db, { outcome: "meeting_booked", servable: ["conversation"], channel: "ai-meeting-booking" });
    expect(pick!.draws.map((d) => d.dynasty)).toEqual(["dy_answer"]);
  });

  it("a refusal stated as `<code>: <why>` reaches the occurrence as its code and its words", () => {
    expect(endRunBodyOf({ status: "unmade", error: "lead_opted_out: This person unsubscribed" }, true)).toEqual({
      success: true,
      stopCampaign: false,
      delivery: { state: "refused", code: "lead_opted_out", reason: "This person unsubscribed" },
    });
    expect(endRunBodyOf({ status: "unmade", error: "lead_opted_out" }, true)).toMatchObject({ delivery: { code: "lead_opted_out", reason: "lead_opted_out" } });
    expect(endRunBodyOf({ status: "unmade", error: "audience_exhausted: nobody left" }, false)).toEqual({ success: true, stopCampaign: true });
    expect(endRunBodyOf({ status: "unmade", error: "person_not_admitted: customer" }, true)).toEqual({ success: true, stopCampaign: false, personNotAdmitted: { reason: "customer" } });
  });

  it("a script's OWN decision is never a sender refusal (MON-UNSENT-RED-1111): done = completed, idle = nothing to do now", () => {
    // Answer lead's `later` / `stopped` / writer stop / escalate: the look did its work, no delivery stated.
    for (const error of ["later: Next working hour is 8:00am Chicago", "stopped: no_action_toward_us", "stop: their own words", "escalate: Price? (sales rep alerted)"]) {
      expect(endRunBodyOf({ status: "unmade", error, decided: "done" }, true)).toEqual({ success: true, stopCampaign: false });
      expect(endRunBodyOf({ status: "unmade", error, decided: "done" }, false)).toEqual({ success: true, stopCampaign: false });
    }
    // Nobody owed / relationship not judged yet: noWorkAvailable (campaign-service redelivers, bounded, then "nothing to do").
    for (const error of ["nobody_due: nothing_due", "nobody_due: relationship_pending"]) {
      expect(endRunBodyOf({ status: "unmade", error, decided: "idle" }, true)).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
    }
    // A refusal the world gave stays a refusal, byte for byte.
    expect(endRunBodyOf({ status: "unmade", error: "refused: lead_opted_out" }, true)).toEqual({ success: true, stopCampaign: false, delivery: { state: "refused", code: "refused", reason: "lead_opted_out" } });
    expect(endRunBodyOf({ status: "unmade", error: "no_channel" }, true)).toEqual({ success: true, stopCampaign: false, delivery: { state: "refused", code: "no_channel", reason: "no_channel" } });
  });

  it("an Engine serves a campaign's channel only when one of its scripts runs for it (else the campaign keeps its workflow)", async () => {
    expect(await servesChannel(db, "conversation", "email-sending")).toBe(false);
    await addScript("conversation", "dy_hello", ANSWER, { channel: "founder-hello" });
    expect(await servesChannel(db, "conversation", "email-sending")).toBe(false);
    expect(await servesChannel(db, "conversation", "founder-hello")).toBe(true);
    await addScript("conversation", "dy_any", ANSWER);
    expect(await servesChannel(db, "conversation", "email-sending")).toBe(true);
  });

  it("runs the script features-service picks, among exactly the candidates the run can feed (SCRIPT-VALUE-RATING-1113-WF2)", async () => {
    await addScript("lead_found", "dy_good", SERVE);
    await addScript("lead_found", "dy_bad", SERVE);
    await addScript("lead_found", "dy_other_channel", SERVE, { channel: "cold-whatsapp-outreach" });
    for (const [scores, winner] of [[{ dy_bad: 2, dy_good: 1 }, "dy_bad"], [{ dy_good: 3, dy_bad: 1 }, "dy_good"]] as const) {
      picks = fakeScriptPick(scores);
      setScriptPickReader(picks);
      const pick = await pickScript(db, { outcome: "lead_found", servable: [], channel: null });
      expect(pick!.script.dynasty).toBe(winner);
      expect(pick!.ranked.map((r) => r.dynasty)).toEqual(pick!.draws.map((d) => d.dynasty));
      expect(pick!.basis).toBe("value_per_dollar");
      expect(picks.calls).toEqual([{ outcome: "lead_found", dynasties: ["lead_found/dy_bad", "lead_found/dy_good"] }]);
    }
  });

  it("an unreadable pick runs nothing: the run is never opened and campaign-service retries", async () => {
    await addScript("lead_found", "dy_good", SERVE);
    setScriptPickReader(async () => {
      throw new Error("the script pick could not be read (features-service 502)");
    });
    await expect(pickScript(db, { outcome: "lead_found", servable: [], channel: null })).rejects.toThrow(/502/);
    await expect(planEngineRun(db, dispatch())).rejects.toThrow(/502/);
  });

  it("a pick that does not rank exactly the candidates asked is refused, never run on a guess", async () => {
    await addScript("lead_found", "dy_good", SERVE);
    await addScript("lead_found", "dy_bad", SERVE);
    const answers = [
      { scriptDynasty: "lead_found/dy_ghost", basis: "cost_only", candidates: [{ scriptDynasty: "lead_found/dy_ghost", runs: 0, score: null }] },
      { scriptDynasty: "lead_found/dy_good", basis: "cost_only", candidates: [{ scriptDynasty: "lead_found/dy_good", runs: 0, score: null }] },
      { scriptDynasty: null, basis: "no_candidate", candidates: [] },
    ];
    for (const a of answers) {
      setScriptPickReader(async () => a);
      await expect(pickScript(db, { outcome: "lead_found", servable: [], channel: null })).rejects.toThrow(/does not rank exactly/);
    }
  });
});

describe("the Rating's pick has nothing to make for this campaign (RATING-UNMADE-FALLTHROUGH-1112)", () => {
  // The top-rated script fleet-wide: it serves people this campaign already contacted, and a brand-new campaign has none.
  const OWED = `
export default function run(ctx) {
  if (ctx.request.campaignId === "camp-owes") return { content: { owed: true }, subject: { service: "lead-service", id: "lead-owed" } };
  return { unmade: "nobody_owed" };
}`;
  async function twoScripts(top = OWED) {
    const a = await addScript("lead_found", "dy_top", top, { recorded_by: "lead" });
    const b = await addScript("lead_found", "dy_lower", SERVE, { recorded_by: "lead" });
    // features-service rates A above B: A wins every pick.
    picks = fakeScriptPick({ dy_top: 2, dy_lower: 1 });
    setScriptPickReader(picks);
    return { a, b };
  }

  it("the campaign gets the next candidate's Unit in the same run, on a child run named by that script", async () => {
    await twoScripts();
    const w = world();
    const { plan, runId, row } = await runOnce(dispatch(), w);
    expect(plan.kind === "pick" && plan.script.dynasty).toBe("dy_top");
    expect(w.runs.map((r) => r.taskName)).toEqual(["script:lead_found/dy_top", "script:lead_found/dy_lower"]);
    const child = "run-2";
    expect(w.doors[0]!.headers).toMatchObject({ "x-run-id": child, "x-campaign-id": "camp-1", "x-audience-id": "aud-1" });
    expect(w.calls.map((c) => c.path)).toEqual(["/gate-check", "/start-run", "/end-run"]);
    expect(w.calls[2]!.body).toEqual({ success: true, stopCampaign: false });
    expect(w.closed).toEqual([{ runId: child, status: "completed" }, { runId, status: "completed" }]);
    const runsByStatus = (await db.select().from(scriptRuns).where(eq(scriptRuns.orgId, ORG))).map((r) => `${r.runId} ${r.status}`).sort();
    expect(runsByStatus).toEqual([`${runId} unmade`, `${child} made`].sort());
    expect(row.result).toMatchObject({ script: "lead_found/dy_lower/v1", status: "made", tried: [{ status: "unmade" }, { status: "made" }] });
  });

  it("the top script keeps winning, alone, for a campaign where it makes", async () => {
    await twoScripts();
    for (let i = 0; i < 10; i++) {
      const w = world();
      const { runId } = await runOnce(dispatch({ campaignId: "camp-owes" }), w);
      expect(w.runs.map((r) => r.taskName)).toEqual(["script:lead_found/dy_top"]);
      expect(w.doors).toEqual([]);
      expect(w.closed).toEqual([{ runId, status: "completed" }]);
      await db.delete(workflowRuns);
    }
  });

  it("one script's spent population never stops a campaign; every tried script spent does", async () => {
    await twoScripts();
    const w = world({ found: false, reason: "audience_exhausted" });
    await runOnce(dispatch(), w);
    expect(w.runs.length).toBe(2);
    expect(w.calls[2]!.body).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });

    await db.delete(scripts);
    await db.delete(workflowRuns);
    await addScript("lead_found", "dy_a", SERVE, { recorded_by: "lead" });
    await addScript("lead_found", "dy_b", SERVE, { recorded_by: "lead" });
    const spent = world({ found: false, reason: "audience_exhausted" });
    await runOnce(dispatch(), spent);
    expect(spent.runs.length).toBe(2);
    expect(spent.calls[2]!.body).toEqual({ success: true, stopCampaign: true });
  });

  it("a script's own decision, an unfinished look, a failure or an occurrence never fall through", () => {
    expect(fallsThrough({ status: "unmade" }, false)).toBe(true);
    expect(fallsThrough({ status: "unmade", decided: "idle" }, false)).toBe(true);
    expect(fallsThrough({ status: "nothing" }, false)).toBe(true);
    expect(fallsThrough({ status: "unmade", decided: "done" }, false)).toBe(false);
    expect(fallsThrough({ status: "unmade", again: true }, false)).toBe(false);
    expect(fallsThrough({ status: "unmade" }, true)).toBe(false);
    for (const status of ["made", "waiting", "failed", "stopped"] as const) expect(fallsThrough({ status }, false)).toBe(false);
    expect(fallsThrough(null, false)).toBe(false);
  });

  it("tries at most MAX_SCRIPTS_PER_RUN scripts, in the order of one pick", async () => {
    for (let i = 0; i < MAX_SCRIPTS_PER_RUN + 2; i++) await addScript("lead_found", `dy_${i}`, OWED, { recorded_by: "lead" });
    picks = fakeScriptPick(Object.fromEntries(Array.from({ length: MAX_SCRIPTS_PER_RUN + 2 }, (_, i) => [`dy_${i}`, i])));
    setScriptPickReader(picks);
    const pick = await pickScript(db, { outcome: "lead_found", servable: [], channel: null });
    expect(pick!.ranked.map((r) => r.dynasty)).toEqual(Array.from({ length: MAX_SCRIPTS_PER_RUN + 2 }, (_, i) => `dy_${MAX_SCRIPTS_PER_RUN + 1 - i}`));
    expect(pick!.ranked[0]!.dynasty).toBe(pick!.script.dynasty);
    const w = world();
    const { row } = await runOnce(dispatch(), w);
    expect(w.runs.length).toBe(MAX_SCRIPTS_PER_RUN);
    expect(w.calls[2]!.body).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
    expect(row.status).toBe("completed");
  });
});

describe("the campaign's strategy", () => {
  it("keeps only the scripts features-service says it keeps, for this campaign and Engine", async () => {
    await addScript("lead_found", "dy_cold", SERVE, { recorded_by: "lead" });
    await addScript("lead_found", "dy_followup_due", SERVE, { recorded_by: "lead" });
    setScriptStrategyReader(async (campaignId, outcome) => {
      strategyAsks.push({ campaignId, outcome });
      return ["dy_followup_due"];
    });
    for (let i = 0; i < 20; i++) {
      const pick = await pickScript(db, { outcome: "lead_found", servable: [], channel: null, campaignId: "camp-1" });
      expect(pick!.script.dynasty).toBe("dy_followup_due");
    }
    expect(strategyAsks[0]).toEqual({ campaignId: "camp-1", outcome: "lead_found" });
    const w = world();
    strategyAsks = [];
    await runOnce(dispatch(), w);
    expect(w.runs[0]!.taskName).toBe("script:lead_found/dy_followup_due");
    expect(strategyAsks).toContainEqual({ campaignId: "camp-1", outcome: "lead_found" });
  });

  it("keeps nothing = no script runs, and an unreadable strategy runs nothing", async () => {
    await addScript("lead_found", "dy_cold", SERVE, { recorded_by: "lead" });
    setScriptStrategyReader(async () => []);
    expect(await pickScript(db, { outcome: "lead_found", servable: [], channel: null, campaignId: "camp-1" })).toBeNull();
    setScriptStrategyReader(async () => {
      throw new Error("features-service 502");
    });
    await expect(pickScript(db, { outcome: "lead_found", servable: [], channel: null, campaignId: "camp-1" })).rejects.toThrow(/502/);
    expect((await pickScript(db, { outcome: "lead_found", servable: [], channel: null }))!.script.dynasty).toBe("dy_cold");
    // A campaign whose strategy keeps no script keeps its workflow (the execute answers engine_not_live).
    setScriptStrategyReader(async () => []);
    expect(await servesChannel(db, "lead_found", null, "camp-1")).toBe(false);
    setScriptStrategyReader(async () => ["dy_cold"]);
    expect(await servesChannel(db, "lead_found", null, "camp-1")).toBe(true);
  });
});

describe("one mechanism for every Engine", () => {
  it("the runner and the Rating name no outcome, slug or channel, and send no workflow slug", () => {
    for (const f of ["src/lib/scripts/engine.ts", "src/lib/scripts/engine-runner.ts", "src/routes/engines.ts"]) {
      const code = readFileSync(join(__dirname, "../..", f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code).not.toMatch(/x-workflow-slug/);
      expect(code).not.toMatch(/["'](lead_found|message_written|meeting_booked|conversation|paid_client|email_found|lead_interested|message_sent)["']/);
    }
  });
});
