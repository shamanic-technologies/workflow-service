import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { testNamer } from "../helpers/script-names.js";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { setNoCampaignStrategyReader, setScriptStrategyReader } from "../../src/lib/scripts/engine.js";
import { endpointOfVendor, requiredKeys, vendorsNamedIn, type Endpoint } from "../../src/lib/scripts/required-keys.js";
import { scripts } from "../../src/db/schema.js";

// SOLO-PLAN-1125: the keys a campaign's Plan needs (provider + what for) and which the org already holds. A staff test
// campaign on real Postgres (PGlite, real migrations), fictional data only.
const MIGRATIONS = join(__dirname, "../../drizzle");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true, nameDynasties: testNamer() };

// The Target (Email sent): a sender serving a person (lead-service), checking the address (apollo), asking a writer.
const SENDER = `export default function run(ctx) {
  const lead = ctx.vendor.call("lead.serve", {});
  const v = ctx.vendor.call("apollo.email.verify", { verifier: "x", email: "a@b.c" });
  const w = ctx.ask("message_written", { request: {} });
  return { content: { sent: true } };
}`;
// The writer asks its model of the LLM completion Engine.
const WRITER = `export default function run(ctx) {
  const c = ctx.ask("llm_completion", { request: { message: "m" } });
  return { content: { text: c.content.answer } };
}`;
const COMPLETION = `export default function run(ctx) {
  const a = ctx.vendor.call("llm.complete", { message: ctx.request.message });
  return { content: { answer: a.data.content } };
}`;
// A script the campaign's strategy does NOT keep: its keys are never asked.
const KEPT_OUT = `export default function run(ctx) {
  const r = ctx.vendor.call("social.publish", {});
  return { content: { r: r.ok } };
}`;

let db: AnyPgDb;
let strategyAsks: Array<{ campaignId: string; outcome: string }> = [];
beforeEach(async () => {
  db = await freshDb();
  strategyAsks = [];
  setScriptStrategyReader(async (campaignId, outcome) => {
    strategyAsks.push({ campaignId, outcome });
    return (await db.select().from(scripts).where(eq(scripts.outcome, outcome))).map((r) => r.dynasty).filter((d) => d !== "dy_kept_out");
  });
  setNoCampaignStrategyReader(async () => null);
  const add = async (outcome: string, dynasty: string, code: string, tactics: Record<string, unknown> = {}) => {
    const row = await createScript(db, { outcome, dynasty, code, description: "x" }, author, known);
    if (Object.keys(tactics).length) await db.update(scripts).set({ tactics }).where(eq(scripts.id, row.id));
  };
  await add("email_sent", "dy_sender", SENDER);
  await add("email_sent", "dy_kept_out", KEPT_OUT);
  await add("message_written", "dy_writer", WRITER);
  // The LLM completion Engine: one script per model; the founder's own Claude is one of them, rated like any other.
  await add("llm_completion", "dy_claude_sonnet", COMPLETION, { llm: { provider: "anthropic", model: "sonnet" } });
  await add("llm_completion", "dy_gpt", COMPLETION, { llm: { provider: "openai", model: "gpt-pro" } });
}, 60_000);
afterEach(() => {
  setScriptStrategyReader(null);
  setNoCampaignStrategyReader(null);
});

/** key-service as it answers: apollo's verifier observed asking apollo; lead-service's serve asking apollo + instantly. */
function keyService(orgHolds: string[]) {
  const asked: Endpoint[][] = [];
  return {
    asked,
    deps: {
      async providersOf(endpoints: Endpoint[]) {
        asked.push(endpoints);
        const out: Array<Endpoint & { provider: string }> = [];
        for (const e of endpoints) {
          if (e.service === "apollo") out.push({ ...e, provider: "apollo" });
          if (e.service === "lead") out.push({ ...e, provider: "apollo" }, { ...e, provider: "instantly" });
          if (e.service === "social") out.push({ ...e, provider: "twitter" });
        }
        return out;
      },
      async orgKeys(orgId: string, userId: string) {
        expect(orgId).toBe("org-staff-test");
        expect(userId).toBe("user-staff");
        return orgHolds;
      },
    },
  };
}

describe("the keys a staff campaign's Plan needs (SOLO-PLAN-1125)", () => {
  it("lists every provider + what for, the musts apart from the choices, marking the keys the org holds", async () => {
    const ks = keyService(["apollo", "anthropic"]);
    const out = await requiredKeys(db, { outcome: "email_sent", orgId: "org-staff-test", userId: "user-staff", campaignId: "camp-staff" }, ks.deps);

    expect(out.engines.map((e) => e.outcome)).toEqual(["email_sent", "message_written", "llm_completion"]);
    // the campaign's strategy narrowed every Engine of the Plan
    expect(strategyAsks.map((a) => a.outcome)).toEqual(["email_sent", "message_written", "llm_completion"]);
    expect(out.keys.map((k) => ({ provider: k.provider, held: k.held, required: k.required }))).toEqual([
      { provider: "apollo", held: true, required: true },
      { provider: "instantly", held: false, required: true },
      { provider: "anthropic", held: true, required: false },
      { provider: "openai", held: false, required: false },
    ]);
    // what for, in the script's own words
    expect(out.keys.find((k) => k.provider === "instantly")!.for).toEqual([{ engine: "email_sent", script: "dy_sender", scriptName: expect.any(String), call: "lead.serve" }]);
    expect(out.keys.find((k) => k.provider === "anthropic")!.for).toEqual([{ engine: "llm_completion", script: "dy_claude_sonnet", scriptName: expect.any(String), call: "llm.complete (anthropic sonnet)" }]);
    // the script the strategy keeps out is never read: no twitter key asked
    expect(out.keys.some((k) => k.provider === "twitter")).toBe(false);
    expect(ks.asked.flat().some((e) => e.service === "social")).toBe(false);
    // the sender misses instantly: not ready; the model can run on the Claude key the org holds
    expect(out.engines.find((e) => e.outcome === "email_sent")!.ready).toBe(false);
    expect(out.engines.find((e) => e.outcome === "llm_completion")!.ready).toBe(true);
    expect(out.ready).toBe(false);
  });

  it("is ready once the org holds every must and one model's key", async () => {
    const out = await requiredKeys(db, { outcome: "email_sent", orgId: "org-staff-test", userId: "user-staff", campaignId: "camp-staff" }, keyService(["apollo", "instantly", "openai"]).deps);
    expect(out.ready).toBe(true);
    expect(out.keys.every((k) => k.held || !k.required)).toBe(true);
  });

  it("before launch reads the scripts kept with no campaign", async () => {
    const out = await requiredKeys(db, { outcome: "email_sent", orgId: "org-staff-test", userId: "user-staff", campaignId: null }, keyService([]).deps);
    expect(strategyAsks).toEqual([]);
    // no strategy narrows: the second sender's provider is one choice among two
    expect(out.keys.find((k) => k.provider === "twitter")).toMatchObject({ held: false, required: false });
  });
});

describe("what a script calls", () => {
  it("reads every vendor its code names, helper-wrapped ones too, never another string", () => {
    expect(vendorsNamedIn(`const a = must(ctx, "llm.complete", x); ctx.vendor.call('apollo.email.verify', {}); const s = "not.a.vendor";`)).toEqual(["llm.complete", "apollo.email.verify"]);
  });
  it("maps a judgment to chat-service, a door to its service, a pick to no third party", () => {
    expect(endpointOfVendor("jev.noul")).toEqual({ service: "chat", method: "POST", path: "/orgs/judgments" });
    expect(endpointOfVendor("apollo.email.verify")).toMatchObject({ service: "apollo", method: "POST" });
    expect(endpointOfVendor("llm.pick")).toBeNull();
    expect(endpointOfVendor("voice.read")).toBeNull();
  });
});
