import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import { SERVICE_DOOR_VENDORS, TO_PERSON_DOORS, type VendorDeps } from "../../src/lib/scripts/vendors.js";
import { setScriptStrategyReader } from "../../src/lib/scripts/engine.js";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { readRequest } from "../../src/lib/scripts/request-fields.js";
import { scriptNameProblem } from "../../src/lib/scripts/script-names.js";
import { scripts } from "../../src/db/schema.js";
import { testNamer } from "../helpers/script-names.js";
import { buildJudgmentSource, buildPageReadSource, engineScripts, JUDGMENT_MADE, PAGE_READ } from "../../scripts/engine-ports/page-read-judgment.js";

// ENGINE-GET-ASK-1123: page reads and judgments are Engines a script (or Distry) asks; one code each, the vendor a tactic.
const ROOT = join(__dirname, "../..");
const MIGRATIONS = join(ROOT, "drizzle");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true, nameDynasties: testNamer() };
const who = { orgId: "org-1", userId: "user-1", parentRunId: "caller", headers: { "x-brand-id": "brand-1" } };
const reader = engineScripts().find((s) => s.outcome === PAGE_READ)!;
const jev = engineScripts().find((s) => s.outcome === JUDGMENT_MADE)!;

let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
  setScriptStrategyReader(async () => []);
  for (const s of engineScripts()) {
    const row = await createScript(db, { outcome: s.outcome, dynasty: s.dynasty, name: s.name, code: s.code, description: s.description }, author, known);
    await db.update(scripts).set({ tactics: s.tactics }).where(eq(scripts.id, row.id));
  }
}, 60_000);

type Door = { service: string; method: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string> };
function world(answer: (d: Door) => { status: number; body: Record<string, unknown> }) {
  const doors: Door[] = [];
  const declared: Array<{ runId: string; body: unknown }> = [];
  let n = 0;
  const ledger: LedgerDeps = {
    async createRun() {
      return `run-${++n}`;
    },
    async declareOutcomes(runId, _o, body) {
      declared.push({ runId, body });
      return {};
    },
    async closeRun() {},
  };
  const never = async () => {
    throw new Error("a page read or a judgment script calls its door only");
  };
  const vendors = {
    complete: never,
    platformComplete: never,
    judge: never,
    platformJudge: never,
    readSkill: async () => null,
    serviceDoor: async (service: string, method: string, path: string, body: Record<string, unknown> | null, headers: Record<string, string>) => {
      const d = { service, method, path, body, headers };
      doors.push(d);
      return answer(d);
    },
  } as unknown as VendorDeps;
  return { ledger, vendors, doors, declared };
}

const read = (request: Record<string, unknown>, w: ReturnType<typeof world>, tactics?: Record<string, unknown>) =>
  runStoredScript(db, { outcome: PAGE_READ, dynasty: reader.dynasty, units: {}, request, ...(tactics ? { tactics } : {}), fallbackSubject: { service: "runs-service", id: "caller" } }, who, w);
const judge = (request: Record<string, unknown>, w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) =>
  runStoredScript(db, { outcome: JUDGMENT_MADE, dynasty: jev.dynasty, units: {}, request, fallbackSubject: { service: "runs-service", id: "caller" }, ...extra }, who, w);

describe("the scripts of the Page read and Judgment made Engines", () => {
  it("are valid scripts: no material, one door each, no outcome or model named, a readable name and description", async () => {
    for (const s of engineScripts()) {
      const key = `${s.outcome}/${s.dynasty}`;
      const v = await validateSource(s.code);
      expect(v.materials, key).toEqual([]);
      expect(v.vendors.length, key).toBe(1);
      for (const name of v.vendors) {
        expect(name in SERVICE_DOOR_VENDORS, name).toBe(true);
        expect(name in TO_PERSON_DOORS, name).toBe(false);
      }
      expect(s.code, key).not.toContain(`"${s.outcome}"`);
      expect(s.code, key).not.toMatch(/claude|haiku|opus|sonnet|gpt-|deepseek|jev-|"jev"|clef|luna|scrape-do|firecrawl/i);
      expect(scriptNameProblem(s.name), key).toBeNull();
      expect(`${s.name} ${s.description}`, key).not.toMatch(/[—–_]|agency/i);
    }
    expect((await validateSource(buildPageReadSource())).vendors).toEqual(["scraping.page"]);
    expect((await validateSource(buildJudgmentSource())).vendors).toEqual(["chat.judgment"]);
  });

  it("state the Request fields an asker outside a campaign must know, each named in the description", () => {
    expect(readRequest(buildPageReadSource())).toEqual({ fields: ["enrich", "maxAgeDays", "options", "render", "skipCache", "url"], whole: false });
    expect(readRequest(buildJudgmentSource())).toEqual({ fields: ["image", "questions", "state"], whole: false });
    for (const f of ["url", "enrich", "render", "maxAgeDays", "options"]) expect(reader.description).toContain(f);
    for (const f of ["questions", "state", "image", "noul", "choice", "score"]) expect(jev.description).toContain(f);
  });

  it("the store prints one create per script, as the catalogue poster reads them", async () => {
    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => void printed.push(String(line)));
    try {
      await import("../../scripts/engine-ports/page-read-judgment-store.js");
    } finally {
      log.mockRestore();
    }
    const ops = printed.map((l) => JSON.parse(l));
    expect(ops.map((o) => `${o.op} ${o.body.outcome}/${o.body.dynasty}`)).toEqual(["create page_read/dy_our_page_reader", "create judgment_made/dy_jev"]);
    for (const o of ops) expect(Object.keys(o.body).sort()).toEqual(["code", "description", "dynasty", "name", "outcome", "tactics"]);
    expect(ops[0].body.tactics).toEqual({});
    expect(ops[1].body.tactics).toEqual({ judge: "jev" });
    expect(ops[0].body.code).toBe(reader.code);
  });
});

describe("a page read", () => {
  const fresh = { cached: false, provider: "scrape-do", requestId: "req-7", runId: "scrape-run", result: { id: "req-7", url: "https://reed.example/pricing", rawMarkdown: "# Pricing" } };

  it("reads the page through the page door as the script's run, the request passed as stated, and the runner declares the Unit under the read's id", async () => {
    const w = world(() => ({ status: 200, body: fresh }));
    const out = await read({ url: " https://reed.example/pricing ", enrich: false, render: true, maxAgeDays: 2, options: { formats: ["markdown"] } }, w);
    expect(out.status).toBe("made");
    expect(w.doors).toHaveLength(1);
    expect(w.doors[0]).toMatchObject({ service: "scraping", method: "POST", path: "/scrape" });
    expect(w.doors[0]!.body).toEqual({ url: "https://reed.example/pricing", enrich: false, render: true, maxAgeDays: 2, options: { formats: ["markdown"] } });
    expect(w.doors[0]!.headers["x-run-id"]).toBe(out.runId);
    expect(w.doors[0]!.headers["x-org-id"]).toBe("org-1");
    expect(out.unit).toEqual({ outcome: PAGE_READ, subject: { service: "scraping-service", id: "req-7" }, content: fresh });
    expect(w.declared).toEqual([{ runId: out.runId, body: { produced: [{ outcomeKey: PAGE_READ, subjectService: "scraping-service", subjectId: "req-7" }], consumed: [] } }]);
  });

  it("states only what the asker states, and a reader pinned by tactic", async () => {
    const w = world(() => ({ status: 200, body: fresh }));
    await read({ url: "https://reed.example" }, w);
    expect(w.doors[0]!.body).toEqual({ url: "https://reed.example" });
    await read({ url: "https://reed.example", skipCache: true }, w, { provider: "a-reader" });
    expect(w.doors[1]!.body).toEqual({ url: "https://reed.example", skipCache: true, provider: "a-reader" });
  });

  it("a read the reader already held makes no Unit and declares nothing: the page is handed back as the answer", async () => {
    const held = { cached: true, result: { id: "res-1", url: "https://reed.example", rawMarkdown: "# Reed" } };
    const w = world(() => ({ status: 200, body: held }));
    const out = await read({ url: "https://reed.example" }, w);
    expect(out.status).toBe("unmade");
    expect(out.error).toMatch(/^stored_read: /);
    expect(out.decided).toBe("done");
    expect(out.answer).toEqual(held);
    expect(out.unit).toBeNull();
    expect(w.declared).toEqual([]);
  });

  it("the door's refusal is unmade with its code, else page_not_read, in the door's words", async () => {
    const w = world(() => ({ status: 500, body: { error: "Scrape failed: timeout", requestId: "req-8" } }));
    const out = await read({ url: "https://down.example" }, w);
    expect(out.status).toBe("unmade");
    expect(out.error).toBe("page_not_read: Scrape failed: timeout (500) for https://down.example");
    expect(w.declared).toEqual([]);
    const coded = await read({ url: "https://down.example" }, world(() => ({ status: 402, body: { error: "Insufficient credits", code: "credit_insufficient" } })));
    expect(coded.error).toBe("credit_insufficient: Insufficient credits (402) for https://down.example");
  });

  it("no URL, no answer at all, or a fresh read without its id fail the run by name", async () => {
    const w = world(() => ({ status: 200, body: fresh }));
    await expect(read({ page: "https://reed.example" }, w)).rejects.toThrow(/names no page to read \(request\.url/);
    expect(w.doors).toEqual([]);
    const down = world(() => {
      throw new Error("fetch failed");
    });
    await expect(read({ url: "https://reed.example" }, down)).rejects.toThrow(/scraping\.page: .*fetch failed/);
    await expect(read({ url: "https://reed.example" }, world(() => ({ status: 200, body: { cached: false, result: {} } })))).rejects.toThrow(/without its requestId/);
    expect(w.declared).toEqual([]);
    expect(down.declared).toEqual([]);
  });
});

describe("a judgment", () => {
  const questions = {
    fits: { type: "noul", instructions: "Is this a plumber?" },
    team: { type: "choice", instructions: "Who handles it?", criteria: { sales: "a buyer", support: "a client" } },
    heat: { type: "score", instructions: "How urgent?", criteria: ["not", "somewhat", "very"] },
  };
  const answered = {
    judge: "jev",
    model: "judge-release",
    answers: {
      fits: { type: "noul", noul: 0.91 },
      team: { type: "choice", choice: "sales", confidence: 0.8, probabilities: { sales: 0.9, support: 0.1 } },
      heat: { type: "score", score: 1.3, confidence: 0.5, probabilities: { "0": 0.2, "1": 0.3, "2": 0.5 }, legend: { "0": "not", "1": "somewhat", "2": "very" } },
    },
    usage: { inputTokens: 120, outputTokens: 9 },
  };

  it("asks the judge its tactic names with the questions as stated, and the runner declares the Unit about the asker's subject", async () => {
    const w = world(() => ({ status: 200, body: answered }));
    const out = await judge({ state: "We fix leaks in Austin.", questions }, w, { subject: { service: "lead-service", id: "lead-9" } });
    expect(out.status).toBe("made");
    expect(w.doors[0]).toMatchObject({ service: "chat", method: "POST", path: "/orgs/judgments" });
    expect(w.doors[0]!.body).toEqual({ state: "We fix leaks in Austin.", questions, judge: "jev" });
    expect(w.doors[0]!.headers["x-run-id"]).toBe(out.runId);
    expect(out.unit).toEqual({ outcome: JUDGMENT_MADE, subject: { service: "lead-service", id: "lead-9" }, content: answered });
    expect(w.declared).toEqual([{ runId: out.runId, body: { produced: [{ outcomeKey: JUDGMENT_MADE, subjectService: "lead-service", subjectId: "lead-9" }], consumed: [] } }]);
  });

  it("an image is passed as stated, a model only when the script's tactics state one, and no subject = the asking run", async () => {
    const w = world(() => ({ status: 200, body: answered }));
    const image = { url: "https://img.example/home.png" };
    const out = await judge({ image, questions: { fits: questions.fits } }, w, { tactics: { model: "a-judge-model" } });
    expect(w.doors[0]!.body).toEqual({ image, questions: { fits: questions.fits }, judge: "jev", model: "a-judge-model" });
    expect(out.unit!.subject).toEqual({ service: "runs-service", id: "caller" });
  });

  it("the judge's refusal is unmade with its code, else judgment_not_made, in its words", async () => {
    const refused = await judge({ image: { url: "https://img.example/dead.png" }, questions }, world(() => ({ status: 400, body: { error: "image could not be fetched", code: "image_unusable" } })));
    expect(refused.status).toBe("unmade");
    expect(refused.error).toBe("image_unusable: image could not be fetched (400)");
    const busy = await judge({ state: "x", questions }, world(() => ({ status: 429, body: { error: "judge saturated" } })));
    expect(busy.error).toBe("judgment_not_made: judge saturated (429)");
  });

  it("no question, nothing to judge, no judge stated, or no answer at all fail the run by name", async () => {
    const w = world(() => ({ status: 200, body: answered }));
    await expect(judge({ state: "x" }, w)).rejects.toThrow(/asks no question \(request\.questions/);
    await expect(judge({ state: "x", questions: {} }, w)).rejects.toThrow(/asks no question/);
    await expect(judge({ questions }, w)).rejects.toThrow(/states nothing to judge \(request\.state, request\.image/);
    expect(w.doors).toEqual([]);
    await db.update(scripts).set({ tactics: {} }).where(eq(scripts.dynasty, jev.dynasty));
    await expect(judge({ state: "x", questions }, w)).rejects.toThrow(/states no judge \(tactic judge\)/);
    await db.update(scripts).set({ tactics: jev.tactics }).where(eq(scripts.dynasty, jev.dynasty));
    const down = world(() => {
      throw new Error("fetch failed");
    });
    await expect(judge({ state: "x", questions }, down)).rejects.toThrow(/chat\.judgment \(jev\): .*fetch failed/);
    await expect(judge({ state: "x", questions }, world(() => ({ status: 200, body: {} })))).rejects.toThrow(/answered without answers/);
    expect(w.declared).toEqual([]);
  });
});
