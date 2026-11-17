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
import { replayCase } from "../../src/lib/scripts/replay.js";
import { scripts } from "../../src/db/schema.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { testNamer } from "../helpers/script-names.js";
import { buildCompletionSource, COMPLETION_LLMS, completionDynasty, completionTactics, LLM_COMPLETION } from "../../scripts/engine-ports/llm-completion.js";
import { askCompletionSource, askCompletionTactics, dropPickLlmSpreads, namesAModelCall, restateCase } from "../../scripts/engine-ports/ask-completion.js";
import { ASKING_SCRIPTS } from "../../scripts/engine-ports/ask-completion-scripts.js";

// ONE-WRITER-N-MODELS-1116-OTHERS: every script that named its model asks the LLM completion Engine instead.
const MIGRATIONS = join(__dirname, "../../drizzle");
const FIXTURES = join(__dirname, "../fixtures/stored-scripts");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}
const stored = (outcome: string, dynasty: string) => {
  const f = readdirSync(FIXTURES).find((x) => x.startsWith(`${outcome}__${dynasty}.v`));
  if (!f) throw new Error(`no fixture for ${outcome}/${dynasty}`);
  return readFileSync(join(FIXTURES, f), "utf8");
};

const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true, nameDynasties: testNamer() };
let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
  setScriptStrategyReader(async () => []);
  setScriptPickReader(fakeScriptPick());
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
    return { content: `answer ${sent.length}`, json: { n: sent.length }, model: `${String(body.model)}-v9` };
  };
  const vendors = {
    complete: async (body: Record<string, unknown>) => answer(body),
    platformComplete: async (body: Record<string, unknown>) => answer(body),
  } as unknown as VendorDeps;
  return { ledger, vendors, sent, runs, declared };
}
const who = { orgId: "org-1", userId: "user-1", parentRunId: "caller", headers: { "x-brand-id": "brand-1" } };

describe("every listed script, upgraded from its stored code", () => {
  for (const def of ASKING_SCRIPTS) {
    it(`${def.outcome}/${def.dynasty}: names no model, reads the same materials, asks llm_completion`, async () => {
      const before = stored(def.outcome, def.from ?? def.dynasty);
      expect(namesAModelCall(before)).toBe(true);
      const code = askCompletionSource(before, def.edits, def.dynasty, def.append ?? "");
      expect(namesAModelCall(code)).toBe(false);
      expect(code).not.toMatch(/pickLlm\(|tactics\.llm|\.llms\b/);
      expect((await validateSource(code)).materials).toEqual([...(await validateSource(before)).materials, LLM_COMPLETION]);
      expect(askCompletionTactics({ llm: { provider: "x", model: "y" }, recorded_by: "brand" })).toEqual({ recorded_by: "brand", asks: [LLM_COMPLETION] });
    });
  }
  it("an anchor that moved fails loud", () => {
    expect(() => askCompletionSource(stored("offer_fields_drafted", "dy_fields_draft").replace("{ place }", "{ place: place }"), ASKING_SCRIPTS[0]!.edits, "fields")).toThrow(/anchor/);
  });
  it("a pickLlm spread leaves the call as written otherwise", () => {
    expect(dropPickLlmSpreads(`f({ a: 1, ...pickLlm(ctx, "judge"), b: 2 })`)).toEqual({ code: `f({ a: 1, b: 2 })`, places: ["judge"] });
  });
});

describe("a field draft asks one completion per call, in order", () => {
  it("the Rating picks the model, the draft answers what each completion wrote, the completion consumed on the asking run", async () => {
    const def = ASKING_SCRIPTS.find((d) => d.outcome === "offer_fields_drafted")!;
    await addScript("offer_fields_drafted", "dy_fields_draft", askCompletionSource(stored(def.outcome, def.dynasty), def.edits, "fields"), askCompletionTactics({ llm: { provider: "x", model: "y" }, recorded_by: "brand" }));
    const flash = COMPLETION_LLMS.find((l) => l.model === "gemini-flash")!;
    await addScript(LLM_COMPLETION, completionDynasty(flash), buildCompletionSource(), completionTactics(flash));
    const w = world();
    const out = await runStoredScript(
      db,
      {
        outcome: "offer_fields_drafted",
        dynasty: "dy_fields_draft",
        units: { draft_request: { content: { calls: [{ place: "a", message: "M1", systemPrompt: "S1", maxTokens: 10 }, { message: "M2", systemPrompt: "S2" }] } } },
        recordedBy: "brand",
      },
      who,
      w,
    );
    expect(out.status).toBe("made");
    expect(out.unit!.content).toEqual({
      answers: [
        { place: "a", json: { n: 1 }, content: "answer 1", model: "gemini-flash-v9" },
        { place: "draft", json: { n: 2 }, content: "answer 2", model: "gemini-flash-v9" },
      ],
    });
    expect(w.sent.map((s) => [s.message, s.systemPrompt, s.model, s.maxTokens])).toEqual([
      ["M1", "S1", "gemini-flash", 10],
      ["M2", "S2", "gemini-flash", undefined],
    ]);
    // No subject on the ask and none on the run: each completion is about the asking run, which consumes it.
    expect(w.declared.find((d) => d.runId === out.runId)!.body).toEqual({ produced: [], consumed: [{ outcomeKey: LLM_COMPLETION, subjectService: "runs-service", subjectId: out.runId }] });
  });

  it("an ask naming no subject on a run that has one: the completion is about the run's subject", async () => {
    await addScript("lead_interested", "dy_judge", `export default function run(ctx) { ctx.ask({ units: {}, request: { message: "m", systemPrompt: "s" } }); const d = ctx.get("llm_completion"); return { content: { said: d.content.answer.content } }; }`, { asks: [LLM_COMPLETION] });
    const flash = COMPLETION_LLMS.find((l) => l.model === "gemini-flash")!;
    await addScript(LLM_COMPLETION, completionDynasty(flash), buildCompletionSource(), completionTactics(flash));
    const w = world();
    const out = await runStoredScript(db, { outcome: "lead_interested", dynasty: "dy_judge", units: {}, subject: { service: "lead-service", id: "lead-7" } }, who, w);
    expect(out.status).toBe("made");
    const child = w.runs.find((r) => r.taskName === "script:llm_completion/dy_gemini_flash")!;
    expect(w.declared.find((d) => d.runId === child.id)!.body).toEqual({ produced: [{ outcomeKey: LLM_COMPLETION, subjectService: "lead-service", subjectId: "lead-7" }], consumed: [] });
  });
});

describe("a recorded case restated under the rule", () => {
  const recorded = {
    id: "c1",
    units: { reply: { text: "hi" } },
    tactics: { llm: { provider: "deepseek", model: "deepseek-flash" }, other: 1 },
    calls: [
      { name: "llm.pick", args: { place: "judge" }, answer: { ok: true, data: { provider: "zai", model: "glm-flash", name: "GLM Flash" } } },
      { name: "llm.complete", args: { message: "m", systemPrompt: "s", provider: "zai", model: "glm-flash", temperature: 0 }, answer: { ok: true, data: { content: "{}", json: { label: "yes" }, model: "glm-flash-1" } } },
      { name: "lead.read", args: { a: 1 }, answer: { ok: true, data: {} } },
    ],
    expect: { content: { label: "yes" } },
  };
  it("the completion becomes a held Unit (with the model the record wrote with), its request the ask, the pick leaves", () => {
    const r = restateCase(recorded, null);
    expect("case" in r).toBe(true);
    const c = (r as { case: Record<string, any> }).case;
    expect(c.calls.map((x: { name: string }) => x.name)).toEqual(["lead.read"]);
    expect(c.units.llm_completion).toEqual([{ answer: { content: "{}", json: { label: "yes" }, model: "glm-flash-1" }, llm: { provider: "zai", model: "glm-flash", name: "GLM Flash" } }]);
    expect(c.asks).toEqual([{ units: {}, request: { message: "m", systemPrompt: "s", temperature: 0 } }]);
    expect(c.tactics).toEqual({ other: 1 });
  });
  it("a failed completion in the record excludes the case", () => {
    const failed = { ...recorded, calls: [{ name: "llm.complete", args: { message: "m" }, answer: { ok: false, data: { error: "boom" } } }] };
    expect(restateCase(failed, null)).toEqual({ excluded: expect.stringContaining("failed llm.complete") });
  });
  it("the upgraded code replays the restated case exactly as the stored code replayed the record", async () => {
    const before = `export default function run(ctx) { const p = pickLlm(ctx, "judge"); const r = ctx.vendor.call("lead.read", { a: 1 }); const a = ctx.vendor.call("llm.complete", { message: "m", systemPrompt: "s", ...pickLlm(ctx, "judge"), temperature: 0 }); return { content: a.data.json }; }
function pickLlm(ctx: any, place: string): { provider: string; model: string } {
  const p = ctx.vendor.call("llm.pick", { place });
  return { provider: p.data.provider, model: p.data.model };
}
`;
    // (The first pickLlm call is a plain read: a script that reads a model outside a call keeps an edit of its own.)
    const code = askCompletionSource(before.replace(`const p = pickLlm(ctx, "judge"); `, ""), [], "t");
    const reordered = (restateCase({ ...recorded, calls: [recorded.calls[0]!, recorded.calls[2]!, recorded.calls[1]!] }, null) as { case: any }).case;
    expect(await replayCase(code, reordered)).toEqual({ id: "c1", match: true, diffs: [] });
  });
});

describe("a template writer of content-generation (posts, WhatsApp) brings its completion", () => {
  it("asks the writer request, asks the completion, hands it back with the model that wrote and the run that asked", async () => {
    const { ASKED_WRITER_HELPER } = await import("../../scripts/engine-ports/ask-completion-scripts.js");
    const code = `function must(ctx, name, args) { const r = ctx.vendor.call(name, args); if (!r.ok) throw new Error(name + " failed"); return r.data; }
${ASKED_WRITER_HELPER}
export default function run(ctx) { return { content: askedWriter(ctx, "content.thread", { type: "t-v1", variables: { a: 1 } }, { dryRun: false }) }; }`;
    const request = { message: "m", systemPrompt: "s", responseFormat: "json", responseSchema: { type: "object" }, strictResponseSchema: { type: "object", additionalProperties: false }, maxTokens: 16000 };
    const answer = { content: "{}", json: { post: "P" }, model: "claude-sonnet-5-5" };
    const r = await replayCase(code, {
      id: "w",
      units: { llm_completion: { answer, llm: { provider: "anthropic", model: "claude-sonnet", name: "Claude Sonnet" } } },
      request: { runId: "run-9" },
      asks: [{ units: {}, request }],
      calls: [
        { name: "content.thread.request", args: { body: { type: "t-v1", variables: { a: 1 } } }, answer: { ok: true, data: { request } } },
        {
          name: "content.thread.generate",
          args: {
            body: {
              type: "t-v1",
              variables: { a: 1 },
              dryRun: false,
              completion: {
                request: { message: "m", systemPrompt: "s", responseFormat: "json", responseSchema: { type: "object", additionalProperties: false }, maxTokens: 16000, provider: "anthropic", model: "claude-sonnet" },
                answer,
                runId: "run-9",
              },
            },
          },
          answer: { ok: true, data: { post: "P", replies: [] } },
        },
      ],
      expect: { content: { post: "P", replies: [] } },
    });
    expect(r.diffs).toEqual([]);
  });
});
