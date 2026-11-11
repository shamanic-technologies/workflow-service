import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { scriptRuns, scripts } from "../../src/db/schema.js";

// PREVIEW-RATING-PICK-1111: the Rating's pick for an Engine with no campaign and no run (content-generation's email
// preview). The route calls the SAME `pickScript` a campaign run calls, among the dynasties the caller's strategy kept.
const MIGRATIONS = join(__dirname, "../../drizzle");
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../../src/db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));

const engine = await import("../../src/lib/scripts/engine.js");
const pickSpy = vi.spyOn(engine, "pickScript");
const { default: enginesRoutes } = await import("../../src/routes/engines.js");

async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

const WRITE = `
export default function run(ctx) {
  const lead = ctx.get("lead_identified");
  return { content: { to: lead.content.email } };
}`;
const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true };
const KEY = "test-key";

let db: AnyPgDb;
let app: express.Express;
beforeEach(async () => {
  process.env.WORKFLOW_SERVICE_API_KEY = KEY;
  db = await freshDb();
  holder.db = db;
  // A campaign strategy read must never happen on this route: it has no campaign.
  engine.setScriptStrategyReader(async () => {
    throw new Error("no campaign strategy is read on a pick outside a run");
  });
  app = express();
  app.use(express.json());
  app.use(enginesRoutes);
  pickSpy.mockClear();
}, 60_000);

async function addScript(outcome: string, dynasty: string, tactics: Record<string, unknown> = {}) {
  const row = await createScript(db, { outcome, dynasty, code: WRITE, description: "x" }, author, known);
  if (Object.keys(tactics).length) await db.update(scripts).set({ tactics }).where(eq(scripts.id, row.id));
  return row;
}
const runs = (scriptId: string, status: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ scriptId, orgId: "org-1", runId: `${scriptId}-${status}-${i}`, parentRunId: "p", status }));

const pick = (outcome: string, body: Record<string, unknown>) => request(app).post(`/internal/engines/${outcome}/pick`).set("x-api-key", KEY).send(body);

describe("POST /internal/engines/{outcome}/pick", () => {
  it("answers the dynasty the Rating favours among the kept ones, through the run's own pickScript", async () => {
    const good = await addScript("message_written", "dy_good");
    const bad = await addScript("message_written", "dy_bad");
    await addScript("message_written", "dy_not_kept");
    await db.insert(scriptRuns).values([...runs(good.id, "made", 90), ...runs(good.id, "unmade", 10), ...runs(bad.id, "made", 5), ...runs(bad.id, "failed", 95)]);
    for (let i = 0; i < 20; i++) {
      const res = await pick("message_written", { keptDynasties: ["dy_good", "dy_bad"], servable: ["lead_identified"] });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ outcome: "message_written", dynasty: "dy_good", version: 1, scriptId: good.id });
      expect(res.body.draws.map((d: { dynasty: string }) => d.dynasty).sort()).toEqual(["dy_bad", "dy_good"]);
    }
    // Same function as a run, same candidates: the kept list replaces a campaign's strategy read.
    expect(pickSpy).toHaveBeenCalledWith(db, { outcome: "message_written", servable: ["lead_identified"], channel: null, keptDynasties: ["dy_good", "dy_bad"] });
    // And a run's pickScript with that same kept list answers the same dynasty.
    expect((await engine.pickScript(db, { outcome: "message_written", servable: ["lead_identified"], channel: null, keptDynasties: ["dy_good", "dy_bad"] }))!.script.dynasty).toBe("dy_good");
    // Nothing written.
    expect((await db.select().from(scriptRuns)).length).toBe(200);
  });

  it("an unknown outcome, or no kept dynasty runnable, is a named refusal, never another Engine's script", async () => {
    await addScript("message_written", "dy_good");
    await addScript("lead_found", "dy_other");
    const unknown = await pick("no_such_outcome", { keptDynasties: ["dy_good"], servable: ["lead_identified"] });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("no_runnable_script");
    const otherEngine = await pick("message_written", { keptDynasties: ["dy_other"], servable: ["lead_identified"] });
    expect(otherEngine.status).toBe(404);
    expect(otherEngine.body.code).toBe("no_runnable_script");
    // The script asks for a material the caller does not hand.
    const unfed = await pick("message_written", { keptDynasties: ["dy_good"], servable: [] });
    expect(unfed.status).toBe(404);
    // A channel the script is not for.
    await addScript("message_written", "dy_wa", { channel: "cold-whatsapp-outreach" });
    const wrongChannel = await pick("message_written", { keptDynasties: ["dy_wa"], servable: ["lead_identified"], channel: "cold-email" });
    expect(wrongChannel.status).toBe(404);
  });

  it("refuses an empty kept list and a missing key", async () => {
    expect((await pick("message_written", { keptDynasties: [], servable: [] })).status).toBe(400);
    expect((await request(app).post("/internal/engines/message_written/pick").send({ keptDynasties: ["dy_x"], servable: [] })).status).toBe(401);
  });
});
