import { describe, it, expect, beforeEach, vi } from "vitest";
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
const known = { isKnownOutcome: async () => true, nameDynasties: testNamer() };
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
  // LOCAL-CLAUDE-RATING-1116: chat-service answers every stated LLM runs as stated (a vendor-backed org).
  engine.setLlmServingReader(async (_org, llms) => new Map(llms.map((l) => [`${l.provider}/${l.model}`, true])));
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
    expect(pickSpy).toHaveBeenCalledWith(db, { outcome: OUTCOME, servable: [DRAFT_REQUEST], channel: null, keptDynasties: undefined, orgId: "org-a" });
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

  it("with no campaign and no strategy stated, only the scripts features-service keeps with no campaign are drawn (REELS-1124)", async () => {
    await addDraftScript("dy_fields_draft", FIELD_DRAFT_LLMS.deepseekFlash);
    await addDraftScript("dy_fields_draft__glm", FIELD_DRAFT_LLMS.glm);
    const asked: string[] = [];
    engine.setNoCampaignStrategyReader(async (outcome) => {
      asked.push(outcome);
      return ["dy_fields_draft__glm"];
    });
    try {
      const res = await make({ units, recordedBy: "brand" });
      expect(res.status).toBe(200);
      expect(res.body.pick.dynasty).toBe("dy_fields_draft__glm");
      expect(asked).toEqual([OUTCOME]);
      // A caller stating its own strategy is not narrowed a second time.
      asked.length = 0;
      expect((await make({ units, recordedBy: "brand", keptDynasties: ["dy_fields_draft"] })).body.pick.dynasty).toBe("dy_fields_draft");
      expect(asked).toEqual([]);
      // Unreadable = nothing runs (never "any script").
      engine.setNoCampaignStrategyReader(async () => {
        throw new Error("features-service 503");
      });
      const down = await make({ units, recordedBy: "brand" });
      expect(down.status).toBe(502);
      expect(down.body.code).toBe("script_pick_unreadable");
    } finally {
      engine.setNoCampaignStrategyReader(async () => null);
    }
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

// ENGINE-GET-ASK-1123 (owner 2026-11-23: an ask « peut être hors campaign »): the ask door needs no campaign.
describe("an Engine's ask outside a campaign", () => {
  const NEEDS_NOTHING = `
export default function run(ctx) {
  return { content: { topic: ctx.request.topic, at: ctx.request.now }, subject: { service: "social-service", id: "acct-1" } };
}`;
  // Claims a person on the campaign its run is for: a run naming no campaign has none to state.
  const NEEDS_CAMPAIGN = `
export default function run(ctx) {
  const r = ctx.vendor.call("lead.followup.claim", { params: { campaignId: ctx.request.campaignId }, body: {} });
  if (!r.ok) throw new Error(r.data.error);
  return { content: { r: r.data }, subject: { service: "lead-service", id: "lead-x" } };
}`;
  const ask = (outcome: string, body: Record<string, unknown>, headers: Record<string, string>) =>
    request(app).post(`/internal/engines/${outcome}/make`).set("x-api-key", KEY).set(headers).send(body);

  it("a script needing nothing campaign-bound makes its Unit with no campaign named anywhere", async () => {
    await createScript(db, { outcome: "x_account_found", dynasty: "dy_finds", code: NEEDS_NOTHING, description: "x", tactics: {} }, author, known);
    engine.setScriptPickReader(fakeScriptPick({ dy_finds: 1 }));
    const res = await ask("x_account_found", { units: {}, request: { topic: "b2b sales", now: "2026-11-24T10:00:00Z" } }, { "x-run-id": "distry-run-1", "x-org-id": "org-a" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "made", unit: { outcome: "x_account_found", content: { topic: "b2b sales", at: "2026-11-24T10:00:00Z" } }, pick: { dynasty: "dy_finds" } });
    // No campaign read for the pick, none on the run opened.
    expect(pickSpy.mock.calls[0]![1]).not.toHaveProperty("campaignId");
    const created = ledgerCalls[0]![1] as Record<string, unknown>;
    expect(created).toMatchObject({ parentRunId: "distry-run-1", orgId: "org-a" });
    expect(JSON.stringify(created)).not.toMatch(/campaign/i);
    expect(ledgerCalls.map((c) => c[0])).toEqual(["create", "declare", "close"]);
  });

  it("a script naming no subject makes a Unit about the asking run (never a paid Unit refused for want of a subject)", async () => {
    const NO_SUBJECT = `export default function run(ctx) { return { content: { email: ctx.request.email, verdict: "valid" } }; }`;
    await createScript(db, { outcome: "x_account_found", dynasty: "dy_checks", code: NO_SUBJECT, description: "x", tactics: {} }, author, known);
    engine.setScriptPickReader(fakeScriptPick({ dy_checks: 1 }));
    const res = await ask("x_account_found", { units: {}, request: { email: "k.lourd+probe@smartdistribute.com" } }, { "x-run-id": "distry-run-2", "x-org-id": "org-a" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "made" });
    const declared = ledgerCalls.find((c) => c[0] === "declare");
    expect(JSON.stringify(declared)).toContain("distry-run-2");
    expect(JSON.stringify(declared)).toContain("runs-service");
  });

  it("a script needing something its run lacks stops with a plain reason (a campaign, an org)", async () => {
    await createScript(db, { outcome: "x_account_found", dynasty: "dy_claims", code: NEEDS_CAMPAIGN, description: "x", tactics: {} }, author, known);
    engine.setScriptPickReader(fakeScriptPick({ dy_claims: 1 }));
    const noCampaign = await ask("x_account_found", { units: {}, request: {} }, { "x-run-id": "distry-run-1", "x-org-id": "org-a" });
    expect(noCampaign.status).toBe(502);
    expect(noCampaign.body.error).toContain("lead.followup.claim needs params.campaignId");
    expect(noCampaign.body.details).toMatchObject({ status: "failed", pick: { dynasty: "dy_claims" } });
    const noOrg = await ask("x_account_found", { units: {}, request: { campaignId: "c-1" } }, { "x-run-id": "distry-run-1" });
    expect(noOrg.status).toBe(502);
    expect(noOrg.body.error).toContain("lead.followup.claim acts only as a run of an org");
  });

  it("the served OpenAPI documents the ask door under the tag an agent finds it by, and the Engine list", () => {
    const spec = JSON.parse(readFileSync(join(__dirname, "../../openapi.json"), "utf8")) as { paths: Record<string, Record<string, { tags: string[]; description: string }>> };
    const door = spec.paths["/internal/engines/{outcome}/make"]!.post!;
    expect(door.tags).toContain("engine:ask");
    for (const word of ["x-run-id", "x-org-id", "billing", "units", "request", "No campaign"]) expect(door.description).toContain(word);
    const tagged = Object.entries(spec.paths).flatMap(([path, ops]) => Object.values(ops).filter((o) => (o.tags ?? []).includes("engine:ask")).map(() => path));
    expect(tagged).toEqual(["/internal/engines/{outcome}/make"]);
    const list = spec.paths["/internal/engines"]!.get!;
    expect(list.tags).toContain("engine:list");
    expect(list.description).toContain("`ask`");
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
