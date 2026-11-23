import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { ScriptRunFailed, runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import { readProvider, type VendorDeps } from "../../src/lib/scripts/vendors.js";
import { asksOf, readAsks, readMaterials, runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { PROVIDER_INDEX_PARTIAL_TTL_MS, PROVIDER_INDEX_TTL_MS, createProviderIndex, providerOperationsOf, type ProviderReads } from "../../src/lib/scripts/provider-index.js";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { pickScript, setScriptPickReader, setScriptStrategyReader } from "../../src/lib/scripts/engine.js";
import { unitsToHand } from "../../src/lib/scripts/engine-calls.js";
import { PROOF_SAMPLE, isPairWriter, proveScript, setProofContext, type ProofDeps } from "../../src/lib/scripts/writer-proof.js";
import { scriptRuns, scripts, writerCases } from "../../src/db/schema.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { testNamer } from "../helpers/script-names.js";
import { buildCompletionSource, COMPLETION_LLMS, completionDynasty, completionTactics, LLM_COMPLETION } from "../../scripts/engine-ports/llm-completion.js";

// ENGINE-GET-ASK-1123: two gestures. `ctx.get(outcome, filters)` READS Units from the outcome's Provider (the read
// that service documents itself); `ctx.ask(outcome, inputs)` MAKES one new Unit through the Engine and returns it.
// The older forms (`ctx.get(outcome)` on a handed Unit, `ctx.ask(request)` then `ctx.get(outcome)`) are unchanged.
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

/** A fake served spec: one Provider read of `lead_found`, two of `post_published`, and an untagged route. */
const SPECS = new Map<string, Record<string, unknown>>([
  [
    "lead",
    {
      paths: {
        "/orgs/brands/{brandId}/leads-found": { get: { operationId: "listLeadsFound", tags: ["leads", "provider:lead_found"] }, delete: { tags: ["provider:lead_found"] } },
        "/orgs/leads/{id}": { get: { operationId: "getLead", tags: ["leads"] } },
      },
    },
  ],
  [
    "social",
    {
      paths: {
        "/orgs/social/publications": { get: { operationId: "listPublications", tags: ["provider:post_published"] } },
        "/orgs/social/publications/search": { post: { operationId: "searchPublications", tags: ["provider:post_published"] } },
      },
    },
  ],
]);
const index = providerOperationsOf(SPECS);
const providerReads = async (outcome: string): Promise<ProviderReads> => ({ operations: index.get(outcome) ?? [], unread: [] });

type Door = { service: string; method: string; path: string; body: unknown; headers: Record<string, string> };
function vendors(answer: { status: number; body: Record<string, unknown> } = { status: 200, body: { leads: [{ id: "lead-1" }], total: 1 } }) {
  const doors: Door[] = [];
  const v = {
    complete: async (body: Record<string, unknown>) => ({ content: "", json: { decision: "write", message: "<p>Tuesday at 10am works.</p>" }, model: String(body.model), tokensInput: 10, tokensOutput: 10 }),
    judge: async () => ({}),
    readSkill: async () => null,
    platformComplete: async () => ({}),
    platformJudge: async () => ({}),
    serviceDoor: async (service: string, method: string, path: string, body: unknown, headers: Record<string, string>) => {
      doors.push({ service, method, path, body, headers });
      return answer;
    },
    providerReads,
  } as unknown as VendorDeps;
  return { v, doors };
}

function ledger() {
  const runs: Array<{ id: string; taskName: string; parentRunId: string }> = [];
  const declared: Array<{ runId: string; body: unknown }> = [];
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
beforeEach(async () => {
  db = await freshDb();
  setScriptPickReader(fakeScriptPick());
  setScriptStrategyReader(async (_c, outcome) => (await db.select().from(scripts).where(eq(scripts.outcome, outcome))).map((r) => r.dynasty));
  setProofContext(null);
}, 60_000);
afterEach(() => {
  setProofContext(null);
  setScriptPickReader(null);
  setScriptStrategyReader(null);
});

async function add(outcome: string, dynasty: string, code: string, tactics: Record<string, unknown> = {}) {
  const row = await createScript(db, { outcome, dynasty, code, description: "x" }, author, known);
  if (Object.keys(tactics).length) await db.update(scripts).set({ tactics }).where(eq(scripts.id, row.id));
  const [fresh] = await db.select().from(scripts).where(eq(scripts.id, row.id));
  return fresh!;
}

describe("the sandbox tells the forms apart by what the script states", () => {
  it("passes one argument for the old forms, two for the new ones; only the direct ask returns", async () => {
    const seen: Array<[string, unknown[]]> = [];
    const bridge: Bridge = (op, args) => {
      seen.push([op, args]);
      return { v: op === "ask" && typeof args[0] !== "string" ? null : { content: { n: seen.length } } };
    };
    const out = await runScript(
      `export default function run(ctx) {
        const a = ctx.get("held");
        const b = ctx.get("read", { query: { since: "2026-11-01" } });
        const c = ctx.ask({ units: {} });
        const d = ctx.ask("made", { request: { x: 1 } });
        const e = ctx.ask("made");
        return { content: { a: a.content.n, b: b.content.n, c: c === undefined, d: d.content.n, e: e.content.n, frozen: Object.isFrozen(d.content) } };
      }`,
      { subject: null, brand: "b", day: 1, tactics: {} },
      bridge,
    );
    expect(out).toEqual({ kind: "done", result: { content: { a: 1, b: 2, c: true, d: 4, e: 5, frozen: true } } });
    expect(seen).toEqual([
      ["get", ["held"]],
      ["get", ["read", { query: { since: "2026-11-01" } }]],
      ["ask", [{ units: {} }]],
      ["ask", ["made", { request: { x: 1 } }]],
      ["ask", ["made", null]],
    ]);
  });
});

describe("what a script must be handed, and what it asks, read from its code", () => {
  const code = `
export default function run(ctx) {
  const held = ctx.get("answer_requested");
  const past = ctx.get("message_sent", { query: { leadId: held.subject } });
  const done = ctx.ask("llm_completion", { request: { message: "(a, b)" } });
  ctx.ask({ units: {} });
  const old = ctx.get("booking_call");
  return null;
}`;
  it("a filtered get is no material; a direct ask is an asked Engine (as tactic asks would say)", () => {
    expect(readMaterials(code)).toEqual(["answer_requested", "booking_call"]);
    expect(readAsks(code)).toEqual(["llm_completion"]);
    expect(asksOf({ tactics: { asks: ["booking_call"] }, code })).toEqual(["booking_call", "llm_completion"]);
    expect(asksOf({ tactics: { asks: ["booking_call"] } })).toEqual(["booking_call"]);
    expect(unitsToHand({ materials: ["answer_requested", "llm_completion"], tactics: {}, code })).toEqual(["answer_requested"]);
  });

  it("keeps the always-a-literal rule for both gestures, and leaves the one-argument Request form alone", async () => {
    await expect(validateSource(code)).resolves.toMatchObject({ materials: ["answer_requested", "booking_call"] });
    await expect(validateSource(`export default function run(ctx) { const o = "x"; return ctx.get(o, {}); }`)).rejects.toThrow(/every ctx.get/);
    await expect(validateSource(`export default function run(ctx) { const o = "x"; return ctx.get(o); }`)).rejects.toThrow(/every ctx.get/);
    await expect(validateSource(`export default function run(ctx) { const o = "x"; return ctx.ask(o, { units: {} }); }`)).rejects.toThrow(/every ctx.ask\(outcome, inputs\)/);
    await expect(validateSource(`export default function run(ctx) { const r = { units: { a: { content: [1, 2] } }, request: f(1, 2) }; ctx.ask(r); ctx.ask({ units: {}, tactics: { a: 1, b: "x, y" } }); return null; }`)).resolves.toBeDefined();
  });

  it("a script asking directly is drawn without the tactic; one reading a material nobody hands is not", async () => {
    await add("conversation", "dy_direct", `export default function run(ctx) { const w = ctx.ask("message_written", {}); return w.content ? null : null; }`);
    expect((await pickScript(db, { outcome: "conversation", servable: [], channel: null }))?.script.dynasty).toBe("dy_direct");
    await add("meeting_booked", "dy_pair", `export default function run(ctx) { ctx.ask({ units: {} }); ctx.get("message_written"); return null; }`);
    expect(await pickScript(db, { outcome: "meeting_booked", servable: [], channel: null })).toBeNull();
    await add("paid_client", "dy_mixed", `export default function run(ctx) { ctx.ask("message_written", {}); ctx.ask({ units: {} }); ctx.get("message_written"); return null; }`);
    expect((await pickScript(db, { outcome: "paid_client", servable: [], channel: null }))?.script.dynasty).toBe("dy_mixed");
  });
});

describe("the Provider read of an outcome is found in the served specs, by its tag", () => {
  it("lists every callable operation tagged provider:<outcome>, whatever its route", () => {
    expect(index.get("lead_found")).toEqual([{ service: "lead", method: "GET", path: "/orgs/brands/{brandId}/leads-found", operationId: "listLeadsFound" }]);
    expect(index.get("post_published")!.map((o) => [o.method, o.operationId])).toEqual([
      ["GET", "listPublications"],
      ["POST", "searchPublications"],
    ]);
    expect(index.get("message_sent")).toBeUndefined();
  });

  it("walks the registry once per TTL, shares one walk between concurrent asks, and keeps a partial index briefly", async () => {
    let at = 0;
    let walks = 0;
    let missing = false;
    const read = createProviderIndex({
      listServices: async () => ["lead", "social"],
      fetchSpecs: async (services) => {
        walks++;
        return new Map(services.filter((s) => !(missing && s === "social")).map((s) => [s, SPECS.get(s)!]));
      },
      now: () => at,
    });
    const [a, b] = await Promise.all([read("lead_found"), read("post_published")]);
    expect([a.operations.length, b.operations.length, walks]).toEqual([1, 2, 1]);
    at = PROVIDER_INDEX_TTL_MS - 1;
    await read("nothing");
    expect(walks).toBe(1);
    at = PROVIDER_INDEX_TTL_MS;
    missing = true;
    expect(await read("post_published")).toEqual({ operations: [], unread: ["social"] });
    expect(walks).toBe(2);
    at += PROVIDER_INDEX_PARTIAL_TTL_MS;
    missing = false;
    expect((await read("post_published")).operations).toHaveLength(2);
    expect(walks).toBe(3);
  });
});

describe("ctx.get(outcome, filters): a read from the outcome's Provider", () => {
  const ctx = { headers: { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "script-run", "x-brand-id": "brand-1" }, tactics: {} };

  it("calls the tagged operation as the script's run with the filters its route documents, and answers its whole body", async () => {
    const { v, doors } = vendors();
    const out = await readProvider("lead_found", { params: { brandId: "brand 1" }, query: { since: "2026-11-01", limit: 5 } }, ctx, v);
    expect(out).toEqual({ answer: { ok: true, data: { leads: [{ id: "lead-1" }], total: 1 } } });
    expect(doors).toEqual([{ service: "lead", method: "GET", path: "/orgs/brands/brand%201/leads-found?since=2026-11-01&limit=5", body: null, headers: ctx.headers }]);
  });

  it("a refusal is an answer the script reads, never a throw", async () => {
    const { v } = vendors({ status: 403, body: { error: "not this brand", code: "brand_not_of_org" } });
    expect(await readProvider("lead_found", { params: { brandId: "b" } }, ctx, v)).toEqual({
      answer: { ok: false, data: { error: "not this brand", status: 403, code: "brand_not_of_org", body: { error: "not this brand", code: "brand_not_of_org" } } },
    });
    expect(await readProvider("lead_found", {}, ctx, v)).toEqual({ answer: { ok: false, data: { error: "provider:lead_found needs params.brandId" } } });
  });

  it("stops, named, when no Provider documents a read for the outcome", async () => {
    const { v, doors } = vendors();
    expect(await readProvider("message_sent", { query: {} }, ctx, v)).toEqual({
      stop: "no Provider read is documented for message_sent (no served operation carries the tag provider:message_sent)",
    });
    const partial = { ...v, providerReads: async () => ({ operations: [], unread: ["crm"] }) } as VendorDeps;
    expect(((await readProvider("message_sent", null, ctx, partial)) as { stop: string }).stop).toContain("specs not read: crm");
    expect(doors).toEqual([]);
  });

  it("several documented reads: the filters name which (its operationId), else a stop listing them", async () => {
    const { v, doors } = vendors();
    const none = (await readProvider("post_published", { query: {} }, ctx, v)) as { stop: string };
    expect(none.stop).toContain("name one in filters.route");
    expect(none.stop).toContain("listPublications = social GET /orgs/social/publications");
    expect(none.stop).toContain("searchPublications = social POST /orgs/social/publications/search");
    expect(((await readProvider("post_published", { route: "nope" }, ctx, v)) as { stop: string }).stop).toContain("is named nope");
    await readProvider("post_published", { route: "searchPublications", body: { text: "launch" } }, ctx, v);
    expect(doors).toEqual([{ service: "social", method: "POST", path: "/orgs/social/publications/search", body: { text: "launch" }, headers: ctx.headers }]);
    expect(((await readProvider("lead_found", "brand-1", ctx, v)) as { stop: string }).stop).toContain("filters is an object");
  });

  it("in a run: answered to the script, on its record, as its run; nothing declared consumed", async () => {
    await add("conversation", "dy_reader", `
export default function run(ctx) {
  const found = ctx.get("lead_found", { params: { brandId: ctx.brand }, query: { limit: 1 } });
  if (!found.ok) return { unmade: "unread: " + found.data.code };
  return { content: { total: found.data.total, first: found.data.leads[0].id }, subject: { service: "lead-service", id: found.data.leads[0].id } };
}`);
    const { v, doors } = vendors();
    const { l, declared } = ledger();
    const out = await runStoredScript(db, { outcome: "conversation", dynasty: "dy_reader", units: {}, trace: true }, who, { ledger: l, vendors: v });
    expect(out.status).toBe("made");
    expect(out.unit!.content).toEqual({ total: 1, first: "lead-1" });
    expect(doors).toHaveLength(1);
    expect(doors[0]).toMatchObject({ service: "lead", path: "/orgs/brands/brand-1/leads-found?limit=1" });
    expect(doors[0]!.headers).toMatchObject({ "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": out.runId, "x-campaign-id": "camp-1" });
    expect(out.vendorCalls.map((c) => [c.name, c.ok])).toEqual([["provider:lead_found", true]]);
    expect(out.trace).toEqual([{ name: "provider:lead_found", args: { params: { brandId: "brand-1" }, query: { limit: 1 } }, answer: { ok: true, data: { leads: [{ id: "lead-1" }], total: 1 } } }]);
    expect(declared).toEqual([{ runId: out.runId, body: { produced: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "lead-1" }], consumed: [] } }]);
  });

  it("in a run: an outcome nobody documents a read for stops the run with that reason", async () => {
    await add("conversation", "dy_reader", `export default function run(ctx) { ctx.get("message_sent", {}); return null; }`);
    const { l } = ledger();
    const failed = await runStoredScript(db, { outcome: "conversation", dynasty: "dy_reader", units: {} }, who, { ledger: l, vendors: vendors().v }).catch((e) => e);
    expect(failed).toBeInstanceOf(ScriptRunFailed);
    expect((failed as ScriptRunFailed).result).toMatchObject({ status: "stopped", error: expect.stringContaining("no Provider read is documented for message_sent") });
  });

  it("the one-argument get still reads the handed Unit and consumes it", async () => {
    await add("conversation", "dy_held", `export default function run(ctx) { const r = ctx.get("lead_found"); return { content: { email: r.content.email } }; }`);
    const { v, doors } = vendors();
    const { l, declared } = ledger();
    const lead = { service: "lead-service", id: "lead-9" };
    const out = await runStoredScript(db, { outcome: "conversation", dynasty: "dy_held", subject: lead, units: { lead_found: { content: { email: "a@staff.test" }, subject: lead } } }, who, { ledger: l, vendors: v });
    expect(out.unit!.content).toEqual({ email: "a@staff.test" });
    expect(doors).toEqual([]);
    expect(declared[0]!.body).toEqual({ produced: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "lead-9" }], consumed: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "lead-9" }] });
  });
});

describe("ctx.ask(outcome, inputs): one new Unit, made by the Engine, handed back", () => {
  const WRITER = `export default function run(ctx) { const b = ctx.get("brand_context"); return { content: { subject: "Hello from " + b.content.name } }; }`;
  const body = `return { content: { subject: w.content.subject, child: w.run.scriptSlug }, subject: { service: "lead-service", id: "lead-9" } };`;
  const PAIR = `export default function run(ctx) { ctx.ask({ units: { brand_context: { content: { name: "Reed" } } }, subject: { service: "lead-service", id: "lead-9" } }); const w = ctx.get("message_written"); ${body} }`;
  const DIRECT = `export default function run(ctx) { const w = ctx.ask("message_written", { units: { brand_context: { content: { name: "Reed" } } }, subject: { service: "lead-service", id: "lead-9" } }); ${body} }`;

  async function run(dynasty: string) {
    const { l, runs, declared } = ledger();
    const out = await runStoredScript(db, { outcome: "conversation", dynasty, units: {} }, who, { ledger: l, vendors: vendors().v });
    return { out, runs, declared, rows: await db.select().from(scriptRuns) };
  }

  it("is the same order as ask-then-get: same pick, same child run, same Unit, same declarations", async () => {
    await add("message_written", "dy_writer", WRITER);
    await add("conversation", "dy_pair", PAIR, { asks: ["message_written"] });
    await add("conversation", "dy_direct", DIRECT);
    const pair = await run("dy_pair");
    const direct = await run("dy_direct");
    for (const r of [pair, direct]) {
      expect(r.out.status).toBe("made");
      expect(r.out.unit!.content).toEqual({ subject: "Hello from Reed", child: "message_written/dy_writer/v1" });
      expect(r.runs.map((x) => x.taskName)).toEqual([expect.stringMatching(/^script:conversation\//), "script:message_written/dy_writer"]);
      expect(r.runs[1]!.parentRunId).toBe(r.runs[0]!.id);
      const written = { outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-9" };
      // The child declares its Unit; the asking run consumes it and produces its own.
      expect(r.declared).toEqual([
        { runId: "run-2", body: { produced: [written], consumed: [] } },
        { runId: "run-1", body: { produced: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "lead-9" }], consumed: [written] } },
      ]);
    }
    expect(fakePickAskedBy()).toEqual(["conversation/dy_pair", "conversation/dy_direct"]);
  });

  it("inputs naming no units hand none (the one-argument Request form still requires them)", async () => {
    await add("message_written", "dy_plain", `export default function run(ctx) { return { content: { subject: String(ctx.request.topic) } }; }`);
    await add("conversation", "dy_direct", `export default function run(ctx) { const w = ctx.ask("message_written", { request: { topic: "Launch" } }); return { content: { subject: w.content.subject }, subject: { service: "lead-service", id: "lead-9" } }; }`);
    await add("meeting_booked", "dy_pair", `export default function run(ctx) { ctx.ask({ request: { topic: "Launch" } }); ctx.get("message_written"); return null; }`, { asks: ["message_written"] });
    expect((await run("dy_direct")).out.unit!.content).toEqual({ subject: "Launch" });
    const { l } = ledger();
    const failed = await runStoredScript(db, { outcome: "meeting_booked", dynasty: "dy_pair", units: {} }, who, { ledger: l, vendors: vendors().v }).catch((e) => e);
    expect((failed as ScriptRunFailed).result.error).toContain("the Request names no units");
  });

  it("answers no_script when no script of that Engine can run, and refuses inputs that are not an object", async () => {
    await add("conversation", "dy_direct", `export default function run(ctx) { const w = ctx.ask("message_written", {}); return { unmade: "asked: " + w.unmade }; }`);
    const r = await run("dy_direct");
    expect([r.out.status, r.out.error]).toEqual(["unmade", "asked: no_script: no live script of that Engine can run on nothing"]);
    await add("meeting_booked", "dy_bad", `export default function run(ctx) { ctx.ask("message_written", [1]); return null; }`);
    const { l } = ledger();
    const failed = await runStoredScript(db, { outcome: "meeting_booked", dynasty: "dy_bad", units: {} }, who, { ledger: l, vendors: vendors().v }).catch((e) => e);
    expect((failed as ScriptRunFailed).result.error).toContain("inputs is one object");
  });
});

let pickReader: ReturnType<typeof fakeScriptPick>;
beforeEach(() => {
  pickReader = fakeScriptPick();
  setScriptPickReader(pickReader);
});
const fakePickAskedBy = () => pickReader.calls.filter((c) => c.outcome === "message_written").map((c) => c.askedBy);

describe("a run using the new forms replays from its record", () => {
  const code = `
export default function run(ctx) {
  const past = ctx.get("message_sent", { query: { leadId: ctx.subject } });
  const first = ctx.ask("llm_completion", { request: { message: "one " + past.data.total } });
  const check = ctx.vendor.call("email.send_check", { body: { email: "a@staff.test" } });
  const second = ctx.ask("llm_completion", { request: { message: "two" } });
  return { content: { text: first.content.answer + " / " + second.content.answer, checked: check.ok } };
}`;
  const CASE: ReplayCase = {
    id: "fictional-get-ask",
    subject: "lead-9",
    units: { llm_completion: [{ answer: "A" }, { answer: "B" }] },
    asks: [{ request: { message: "one 3" } }, { request: { message: "two" } }],
    calls: [
      { name: "provider:message_sent", args: { query: { leadId: "lead-9" } }, answer: { ok: true, data: { total: 3 } } },
      { name: "email.send_check", args: { body: { email: "a@staff.test" } }, answer: { ok: true, data: {} } },
    ],
    expect: { content: { text: "A / B", checked: true } },
  };

  it("answers the filtered read and each direct ask from the record, in order", async () => {
    expect(await replayCase(code, CASE)).toEqual({ id: CASE.id, match: true, diffs: [] });
  });

  it("names a read whose filters differ, a read the record did not make, and an ask whose inputs differ", async () => {
    const filters = await replayCase(code, { ...CASE, calls: [{ ...CASE.calls[0]!, args: { query: { leadId: "lead-1" } } }, CASE.calls[1]!] });
    expect(filters.diffs[0]).toMatch(/^call 1 provider:message_sent: request\.query\.leadId/);
    const absent = await replayCase(code, { ...CASE, calls: [CASE.calls[1]!] });
    expect(absent.diffs).toEqual(["call 1: called provider:message_sent, the record called email.send_check"]);
    const inputs = await replayCase(code, { ...CASE, asks: [{ request: { message: "one 3" } }, { request: { message: "2" } }] });
    expect(inputs.diffs[0]).toMatch(/^asks\[1\]\.request\.message/);
  });

  it("the same case replays the ask-then-get pair and the direct ask alike", async () => {
    const pair = `export default function run(ctx) { ctx.ask({ units: {}, request: { message: "hi" } }); const c = ctx.get("llm_completion"); return { content: { text: c.content.answer } }; }`;
    const direct = `export default function run(ctx) { const c = ctx.ask("llm_completion", { units: {}, request: { message: "hi" } }); return { content: { text: c.content.answer } }; }`;
    const c: ReplayCase = { id: "fictional-pair", units: { llm_completion: { answer: "A" } }, asks: [{ units: {}, request: { message: "hi" } }], calls: [], expect: { content: { text: "A" } } };
    expect((await replayCase(pair, c)).match).toBe(true);
    expect((await replayCase(direct, c)).match).toBe(true);
  });
});

describe("a writer asking its model directly is recorded and proven like the pair", () => {
  const WRITER = `
export default function run(ctx) {
  const a = ctx.get("answer_requested");
  const past = ctx.get("lead_found", { params: { brandId: ctx.brand } });
  ctx.consume("lead_found", { service: "lead-service", id: past.data.leads[0].id });
  const done = ctx.ask("llm_completion", { subject: { service: "lead-service", id: a.subject }, request: { message: "Thread: " + a.content.thread + " (" + past.data.total + " found)", systemPrompt: "Answer the person.", responseFormat: "json", responseSchema: { type: "object" } } });
  const d = done.content.answer.json || {};
  if (d.decision !== "write") throw new Error("unknown decision");
  return { content: { decision: "write", message: String(d.message || "") }, subject: { service: "lead-service", id: a.subject } };
}`;
  const llm = COMPLETION_LLMS.find((l) => l.model === "claude-haiku")!;

  it("keeps the case with its read and its ordered Unit; the pair proof replays it with the model live, nothing sent", async () => {
    // No tactic `asks`: the code's direct ask says it.
    const writer = await add("message_written", "dy_direct_writer", WRITER, { personFields: ["message"] });
    const completion = await add(LLM_COMPLETION, completionDynasty(llm), buildCompletionSource(), completionTactics(llm));
    expect(isPairWriter(writer)).toBe(true);
    const lead = { service: "lead-service", id: "lead-9" };
    const { l } = ledger();
    for (let i = 0; i < PROOF_SAMPLE; i++) {
      await runStoredScript(db, { outcome: "message_written", dynasty: "dy_direct_writer", subject: lead, units: { answer_requested: { content: { thread: `Can we meet Tuesday? #${i}` }, subject: lead } } }, { ...who, parentRunId: `sender-${i}` }, { ledger: l, vendors: vendors().v });
    }
    const cases = await db.select().from(writerCases);
    expect(cases).toHaveLength(PROOF_SAMPLE);
    const kept = cases[0]!.body as { calls: Array<{ name: string }>; asked: Record<string, unknown>; orders: Array<{ outcome: string; unit: { content: unknown } }> };
    expect(cases[0]!.wrote).toBe(true);
    expect(kept.calls.map((c) => c.name)).toEqual(["provider:lead_found"]);
    expect(Object.keys(kept.asked)).toEqual([LLM_COMPLETION]);
    expect(kept.orders.map((o) => o.outcome)).toEqual([LLM_COMPLETION]);

    const llmCalls: Array<Record<string, unknown>> = [];
    const doors: string[] = [];
    const proofVendors = {
      complete: async () => {
        throw new Error("a proof is platform-billed");
      },
      judge: async () => {
        throw new Error("a proof is platform-billed");
      },
      platformComplete: async (b: Record<string, unknown>) => {
        llmCalls.push(b);
        const json = { decision: "write", message: "<p>Tuesday 10am works for us.</p>" };
        return { content: JSON.stringify(json), json, model: String(b.model), tokensInput: 2000, tokensOutput: 200 };
      },
      platformJudge: async (b: Record<string, unknown>) => ({ answers: Object.fromEntries(Object.keys(b.questions as object).map((k) => [k, { noul: 0.96 }])), model: "jev" }),
      readSkill: async () => null,
      serviceDoor: async (_s: string, _m: string, path: string) => {
        doors.push(path);
        throw new Error("a proof never calls a door");
      },
      providerReads: async () => {
        throw new Error("a proof never resolves a Provider");
      },
    } as unknown as VendorDeps;
    const deps: ProofDeps = { vendors: proofVendors, openRun: async () => "proof-run", closeRun: async () => {} };
    const proof = await proveScript(db, deps, writer, "staff", completion);
    expect([proof.state, proof.sample, proof.usable]).toEqual(["passed", PROOF_SAMPLE, PROOF_SAMPLE]);
    expect(llmCalls).toHaveLength(PROOF_SAMPLE);
    expect(String(llmCalls[0]!.message)).toContain("(1 found)");
    expect(doors).toEqual([]);
  });
});

// ENGINE-GET-ASK-1123 step 2a (owner 2026-11-23, option A): a read declares nothing; the Script says, Unit by Unit,
// which Units it read it USED (`ctx.consume(outcome, {service, id})`), and the run declares exactly those consumed.
describe("ctx.consume(outcome, subject): the script declares a Unit it read as used", () => {
  const verification = { service: "apollo-service", id: "verif-12" };
  const reuse = `
export default function run(ctx) {
  const past = ctx.get("email_sent", { query: { leadId: ctx.subject } });
  const found = ctx.get("email_found", { query: { leadId: ctx.subject } });
  ctx.consume("email_found", found.data.subject);
  ctx.consume("email_found", { service: " apollo-service ", id: "verif-12" });
  return { content: { sentBefore: past.ok } };
}`;
  const SPECS2 = new Map<string, Record<string, unknown>>([
    ["apollo", { paths: { "/orgs/emails-found": { get: { operationId: "listEmailsFound", tags: ["provider:email_found"] } } } }],
    ["instantly", { paths: { "/orgs/emails-sent": { get: { operationId: "listEmailsSent", tags: ["provider:email_sent"] } } } }],
  ]);
  const index2 = providerOperationsOf(SPECS2);
  const reads = () => {
    const { v } = vendors({ status: 200, body: { subject: verification, verdict: "deliverable" } });
    (v as unknown as { providerReads: unknown }).providerReads = async (outcome: string): Promise<ProviderReads> => ({ operations: index2.get(outcome) ?? [], unread: [] });
    return v;
  };
  const lead = { service: "lead-service", id: "lead-9" };

  it("reaches the ledger declaration once per Unit: the one it used, never the one it only looked at", async () => {
    await add("conversation", "dy_reuse", reuse);
    const { l, declared } = ledger();
    const out = await runStoredScript(db, { outcome: "conversation", dynasty: "dy_reuse", subject: lead, units: {} }, who, { ledger: l, vendors: reads() });
    expect(out.status).toBe("made");
    const consumed = [{ outcomeKey: "email_found", subjectService: "apollo-service", subjectId: "verif-12" }];
    expect(declared).toEqual([{ runId: out.runId, body: { produced: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "lead-9" }], consumed } }]);
    expect(out.declared.consumed).toEqual(consumed);
    // No call to the world: neither a vendor call nor a Provider read.
    expect(out.vendorCalls.map((c) => c.name)).toEqual(["provider:email_sent", "provider:email_found"]);
    const [stored] = await db.select().from(scriptRuns).where(eq(scriptRuns.runId, out.runId));
    expect((stored!.declared as { consumed: unknown }).consumed).toEqual(consumed);
  });

  it("is declared too when the run's own Unit is recorded by a service, beside nothing else", async () => {
    await add("conversation", "dy_reuse", reuse);
    const { l, declared } = ledger();
    const out = await runStoredScript(db, { outcome: "conversation", dynasty: "dy_reuse", subject: lead, units: {}, recordedBy: "content-generation" }, who, { ledger: l, vendors: reads() });
    expect(declared).toEqual([{ runId: out.runId, body: { produced: [], consumed: [{ outcomeKey: "email_found", subjectService: "apollo-service", subjectId: "verif-12" }] } }]);
  });

  it("is declared once beside a handed Unit of the same subject, and beside other handed Units", async () => {
    await add("conversation", "dy_both", `
export default function run(ctx) {
  const held = ctx.get("lead_found");
  ctx.consume("lead_found", { service: "lead-service", id: "lead-9" });
  ctx.consume("email_found", { service: "apollo-service", id: "verif-12" });
  return { content: { email: held.content.email } };
}`);
    const { l, declared } = ledger();
    await runStoredScript(db, { outcome: "conversation", dynasty: "dy_both", subject: lead, units: { lead_found: { content: { email: "a@staff.test" }, subject: lead } } }, who, { ledger: l, vendors: vendors().v });
    expect((declared[0]!.body as { consumed: unknown }).consumed).toEqual([
      { outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "lead-9" },
      { outcomeKey: "email_found", subjectService: "apollo-service", subjectId: "verif-12" },
    ]);
  });

  it("a subject that is not {service, id} stops the run by name; nothing declared", async () => {
    for (const [call, why] of [
      [`ctx.consume("email_found", "verif-12")`, "ctx.consume(email_found, subject): subject is {service, id}"],
      [`ctx.consume("email_found", { service: "apollo-service" })`, "ctx.consume(email_found, subject): subject is {service, id}"],
      [`ctx.consume("email_found")`, "ctx.consume(email_found, subject): subject is {service, id}"],
    ] as const) {
      const fresh = await freshDb();
      db = fresh;
      await add("conversation", "dy_bad", `export default function run(ctx) { ${call}; return { content: {} }; }`);
      const { l, declared } = ledger();
      const failed = await runStoredScript(db, { outcome: "conversation", dynasty: "dy_bad", subject: lead, units: {} }, who, { ledger: l, vendors: vendors().v }).catch((e) => e);
      expect(failed).toBeInstanceOf(ScriptRunFailed);
      expect((failed as ScriptRunFailed).result).toMatchObject({ status: "stopped", error: expect.stringContaining(why) });
      expect(declared).toEqual([]);
    }
  }, 60_000);

  it("names its outcome with a literal at store; it is neither a material to hand nor an asked Engine", async () => {
    await expect(validateSource(`export default function run(ctx) { const o = "email_found"; ctx.consume(o, { service: "a", id: "b" }); return null; }`)).rejects.toThrow("every ctx.consume(outcome, subject) must name its outcome with a literal string");
    await expect(validateSource(`export default function run(ctx) { ctx.consume(ctx.tactics.used); return null; }`)).rejects.toThrow("every ctx.consume(outcome, subject)");
    await expect(validateSource(`export default function run(ctx) { ctx.consume("", { service: "a", id: "b" }); return null; }`)).rejects.toThrow("every ctx.consume(outcome, subject)");
    const ok = `export default function run(ctx) { ctx.consume("email_found", { service: "a", id: "b" }); return null; }`;
    expect((await validateSource(ok)).materials).toEqual([]);
    expect(readMaterials(ok)).toEqual([]);
    expect(readAsks(ok)).toEqual([]);
    expect(asksOf({ tactics: {}, code: ok })).toEqual([]);
    expect(unitsToHand({ code: ok, tactics: {}, materials: (await validateSource(ok)).materials })).toEqual([]);
  });

  it("a recorded case replays it: acknowledged, no call of the record spent on it", async () => {
    const c: ReplayCase = {
      id: "fictional-consume",
      subject: "lead-9",
      units: {},
      calls: [
        { name: "provider:email_sent", args: { query: { leadId: "lead-9" } }, answer: { ok: true, data: {} } },
        { name: "provider:email_found", args: { query: { leadId: "lead-9" } }, answer: { ok: true, data: { subject: verification } } },
      ],
      expect: { content: { sentBefore: true } },
    };
    expect(await replayCase(reuse, c)).toEqual({ id: c.id, match: true, diffs: [] });
  });

  it("a script that never calls it declares exactly what it did before", async () => {
    await add("conversation", "dy_reader", `export default function run(ctx) { const f = ctx.get("lead_found", { params: { brandId: ctx.brand } }); return { content: { total: f.data.total } }; }`);
    const { l, declared } = ledger();
    const out = await runStoredScript(db, { outcome: "conversation", dynasty: "dy_reader", subject: lead, units: {} }, who, { ledger: l, vendors: vendors().v });
    expect(declared).toEqual([{ runId: out.runId, body: { produced: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "lead-9" }], consumed: [] } }]);
  });
});
