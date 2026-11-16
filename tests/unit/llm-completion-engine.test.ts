import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { setScriptPickReader, setScriptStrategyReader } from "../../src/lib/scripts/engine.js";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { scriptRuns, scripts } from "../../src/db/schema.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { testNamer } from "../helpers/script-names.js";
import { buildCompletionSource, COMPLETION_LLMS, completionDynasty, completionTactics, LLM_COMPLETION } from "../../scripts/engine-ports/llm-completion.js";

// ONE-WRITER-N-MODELS-1116: the model is its own Engine; a writer asks for a completion and never names a model.
const MIGRATIONS = join(__dirname, "../../drizzle");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

const WRITER = `
export default function run(ctx) {
  const b = ctx.get("brand_context");
  ctx.ask({ units: {}, subject: { service: "lead-service", id: "lead-9" }, request: { message: "Write for " + b.content.name, systemPrompt: "S", responseSchema: { type: "object" }, strictResponseSchema: { type: "object", additionalProperties: false } } });
  const done = ctx.get("llm_completion");
  return { content: { body: done.content.answer.content, wroteWith: done.content.llm.model }, subject: { service: "lead-service", id: "lead-9" } };
}`;

const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true, nameDynasties: testNamer() };

let db: AnyPgDb;
let pick: ReturnType<typeof fakeScriptPick>;
beforeEach(async () => {
  db = await freshDb();
  setScriptStrategyReader(async () => []);
}, 60_000);

async function addScript(outcome: string, dynasty: string, code: string, tactics: Record<string, unknown> = {}) {
  const row = await createScript(db, { outcome, dynasty, code, description: "x" }, author, known);
  if (Object.keys(tactics).length) await db.update(scripts).set({ tactics }).where(eq(scripts.id, row.id));
}

function world() {
  const sent: Array<Record<string, unknown>> = [];
  const runs: Array<{ id: string; taskName: string; parentRunId: string }> = [];
  const declared: Array<{ runId: string; body: unknown }> = [];
  const ledger: LedgerDeps = {
    async createRun(o) {
      runs.push({ id: `run-${runs.length + 1}`, taskName: o.taskName, parentRunId: o.parentRunId });
      return `run-${runs.length}`;
    },
    async declareOutcomes(runId, _o, body) {
      declared.push({ runId, body });
      return {};
    },
    async closeRun() {},
  };
  const answer = (body: Record<string, unknown>) => {
    sent.push(body);
    return { content: `written by ${String(body.model)}`, json: null, model: `${String(body.model)}-v9` };
  };
  const vendors: VendorDeps = {
    complete: async (body) => answer(body),
    platformComplete: async (body) => answer(body),
    judge: async () => ({}),
    platformJudge: async () => ({}),
    readSkill: async () => null,
    serviceDoor: async () => ({ status: 200, body: {} }),
  } as unknown as VendorDeps;
  return { ledger, vendors, sent, runs, declared };
}

const who = { orgId: "org-1", userId: "user-1", parentRunId: "caller", headers: { "x-brand-id": "brand-1" } };

describe("the LLM completion Engine", () => {
  it("one code for every model: it reads no material and names no model", async () => {
    const src = buildCompletionSource();
    expect((await validateSource(src)).materials).toEqual([]);
    for (const l of COMPLETION_LLMS) expect(src).not.toContain(`"${l.model}"`);
    expect(COMPLETION_LLMS.map((l) => l.model)).not.toContain("claude-haiku-4-5");
    expect(new Set(COMPLETION_LLMS.map(completionDynasty)).size).toBe(COMPLETION_LLMS.length);
  });

  it("a writer asks for a completion: the Rating is told who asks, the picked model writes, on a child run that declares its Unit on the writer's subject", async () => {
    pick = fakeScriptPick({ dy_gemini_flash: 2 });
    setScriptPickReader(pick);
    await addScript("message_written", "dy_writer", WRITER, { asks: [LLM_COMPLETION] });
    for (const l of COMPLETION_LLMS.filter((x) => x.model === "gemini-flash" || x.model === "claude-haiku")) await addScript(LLM_COMPLETION, completionDynasty(l), buildCompletionSource(), completionTactics(l));
    const w = world();
    const out = await runStoredScript(db, { outcome: "message_written", dynasty: "dy_writer", units: { brand_context: { content: { name: "Reed" } } } }, who, w);
    expect(out.status).toBe("made");
    expect(out.unit!.content).toEqual({ body: "written by gemini-flash", wroteWith: "gemini-flash" });
    const asked = pick.calls.find((c) => c.outcome === LLM_COMPLETION)!;
    expect(asked.askedBy).toBe("message_written/dy_writer");
    expect(asked.dynasties.sort()).toEqual(["llm_completion/dy_claude_haiku", "llm_completion/dy_gemini_flash"]);
    // Not anthropic: the plain schema, the prompt as the writer stated it.
    expect(w.sent[0]).toMatchObject({ message: "Write for Reed", systemPrompt: "S", provider: "google", model: "gemini-flash", responseSchema: { type: "object" } });
    expect(w.sent[0]).not.toHaveProperty("strictResponseSchema");
    const child = w.runs.find((r) => r.taskName === "script:llm_completion/dy_gemini_flash")!;
    expect(child.parentRunId).toBe(out.runId);
    expect(w.declared.find((d) => d.runId === child.id)!.body).toEqual({ produced: [{ outcomeKey: LLM_COMPLETION, subjectService: "lead-service", subjectId: "lead-9" }], consumed: [] });
    // The writer consumed the completion: the ledger's chain links completion -> message, so the model is credited.
    expect(w.declared.find((d) => d.runId === out.runId)!.body).toEqual({
      produced: [{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-9" }],
      consumed: [{ outcomeKey: LLM_COMPLETION, subjectService: "lead-service", subjectId: "lead-9" }],
    });
  });

  it("an Anthropic model gets the strict schema the writer offers", async () => {
    setScriptPickReader(fakeScriptPick());
    await addScript("message_written", "dy_writer", WRITER, { asks: [LLM_COMPLETION] });
    const haiku = COMPLETION_LLMS.find((l) => l.model === "claude-haiku")!;
    await addScript(LLM_COMPLETION, completionDynasty(haiku), buildCompletionSource(), completionTactics(haiku));
    const w = world();
    await runStoredScript(db, { outcome: "message_written", dynasty: "dy_writer", units: { brand_context: { content: { name: "Reed" } } } }, who, w);
    expect(w.sent[0]).toMatchObject({ provider: "anthropic", model: "claude-haiku", responseSchema: { type: "object", additionalProperties: false } });
  });

  it("a platform-billed asker's completion is platform-billed too", async () => {
    setScriptPickReader(fakeScriptPick());
    await addScript("message_written", "dy_writer", WRITER, { asks: [LLM_COMPLETION] });
    const flash = COMPLETION_LLMS.find((l) => l.model === "gemini-flash")!;
    await addScript(LLM_COMPLETION, completionDynasty(flash), buildCompletionSource(), completionTactics(flash));
    const w = world();
    let platform = 0;
    w.vendors.platformComplete = async (body) => {
      platform++;
      return { content: "p", json: null, model: String(body.model) };
    };
    w.vendors.complete = async () => {
      throw new Error("org-billed call from a platform run");
    };
    const out = await runStoredScript(db, { outcome: "message_written", dynasty: "dy_writer", units: { brand_context: { content: { name: "Reed" } } }, billing: "platform" }, { ...who, headers: { ...who.headers } }, w);
    expect(out.status).toBe("made");
    expect(platform).toBe(1);
    expect((await db.select().from(scriptRuns)).every((r) => r.status === "made")).toBe(true);
  });

  it("a campaign's own pick states no askedBy", async () => {
    const p = fakeScriptPick();
    setScriptPickReader(p);
    const flash = COMPLETION_LLMS.find((l) => l.model === "gemini-flash")!;
    await addScript(LLM_COMPLETION, completionDynasty(flash), buildCompletionSource(), completionTactics(flash));
    const { pickScript } = await import("../../src/lib/scripts/engine.js");
    await pickScript(db, { outcome: LLM_COMPLETION, servable: [], channel: null });
    expect(p.calls[0]).not.toHaveProperty("askedBy");
  });
});

describe("a traced writer's trace carries its asked completion", () => {
  it("the completion the model made lands in the writer's trace (content-generation reads one llm.complete there)", async () => {
    setScriptPickReader(fakeScriptPick());
    await addScript("message_written", "dy_writer", WRITER, { asks: [LLM_COMPLETION] });
    const flash = COMPLETION_LLMS.find((l) => l.model === "gemini-flash")!;
    await addScript(LLM_COMPLETION, completionDynasty(flash), buildCompletionSource(), completionTactics(flash));
    const w = world();
    const out = await runStoredScript(db, { outcome: "message_written", dynasty: "dy_writer", units: { brand_context: { content: { name: "Reed" } } }, trace: true }, who, w);
    const completions = (out.trace ?? []).filter((t) => t.name === "llm.complete");
    expect(completions).toHaveLength(1);
    expect(completions[0]!.sent).toMatchObject({ provider: "google", model: "gemini-flash", message: "Write for Reed" });
    expect(completions[0]!.raw).toMatchObject({ model: "gemini-flash-v9" });
  });
});

describe("a writer whose Unit its service records still consumes its completion", () => {
  it("recordedBy: nothing produced by the runner, the completion consumed", async () => {
    setScriptPickReader(fakeScriptPick());
    await addScript("message_written", "dy_writer", WRITER, { asks: [LLM_COMPLETION] });
    const flash = COMPLETION_LLMS.find((l) => l.model === "gemini-flash")!;
    await addScript(LLM_COMPLETION, completionDynasty(flash), buildCompletionSource(), completionTactics(flash));
    const w = world();
    const out = await runStoredScript(db, { outcome: "message_written", dynasty: "dy_writer", units: { brand_context: { content: { name: "Reed" } } }, recordedBy: "content-generation" }, who, w);
    expect(w.declared.find((d) => d.runId === out.runId)!.body).toEqual({ produced: [], consumed: [{ outcomeKey: LLM_COMPLETION, subjectService: "lead-service", subjectId: "lead-9" }] });
  });
});
