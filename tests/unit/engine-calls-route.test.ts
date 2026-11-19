import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { testNamer } from "../helpers/script-names.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { engineCalls, scripts } from "../../src/db/schema.js";
import { runStoredScript, type LedgerDeps, type RunScriptInput, type RunIdentity, type ScriptRunResult } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";

// DISTRY-PRINCIPAL-1119: Distry asks any Engine for one Unit: the Rating picks the script (the SAME pickScript a
// campaign run calls), it runs on a child of the caller's run, and the caller waits or polls; plus the Engine list.
const MIGRATIONS = join(__dirname, "../../drizzle");
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../../src/db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));

const engine = await import("../../src/lib/scripts/engine.js");
const calls = await import("../../src/lib/scripts/engine-calls.js");
const { default: enginesRoutes, setEngineCallDepsFactory } = await import("../../src/routes/engines.js");

async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true, nameDynasties: testNamer() };
const KEY = "test-key";
const OUTCOME = "x_account_found";

// Makes a Unit from the Request it reads (the clock and the brand a campaign run would carry).
const MAKES = `
export default function run(ctx) {
  return { content: { at: ctx.request.now, brands: ctx.request.brandIds, topic: ctx.request.topic || null }, subject: { service: "social-service", id: "acct-1" } };
}`;
// Names no subject: the Unit is about the caller's run (as an asked script's is).
const NO_SUBJECT = `
export default function run(ctx) {
  return { content: { answer: "ready" } };
}`;
// Has nothing to make here.
const NOTHING = `
export default function run(ctx) {
  return { unmade: "nobody_found: no account matched" };
}`;
// Reads a handed Unit.
const READS_LEAD = `
export default function run(ctx) {
  const lead = ctx.get("lead_found");
  return { content: { email: lead.content.email }, subject: { service: "lead-service", id: "lead-staff" } };
}`;

// Serves a lead to the campaign its run is for: lead-service refuses a run that names no campaign.
const SERVES_CAMPAIGN = `
export default function run(ctx) {
  const r = ctx.vendor.call(ctx, "lead.serve", { body: {} });
  return { content: { lead: r }, subject: { service: "lead-service", id: "lead-x" } };
}`;

let db: AnyPgDb;
let app: express.Express;
let ledgerCalls: unknown[][];
let runs: Array<{ input: RunScriptInput; who: RunIdentity }>;
let runIds: number;
const ledger: LedgerDeps = {
  async createRun(o) {
    ledgerCalls.push(["create", o]);
    return `run-script-${++runIds}`;
  },
  async declareOutcomes(runId, orgId, body) {
    ledgerCalls.push(["declare", { runId, orgId, body }]);
    return {};
  },
  async closeRun(runId, status) {
    ledgerCalls.push(["close", { runId, status }]);
  },
};
const vendors = {} as VendorDeps;

beforeEach(async () => {
  process.env.WORKFLOW_SERVICE_API_KEY = KEY;
  db = await freshDb();
  holder.db = db;
  engine.setScriptStrategyReader(async () => {
    throw new Error("no campaign strategy is read: a call names no campaign");
  });
  engine.setScriptPickReader(fakeScriptPick({ dy_finds: 2, dy_empty: 3 }));
  engine.setLlmServingReader(async (_org, llms) => new Map(llms.map((l) => [`${l.provider}/${l.model}`, true])));
  calls.setCatalogueOutcomesReader(async () => [
    { key: OUTCOME, name: "X account found" },
    { key: "email_sent", name: "Email sent" },
    { key: "meeting_booked", name: "Meeting booked" },
    { key: "start", name: "Start" },
  ]);
  ledgerCalls = [];
  runs = [];
  runIds = 0;
  setEngineCallDepsFactory(() => ({
    run: (input, who) => {
      runs.push({ input, who });
      return runStoredScript(db, input, who, { ledger, vendors });
    },
  }));
  app = express();
  app.use(express.json());
  app.use(enginesRoutes);
}, 60_000);

afterEach(() => {
  setEngineCallDepsFactory(null);
  calls.setCatalogueOutcomesReader(null);
});

const add = (outcome: string, dynasty: string, code: string, tactics: Record<string, unknown> = {}) =>
  createScript(db, { outcome, dynasty, code, description: "x", tactics }, author, known);

const call = (outcome: string, body: Record<string, unknown>, headers: Record<string, string> = { "x-run-id": "distry-run-1", "x-org-id": "org-staff-test", "x-brand-id": "brand-reed" }) =>
  request(app).post(`/internal/engines/${outcome}/calls`).set("x-api-key", KEY).set(headers).send(body);

describe("POST /internal/engines/{outcome}/calls", { timeout: 60_000 }, () => {
  it("pick -> run -> result: the Rating's script runs on a child of the caller's run, org-billed, and its Unit comes back", async () => {
    await add(OUTCOME, "dy_finds", MAKES);
    const res = await call(OUTCOME, { request: { topic: "dentists" }, waitSeconds: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: OUTCOME, status: "made", ended: true, error: null, pick: { dynasty: "dy_finds", version: 1 } });
    expect(res.body.unit).toMatchObject({ outcome: OUTCOME, subject: { service: "social-service", id: "acct-1" }, content: { brands: ["brand-reed"], topic: "dentists" } });
    expect(typeof res.body.unit.content.at).toBe("string");
    expect(runs[0]!.input).toMatchObject({ outcome: OUTCOME, dynasty: "dy_finds", version: 1, billing: "org" });
    expect(runs[0]!.who).toMatchObject({ orgId: "org-staff-test", parentRunId: "distry-run-1" });
    expect(ledgerCalls[0]).toEqual(["create", expect.objectContaining({ parentRunId: "distry-run-1", orgId: "org-staff-test", taskName: `script:${OUTCOME}/dy_finds` })]);
    // Declared through the shared path like a campaign's script run: produced on the Unit's subject.
    expect(ledgerCalls.find((c) => c[0] === "declare")).toBeTruthy();
    const [row] = await db.select().from(engineCalls).where(eq(engineCalls.id, res.body.callId));
    expect(row!.status).toBe("made");
    // Read back by its org, never another's.
    const back = await request(app).get(`/internal/engine-calls/${res.body.callId}`).set("x-api-key", KEY).set("x-org-id", "org-staff-test");
    expect(back.status).toBe(200);
    expect(back.body.status).toBe("made");
    expect((await request(app).get(`/internal/engine-calls/${res.body.callId}`).set("x-api-key", KEY).set("x-org-id", "org-other")).status).toBe(404);
  });

  it("a Unit naming no subject is about the caller's run; a script whose tactic says recorded_by declares nothing itself", async () => {
    await add(OUTCOME, "dy_finds", NO_SUBJECT);
    const res = await call(OUTCOME, { waitSeconds: 30 });
    expect(res.body).toMatchObject({ status: "made", error: null });
    const declared = ledgerCalls.find((c) => c[0] === "declare")![1] as { body: { produced: unknown[] } };
    expect(declared.body.produced).toEqual([{ outcomeKey: OUTCOME, subjectService: "runs-service", subjectId: "distry-run-1" }]);
    await add("email_sent", "dy_social", NO_SUBJECT, { recorded_by: "social" });
    ledgerCalls = [];
    const owned = await call("email_sent", { waitSeconds: 30 });
    expect(owned.body).toMatchObject({ status: "made", error: null });
    expect(runs.at(-1)!.input.recordedBy).toBe("social");
    expect(ledgerCalls.find((c) => c[0] === "declare")).toBeUndefined();
  });

  it("the Rating's pick has nothing to make: its next candidate is asked, in the same draw's order (the campaign rule)", async () => {
    await add(OUTCOME, "dy_finds", MAKES);
    await add(OUTCOME, "dy_empty", NOTHING);
    const res = await call(OUTCOME, { waitSeconds: 30 });
    expect(res.status).toBe(200);
    expect(res.body.pick.dynasty).toBe("dy_empty");
    expect(res.body.status).toBe("made");
    expect(res.body.tried.map((t: { script: string; status: string }) => `${t.script} ${t.status}`)).toEqual([`${OUTCOME}/dy_empty/v1 unmade`, `${OUTCOME}/dy_finds/v1 made`]);
  });

  it("a named failure when no script makes it: the reason comes back, never a guessed Unit", async () => {
    await add(OUTCOME, "dy_empty", NOTHING);
    const res = await call(OUTCOME, { waitSeconds: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "unmade", unit: null, error: "nobody_found: no account matched" });
  });

  it("not callable: 404 no_runnable_script (no script, or none fed by what was handed); 502 when the pick is unreadable", async () => {
    const none = await call("meeting_booked", {});
    expect(none.status).toBe(404);
    expect(none.body.code).toBe("no_runnable_script");
    await add("email_sent", "dy_reads_lead", READS_LEAD);
    const unfed = await call("email_sent", {});
    expect(unfed.status).toBe(404);
    const fed = await call("email_sent", { units: { lead_found: { content: { email: "staff@distribute.you" } } }, waitSeconds: 30 });
    expect(fed.status).toBe(200);
    expect(fed.body).toMatchObject({ status: "made", error: null });
    expect(fed.body.unit.content.email).toBe("staff@distribute.you");
    engine.setScriptPickReader(async () => {
      throw new Error("features-service 502");
    });
    const unread = await call("email_sent", { units: { lead_found: { content: { email: "x" } } } });
    expect(unread.status).toBe(502);
    expect(unread.body.code).toBe("script_pick_unreadable");
    expect((await call(OUTCOME, {}, { "x-org-id": "org-a" })).status).toBe(400);
    expect((await call(OUTCOME, {}, { "x-run-id": "r" })).status).toBe(400);
  });

  it("timeout: a long script answers 202 running after waitSeconds, and the poll returns the Unit once it ends", async () => {
    await add(OUTCOME, "dy_finds", MAKES);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setEngineCallDepsFactory(() => ({
      run: async (input, who): Promise<ScriptRunResult> => {
        await gate;
        return runStoredScript(db, input, who, { ledger, vendors });
      },
    }));
    const started = await call(OUTCOME, { waitSeconds: 0 });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ status: "running", ended: false, unit: null });
    const still = await request(app).get(`/internal/engine-calls/${started.body.callId}?waitSeconds=1`).set("x-api-key", KEY).set("x-org-id", "org-staff-test");
    expect(still.body.ended).toBe(false);
    release();
    const ended = await request(app).get(`/internal/engine-calls/${started.body.callId}?waitSeconds=10`).set("x-api-key", KEY).set("x-org-id", "org-staff-test");
    expect(ended.body).toMatchObject({ status: "made", ended: true });
    expect((await request(app).get(`/internal/engine-calls/${started.body.callId}?waitSeconds=999`).set("x-api-key", KEY).set("x-org-id", "org-staff-test")).status).toBe(400);
  });

  it("a call a dead process left running is closed failed at boot, with a reason its caller reads", async () => {
    const [row] = await db.insert(engineCalls).values({ outcome: OUTCOME, orgId: "org-staff-test", callerRunId: "r", pick: {}, createdAt: new Date(Date.now() - 60_000) }).returning();
    const [fresh] = await db.insert(engineCalls).values({ outcome: OUTCOME, orgId: "org-staff-test", callerRunId: "r", pick: {} }).returning();
    expect(await calls.closeOrphanEngineCalls(db, new Date(Date.now() - 1000))).toBe(1);
    const back = await request(app).get(`/internal/engine-calls/${row!.id}`).set("x-api-key", KEY).set("x-org-id", "org-staff-test");
    expect(back.body).toMatchObject({ status: "failed", ended: true });
    expect(back.body.error).toMatch(/restarted/);
    const [still] = await db.select().from(engineCalls).where(eq(engineCalls.id, fresh!.id));
    expect(still!.status).toBe("running");
  });
});

describe("GET /internal/engines", () => {
  it("every catalogue outcome, callable or not and why in plain words, and what a caller hands", async () => {
    await add(OUTCOME, "dy_finds", MAKES, { channel: "x-posts" });
    await add("email_sent", "dy_reads_lead", READS_LEAD);
    const retired = await add("meeting_booked", "dy_old", MAKES);
    await db.update(scripts).set({ dynastyStatus: "deprecated", status: "deprecated" }).where(eq(scripts.id, retired.id));
    const res = await request(app).get("/internal/engines").set("x-api-key", KEY);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3); // `start` is not an outcome
    expect(res.body.callable).toBe(2);
    const by = new Map(res.body.engines.map((e: { outcome: string }) => [e.outcome, e]));
    expect(by.get(OUTCOME)).toMatchObject({ name: "X account found", callable: true, reason: null, inputs: [{ units: [], channel: "x-posts" }], counts: { scripts: 1, live: 1, runnable: 1 } });
    expect(by.get("email_sent")).toMatchObject({ callable: true, inputs: [{ units: ["lead_found"], channel: null }] });
    expect(by.get("meeting_booked")).toMatchObject({ callable: false, reason: "Every script of this outcome is retired (1 stored).", inputs: [] });
  });

  it("an outcome with no script says so; an unreadable catalogue is a named 502", async () => {
    let res = await request(app).get("/internal/engines").set("x-api-key", KEY);
    expect(res.body.engines.every((e: { callable: boolean; reason: string }) => !e.callable && e.reason === "No script makes this outcome yet.")).toBe(true);
    calls.setCatalogueOutcomesReader(async () => {
      throw new Error("features-service 503");
    });
    res = await request(app).get("/internal/engines").set("x-api-key", KEY);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("engine_list_unreadable");
  });

  it("a reason staff stated for an Engine no script makes is shown as-is; a moved dynasty says where it went (DISTRY-ENGINES-1119)", async () => {
    const reason = "We run no ads yet: no ad account is connected, so nothing can show an ad.";
    let res = await request(app).put("/internal/engines/meeting_booked/reason").set("x-api-key", KEY).set("x-email", "staff@example.com").send({ reason });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "meeting_booked", reason, statedBy: "staff@example.com" });
    res = await request(app).get("/internal/engines").set("x-api-key", KEY);
    expect(res.body.engines.find((e: { outcome: string }) => e.outcome === "meeting_booked")).toMatchObject({ callable: false, reason });
    // A runnable script wins over the stated reason.
    await add("meeting_booked", "dy_now_runs", MAKES);
    res = await request(app).get("/internal/engines").set("x-api-key", KEY);
    expect(res.body.engines.find((e: { outcome: string }) => e.outcome === "meeting_booked")).toMatchObject({ callable: true, reason: null });
    expect((await request(app).delete("/internal/engines/meeting_booked/reason").set("x-api-key", KEY)).status).toBe(204);
    expect((await request(app).delete("/internal/engines/meeting_booked/reason").set("x-api-key", KEY)).status).toBe(404);
    expect((await request(app).put("/internal/engines/meeting_booked/reason").set("x-api-key", KEY).send({ reason })).status).toBe(400); // nobody stated it
    // A dynasty retired here that runs under another outcome: the reason names where.
    const moved = await add("email_sent", "dy_moved", MAKES);
    await db.update(scripts).set({ dynastyStatus: "deprecated", status: "deprecated" }).where(eq(scripts.id, moved.id));
    await add(OUTCOME, "dy_moved", MAKES);
    res = await request(app).get("/internal/engines").set("x-api-key", KEY);
    expect(res.body.engines.find((e: { outcome: string }) => e.outcome === "email_sent")).toMatchObject({ callable: false, reason: "Its scripts moved to X account found, which make this work now: ask that Engine instead." });
  });

  it("plain reasons for live scripts that cannot run", () => {
    expect(calls.notCallableReason({ scripts: 2, live: 2, unprovenPorts: 1, awaitingWriterProof: 1 })).toBe(
      "None of its 2 live scripts can run now: 1 not yet proven on their recorded cases, 1 waiting to pass their writing proof before writing to people.",
    );
  });
});

describe("DISTRY-ENGINE-CALL-CAMPAIGN-1119: a script that needs its run's campaign is never callable outside one", { timeout: 60_000 }, () => {
  it("only campaign scripts: the list says not callable with a plain reason, and a call is a 404, never a failed run", async () => {
    await add("lead_found", "dy_lead_serve_crm_phone", SERVES_CAMPAIGN, { channel: "sourcing-crm-contacts" });
    await add("lead_found", "dy_lead_serve_crm_everyone", SERVES_CAMPAIGN);
    calls.setCatalogueOutcomesReader(async () => [{ key: "lead_found", name: "Lead found" }]);
    const list = await request(app).get("/internal/engines").set("x-api-key", KEY);
    const [lead] = list.body.engines;
    expect(lead).toMatchObject({
      outcome: "lead_found",
      callable: false,
      reason: "None of its 2 live scripts can run now: 2 only run inside a campaign (they serve or answer that campaign's people).",
      inputs: [],
      scripts: [],
      counts: { scripts: 2, live: 2, runnable: 0, needCampaign: 2 },
    });
    for (const body of [{ channel: "sourcing-crm-contacts" }, {}]) {
      const res = await call("lead_found", body);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("no_runnable_script");
    }
    expect(runs).toHaveLength(0);
  });

  it("a mix: the list shows only the campaign-free script and the pick draws it, whatever the Rating ranks first", async () => {
    engine.setScriptPickReader(fakeScriptPick({ dy_serve: 9, dy_finds: 1 }));
    await add(OUTCOME, "dy_serve", SERVES_CAMPAIGN);
    await add(OUTCOME, "dy_finds", MAKES);
    const list = await request(app).get("/internal/engines").set("x-api-key", KEY);
    const x = list.body.engines.find((e: { outcome: string }) => e.outcome === OUTCOME);
    expect(x).toMatchObject({ callable: true, counts: { live: 2, runnable: 1, needCampaign: 1 } });
    expect(x.scripts.map((s: { dynasty: string }) => s.dynasty)).toEqual(["dy_finds"]);
    const res = await call(OUTCOME, { waitSeconds: 30 });
    expect(res.body).toMatchObject({ status: "made", pick: { dynasty: "dy_finds" } });
    expect(res.body.tried).toHaveLength(1);
  });

  it("a campaign run still draws it; a pick for no campaign never does", async () => {
    await add("lead_found", "dy_serve", SERVES_CAMPAIGN);
    expect((await engine.candidatesOf(db, { outcome: "lead_found", servable: [], channel: null })).map((r) => r.dynasty)).toEqual(["dy_serve"]);
    expect(await engine.candidatesOf(db, { outcome: "lead_found", servable: [], channel: null, noCampaign: true })).toEqual([]);
  });
});
