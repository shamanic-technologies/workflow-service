import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { setScriptPickReader, setScriptStrategyReader } from "../../src/lib/scripts/engine.js";
import { planEngineRun, type EngineDispatch } from "../../src/lib/scripts/engine-runner.js";
import { MOST_UNITS_REACHED, paceHold, parseMostUnits, setMostUnitsReaders, type MostUnits } from "../../src/lib/scripts/most-units.js";
import { setProofContext } from "../../src/lib/scripts/writer-proof.js";
import { scripts } from "../../src/db/schema.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { testNamer } from "../helpers/script-names.js";

// MOST-UNITS-PACE-1125: the pace a campaign's brief states (features-service `mostUnits`) holds a run of that Engine,
// direct or asked, once the campaign's Units of the period reach it. Fictional data only.
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
const noVendors = {} as unknown as VendorDeps;
const ONE_A_DAY: MostUnits = { units: 1, per: "day", days: 1 };

function ledger(): LedgerDeps {
  let n = 0;
  return {
    async createRun() {
      n += 1;
      return `run-${n}`;
    },
    async declareOutcomes() {
      return {};
    },
    async closeRun() {},
  };
}

let db: AnyPgDb;
let counted: Array<{ campaignId: string; outcome: string; since: Date }>;
const pace = (byOutcome: Record<string, MostUnits | null>, made: number) => {
  setMostUnitsReaders({
    mostUnits: async (_c, outcome) => byOutcome[outcome] ?? null,
    count: async ({ campaignId, outcome, since }) => {
      counted.push({ campaignId, outcome, since });
      return made;
    },
  });
};

beforeEach(async () => {
  db = await freshDb();
  counted = [];
  process.env.MOST_UNITS_PACE = "on";
  setScriptPickReader(fakeScriptPick());
  setScriptStrategyReader(async (_c, outcome) => (await db.select().from(scripts).where(eq(scripts.outcome, outcome))).map((r) => r.dynasty));
  setProofContext(null);
}, 60_000);
afterEach(() => {
  process.env.MOST_UNITS_PACE = "off";
  setMostUnitsReaders({ mostUnits: null, count: null });
  setScriptPickReader(null);
  setScriptStrategyReader(null);
});

describe("mostUnits as features-service serves it", () => {
  it("reads null and the served shape, refuses anything else", () => {
    expect(parseMostUnits(null, "x")).toBeNull();
    expect(parseMostUnits(undefined, "x")).toBeNull();
    expect(parseMostUnits({ units: 1, per: "day", days: 1 }, "x")).toEqual(ONE_A_DAY);
    expect(() => parseMostUnits({ units: 1, per: "hour", days: 1 }, "x")).toThrow(/cannot read/);
    expect(() => parseMostUnits({ units: "1", per: "day", days: 1 }, "x")).toThrow(/cannot read/);
  });
});

describe("paceHold", () => {
  it("no pace stated = no hold, nothing counted", async () => {
    pace({}, 99);
    expect(await paceHold({ campaignId: "camp-1", orgId: "org-1", outcome: "threads_post_published" })).toBeNull();
    expect(counted).toEqual([]);
  });

  it("below the cap = no hold; at the cap = held, on a rolling window of days x 24 h", async () => {
    const now = new Date("2026-11-25T12:00:00Z");
    pace({ threads_post_published: ONE_A_DAY }, 0);
    expect(await paceHold({ campaignId: "camp-1", orgId: "org-1", outcome: "threads_post_published", now })).toBeNull();
    pace({ threads_post_published: ONE_A_DAY }, 1);
    const held = await paceHold({ campaignId: "camp-1", orgId: "org-1", outcome: "threads_post_published", now });
    expect(held).toMatch(new RegExp(`^${MOST_UNITS_REACHED}: `));
    expect(counted.at(-1)!.since.toISOString()).toBe("2026-11-24T12:00:00.000Z");
  });

  it("no campaign = no hold (a direct ask outside a campaign)", async () => {
    pace({ threads_post_published: ONE_A_DAY }, 5);
    expect(await paceHold({ campaignId: null, orgId: "org-1", outcome: "threads_post_published" })).toBeNull();
  });
});

describe("an Engine at its pace makes nothing, decided idle", () => {
  it("a DIRECT run: the plan is held before any pick", async () => {
    await createScript(db, { outcome: "threads_post_published", dynasty: "dy_post", code: `export default function run(ctx) { return { content: { p: 1 }, subject: { service: "meta-service", id: "p1" } }; }`, description: "x" }, author, known);
    pace({ threads_post_published: ONE_A_DAY }, 1);
    const d = { outcome: "threads_post_published", orgId: "org-1", campaignId: "camp-1", featureSlug: null, fromOutcome: "start", inputs: {} } as unknown as EngineDispatch;
    const plan = await planEngineRun(db, d);
    expect(plan.kind).toBe("none");
    expect(plan.kind === "none" && plan.held).toMatch(/^most_units_reached: /);
    pace({ threads_post_published: ONE_A_DAY }, 0);
    expect((await planEngineRun(db, d)).kind).toBe("pick");
  });

  it("an ASKED run: the asker reads unmade + decided idle, no child run, and forwards it", async () => {
    await createScript(db, { outcome: "threads_post_published", dynasty: "dy_post", code: `export default function run(ctx) { return { content: { p: 1 }, subject: { service: "meta-service", id: "p1" } }; }`, description: "x" }, author, known);
    await createScript(
      db,
      {
        outcome: "signup",
        dynasty: "dy_signup_post",
        code: `export default function run(ctx) {
  ctx.ask({ units: {}, request: {} });
  const got = ctx.get("threads_post_published");
  if (got && typeof got.unmade === "string") return { unmade: got.unmade, ...(got.decided ? { decided: got.decided } : {}) };
  return { content: { post: got.content } };
}`,
        description: "x",
        tactics: { asks: ["threads_post_published"] },
      },
      author,
      known,
    );
    pace({ threads_post_published: ONE_A_DAY }, 1);
    const res = await runStoredScript(
      db,
      { outcome: "signup", dynasty: "dy_signup_post", units: {}, fallbackSubject: { service: "runs-service", id: "r" } },
      { orgId: "org-1", userId: "user-1", parentRunId: "run-parent", headers: { "x-campaign-id": "camp-1", "x-org-id": "org-1" } },
      { ledger: ledger(), vendors: noVendors },
    );
    expect(res.status).toBe("unmade");
    expect(res.decided).toBe("idle");
    expect(res.error).toMatch(/^most_units_reached: /);
  });
});
