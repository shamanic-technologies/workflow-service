import { buildAiInstantCallSource } from "../../scripts/engine-ports/ai-instant-call.js";
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, putCases, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { engineState, pickScript, sampleBeta, setScriptStrategyReader, switchEngine, switchEngineOff } from "../../src/lib/scripts/engine.js";
import { endRunBodyOf, executeEngineRun, planEngineRun, planTaskName, type EngineDispatch, type EngineRunDeps } from "../../src/lib/scripts/engine-runner.js";
import { reserveCampaignExecution } from "../../src/lib/execution-admission.js";
import { engineWaits, scriptRuns, scripts, workflowRuns } from "../../src/db/schema.js";

// MIGRATE-1105 S2: a Provider piece, on real Postgres (PGlite, real migrations), with the S0 engine-runner harness.
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
beforeEach(async () => {
  db = await freshDb();
  // The campaign's strategy keeps every script of the Engine (features-service's answer with no strategy).
  setScriptStrategyReader(async (_campaignId, outcome) => (await db.select().from(scripts).where(eq(scripts.outcome, outcome))).map((r) => r.dynasty));
}, 60_000);

function world(serve: Record<string, unknown> = { found: true, lead: { leadId: "lead-9", email: "a@staff.test" } }) {
  const calls: Array<{ path: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const runs: Array<{ taskName: string; headers: Record<string, string> }> = [];
  const closed: Array<{ runId: string; status: string }> = [];
  const declared: Array<{ runId: string; body: unknown }> = [];
  const doors: Array<{ path: string; headers: Record<string, string>; body: unknown }> = [];
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
  return { deps, calls, runs, closed, declared, doors, refuseGate: () => (gateAllowed = false) };
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


// MIGRATE-1105 S2, a Provider piece: `ctx.ask(request)` then `ctx.get(<outcome>)` on an outcome the run does not hold
// runs that Engine's Rating pick as a CHILD run (own run, own script_runs row), and hands its Unit back.
const PARENT = `
export default function run(ctx) {
  ctx.ask({ units: { brand_context: { content: { name: "Reed" } } }, recordedBy: "content-generation" });
  const written = ctx.get("message_written");
  return { content: { subject: written.content.subject, childRun: written.run.runId, childSlug: written.run.scriptSlug }, subject: { service: "lead-service", id: "lead-9" } };
}`;
const WRITER = `
export default function run(ctx) {
  const b = ctx.get("brand_context");
  return { content: { subject: "Hello from " + b.content.name } };
}`;

// MIGRATE-1105 S1b: the rep call, asked by the answering script, consumes the occurrence it was handed (as the old
// AI Instant Call workflow declared it: produced booking_call, consumed the positive reply / form fill, on the lead).
const CALL_ASKER = `
export default function run(ctx) {
  const t = ctx.request.trigger;
  ctx.ask({ units: { conversation: { content: t, subject: { service: "lead-service", id: t.leadId } } }, request: Object.assign({}, ctx.request, { campaignId: "camp-1", claimed: { found: true, followup: { id: "row-9", email: "a@staff.test", leadId: t.leadId, brandId: "brand-1" } } }) });
  const call = ctx.get("booking_call");
  return { unmade: "answered after the call: " + String(call.unmade || "rung") };
}`;

describe("an asked run consumes what the asking script handed it (MIGRATE-1105 S1b)", () => {
  const trigger = { eventId: "ev-9", leadId: "lead-9", person: { email: "a@staff.test" }, item: { channel: "email", replyText: "Yes" } };
  const serve = (rep: string | null) => ({ leadDetail: { lead: { firstName: "Ana" } }, brand: { name: "Reed" }, salesRepPhone: rep, callId: "call-1" });

  it("the rep call declares produced booking_call AND consumed the handed reply, on the lead (the old run's two rows)", async () => {
    await addScript("conversation", "dy_answer", CALL_ASKER, { asks: ["booking_call"] });
    await addScript("booking_call", "dy_ring_rep", buildAiInstantCallSource());
    const w = world(serve("+15550001111"));
    await runOnce(dispatch({ outcome: "conversation", inputs: { trigger } }), w);
    const child = (await db.select().from(scriptRuns)).find((r) => r.status === "made")!;
    expect(w.doors.map((d) => d.path)).toContain("/calls");
    expect(w.declared.find((d) => d.runId === child.runId)!.body).toEqual({
      produced: [{ outcomeKey: "booking_call", subjectService: "lead-service", subjectId: "lead-9" }],
      consumed: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "lead-9" }],
    });
  });

  it("a call refused (no rep phone) still consumed the reply it acted on; nothing produced", async () => {
    await addScript("conversation", "dy_answer", CALL_ASKER, { asks: ["booking_call"] });
    await addScript("booking_call", "dy_ring_rep", buildAiInstantCallSource());
    const w = world(serve(null));
    await runOnce(dispatch({ outcome: "conversation", inputs: { trigger } }), w);
    const child = (await db.select().from(scriptRuns)).find((r) => r.error?.startsWith("no_sales_rep_phone"))!;
    expect(child.status).toBe("unmade");
    expect(w.doors.map((d) => d.path)).not.toContain("/calls");
    expect(w.declared.find((d) => d.runId === child.runId)!.body).toEqual({ produced: [], consumed: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "lead-9" }] });
  });
});

describe("a script asks another Engine for a Unit (MIGRATE-1105 S2)", () => {
  it("runs the asked Engine's pick as a child run of the asking run and hands its Unit back", async () => {
    await addScript("conversation", "dy_cold", PARENT, { asks: ["message_written"] });
    await addScript("message_written", "dy_writer", WRITER);
    const w = world();
    const { plan, runId, row } = await runOnce(dispatch({ outcome: "conversation", featureSlug: "sales-cold-email-outreach" }), w);
    expect(plan.kind).toBe("pick");
    expect(row.status).toBe("completed");
    const child = w.runs.find((r) => r.taskName === "script:message_written/dy_writer");
    expect(child).toBeDefined();
    expect(child!.headers["x-workflow-slug"]).toBeUndefined();
    const all = await db.select().from(scriptRuns);
    const parentRow = all.find((r) => r.runId === runId)!;
    const childRow = all.find((r) => r.runId !== runId)!;
    expect(childRow.parentRunId).toBe(runId);
    expect(childRow.status).toBe("made");
    expect(parentRow.status).toBe("made");
    expect(parentRow.result).toMatchObject({ content: { subject: "Hello from Reed", childRun: childRow.runId, childSlug: "message_written/dy_writer/v1" } });
    // The child recorded by its service declares nothing itself.
    expect(w.declared.find((d) => d.runId === childRow.runId)).toBeUndefined();
    noWorkflowSlugAnywhere(w);
  });

  it("a script that does not state the ask is never picked for a run that does not hold the outcome", async () => {
    await addScript("conversation", "dy_cold", PARENT);
    await addScript("message_written", "dy_writer", WRITER);
    expect(await pickScript(db, { outcome: "conversation", servable: [], channel: null })).toBeNull();
  });

  it("refuses a get of an outcome not held and not asked for", async () => {
    await addScript("conversation", "dy_cold", `export default function run(ctx) { ctx.get("message_written"); return null; }`, { asks: ["message_written"] });
    await addScript("message_written", "dy_writer", WRITER);
    const w = world();
    const { runId } = await runOnce(dispatch({ outcome: "conversation" }), w);
    const [r] = await db.select().from(scriptRuns).where(eq(scriptRuns.runId, runId));
    expect(r!.status).toBe("stopped");
    expect(r!.error).toMatch(/not handed/);
    expect(w.runs.some((x) => x.taskName.startsWith("script:message_written"))).toBe(false);
  });

  it("answers no_script, named, when no script of the asked Engine can run (never a fallback, never a stop)", async () => {
    const ASKER = `
export default function run(ctx) {
  ctx.ask({ units: { brand_context: { content: { name: "Reed" } } } });
  const written = ctx.get("message_written");
  return { unmade: "asked: " + written.unmade + " content=" + JSON.stringify(written.content) };
}`;
    await addScript("conversation", "dy_cold", ASKER, { asks: ["message_written"] });
    await addScript("message_written", "dy_writer", `export default function run(ctx) { ctx.get("lead_identified"); return null; }`);
    const w = world();
    const { runId } = await runOnce(dispatch({ outcome: "conversation" }), w);
    const rows = await db.select().from(scriptRuns);
    expect(rows).toHaveLength(1);
    const [r] = rows.filter((x) => x.runId === runId);
    expect(r!.status).toBe("unmade");
    expect(r!.error).toBe("asked: no_script: no live script of that Engine can run on brand_context content=null");
    expect(w.runs.some((x) => x.taskName.startsWith("script:message_written"))).toBe(false);
  });

  it("hands an unmade child back as an answer the asking script reads (no stop, no redelivery)", async () => {
    const ASKER = `
export default function run(ctx) {
  ctx.ask({ units: { brand_context: { content: { name: "Reed" } } } });
  const written = ctx.get("message_written");
  if (written.unmade) return { unmade: "later: " + written.unmade };
  return { content: { subject: written.content.subject }, subject: { service: "lead-service", id: "lead-9" } };
}`;
    await addScript("conversation", "dy_cold", ASKER, { asks: ["message_written"] });
    await addScript("message_written", "dy_writer", `export default function run(ctx) { ctx.get("brand_context"); return { unmade: "they asked for January" }; }`);
    const w = world();
    const trigger = { eventId: "ev-9", leadId: "lead-9", item: {} };
    const { runId } = await runOnce(dispatch({ outcome: "conversation", fromOutcome: "start", inputs: { trigger } }), w);
    const rows = await db.select().from(scriptRuns);
    const parentRow = rows.find((x) => x.runId === runId)!;
    const childRow = rows.find((x) => x.runId !== runId)!;
    expect(childRow.status).toBe("unmade");
    expect(parentRow.status).toBe("unmade");
    expect(parentRow.error).toBe("later: they asked for January");
    // A normal run: the occurrence is settled (refused with the script's words), never redelivered.
    const end = w.calls.find((c) => c.path === "/end-run")!.body;
    expect(end.success).toBe(true);
  });

  it("stops the asking script with the child's reason when the child fails or would wait", async () => {
    await addScript("conversation", "dy_cold", PARENT, { asks: ["message_written"] });
    await addScript("message_written", "dy_writer", `export default function run(ctx) { ctx.get("brand_context"); ctx.wait(3); return null; }`);
    const w = world();
    const { runId } = await runOnce(dispatch({ outcome: "conversation" }), w);
    const rows = await db.select().from(scriptRuns);
    const parentRow = rows.find((x) => x.runId === runId)!;
    const childRow = rows.find((x) => x.runId !== runId)!;
    expect(childRow.status).toBe("stopped");
    expect(parentRow.status).toBe("stopped");
    expect(parentRow.error).toMatch(/message_written\/dy_writer\/v1 \(asked for message_written\) stopped: .*does not wait/);
    expect(w.closed.find((c) => c.runId === childRow.runId)?.status).toBe("failed");
  });
});

describe("a port replays with its own tactics (MIGRATE-1105 S2)", () => {
  it("merges the version's tactics under each case's, as a live run does", async () => {
    const code = `export default function run(ctx) { const r = ctx.vendor.call("lead.serve", ctx.tactics.serve); return { content: { found: r.data.found } }; }`;
    await putCases(db, "lead_found", "dy_t", [{ id: "c1", units: {}, calls: [{ name: "lead.serve", args: { relationships: "business_only" }, answer: { ok: true, data: { found: true } } }], expect: { content: { found: true } } }], "test");
    await expect(createScript(db, { outcome: "lead_found", dynasty: "dy_t", code, description: "x" }, author, known)).rejects.toThrow(/replay|matches 0/);
    const row = await createScript(db, { outcome: "lead_found", dynasty: "dy_t", code, description: "x", tactics: { serve: { relationships: "business_only" } } }, author, known);
    expect(row.replay).toEqual({ cases: 1, matches: 1 });
  });
});

describe("the audience chosen before the run reaches /start-run (MIGRATE-1105 S2, prod 2026-11-05)", () => {
  it("states the dispatch's audience on the campaign callbacks, so start-run files under the same one", async () => {
    await addScript("lead_found", "dy_serve", `export default function run(ctx) { return null; }`);
    const w = world();
    await runOnce(dispatch({ audienceId: "aud-pre" }), w);
    const start = w.calls.find((c) => c.path === "/start-run")!;
    expect(start.headers["x-audience-id"]).toBe("aud-pre");
    const w2 = world();
    await runOnce(dispatch({ audienceId: null, campaignId: "camp-2" }), w2);
    expect(w2.calls.find((c) => c.path === "/start-run")!.headers["x-audience-id"]).toBeUndefined();
  });
});
