import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  ScriptCatalogueError,
  activeVersion,
  createScript,
  dynastyVersions,
  forkScript,
  listScripts,
  putCases,
  reproveActive,
  setDynastyStatus,
  upgradeScript,
  type AnyPgDb,
} from "../../src/lib/scripts/script-catalogue.js";
import { replayAll, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { ScriptRunFailed, runStoredScript, scriptTaskName, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import { callVendor, type VendorDeps } from "../../src/lib/scripts/vendors.js";

// FACTORY-P2-ENGINES on a real Postgres (PGlite, the service's own migrations): the catalogue's dynasty semantics,
// the port rule (replay gate), and a script run's ledger declaration. Fictional data only: real cases never live in git.
const MIGRATIONS = join(__dirname, "../../drizzle");

async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

/** A fictional writer: a template's {{name}} filled from the lead, then the model's JSON read into a subject. */
const WRITER_V1 = `
import type { ScriptContext, ScriptResult } from "@gtm-factory/core";
export default function run(ctx: ScriptContext): ScriptResult {
  const lead = ctx.get("lead_identified");
  const template = ctx.get("template_written");
  const prompt = String(template.content.text).replace("{{name}}", String(lead.content.name));
  const answer = ctx.vendor.call("llm.complete", { message: prompt, responseSchema: "email_sequence" });
  if (!answer.ok) throw new Error("llm.complete failed: " + String(answer.data.error));
  const json = answer.data.json as { subject: string };
  return { content: { subject: json.subject.trim() } };
}`;
const WRITER_V2_SAME = WRITER_V1.replace("json.subject.trim()", "String(json.subject).trim()");
const WRITER_DIFFERENT = WRITER_V1.replace("json.subject.trim()", "json.subject.toUpperCase()");

const CASE: ReplayCase = {
  id: "fictional-1",
  units: { lead_identified: { name: "Ana" }, template_written: { text: "Write to {{name}}" } },
  calls: [{ name: "llm.complete", args: { message: "Write to Ana", responseSchema: "email_sequence" }, answer: { ok: true, data: { json: { subject: " Hello Ana " } } } }],
  expect: { content: { subject: "Hello Ana" } },
};

const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const deps = { isKnownOutcome: async (o: string) => ["message_written", "lead_identified"].includes(o) };

let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ScriptCatalogueError ? `${e.status} ${e.code}` : String(e);
  }
}

describe("replay", () => {
  it("matches a case, and names the first difference when the request or result differs", async () => {
    expect((await replayAll(WRITER_V1, [CASE])).matches).toBe(1);
    const other = await replayAll(WRITER_V1, [{ ...CASE, units: { ...CASE.units, lead_identified: { name: "Bo" } } }]);
    expect(other.matches).toBe(0);
    expect(other.failures[0]!.diffs[0]).toMatch(/call 1 llm.complete: request.message: differs at char 9/);
    const result = await replayAll(WRITER_DIFFERENT, [CASE]);
    expect(result.failures[0]!.diffs).toEqual([expect.stringMatching(/^content.subject:/)]);
    const extra = await replayAll(WRITER_V1, [{ ...CASE, calls: [...CASE.calls, CASE.calls[0]!] }]);
    expect(extra.failures[0]!.diffs).toEqual(["made 1 calls, the record made 2 (next: llm.complete)"]);
  });
});

describe("script catalogue (dynasties)", () => {
  it("creates v1, upgrades to v2 deprecating v1, forks into a new dynasty, keeps one active version", async () => {
    const v1 = await createScript(db, { outcome: "message_written", dynasty: "dy_writer", code: WRITER_V1, description: "Writes one email" }, author, deps);
    expect(v1).toMatchObject({ version: 1, creationType: "scratch", materials: ["lead_identified", "template_written"], vendors: ["llm.complete"], replay: null });
    expect(await code(createScript(db, { outcome: "message_written", dynasty: "dy_writer", code: WRITER_V1, description: "x" }, author, deps))).toBe("409 dynasty_exists");
    expect(await code(createScript(db, { outcome: "made_up", dynasty: "dy_x", code: WRITER_V1, description: "x" }, author, deps))).toBe("400 unknown_outcome");
    expect(await code(createScript(db, { outcome: "message_written", dynasty: "dy_bad", code: "export const x = 1", description: "x" }, author, deps))).toBe("400 invalid_code");

    const v2 = await upgradeScript(db, "message_written", "dy_writer", { code: WRITER_DIFFERENT }, author);
    expect(v2).toMatchObject({ version: 2, creationType: "upgrade", createdFromScript: v1.id, status: "active", description: "Writes one email" });
    const versions = await dynastyVersions(db, "message_written", "dy_writer");
    expect(versions.map((v) => [v.version, v.status])).toEqual([[2, "active"], [1, "deprecated"]]);
    expect(versions[1]!.deprecationReason).toBe("Upgraded: replaced by version 2");
    expect(await code(upgradeScript(db, "message_written", "dy_writer", { code: WRITER_DIFFERENT }, author))).toBe("400 no_change");

    const fork = await forkScript(db, "message_written", "dy_writer", { dynasty: "dy_writer_upper", description: "Shouts" }, author);
    expect(fork).toMatchObject({ dynasty: "dy_writer_upper", version: 1, creationType: "fork", createdFromScript: v2.id, code: WRITER_DIFFERENT });
    expect((await activeVersion(db, "message_written", "dy_writer"))!.id).toBe(v2.id);
    expect((await listScripts(db, { status: "active" })).map((s) => `${s.dynasty}/v${s.version}`)).toEqual(["dy_writer/v2", "dy_writer_upper/v1"]);
  });

  it("retires a whole dynasty (no version runs) and restores only its latest version", async () => {
    await createScript(db, { outcome: "message_written", dynasty: "dy_writer", code: WRITER_V1, description: "x" }, author, deps);
    await upgradeScript(db, "message_written", "dy_writer", { code: WRITER_DIFFERENT }, author);
    const retired = await setDynastyStatus(db, "message_written", "dy_writer", "deprecated", "staff test");
    expect(retired.map((v) => [v.status, v.dynastyStatus])).toEqual([["deprecated", "deprecated"], ["deprecated", "deprecated"]]);
    const restored = await setDynastyStatus(db, "message_written", "dy_writer", "active", "back");
    expect(restored.map((v) => [v.version, v.status, v.dynastyStatus])).toEqual([[2, "active", "active"], [1, "deprecated", "active"]]);
  });

  it("fresh cases re-prove the ACTIVE version; a miss is stored and the runner refuses it until a 100 % version", async () => {
    await putCases(db, "message_written", "dy_port", [CASE], "fictional");
    await createScript(db, { outcome: "message_written", dynasty: "dy_port", code: WRITER_V1, description: "Port" }, author, deps);
    const fresh = { ...CASE, id: "fictional-2", units: { ...CASE.units, lead_identified: { name: "Bo" } }, calls: [{ ...CASE.calls[0]!, args: { message: "Write to Bo", responseSchema: "email_sequence" } }] };
    await putCases(db, "message_written", "dy_port", [fresh], "fictional fresh");
    expect(await reproveActive(db, "message_written", "dy_port")).toEqual({ scriptSlug: "message_written/dy_port/v1", cases: 2, matches: 2 });
    const wrong = { ...fresh, id: "fictional-3", expect: { content: { subject: "Something else" } } };
    await putCases(db, "message_written", "dy_port", [wrong], "fictional wrong");
    expect(await reproveActive(db, "message_written", "dy_port")).toEqual({ scriptSlug: "message_written/dy_port/v1", cases: 3, matches: 2 });
    expect((await activeVersion(db, "message_written", "dy_port"))!.replay).toEqual({ cases: 3, matches: 2 });
    expect(await reproveActive(db, "message_written", "dy_none")).toBeNull();
  });

  it("a PORT stores a version only when it replays 100 % of its cases; a behaviour change is a fork", async () => {
    await putCases(db, "message_written", "dy_port", [CASE], "fictional");
    expect(await code(createScript(db, { outcome: "message_written", dynasty: "dy_port", code: WRITER_DIFFERENT, description: "x" }, author, deps))).toBe("422 replay_failed");
    expect(await dynastyVersions(db, "message_written", "dy_port")).toEqual([]);
    const v1 = await createScript(db, { outcome: "message_written", dynasty: "dy_port", code: WRITER_V1, description: "Port" }, author, deps);
    expect(v1.replay).toEqual({ cases: 1, matches: 1 });
    expect((await upgradeScript(db, "message_written", "dy_port", { code: WRITER_V2_SAME }, author)).replay).toEqual({ cases: 1, matches: 1 });
    expect(await code(upgradeScript(db, "message_written", "dy_port", { code: WRITER_DIFFERENT }, author))).toBe("422 replay_failed");
    const fork = await forkScript(db, "message_written", "dy_port", { dynasty: "dy_port_upper", code: WRITER_DIFFERENT, description: "New idea" }, author);
    expect(fork.replay).toBeNull();
  });
});

describe("a script run as a step: isolation and ledger declaration", () => {
  function ledger() {
    const calls: Array<[string, unknown]> = [];
    const deps: LedgerDeps = {
      async createRun(opts) {
        calls.push(["create", opts]);
        return "run-child-1";
      },
      async declareOutcomes(runId, orgId, body) {
        calls.push(["declare", { runId, orgId, body }]);
        return { recordedCount: 1 };
      },
      async closeRun(runId, status, orgId) {
        calls.push(["close", { runId, status, orgId }]);
      },
    };
    return { calls, deps };
  }
  function vendors(answer: Record<string, unknown> = { subject: " Hi Ana " }) {
    const calls: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const deps: VendorDeps = {
      async complete(body, headers) {
        calls.push({ body, headers });
        return { content: "", json: answer, model: "sonnet" };
      },
      async judge() {
        return { answers: {} };
      },
      async platformComplete() { throw new Error("not a platform run"); },
  async platformJudge() { throw new Error("not a platform run"); },
  async readSkill() {
        return { content: "Write short and warm.", version: 3 };
      },
    };
    return { calls, deps };
  }
  const who = { orgId: "org-test", userId: "user-1", parentRunId: "run-parent", headers: { "x-brand-id": "brand-1", "x-campaign-id": "camp-1" } };
  const input = {
    outcome: "message_written",
    dynasty: "dy_writer",
    subject: { service: "lead-service", id: "lead-42" },
    units: {
      lead_identified: { content: { name: "Ana" }, subject: { service: "lead-service", id: "lead-42" } },
      template_written: { content: { text: "Write to {{name}}" } },
    },
    tactics: { llm: { provider: "anthropic", model: "sonnet" }, systemPrompt: "You write cold emails." },
  };

  it("opens a child run under the dynasty's task, calls the vendor ON that run, declares produced + consumed, closes it", async () => {
    await createScript(db, { outcome: "message_written", dynasty: "dy_writer", code: WRITER_V1, description: "x" }, author, deps);
    const l = ledger();
    const v = vendors();
    const out = await runStoredScript(db, input, who, { ledger: l.deps, vendors: v.deps });
    expect(out).toMatchObject({ status: "made", runId: "run-child-1", scriptSlug: "message_written/dy_writer/v1", unit: { outcome: "message_written", content: { subject: "Hi Ana" } } });
    expect(l.calls[0]).toEqual(["create", { parentRunId: "run-parent", orgId: "org-test", userId: "user-1", taskName: scriptTaskName("message_written", "dy_writer"), headers: who.headers }]);
    expect(v.calls[0]!.headers).toMatchObject({ "x-run-id": "run-child-1", "x-org-id": "org-test", "x-user-id": "user-1", "x-brand-id": "brand-1", "x-campaign-id": "camp-1" });
    expect(v.calls[0]!.body).toMatchObject({ message: "Write to Ana", provider: "anthropic", model: "sonnet", responseFormat: "json" });
    expect(v.calls[0]!.body.systemPrompt).toBe("You write cold emails.");
    expect(l.calls[1]).toEqual([
      "declare",
      {
        runId: "run-child-1",
        orgId: "org-test",
        body: {
          produced: [{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-42" }],
          consumed: [{ outcomeKey: "lead_identified", subjectService: "lead-service", subjectId: "lead-42" }],
        },
      },
    ]);
    expect(l.calls[2]).toEqual(["close", { runId: "run-child-1", status: "completed", orgId: "org-test" }]);
  });

  it("a script that makes nothing declares only what it consumed; a failing one is closed failed and named", async () => {
    await createScript(db, { outcome: "message_written", dynasty: "dy_writer", code: `export default function run(ctx) { ctx.get("lead_identified"); return null; }`, description: "x" }, author, deps);
    const l = ledger();
    const out = await runStoredScript(db, input, who, { ledger: l.deps, vendors: vendors().deps });
    expect(out.status).toBe("nothing");
    expect((l.calls[1]![1] as { body: unknown }).body).toEqual({ produced: [], consumed: [{ outcomeKey: "lead_identified", subjectService: "lead-service", subjectId: "lead-42" }] });

    await upgradeScript(db, "message_written", "dy_writer", { code: WRITER_V1 }, author);
    const l2 = ledger();
    const refused = vendors();
    refused.deps.complete = async () => {
      throw new Error("chat-service 402 no credit");
    };
    const failed = await runStoredScript(db, input, who, { ledger: l2.deps, vendors: refused.deps }).catch((e) => e);
    expect(failed).toBeInstanceOf(ScriptRunFailed);
    expect((failed as ScriptRunFailed).result).toMatchObject({ status: "failed", error: expect.stringContaining("chat-service 402 no credit"), vendorCalls: [{ name: "llm.complete", ok: false }] });
    expect(l2.calls.at(-1)).toEqual(["close", { runId: "run-child-1", status: "failed", orgId: "org-test" }]);
  });

  it("a declaration the ledger refuses fails the step (untracked spend is a bug)", async () => {
    await createScript(db, { outcome: "message_written", dynasty: "dy_writer", code: WRITER_V1, description: "x" }, author, deps);
    const l = ledger();
    l.deps.declareOutcomes = async () => {
      throw new Error("400 unknown_outcome_key");
    };
    const failed = await runStoredScript(db, input, who, { ledger: l.deps, vendors: vendors().deps }).catch((e) => e);
    expect((failed as ScriptRunFailed).result).toMatchObject({ status: "failed", unit: null, error: expect.stringContaining("the ledger refused the declaration") });
  });

  it("a material the step was not handed stops the run; storage is scoped to the org", async () => {
    const storing = `export default function run(ctx) {
      var before = ctx.storage.get("notes", "k");
      ctx.storage.set("notes", "k", { by: ctx.tactics.who });
      return { content: { before: before, count: ctx.storage.count("notes") } };
    }`;
    await createScript(db, { outcome: "message_written", dynasty: "dy_store", code: storing, description: "x" }, author, deps);
    const run = (orgId: string, who2: string) =>
      runStoredScript(db, { ...input, dynasty: "dy_store", tactics: { who: who2 } }, { ...who, orgId }, { ledger: ledger().deps, vendors: vendors().deps });
    expect((await run("org-a", "a")).unit!.content).toEqual({ before: null, count: 1 });
    expect((await run("org-a", "a2")).unit!.content).toEqual({ before: { by: "a" }, count: 1 });
    expect((await run("org-b", "b")).unit!.content).toEqual({ before: null, count: 1 });

    await createScript(db, { outcome: "message_written", dynasty: "dy_greedy", code: `export default function run(ctx) { ctx.get("email_found"); return null; }`, description: "x" }, author, deps);
    const stopped = await runStoredScript(db, { ...input, dynasty: "dy_greedy" }, who, { ledger: ledger().deps, vendors: vendors().deps }).catch((e) => e);
    expect((stopped as ScriptRunFailed).result).toMatchObject({ status: "stopped", error: expect.stringContaining("email_found, which this step was not handed") });
  });

  it("refuses a retired dynasty (410) and a port not proven on cases loaded after it (409)", async () => {
    await createScript(db, { outcome: "message_written", dynasty: "dy_writer", code: WRITER_V1, description: "x" }, author, deps);
    await putCases(db, "message_written", "dy_writer", [CASE], "fictional");
    expect(await code(runStoredScript(db, input, who, { ledger: ledger().deps, vendors: vendors().deps }))).toBe("409 not_proven");
    await setDynastyStatus(db, "message_written", "dy_writer", "deprecated", "test");
    expect(await code(runStoredScript(db, input, who, { ledger: ledger().deps, vendors: vendors().deps }))).toBe("410 dynasty_retired");
  });
});

describe("vendors", () => {
  const ctx = { headers: { "x-run-id": "r" }, tactics: {} };
  const seen: Array<Record<string, unknown>> = [];
  const deps: VendorDeps = {
    complete: async (body) => {
      seen.push(body);
      return { content: "{}", json: { axes: ["size"], segments: [] }, model: "m", tokensInput: 1, tokensOutput: 2 };
    },
    judge: async (body) => {
      seen.push(body);
      return { answers: { answer: { noul: 0.8 } }, model: "jev" };
    },
    readSkill: async () => ({ content: "voice", version: 4 }),
  };
  it("refuses an unknown vendor, no LLM stated, no system prompt, and Haiku 4.5", async () => {
    expect(await callVendor("http.get", {}, ctx, deps)).toEqual({ ok: false, data: { error: "no vendor named http.get (scripts may call: llm.complete, chat.complete, jev.noul, voice.read, apollo.email.verify, apollo.apify.available)" } });
    expect((await callVendor("llm.complete", { message: "x", systemPrompt: "s" }, ctx, deps)).data.error).toMatch(/needs an LLM/);
    expect((await callVendor("llm.complete", { message: "x", provider: "anthropic", model: "sonnet" }, ctx, deps)).data.error).toMatch(/needs a systemPrompt/);
    expect((await callVendor("llm.complete", { message: "x", systemPrompt: "s", provider: "anthropic", model: "claude-haiku-4-5" }, ctx, deps)).data.error).toMatch(/Haiku 4.5/);
  });
  it("passes a completion VERBATIM (nothing appended), answers chat's whole answer or its JSON", async () => {
    seen.length = 0;
    const a = await callVendor("llm.complete", { message: "m", systemPrompt: "You classify.", model: "deepseek-flash", responseFormat: "json", temperature: 0 }, { ...ctx, tactics: { llm: { provider: "deepseek" } } }, deps);
    expect(seen[0]).toEqual({ message: "m", systemPrompt: "You classify.", provider: "deepseek", model: "deepseek-flash", responseFormat: "json", temperature: 0 });
    expect(a).toEqual({ ok: true, data: { content: "{}", json: { axes: ["size"], segments: [] }, model: "m", tokensInput: 1, tokensOutput: 2 } });
    const c = await callVendor("chat.complete", { message: "m", systemPrompt: "s", provider: "google", model: "pro", disableThinking: true }, ctx, deps);
    expect(seen[1]).toMatchObject({ disableThinking: true });
    expect(c).toEqual({ ok: true, data: { axes: ["size"], segments: [] } });
    const schema = { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] };
    await callVendor("llm.complete", { message: "m", systemPrompt: "s", responseSchema: schema, provider: "anthropic", model: "sonnet" }, ctx, deps);
    expect(seen[2]).toEqual({ message: "m", systemPrompt: "s", responseSchema: schema, provider: "anthropic", model: "sonnet" });
  });
  it("jev.noul asks chat-service's judgments and answers probabilities; voice.read serves our voice", async () => {
    seen.length = 0;
    const j = await callVendor("jev.noul", { state: { a: 1 }, questions: { answer: { instructions: "Fits?" } } }, ctx, deps);
    expect(seen[0]).toEqual({ state: { a: 1 }, questions: { answer: { type: "noul", instructions: "Fits?" } } });
    expect(j).toEqual({ ok: true, data: { probabilities: { answer: 0.8 }, model: "jev" } });
    expect(await callVendor("voice.read", null, ctx, deps)).toEqual({ ok: true, data: { content: "voice", version: 4 } });
    expect((await callVendor("voice.read", null, ctx, { ...deps, readSkill: async () => null })).ok).toBe(false);
  });
});
