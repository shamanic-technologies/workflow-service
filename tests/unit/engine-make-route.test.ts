import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { scriptRuns, scripts } from "../../src/db/schema.js";
import type { LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { buildFieldDraftSource, DRAFT_REQUEST, fieldDraftTactics, FIELD_DRAFT_LLMS } from "../../scripts/engine-ports/field-drafts.js";

// SCRIPT-VALUE-RATING-1113-WF3: a service waiting on a Unit (brand-service's field drafts) asks the Engine: the Rating
// picks the script (the SAME pickScript a run calls), the script runs on its own run, a child of the caller's.
const MIGRATIONS = join(__dirname, "../../drizzle");
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../../src/db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));

const engine = await import("../../src/lib/scripts/engine.js");
const runner = await import("../../src/lib/scripts/script-runner.js");
const vendorsModule = await import("../../src/lib/scripts/vendors.js");
const pickSpy = vi.spyOn(engine, "pickScript");
const { default: enginesRoutes } = await import("../../src/routes/engines.js");

async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true };
const KEY = "test-key";
const OUTCOME = "offer_fields_drafted";

let db: AnyPgDb;
let app: express.Express;
let ledgerCalls: unknown[][];
let chat: Array<[string, Record<string, unknown>, Record<string, string>]>;
beforeEach(async () => {
  process.env.WORKFLOW_SERVICE_API_KEY = KEY;
  db = await freshDb();
  holder.db = db;
  engine.setScriptStrategyReader(async () => {
    throw new Error("no campaign strategy is read: a make names no campaign");
  });
  engine.setScriptPickReader(fakeScriptPick({ dy_fields_draft: 2, dy_fields_draft__glm: 1 }));
  ledgerCalls = [];
  chat = [];
  const ledger: LedgerDeps = {
    async createRun(o) { ledgerCalls.push(["create", o]); return "run-script-1"; },
    async declareOutcomes(runId, orgId, body) { ledgerCalls.push(["declare", { runId, orgId, body }]); return {}; },
    async closeRun(runId, status) { ledgerCalls.push(["close", { runId, status }]); },
  };
  const answer = { content: "{\"offerName\":\"Coaching\"}", json: { offerName: "Coaching" }, model: "deepseek-v4-flash" };
  const vendors = {
    async complete(body, headers) { chat.push(["complete", body, headers]); return answer; },
    async platformComplete(body, headers) { chat.push(["platformComplete", body, headers]); return answer; },
    async judge() { return { answers: {} }; },
    async platformJudge() { return { answers: {} }; },
    async readSkill() { return null; },
    async serviceDoor() { return { status: 500, body: {} }; },
  } as VendorDeps;
  vi.spyOn(runner, "productionLedgerDeps").mockReturnValue(ledger);
  vi.spyOn(vendorsModule, "productionVendorDeps").mockReturnValue(vendors);
  app = express();
  app.use(express.json());
  app.use(enginesRoutes);
  pickSpy.mockClear();
}, 60_000);

async function addDraftScript(dynasty: string, llm: (typeof FIELD_DRAFT_LLMS)[keyof typeof FIELD_DRAFT_LLMS]) {
  const row = await createScript(db, { outcome: OUTCOME, dynasty, code: buildFieldDraftSource(), description: "x", tactics: fieldDraftTactics(llm) }, author, known);
  return row;
}

const units = { [DRAFT_REQUEST]: { content: { calls: [{ place: "draft", systemPrompt: "S", message: "M", responseFormat: "json", maxTokens: 24000 }] } } };
const make = (body: Record<string, unknown>, headers: Record<string, string> = { "x-run-id": "brand-run-1", "x-org-id": "org-a" }) =>
  request(app).post(`/internal/engines/${OUTCOME}/make`).set("x-api-key", KEY).set(headers).send(body);

describe("POST /internal/engines/{outcome}/make", () => {
  it("runs the dynasty the Rating picks, with the LLM ITS tactic states, on a child of the caller's run", async () => {
    await addDraftScript("dy_fields_draft", FIELD_DRAFT_LLMS.deepseekFlash);
    await addDraftScript("dy_fields_draft__glm", FIELD_DRAFT_LLMS.glm);
    const res = await make({ units, recordedBy: "brand", billing: "org" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "made", runId: "run-script-1", unit: { outcome: OUTCOME, content: { answers: [{ place: "draft", json: { offerName: "Coaching" } }] } } });
    expect(res.body.pick).toMatchObject({ outcome: OUTCOME, dynasty: "dy_fields_draft", version: 1, tactics: { llm: { model: "deepseek-flash" }, recorded_by: "brand" } });
    expect(pickSpy).toHaveBeenCalledWith(db, { outcome: OUTCOME, servable: [DRAFT_REQUEST], channel: null, keptDynasties: undefined });
    // The picked script's LLM, org-billed on the script's run.
    expect(chat).toHaveLength(1);
    expect(chat[0]![0]).toBe("complete");
    expect(chat[0]![1]).toMatchObject({ message: "M", systemPrompt: "S", provider: "deepseek", model: "deepseek-flash", responseFormat: "json", maxTokens: 24000 });
    expect(chat[0]![2]["x-run-id"]).toBe("run-script-1");
    expect(ledgerCalls[0]).toEqual(["create", expect.objectContaining({ parentRunId: "brand-run-1", orgId: "org-a", taskName: `script:${OUTCOME}/dy_fields_draft` })]);
    // recorded by brand: the run declares nothing itself.
    expect(ledgerCalls.map((c) => c[0])).toEqual(["create", "close"]);
    expect((await db.select().from(scriptRuns)).length).toBe(1);
  });

  it("is platform-billed unless the caller states org with an org", async () => {
    await addDraftScript("dy_fields_draft", FIELD_DRAFT_LLMS.deepseekFlash);
    const res = await make({ units, recordedBy: "brand" }, { "x-run-id": "brand-run-1" });
    expect(res.status).toBe(200);
    expect(chat[0]![0]).toBe("platformComplete");
  });

  it("narrows to the kept dynasties when the caller has a strategy", async () => {
    await addDraftScript("dy_fields_draft", FIELD_DRAFT_LLMS.deepseekFlash);
    await addDraftScript("dy_fields_draft__glm", FIELD_DRAFT_LLMS.glm);
    const res = await make({ units, recordedBy: "brand", keptDynasties: ["dy_fields_draft__glm"] });
    expect(res.status).toBe(200);
    expect(res.body.pick.dynasty).toBe("dy_fields_draft__glm");
    expect(chat[0]![1]).toMatchObject({ provider: "zai", model: "glm" });
  });

  it("named refusals: no x-run-id, no runnable script, a pick unreadable, a script that fails", async () => {
    expect((await make({ units }, { "x-org-id": "org-a" })).status).toBe(400);
    const none = await make({ units });
    expect(none.status).toBe(404);
    expect(none.body.code).toBe("no_runnable_script");
    await addDraftScript("dy_fields_draft", FIELD_DRAFT_LLMS.deepseekFlash);
    const unfed = await make({ units: {} });
    expect(unfed.status).toBe(404);
    engine.setScriptPickReader(async () => {
      throw new Error("features-service 502");
    });
    const unread = await make({ units });
    expect(unread.status).toBe(502);
    expect(unread.body.code).toBe("script_pick_unreadable");
    expect(chat).toHaveLength(0);
    engine.setScriptPickReader(fakeScriptPick({ dy_fields_draft: 1 }));
    const failed = await make({ units: { [DRAFT_REQUEST]: { content: { calls: [] } } } });
    expect(failed.status).toBe(502);
    expect(failed.body.details).toMatchObject({ status: "failed", pick: { dynasty: "dy_fields_draft" } });
  });
});

describe("POST /internal/engines/{outcome}/pick serves the picked script's tactics", () => {
  it("what the picked script writes with (a preview writes with the template and LLM its picked script states)", async () => {
    const row = await addDraftScript("dy_fields_draft", FIELD_DRAFT_LLMS.deepseekFlash);
    await db.update(scripts).set({ tactics: { llm: { provider: "google", model: "gemini-pro" }, template: "cold-reply-free-offer-named" } }).where(eq(scripts.id, row.id));
    const res = await request(app).post(`/internal/engines/${OUTCOME}/pick`).set("x-api-key", KEY).send({ keptDynasties: ["dy_fields_draft"], servable: [DRAFT_REQUEST] });
    expect(res.status).toBe(200);
    expect(res.body.tactics).toEqual({ llm: { provider: "google", model: "gemini-pro" }, template: "cold-reply-free-offer-named" });
  });
});
