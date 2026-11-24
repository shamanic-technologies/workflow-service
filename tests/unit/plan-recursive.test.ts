import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { ASK_CYCLE, runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { candidatesOf, pickScript, setScriptPickReader, setScriptStrategyReader } from "../../src/lib/scripts/engine.js";
import { setProofContext } from "../../src/lib/scripts/writer-proof.js";
import { scripts } from "../../src/db/schema.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { testNamer } from "../helpers/script-names.js";

// PLAN-RECURSIVE-PER-ENGINE-1124 (owner 2026-11-24: « À chaque Engine en partant de la fin (Target), on demande à Jev de
// filtrer les scripts possibles et puis le Rating nous donne le meilleur parmi la liste possible. Et ainsi de suite
// récursivement »): a script needing a Unit the run does not hold gets it from that Unit's Engine, under the same
// campaign, one level deeper, recursively, until a script needs nothing; an Engine already asked is never asked again.
// Fictional data only.
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
const who = { orgId: "org-1", userId: "user-1", parentRunId: "run-parent", headers: { "x-brand-id": "brand-1", "x-campaign-id": "camp-1" } };

const noVendors = {} as unknown as VendorDeps;

function ledger() {
  const runs: Array<{ id: string; taskName: string; parentRunId: string }> = [];
  const declared: Array<{ runId: string; body: { produced: unknown[]; consumed: unknown[] } }> = [];
  const l: LedgerDeps = {
    async createRun(opts) {
      runs.push({ id: `run-${runs.length + 1}`, taskName: opts.taskName, parentRunId: opts.parentRunId });
      return `run-${runs.length}`;
    },
    async declareOutcomes(runId, _org, body) {
      declared.push({ runId, body });
      return {};
    },
    async closeRun() {},
  };
  return { l, runs, declared };
}

let db: AnyPgDb;
let kept: Record<string, string[]> | null;
beforeEach(async () => {
  db = await freshDb();
  kept = null;
  setScriptPickReader(fakeScriptPick());
  // The campaign's strategy per Engine (features-service): every script of the Engine unless a test narrows it.
  setScriptStrategyReader(async (_c, outcome) => kept?.[outcome] ?? (await db.select().from(scripts).where(eq(scripts.outcome, outcome))).map((r) => r.dynasty));
  setProofContext(null);
}, 60_000);
afterEach(() => {
  setScriptPickReader(null);
  setScriptStrategyReader(null);
});

async function add(outcome: string, dynasty: string, code: string, tactics: Record<string, unknown> = {}) {
  const row = await createScript(db, { outcome, dynasty, code, description: "x" }, author, known);
  if (Object.keys(tactics).length) await db.update(scripts).set({ tactics }).where(eq(scripts.id, row.id));
  const [fresh] = await db.select().from(scripts).where(eq(scripts.id, row.id));
  return fresh!;
}

/** A script that reads one Unit it is never handed and makes its own from it. */
const reads = (material: string, made: string) => `export default function run(ctx) {
  const u = ctx.get("${material}");
  return { content: { made: "${made}", from: u.content }, subject: { service: "runs-service", id: "${made}-1" } };
}`;
const leaf = (made: string) => `export default function run(ctx) {
  return { content: { made: "${made}" }, subject: { service: "runs-service", id: "${made}-1" } };
}`;

describe("a Unit the run does not hold is asked of its Engine, recursively", () => {
  it("two levels deep: signup reads a post, the post reads an angle, the angle needs nothing", async () => {
    await add("signup", "dy_signup_via_post", reads("post_published", "signup"));
    await add("post_published", "dy_post", reads("angle_found", "post"));
    await add("angle_found", "dy_angle", leaf("angle"));

    // The pick: the top script is a candidate although the run holds nothing (no channel either).
    const pick = await pickScript(db, { outcome: "signup", servable: [], channel: null, campaignId: "camp-1", orgId: null });
    expect(pick?.script.dynasty).toBe("dy_signup_via_post");

    const { l, runs, declared } = ledger();
    const result = await runStoredScript(db, { outcome: "signup", dynasty: "dy_signup_via_post", units: {} }, who, { ledger: l, vendors: noVendors });
    expect(result.status).toBe("made");
    expect(result.unit?.content).toEqual({ made: "signup", from: { made: "post", from: { made: "angle" } } });
    // One run per Engine, each the child of the one that asked it.
    expect(runs.map((r) => [r.taskName, r.parentRunId])).toEqual([
      ["script:signup/dy_signup_via_post", "run-parent"],
      ["script:post_published/dy_post", "run-1"],
      ["script:angle_found/dy_angle", "run-2"],
    ]);
    // Each asker consumes the Unit its child made.
    const top = declared.find((d) => d.runId === "run-1")!;
    expect(top.body.consumed).toEqual([{ outcomeKey: "post_published", subjectService: "runs-service", subjectId: "post-1" }]);
  });

  it("the campaign's strategy narrows every level: a deeper Engine it keeps nothing of makes the top unreachable", async () => {
    await add("signup", "dy_signup_via_post", reads("post_published", "signup"));
    await add("post_published", "dy_post", reads("angle_found", "post"));
    await add("angle_found", "dy_angle", leaf("angle"));
    kept = { angle_found: [] };
    expect(await candidatesOf(db, { outcome: "signup", servable: [], channel: null, campaignId: "camp-1" })).toEqual([]);
  });

  it("an Engine with no script makes the script needing it no candidate", async () => {
    await add("signup", "dy_signup_via_post", reads("post_published", "signup"));
    await add("signup", "dy_signup_alone", leaf("signup"));
    const c = await candidatesOf(db, { outcome: "signup", servable: [], channel: null, campaignId: "camp-1" });
    expect(c.map((r) => r.dynasty)).toEqual(["dy_signup_alone"]);
  });

  it("a held Unit is never asked again", async () => {
    await add("signup", "dy_signup_via_post", reads("post_published", "signup"));
    const { l, runs } = ledger();
    const result = await runStoredScript(db, { outcome: "signup", dynasty: "dy_signup_via_post", units: { post_published: { content: { made: "handed" } } } }, who, { ledger: l, vendors: noVendors });
    expect(result.unit?.content).toEqual({ made: "signup", from: { made: "handed" } });
    expect(runs).toHaveLength(1);
  });
});

describe("a cycle ends with a named refusal, never a loop", () => {
  it("two Engines needing each other: neither is a candidate, and a forced run ends unmade", async () => {
    await add("a_made", "dy_a", reads("b_made", "a"));
    await add("b_made", "dy_b", reads("a_made", "b"));
    expect(await candidatesOf(db, { outcome: "a_made", servable: [], channel: null, campaignId: "camp-1" })).toEqual([]);

    const { l, runs } = ledger();
    const result = await runStoredScript(db, { outcome: "a_made", dynasty: "dy_a", units: {} }, who, { ledger: l, vendors: noVendors });
    expect(result.status).toBe("unmade");
    expect(result.error).toMatch(/^no_script: /);
    expect(runs).toHaveLength(1);
  });

  it("a script reading its own Engine's Unit ends ask_cycle", async () => {
    await add("c_made", "dy_c", reads("c_made", "c"));
    const { l } = ledger();
    const result = await runStoredScript(db, { outcome: "c_made", dynasty: "dy_c", units: {} }, who, { ledger: l, vendors: noVendors });
    expect(result.status).toBe("unmade");
    expect(result.error).toBe(`${ASK_CYCLE}: c_made is already asked above this run (c_made)`);
  });

  it("an Engine asked above is never asked again, by a direct ask either", async () => {
    await add("top_made", "dy_top", reads("mid_made", "top"));
    await add(
      "mid_made",
      "dy_mid",
      `export default function run(ctx) {
        const back = ctx.ask("top_made", {});
        return { content: { made: "mid", back: back.unmade }, subject: { service: "runs-service", id: "mid-1" } };
      }`,
      { asks: ["top_made"] },
    );
    const { l } = ledger();
    const result = await runStoredScript(db, { outcome: "top_made", dynasty: "dy_top", units: {} }, who, { ledger: l, vendors: noVendors });
    expect(result.status).toBe("made");
    expect(result.unit?.content).toEqual({ made: "top", from: { made: "mid", back: `${ASK_CYCLE}: top_made is already asked above this run (top_made > mid_made)` } });
  });
});
