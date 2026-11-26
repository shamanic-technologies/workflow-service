import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { ScriptRunFailed, runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { setScriptPickReader, setScriptStrategyReader } from "../../src/lib/scripts/engine.js";
import { setProofContext } from "../../src/lib/scripts/writer-proof.js";
import { wellFormedJson, wellFormedString } from "../../src/db/well-formed-jsonb.js";
import { scriptRuns, scripts } from "../../src/db/schema.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { testNamer } from "../helpers/script-names.js";

// MON-XPOST-SCRIPT-1126-WF: a Unit whose text holds half an emoji (a lone surrogate, e.g. a 2000-cut landing inside a
// pair) is stored like any other: every jsonb write goes through one guard (lone surrogate -> U+FFFD), valid pairs
// untouched. Real Postgres (PGlite) on the real migrations, which refuses a lone surrogate in jsonb. Fictional data only.
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
  const closed: Array<{ runId: string; status: string }> = [];
  const l: LedgerDeps = {
    async createRun(opts) {
      runs.push({ id: `run-${runs.length + 1}`, taskName: opts.taskName, parentRunId: opts.parentRunId });
      return `run-${runs.length}`;
    },
    async declareOutcomes() {
      return {};
    },
    async closeRun(runId, status) {
      closed.push({ runId, status });
    },
  };
  return { l, runs, closed };
}


let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
  setScriptPickReader(fakeScriptPick());
  setScriptStrategyReader(async (_c, outcome) => (await db.select().from(scripts).where(eq(scripts.outcome, outcome))).map((r) => r.dynasty));
  setProofContext(null);
}, 60_000);
afterEach(() => {
  setScriptPickReader(null);
  setScriptStrategyReader(null);
});

const add = (outcome: string, dynasty: string, code: string) => createScript(db, { outcome, dynasty, code, description: "x" }, author, known);

const asksDirect = (asked: string, made: string) => `export default function run(ctx) {
  const u = ctx.ask("${asked}", {});
  return { content: { made: "${made}", from: u.content }, subject: { service: "runs-service", id: "${made}-1" } };
}`;
const readsUnheld = (material: string, made: string) => `export default function run(ctx) {
  const u = ctx.get("${material}");
  return { content: { made: "${made}", from: u.content }, subject: { service: "runs-service", id: "${made}-1" } };
}`;
const waits = (days: number) => `export default function run(ctx) {
  ctx.wait(${days});
  return { content: { never: true }, subject: { service: "runs-service", id: "x" } };
}`;


// The watch's 2000-cut of a post whose emoji sits at index 1999: the cut keeps the high surrogate alone.
const CUT_POST = "a".repeat(1999) + "\u{1F680} more words after the emoji";
const makesText = (expr: string) => `export default function run(ctx) {
  const text = ${expr};
  return { content: { text, ok: "\u{1F680} pair" }, subject: { service: "social-service", id: "item-1" } };
}`;

describe("a Unit holding half an emoji is stored and handed to its asker", () => {
  it("Postgres jsonb refuses a lone surrogate written raw (why the guard exists)", async () => {
    const client = new PGlite();
    await expect(client.query("select $1::jsonb", [JSON.stringify({ t: "\ud83d" })])).rejects.toThrow(/json/i);
    await expect(client.query("select $1::jsonb", [wellFormedJson({ t: "\ud83d" })])).resolves.toBeTruthy();
  });

  for (const [label, expr] of [
    ["a lone high surrogate", `"x\\ud83d"`],
    ["a 2000-cut with an emoji at index 1999", `${JSON.stringify(CUT_POST)}.slice(0, 2000)`],
  ] as const) {
    it(`${label}: the child finishes made, its script_runs row stored, the parent receives the content`, async () => {
      await add("x_post_published", "dy_quote", `export default function run(ctx) {
  ctx.ask({ units: {} });
  const u = ctx.get("industry_news_found");
  return { content: { quoted: u.content.text, pair: u.content.ok }, subject: { service: "runs-service", id: "post-1" } };
}`);
      await db.update(scripts).set({ tactics: { asks: ["industry_news_found"] } }).where(eq(scripts.dynasty, "dy_quote"));
      await add("industry_news_found", "dy_watch", makesText(expr));
      const { l } = ledger();
      const result = await runStoredScript(db, { outcome: "x_post_published", dynasty: "dy_quote", units: {} }, who, { ledger: l, vendors: noVendors });
      expect(result.status).toBe("made");
      const quoted = (result.unit as { content: { quoted: string; pair: string } }).content;
      // The parent got the content (in memory, as the child made it); the valid pair is intact.
      expect(quoted.quoted.endsWith("\ud83d")).toBe(true);
      expect(quoted.pair).toBe("\u{1F680} pair");
      const rows = await db.select({ runId: scriptRuns.runId, status: scriptRuns.status, result: scriptRuns.result }).from(scriptRuns);
      expect(rows.map((r) => r.status).sort()).toEqual(["made", "made"]);
      const child = rows.find((r) => JSON.stringify(r.result).includes("item-1"))!;
      const stored = JSON.stringify(child.result);
      // Stored: the lone surrogate became U+FFFD, the valid pair byte-identical.
      expect(stored).toContain("\uFFFD");
      expect(stored).not.toMatch(/\\ud83d|[\ud800-\udbff](?![\udc00-\udfff])/);
      expect(stored).toContain("\u{1F680} pair");
    });
  }
});

describe("wellFormedJson", () => {
  it("serializes a well-formed value byte for byte as JSON.stringify", () => {
    const v = { a: "\u{1F680}\u{1F44D} ok", b: [1, "é", null, { "\u{1F680}": true }], d: new Date(0) };
    expect(wellFormedJson(v)).toBe(JSON.stringify(v));
  });
  it("replaces lone surrogates (values and keys) with U+FFFD, keeps pairs", () => {
    expect(wellFormedString("a\ud83db\ude80c\u{1F680}")).toBe("a�b�c\u{1F680}");
    expect(JSON.parse(wellFormedJson({ ["k\ud83d"]: ["\ude80"] }))).toEqual({ "k�": ["�"] });
  });
});

describe("the industry news watch cuts its post text on a whole character (v3 edit)", () => {
  it("the edit's anchor is found exactly once in v2's code, and the new cut never leaves half an emoji", async () => {
    const { buildIndustryNewsV2Source, INDUSTRY_NEWS_WHOLE_CHARS_EDIT: e } = await import("../../scripts/engine-ports/x-quote-industry.js");
    const v2 = buildIndustryNewsV2Source();
    expect(v2.split(e.from).length).toBe(2);
    const cut = e.to.slice("text: ".length, -1).replace("(t: string)", "(t)").replace(`String(i.text ?? "")`, "s");
    const apply = new Function("s", `return ${cut};`) as (s: string) => string;
    expect(apply(CUT_POST)).toBe("a".repeat(1999));
    expect(apply("short \u{1F680}")).toBe("short \u{1F680}");
    expect(apply("b".repeat(1998) + "\u{1F680}xyz")).toBe("b".repeat(1998) + "\u{1F680}");
  });
});
