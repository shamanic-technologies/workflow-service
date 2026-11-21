import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { testNamer } from "../helpers/script-names.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { scripts } from "../../src/db/schema.js";
import { switchEngine, switchEngineOff } from "../../src/lib/scripts/engine.js";

// DISTRY-PRINCIPAL-1119: the Engine list. DISTRY-CALL-IS-CAMPAIGN-1121: every Distry call to an Engine is a campaign,
// so the direct call route is gone and no script is held out for "needing a campaign".
const MIGRATIONS = join(__dirname, "../../drizzle");
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../../src/db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));

const calls = await import("../../src/lib/scripts/engine-calls.js");
const { default: enginesRoutes } = await import("../../src/routes/engines.js");

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
beforeEach(async () => {
  process.env.WORKFLOW_SERVICE_API_KEY = KEY;
  db = await freshDb();
  holder.db = db;
  calls.setCatalogueOutcomesReader(async () => [
    { key: OUTCOME, name: "X account found" },
    { key: "email_sent", name: "Email sent" },
    { key: "meeting_booked", name: "Meeting booked" },
    { key: "start", name: "Start" },
  ]);
  app = express();
  app.use(express.json());
  app.use(enginesRoutes);
}, 60_000);

afterEach(() => {
  calls.setCatalogueOutcomesReader(null);
});

const add = (outcome: string, dynasty: string, code: string, tactics: Record<string, unknown> = {}) =>
  createScript(db, { outcome, dynasty, code, description: "x", tactics }, author, known);
const on = (outcome: string, dynasty: string, orgId: string | null = null) => switchEngine(db, { outcome, dynasty, orgId });

describe("GET /internal/engines", () => {
  it("every catalogue outcome, callable or not and why in plain words, and what a caller hands", async () => {
    await add(OUTCOME, "dy_finds", MAKES, { channel: "x-posts" });
    await add("email_sent", "dy_reads_lead", READS_LEAD);
    await on(OUTCOME, "dy_finds");
    await on("email_sent", "dy_reads_lead");
    const retired = await add("meeting_booked", "dy_old", MAKES);
    await db.update(scripts).set({ dynastyStatus: "deprecated", status: "deprecated" }).where(eq(scripts.id, retired.id));
    const res = await request(app).get("/internal/engines").set("x-api-key", KEY);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3); // `start` is not an outcome
    expect(res.body.callable).toBe(1);
    const by = new Map(res.body.engines.map((e: { outcome: string }) => [e.outcome, e]));
    expect(by.get(OUTCOME)).toMatchObject({ name: "X account found", callable: true, reason: null, inputs: [{ units: [], channel: "x-posts" }], counts: { scripts: 1, live: 1, runnable: 1 }, liveForCampaigns: true });
    // A campaign hands no Unit: a script that must be handed one never makes a campaign's Unit.
    expect(by.get("email_sent")).toMatchObject({
      callable: false,
      liveForCampaigns: true,
      reason: "Each of its scripts needs Units a campaign does not hand (lead_found): another Engine asks it inside its own run.",
      inputs: [{ units: ["lead_found"], channel: null }],
    });
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

  it("no campaign rule in the list: a script asking a channel-only Engine, or serving a campaign's people, counts as runnable (DISTRY-CALL-IS-CAMPAIGN-1121)", async () => {
    await add("email_sent", "dy_channel_only", MAKES, { channel: "sales-cold-email-outreach" });
    await add("meeting_booked", "dy_path", `export default function run(ctx) { ctx.ask({ units: {} }); const u = ctx.get("email_sent"); return { content: { u: u.content } }; }`, { asks: ["email_sent"] });
    await add(OUTCOME, "dy_serve", SERVES_CAMPAIGN);
    await on("meeting_booked", "dy_path");
    await on(OUTCOME, "dy_serve");
    const res = await request(app).get("/internal/engines").set("x-api-key", KEY);
    const by = new Map(res.body.engines.map((e: { outcome: string }) => [e.outcome, e]));
    expect(by.get("meeting_booked")).toMatchObject({ callable: true, reason: null, counts: { scripts: 1, live: 1, runnable: 1 } });
    expect(by.get(OUTCOME)).toMatchObject({ callable: true, counts: { runnable: 1 } });
    expect(by.get(OUTCOME).counts.needCampaign).toBeUndefined();
  });

  it("a reason staff stated for an Engine no script makes is shown as-is; a moved dynasty says where it went (DISTRY-ENGINES-1119)", async () => {
    const reason = "We run no ads yet: no ad account is connected, so nothing can show an ad.";
    let res = await request(app).put("/internal/engines/meeting_booked/reason").set("x-api-key", KEY).set("x-email", "staff@example.com").send({ reason });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "meeting_booked", reason, statedBy: "staff@example.com" });
    res = await request(app).get("/internal/engines").set("x-api-key", KEY);
    expect(res.body.engines.find((e: { outcome: string }) => e.outcome === "meeting_booked")).toMatchObject({ callable: false, reason });
    // A runnable script switched on for campaigns wins over the stated reason.
    await add("meeting_booked", "dy_now_runs", MAKES);
    await on("meeting_booked", "dy_now_runs");
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

  it("callable only when a campaign of the org asked can run it: never switched on, switched off, an org's own row (DISTRY-CALL-IS-CAMPAIGN-1121 AC)", async () => {
    await add(OUTCOME, "dy_finds", MAKES);
    const row = (r: request.Response) => r.body.engines.find((e: { outcome: string }) => e.outcome === OUTCOME);
    let res = await request(app).get("/internal/engines").set("x-api-key", KEY);
    expect(row(res)).toMatchObject({ callable: false, liveForCampaigns: false, reason: "Not switched on for campaigns yet: a campaign on it would be refused.", counts: { runnable: 1 } });
    // One org first: callable for that org only.
    await on(OUTCOME, "dy_finds", "org-a");
    res = await request(app).get("/internal/engines?orgId=org-a").set("x-api-key", KEY);
    expect(row(res)).toMatchObject({ callable: true, liveForCampaigns: true, reason: null });
    res = await request(app).get("/internal/engines?orgId=org-b").set("x-api-key", KEY);
    expect(row(res)).toMatchObject({ callable: false });
    // Every org, then switched off for org-a: org-a's own row wins and says why.
    await on(OUTCOME, "dy_finds");
    await switchEngineOff(db, { outcome: OUTCOME, orgId: "org-a", reason: "the guard rolled it back" });
    res = await request(app).get("/internal/engines?orgId=org-b").set("x-api-key", KEY);
    expect(row(res)).toMatchObject({ callable: true });
    res = await request(app).get("/internal/engines?orgId=org-a").set("x-api-key", KEY);
    expect(row(res)).toMatchObject({ callable: false, liveForCampaigns: false, reason: "Switched off for campaigns: the guard rolled it back." });
  });

  it("plain reasons for live scripts that cannot run", () => {
    expect(calls.notCallableReason({ scripts: 2, live: 2, unprovenPorts: 1, awaitingWriterProof: 1 })).toBe(
      "None of its 2 live scripts can run now: 1 not yet proven on their recorded cases, 1 waiting to pass their writing proof before writing to people.",
    );
  });
});
