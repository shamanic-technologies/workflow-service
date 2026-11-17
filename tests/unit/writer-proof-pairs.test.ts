import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { candidatesOf, setScriptPickReader, setScriptStrategyReader } from "../../src/lib/scripts/engine.js";
import { PROOF_SAMPLE, proveScript, readWriterProofs, setEngineEnforced, setProofContext, writerProofAllows, type ProofDeps } from "../../src/lib/scripts/writer-proof.js";
import { scripts, writerCases, writerProofs } from "../../src/db/schema.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { testNamer } from "../helpers/script-names.js";
import { buildCompletionSource, COMPLETION_LLMS, completionDynasty, completionTactics, LLM_COMPLETION } from "../../scripts/engine-ports/llm-completion.js";

// ONE-WRITER-N-MODELS-1116-ANSWERER: a writer that asks its model is proven per (writer version, completion script),
// and the gate sits on the completion pick. Fictional data only; the judge is a test double (Jev in production).
const MIGRATIONS = join(__dirname, "../../drizzle");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

/** A fictional writer: builds its prompt from what its sender handed, asks its model, hands back the message or a later. */
const WRITER = `
export default function run(ctx) {
  const a = ctx.get("answer_requested");
  ctx.ask({ units: {}, subject: { service: "lead-service", id: a.subject }, request: { message: "Thread: " + a.content.thread, systemPrompt: "Answer the person.", responseFormat: "json", responseSchema: { type: "object" } } });
  const done = ctx.get("llm_completion");
  const d = done.content.answer.json || {};
  if (d.decision === "later") return { unmade: "later: night", decided: "done", answer: { decision: "later", nextFollowUpAt: "2026-11-17T09:00:00Z" } };
  if (d.decision !== "write") throw new Error("the writer answered an unknown decision " + JSON.stringify(d.decision));
  return { content: { decision: "write", message: String(d.message || ""), writtenWith: done.content.llm.name }, subject: { service: "lead-service", id: a.subject } };
}`;

/** A fictional sender: reads the thread, asks the writer, sends what it wrote. Calls no LLM itself. */
const SENDER = `
export default function run(ctx) {
  const thread = ctx.vendor.call("crm.person.thread", { query: { personKey: "email:" + ctx.request.email } });
  if (!thread.ok) throw new Error("thread unreadable");
  ctx.ask({ units: { answer_requested: { content: { thread: JSON.stringify(thread.data) }, subject: { service: "lead-service", id: "lead-" + ctx.request.email } } } });
  const w = ctx.get("message_written");
  if (!w.content) return { unmade: String(w.unmade), decided: "done" };
  const sent = ctx.vendor.call("instantly.reply.send", { body: { email: ctx.request.email, body_html: w.content.message } });
  if (!sent.ok) throw new Error("not sent");
  return { content: { sent: true, writtenWith: w.content.writtenWith }, subject: { service: "lead-service", id: "lead-" + ctx.request.email } };
}`;

const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true, nameDynasties: testNamer() };
const who = { orgId: "org-1", userId: "user-1", parentRunId: "run-parent", headers: { "x-brand-id": "brand-1" } };
const WRITER_TACTICS = { asks: [LLM_COMPLETION], personFields: ["message"] };

let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
  setScriptStrategyReader(async () => []);
  setScriptPickReader(fakeScriptPick({ dy_glm_flash: 2 }));
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

const llm = (model: string) => COMPLETION_LLMS.find((l) => l.model === model)!;
async function seed() {
  const writer = await add("message_written", "dy_answer_lead", WRITER, WRITER_TACTICS);
  const sender = await add("message_sent", "dy_answer_lead", SENDER, { asks: ["message_written"] });
  const glmFlash = await add(LLM_COMPLETION, completionDynasty(llm("glm-flash")), buildCompletionSource(), completionTactics(llm("glm-flash")));
  const haiku = await add(LLM_COMPLETION, completionDynasty(llm("claude-haiku")), buildCompletionSource(), completionTactics(llm("claude-haiku")));
  return { writer, sender, glmFlash, haiku };
}

function productionVendors(json: Record<string, unknown>): VendorDeps & { sends: string[] } {
  const sends: string[] = [];
  const v = {
    async complete(body: Record<string, unknown>) {
      return { content: "", json, model: String(body.model), tokensInput: 1000, tokensOutput: 100 };
    },
    async judge() {
      return {};
    },
    async platformComplete() {
      throw new Error("production is org-billed");
    },
    async platformJudge() {
      throw new Error("production is org-billed");
    },
    async readSkill() {
      return null;
    },
    async serviceDoor(_s: string, _m: string, path: string, req: { body?: unknown }) {
      if (path.includes("timeline")) return { status: 200, body: { messages: [{ direction: "inbound", text: "Can we meet Tuesday?" }] } };
      sends.push(JSON.stringify(req?.body ?? null));
      return { status: 200, body: { id: "sent-1" } };
    },
    sends,
  };
  return v as unknown as VendorDeps & { sends: string[] };
}

function ledger(): LedgerDeps {
  let n = 0;
  return {
    async createRun() {
      n++;
      return `run-${n}-${Math.random().toString(36).slice(2, 8)}`;
    },
    async declareOutcomes() {
      return {};
    },
    async closeRun() {},
  };
}

async function produce(n: number, json: Record<string, unknown> = { decision: "write", message: "<p>Tuesday at 10am works, see you then.</p>" }) {
  for (let i = 0; i < n; i++) {
    await runStoredScript(db, { outcome: "message_sent", dynasty: "dy_answer_lead", units: {}, request: { email: `p${i}@example.test` } }, who, { ledger: ledger(), vendors: productionVendors(json) });
  }
}

function proofDeps(json: Record<string, unknown>) {
  const llmCalls: Array<Record<string, unknown>> = [];
  const doors: string[] = [];
  const judged: string[] = [];
  const vendors = {
    async complete() {
      throw new Error("a proof is platform-billed");
    },
    async judge() {
      throw new Error("a proof is platform-billed");
    },
    async platformComplete(body: Record<string, unknown>, headers: Record<string, string>) {
      llmCalls.push({ ...body, runId: headers["x-run-id"] });
      return { content: JSON.stringify(json), json, model: String(body.model), tokensInput: 2000, tokensOutput: 200 };
    },
    async platformJudge(body: Record<string, unknown>) {
      const state = String(body.state);
      judged.push(state);
      const p = /\n(cold_email_followup|M3)$/m.test(state) ? 0.02 : 0.96;
      return { answers: Object.fromEntries(Object.keys(body.questions as object).map((k) => [k, { noul: p }])), model: "jev" };
    },
    async readSkill() {
      return null;
    },
    async serviceDoor(_s: string, _m: string, path: string) {
      doors.push(path);
      throw new Error("a proof never calls a door");
    },
  } as unknown as VendorDeps;
  const deps: ProofDeps = { vendors, openRun: async () => "proof-run", closeRun: async () => {} };
  return { deps, llmCalls, doors, judged };
}

describe("a writer that asks its model", () => {
  it("production: the sender calls no LLM, the writer calls no door; the writer's run is kept as a case of ITS Engine", async () => {
    const { sender, writer } = await seed();
    await produce(2);
    const cases = await db.select().from(writerCases);
    expect(cases.map((c) => [c.outcome, c.recordedFrom, c.wrote])).toEqual([
      ["message_written", "message_written/dy_answer_lead/v1", true],
      ["message_written", "message_written/dy_answer_lead/v1", true],
    ]);
    const body = cases[0]!.body as { units: Record<string, unknown>; calls: unknown[]; asked: Record<string, unknown> };
    expect(Object.keys(body.units)).toEqual(["answer_requested"]);
    expect(body.calls).toEqual([]); // the writer calls no door at all
    expect(Object.keys(body.asked)).toEqual([LLM_COMPLETION]);
    // The sender is no writer combination: never gated, never recorded, even on an enforced Engine.
    await setEngineEnforced(db, "message_sent", true, "staff");
    expect(await writerProofAllows(db, sender)).toBe(true);
    expect(await writerProofAllows(db, writer)).toBe(true);
  });

  it("a later decision hands its answer back to the sender, and counts as a case that did not write", async () => {
    await seed();
    await produce(1, { decision: "later" });
    const [c] = await db.select().from(writerCases);
    expect(c!.wrote).toBe(false);
  });

  it("a pair proof: the writer replayed, its model LIVE through the completion script, Jev on the Unit's person fields, nothing sent", async () => {
    const { writer, haiku } = await seed();
    await produce(PROOF_SAMPLE + 1);
    const p = proofDeps({ decision: "write", message: "<p>Tuesday 10am works for us.</p>" });
    const proof = await proveScript(db, p.deps, writer, "staff", haiku);
    expect([proof.state, proof.sample, proof.usable, proof.completionDynasty]).toEqual(["passed", PROOF_SAMPLE, PROOF_SAMPLE, "dy_claude_haiku"]);
    expect(p.llmCalls).toHaveLength(PROOF_SAMPLE);
    expect(p.llmCalls[0]).toMatchObject({ provider: "anthropic", model: "claude-haiku", runId: "proof-run", message: expect.stringContaining("Can we meet Tuesday?") });
    expect(p.llmCalls[0]!.brandTools).toBeUndefined(); // never through a brand's tools
    expect(p.judged[0]).toContain('its field "message" of "message_written"');
    // Each field is judged inside the whole message it belongs to (ONE-WRITER-N-MODELS-1116: a subject alone read as misplaced).
    expect(p.judged[0]).toContain("The whole of what a person will read once this is sent");
    expect(p.judged[0]).toContain("[message_written message]\n<p>Tuesday 10am works for us.</p>");
    expect(p.doors).toEqual([]);
  });

  it("a pair whose model writes a label where the message goes fails after one case", async () => {
    const { writer, glmFlash } = await seed();
    await produce(PROOF_SAMPLE);
    const proof = await proveScript(db, proofDeps({ decision: "write", message: "cold_email_followup" }).deps, writer, "staff", glmFlash);
    expect([proof.state, proof.sample]).toEqual(["failed", 1]);
    expect(JSON.stringify(proof.cases)).toContain("message_written message is not usable");
  });

  it("the gate: on an enforced writer Engine, a model is drawn for that writer only once the pair passed", async () => {
    const { writer, glmFlash, haiku } = await seed();
    await produce(PROOF_SAMPLE);
    const models = async (askedBy: string | null) =>
      (await candidatesOf(db, { outcome: LLM_COMPLETION, servable: [], channel: null, askedBy })).map((r) => r.dynasty).sort();
    expect(await models("message_written/dy_answer_lead")).toEqual(["dy_claude_haiku", "dy_glm_flash"]);
    await proveScript(db, proofDeps({ decision: "write", message: "M3" }).deps, writer, "staff", glmFlash);
    await proveScript(db, proofDeps({ decision: "write", message: "<p>Tuesday works.</p>" }).deps, writer, "staff", haiku);
    expect(await models("message_written/dy_answer_lead")).toEqual(["dy_claude_haiku", "dy_glm_flash"]); // not enforced yet

    await setEngineEnforced(db, "message_written", true, "staff");
    expect(await models("message_written/dy_answer_lead")).toEqual(["dy_claude_haiku"]);
    // Another asker (a writer stating no personFields, a campaign run) is never gated by this writer's pairs.
    expect(await models(null)).toEqual(["dy_claude_haiku", "dy_glm_flash"]);

    const view = await readWriterProofs(db);
    expect(view.combinations.filter((c) => c.completion).map((c) => [c.dynasty, c.completion, c.state, c.red])).toEqual([
      ["dy_answer_lead", "llm_completion/dy_glm_flash", "failed", true],
      ["dy_answer_lead", "llm_completion/dy_claude_haiku", "passed", false],
    ]);
  });

  it("an unproven pair is held out and proven once in the background, then drawn", async () => {
    const { haiku } = await seed();
    await db.update(scripts).set({ status: "deprecated", dynastyStatus: "deprecated" }).where(eq(scripts.dynasty, "dy_glm_flash"));
    await produce(PROOF_SAMPLE);
    await setEngineEnforced(db, "message_written", true, "staff");
    setProofContext({ db, deps: proofDeps({ decision: "write", message: "<p>Tuesday works.</p>" }).deps });
    const models = async () => (await candidatesOf(db, { outcome: LLM_COMPLETION, servable: [], channel: null, askedBy: "message_written/dy_answer_lead" })).map((r) => r.dynasty);
    expect(await models()).toEqual([]);
    for (let i = 0; i < 100 && (await db.select().from(writerProofs)).some((r) => r.state === "running"); i++) await new Promise((r) => setTimeout(r, 20));
    expect((await db.select().from(writerProofs)).map((r) => [r.state, r.trigger, r.completionScriptId])).toEqual([["passed", "auto", haiku.id]]);
    expect(await models()).toEqual(["dy_claude_haiku"]);
  });

  it("the model that wrote reaches the sender (SERVED-MODEL-1116)", async () => {
    await seed();
    const v = productionVendors({ decision: "write", message: "<p>Hi</p>" });
    const out = await runStoredScript(db, { outcome: "message_sent", dynasty: "dy_answer_lead", units: {}, request: { email: "a@example.test" } }, who, { ledger: ledger(), vendors: v });
    expect(out.unit!.content).toEqual({ sent: true, writtenWith: "GLM Flash" });
  });

  it("a script that asks its model and SENDS itself (no personFields) is a pair writer: its send fields are judged", async () => {
    const SELF = `
export default function run(ctx) {
  const thread = ctx.vendor.call("crm.person.thread", { query: { personKey: "email:" + ctx.request.email } });
  if (!thread.ok) throw new Error("thread unreadable");
  ctx.ask({ units: {}, subject: { service: "lead-service", id: "lead-" + ctx.request.email }, request: { message: "Thread: " + JSON.stringify(thread.data), systemPrompt: "Say hello.", responseFormat: "json", responseSchema: { type: "object" } } });
  const done = ctx.get("llm_completion");
  const d = done.content.answer.json || {};
  const sent = ctx.vendor.call("crm.whatsapp.send", { body: { phone: "+15550001", text: String(d.message || "") } });
  if (!sent.ok) throw new Error("not sent");
  return { content: { sent: true }, subject: { service: "lead-service", id: "lead-" + ctx.request.email } };
}`;
    const self = await add("whatsapp_message_sent", "dy_hello", SELF, { asks: [LLM_COMPLETION] });
    const glm = await add(LLM_COMPLETION, completionDynasty(llm("glm-flash")), buildCompletionSource(), completionTactics(llm("glm-flash")));
    for (let i = 0; i < PROOF_SAMPLE; i++) {
      await runStoredScript(db, { outcome: "whatsapp_message_sent", dynasty: "dy_hello", units: {}, request: { email: `h${i}@example.test` } }, who, { ledger: ledger(), vendors: productionVendors({ message: "Hi there, welcome aboard." }) });
    }
    const cases = await db.select().from(writerCases);
    expect(cases.map((c) => [c.outcome, c.wrote])).toEqual(Array.from({ length: PROOF_SAMPLE }, () => ["whatsapp_message_sent", true]));
    const bad = await proveScript(db, proofDeps({ message: "M3" }).deps, self, "staff", glm);
    expect([bad.state, bad.sample]).toEqual(["failed", 1]);
    expect(JSON.stringify(bad.cases)).toContain("crm.whatsapp.send body.text is not usable");
    const good = await proveScript(db, proofDeps({ message: "Hi, welcome aboard." }).deps, self, "staff", glm);
    expect([good.state, good.usable]).toEqual(["passed", PROOF_SAMPLE]);
    await setEngineEnforced(db, "whatsapp_message_sent", true, "staff");
    expect((await candidatesOf(db, { outcome: LLM_COMPLETION, servable: [], channel: null, askedBy: "whatsapp_message_sent/dy_hello" })).map((r) => r.dynasty)).toEqual(["dy_glm_flash"]);
  });

  it("a pair's proof survives an upgrade of the completion script (a pair = writer version x completion DYNASTY)", async () => {
    const { writer, haiku } = await seed();
    await produce(PROOF_SAMPLE);
    await proveScript(db, proofDeps({ decision: "write", message: "<p>Tuesday works.</p>" }).deps, writer, "staff", haiku);
    await db.update(scripts).set({ status: "deprecated", dynastyStatus: "deprecated" }).where(eq(scripts.dynasty, "dy_glm_flash"));
    // A byte-identical re-store of the completion script: new version row, same dynasty.
    await db.update(scripts).set({ status: "deprecated" }).where(eq(scripts.id, haiku.id));
    await db.insert(scripts).values({ ...haiku, id: undefined, version: 2, status: "active", createdAt: new Date() });
    await setEngineEnforced(db, "message_written", true, "staff");
    expect((await candidatesOf(db, { outcome: LLM_COMPLETION, servable: [], channel: null, askedBy: "message_written/dy_answer_lead" })).map((r) => [r.dynasty, r.version])).toEqual([["dy_claude_haiku", 2]]);
  });
});
