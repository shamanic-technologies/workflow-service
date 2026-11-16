import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { testNamer } from "../helpers/script-names.js";
import { drizzle } from "drizzle-orm/pglite";
import { createScript, forkScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { candidatesOf } from "../../src/lib/scripts/engine.js";
import {
  PROOF_SAMPLE,
  abandonRunningProofs,
  gateFor,
  personFields,
  proveScript,
  readWriterProofs,
  setEngineEnforced,
  setProofContext,
  type ProofDeps,
} from "../../src/lib/scripts/writer-proof.js";
import { writerCases, writerProofs } from "../../src/db/schema.js";

// PROVEN-BEFORE-PEOPLE-1116 on a real Postgres (PGlite, the service's own migrations). Fictional data only: real
// cases never live in git. The judge here is a test double; in production it is Jev.
const MIGRATIONS = join(__dirname, "../../drizzle");

async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

/** A fictional lead answerer: reads the thread, asks its LLM for a decision + message, sends the message. */
const ANSWERER = `
export default function run(ctx) {
  const thread = ctx.vendor.call("crm.person.thread", { query: { personKey: "email:" + ctx.request.email } });
  if (!thread.ok) throw new Error("thread unreadable: " + String(thread.data.error));
  const llm = ctx.vendor.call("llm.pick", { place: "writer" });
  if (!llm.ok) throw new Error(String(llm.data.error));
  const answer = ctx.vendor.call("llm.complete", { provider: llm.data.provider, model: llm.data.model, systemPrompt: "Answer the person.", message: "Thread: " + JSON.stringify(thread.data), responseFormat: "json", responseSchema: { type: "object" } });
  if (!answer.ok) throw new Error("the writer failed: " + String(answer.data.error));
  const d = answer.data.json || {};
  if (d.decision === "later") return { unmade: "later", decided: "done" };
  if (d.decision !== "write") throw new Error("the writer answered an unknown decision " + JSON.stringify(d.decision));
  const sent = ctx.vendor.call("instantly.reply.send", { body: { email: ctx.request.email, body_html: String(d.message || "") } });
  if (!sent.ok) throw new Error("not sent");
  return { content: { sent: true }, subject: { service: "lead-service", id: "lead-" + ctx.request.email } };
}`;

/** A script that sends nothing to anyone: never recorded, never gated. */
const CLASSIFIER = `
export default function run(ctx) {
  const answer = ctx.vendor.call("llm.complete", { provider: "anthropic", model: "sonnet", systemPrompt: "Classify.", message: "x" });
  return { content: { label: String(answer.data.content) }, subject: { service: "lead-service", id: "l1" } };
}`;

const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const catalogueDeps = { isKnownOutcome: async () => true, nameDynasties: testNamer() };
const who = { orgId: "org-1", userId: "user-1", parentRunId: "run-parent", headers: { "x-brand-id": "brand-1", "x-campaign-id": "camp-1" } };

let runCount = 0;
function ledger(): LedgerDeps {
  return {
    async createRun() {
      runCount++;
      return `run-${runCount}`;
    },
    async declareOutcomes() {
      return {};
    },
    async closeRun() {},
  };
}

/** Production vendors: a good writer, a thread read and a send that both answer. */
function productionVendors(): VendorDeps {
  return {
    async complete() {
      return { content: "", json: { decision: "write", message: "<p>Hi Ana, Tuesday 10am works, see you then.</p>" }, model: "glm", tokensInput: 2000, tokensOutput: 200 };
    },
    async judge() {
      return { answers: {} };
    },
    async platformComplete() {
      throw new Error("not a platform run");
    },
    async platformJudge() {
      throw new Error("not a platform run");
    },
    async readSkill() {
      return null;
    },
    async serviceDoor(_service, _method, path) {
      if (path.includes("timeline")) return { status: 200, body: { messages: [{ direction: "inbound", text: "Can we meet Tuesday?" }] } };
      return { status: 200, body: { id: "sent-1" } };
    },
  };
}

/** Proof vendors: the combination's LLM answers `json`; the judge says a field is usable unless it reads like a label. */
function proofDeps(json: Record<string, unknown>, tokens = { tokensInput: 3000, tokensOutput: 300 }) {
  const sentToDoors: string[] = [];
  const judged: string[] = [];
  const llmCalls: Array<Record<string, unknown>> = [];
  const closed: string[] = [];
  const vendors: VendorDeps = {
    async complete() {
      throw new Error("a proof is platform-billed");
    },
    async judge() {
      throw new Error("a proof is platform-billed");
    },
    async platformComplete(body, headers) {
      llmCalls.push({ ...body, runId: headers["x-run-id"] });
      return { content: JSON.stringify(json), json, model: String(body.model), ...tokens };
    },
    async platformJudge(body) {
      const state = String(body.state);
      judged.push(state);
      const p = /= field[^\n]*\n(cold_email_followup|M3|subject: .*)$/m.test(state) ? 0.03 : 0.97;
      return { answers: Object.fromEntries(Object.keys(body.questions as object).map((k) => [k, { noul: p }])), model: "jev" };
    },
    async readSkill() {
      return null;
    },
    async serviceDoor(_s, _m, path) {
      sentToDoors.push(path);
      throw new Error("a proof never calls a door");
    },
  };
  const deps: ProofDeps = {
    vendors,
    async openRun() {
      return "proof-run-1";
    },
    async closeRun(runId, status) {
      closed.push(`${runId}:${status}`);
    },
  };
  return { deps, sentToDoors, judged, llmCalls, closed };
}

let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
  setProofContext(null);
});
afterEach(() => setProofContext(null));

async function seedWriter(tactics: Record<string, unknown> = { llm: { provider: "zai", model: "glm-flash", name: "GLM Flash" } }) {
  return createScript(db, { outcome: "message_sent", dynasty: "dy_answer", code: ANSWERER, description: "Answers a lead.", tactics }, author, catalogueDeps);
}

async function recordProductionRuns(n: number) {
  for (let i = 0; i < n; i++) {
    await runStoredScript(db, { outcome: "message_sent", dynasty: "dy_answer", units: {}, request: { email: `p${i}@example.test`, now: "2026-11-15T10:00:00Z" } }, who, { ledger: ledger(), vendors: productionVendors() });
  }
}

describe("cases: what production runs of a writer saw", () => {
  it("keeps every run of a script that writes to a person and reached its LLM, with each call's request and answer", async () => {
    await seedWriter();
    await recordProductionRuns(3);
    const rows = await db.select().from(writerCases);
    expect(rows).toHaveLength(3);
    const body = rows[0]!.body as { calls: Array<{ name: string; args: unknown; answer: { ok: boolean } }>; request: Record<string, unknown> };
    expect(body.calls.map((c) => c.name)).toEqual(["crm.person.thread", "llm.pick", "llm.complete", "instantly.reply.send"]);
    expect(body.calls[0]!.args).toEqual({ query: { personKey: expect.stringMatching(/^email:p\d@example.test$/) } });
    expect(body.request).toMatchObject({ now: "2026-11-15T10:00:00Z" });
    expect(rows[0]!.recordedFrom).toBe("message_sent/dy_answer/v1");
    expect(rows.every((r) => r.wrote)).toBe(true);
  });

  it("a proof tries the cases where production wrote to a person first, whatever newer cases sent nothing", async () => {
    const row = await seedWriter();
    await recordProductionRuns(PROOF_SAMPLE);
    // Newer cases of runs that sent nothing (night: later), recorded by the same code.
    const nothingSent = await db.select().from(writerCases);
    for (const [i, c] of nothingSent.entries()) {
      const body = c.body as { calls: Array<{ name: string }> };
      await db.insert(writerCases).values({ ...c, id: undefined, runId: `later-${i}`, wrote: false, createdAt: new Date(Date.now() + 60_000), body: { ...body, calls: body.calls.filter((x) => x.name !== "instantly.reply.send") } });
    }
    const p = proofDeps({ decision: "write", message: "<p>Tuesday 10am works.</p>" });
    const proof = await proveScript(db, p.deps, row, "staff");
    expect([proof.state, proof.sample, proof.casesAvailable]).toEqual(["passed", PROOF_SAMPLE, 2 * PROOF_SAMPLE]);
    expect((proof.cases as Array<{ caseId: string }>).every((c) => !c.caseId.startsWith("later-"))).toBe(true);
  });

  it("never keeps a script that sends nothing to a person", async () => {
    await createScript(db, { outcome: "lead_interested", dynasty: "dy_judge", code: CLASSIFIER, description: "Judges a reply." }, author, catalogueDeps);
    await runStoredScript(db, { outcome: "lead_interested", dynasty: "dy_judge", units: {} }, who, { ledger: ledger(), vendors: productionVendors() });
    expect(await db.select().from(writerCases)).toHaveLength(0);
  });
});

describe("a proof: the combination's LLM live on recorded cases, nothing sent", () => {
  it("refuses a combination that puts a label where the body goes (DIS-800: 'cold_email_followup'), after ONE case", async () => {
    const row = await seedWriter();
    await recordProductionRuns(PROOF_SAMPLE + 1);
    const p = proofDeps({ decision: "write", message: "cold_email_followup" });
    const proof = await proveScript(db, p.deps, row, "staff");
    expect(proof.state).toBe("failed");
    expect(proof.sample).toBe(1); // the first unusable case ends it: no more spend
    expect(JSON.stringify(proof.cases)).toContain("instantly.reply.send body.body_html is not usable");
    expect(p.sentToDoors).toEqual([]); // nothing was sent, read or written through a door
    expect(p.llmCalls[0]).toMatchObject({ provider: "zai", model: "glm-flash", runId: "proof-run-1" });
    expect(p.llmCalls[0]!.brandTools).toBeUndefined(); // a proof never acts through a brand's tools
    expect(p.closed).toEqual(["proof-run-1:completed"]);
  });

  it("refuses a combination whose answer is empty: its script cannot read it", async () => {
    const row = await seedWriter();
    await recordProductionRuns(PROOF_SAMPLE);
    const proof = await proveScript(db, proofDeps({}).deps, row, "staff");
    expect(proof.state).toBe("failed");
    expect(JSON.stringify(proof.cases)).toContain("its script could not use the answer: the writer answered an unknown decision");
  });

  it("passes a combination that answers every case usably, judging each field a person would read", async () => {
    const row = await seedWriter({ llm: { provider: "anthropic", model: "claude-haiku", name: "Claude Haiku" } });
    await recordProductionRuns(PROOF_SAMPLE + 2);
    const p = proofDeps({ decision: "write", message: "<p>Hi, Tuesday at 10am works for us. See you then.</p>" });
    const proof = await proveScript(db, p.deps, row, "staff");
    expect([proof.state, proof.sample, proof.usable]).toEqual(["passed", PROOF_SAMPLE, PROOF_SAMPLE]);
    expect(p.llmCalls).toHaveLength(PROOF_SAMPLE); // a fixed sample, never every case held
    expect(p.judged).toHaveLength(PROOF_SAMPLE);
    expect(Number(proof.spendCents)).toBeGreaterThan(0);
  });

  it("a case where it decides to send nothing (later) proves nothing: never counted, so no pass on such cases alone", async () => {
    const row = await seedWriter();
    await recordProductionRuns(PROOF_SAMPLE);
    const p = proofDeps({ decision: "later" });
    const proof = await proveScript(db, p.deps, row, "staff");
    expect([proof.state, proof.sample]).toEqual(["no_cases", 0]);
    expect(p.llmCalls).toHaveLength(PROOF_SAMPLE); // each case was asked once, never more
    expect((proof.cases as Array<{ exercised: boolean; usable: boolean }>).every((c) => !c.exercised && c.usable)).toBe(true);
  });

  it("stops at its spend ceiling", async () => {
    const row = await seedWriter();
    await recordProductionRuns(PROOF_SAMPLE);
    const proof = await proveScript(db, proofDeps({ decision: "write", message: "<p>Tuesday 10am works.</p>" }, { tokensInput: 200_000, tokensOutput: 30_000 }).deps, row, "staff");
    expect(proof.state).toBe("error");
    expect(proof.error).toMatch(/stopped at the ceiling/);
    expect(proof.sample).toBeLessThan(PROOF_SAMPLE);
  });

  it("proves nothing on too few cases (nothing refused for it either)", async () => {
    const row = await seedWriter();
    await recordProductionRuns(PROOF_SAMPLE - 1);
    const p = proofDeps({ decision: "later" });
    const proof = await proveScript(db, p.deps, row, "staff");
    expect(proof.state).toBe("no_cases");
    expect(p.llmCalls).toHaveLength(0);
  });

  it("skips a case its code does not fit (a read the record lacks before the LLM), at no LLM spend", async () => {
    const row = await seedWriter();
    await recordProductionRuns(PROOF_SAMPLE);
    // One more case recorded by another script that never read the thread.
    await db.insert(writerCases).values({
      outcome: "message_sent",
      runId: "other-run",
      recordedFrom: "message_sent/dy_other/v1",
      codeMd5: "other",
      orgId: "org-1",
      body: { units: {}, request: { email: "x@example.test" }, tactics: {}, subject: null, brand: "", day: 0, calls: [{ name: "llm.complete", args: {}, answer: { ok: true, data: {} } }], asked: {} },
    });
    const p = proofDeps({ decision: "write", message: "<p>Tuesday 10am works.</p>" });
    const proof = await proveScript(db, p.deps, row, "staff");
    expect([proof.state, proof.sample]).toEqual(["passed", PROOF_SAMPLE]);
    expect(p.llmCalls).toHaveLength(PROOF_SAMPLE);
  });
});

describe("the gate: an enforced Engine's Rating draws only proven writers", () => {
  it("draws every writer while the Engine is not enforced; then only the proven one", async () => {
    const glm = await seedWriter();
    const haiku = await forkScript(db, "message_sent", "dy_answer", { dynasty: "dy_answer__claude_haiku", description: "Answers a lead with Claude Haiku.", tactics: { llm: { provider: "anthropic", model: "claude-haiku" } } }, author, catalogueDeps);
    await recordProductionRuns(PROOF_SAMPLE);
    const pick = async () => (await candidatesOf(db, { outcome: "message_sent", servable: [], channel: null })).map((r) => r.dynasty).sort();

    expect(await pick()).toEqual(["dy_answer", "dy_answer__claude_haiku"]);
    await proveScript(db, proofDeps({ decision: "write", message: "M3" }).deps, glm, "staff");
    await proveScript(db, proofDeps({ decision: "write", message: "<p>Tuesday 10am works.</p>" }).deps, haiku, "staff");
    expect(await pick()).toEqual(["dy_answer", "dy_answer__claude_haiku"]); // not enforced yet: nothing changes

    await setEngineEnforced(db, "message_sent", true, "staff@example.com");
    expect(await pick()).toEqual(["dy_answer__claude_haiku"]);

    const view = await readWriterProofs(db);
    expect(view.engines).toEqual([{ outcome: "message_sent", enforced: true, cases: PROOF_SAMPLE }]);
    expect(view.combinations.find((c) => c.dynasty === "dy_answer")).toMatchObject({ state: "failed", live: true, red: true, llm: "GLM Flash" });
    expect(view.combinations.find((c) => c.dynasty === "dy_answer__claude_haiku")).toMatchObject({ state: "passed", red: false });
  });

  it("an unproven writer of an enforced Engine is held out and proven once in the background", async () => {
    await seedWriter();
    await recordProductionRuns(PROOF_SAMPLE);
    await setEngineEnforced(db, "message_sent", true, "staff@example.com");
    const p = proofDeps({ decision: "write", message: "<p>Tuesday 10am works.</p>" });
    setProofContext({ db, deps: p.deps });
    expect(await candidatesOf(db, { outcome: "message_sent", servable: [], channel: null })).toEqual([]);
    for (let i = 0; i < 50 && (await db.select().from(writerProofs)).every((r) => r.state === "running"); i++) await new Promise((r) => setTimeout(r, 20));
    expect((await db.select().from(writerProofs)).map((r) => [r.state, r.trigger])).toEqual([["passed", "auto"]]);
    expect((await candidatesOf(db, { outcome: "message_sent", servable: [], channel: null })).map((r) => r.dynasty)).toEqual(["dy_answer"]);
  });

  it("a proof left running by a dead process is abandoned at boot, then retried a bounded number of times", async () => {
    const row = await seedWriter();
    await db.insert(writerProofs).values({ scriptId: row.id, outcome: "message_sent", dynasty: "dy_answer", version: 1, state: "running", trigger: "auto", ceilingCents: "400" });
    expect(await abandonRunningProofs(db)).toBe(1);
    const t = new Date();
    const p = (state: string) => ({ state, trigger: "auto", createdAt: t, casesAvailable: 0 });
    expect(gateFor([p("abandoned")], 10, t.getTime())).toEqual({ draws: false, prove: true, why: "its proof did not finish" });
    expect(gateFor([p("error"), p("abandoned"), p("error")], 10, t.getTime()).prove).toBe(false);
    expect(gateFor([p("failed")], 10, t.getTime())).toEqual({ draws: false, prove: false, why: "failed its proof" });
    expect(gateFor([], 2, t.getTime())).toMatchObject({ draws: true, prove: false });
    expect(gateFor([{ ...p("no_cases"), casesAvailable: 3 }], 8, t.getTime())).toMatchObject({ draws: true, prove: true });
  });
});

describe("the fields a person reads", () => {
  it("reads every sending door's person-facing fields, lists included, absent ones left out", () => {
    expect(personFields("email.send", { body: { subject: "Re: Tuesday", sequence: [{ bodyHtml: "<p>Hi</p>" }] } }).map((f) => `${f.path}=${f.value}`)).toEqual(["body.subject=Re: Tuesday", "body.sequence.*.bodyHtml=<p>Hi</p>"]);
    expect(personFields("crm.whatsapp.send", { body: { messages: ["Hi", "Tuesday?"] } }).map((f) => f.value)).toEqual(["Hi", "Tuesday?"]);
    expect(personFields("lead.followup_date.set", { body: {} })).toEqual([]);
  });
});
