import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { withScriptWriter, writesWithScript, switchableToScript, recordSwitch, SCRIPT_WRITER } from "../../src/lib/scripts/script-writer-switch.js";
import { binomialTail, checkGuard, shouldRollBack, rollBackSwitches, guardView, MIN_RUNS } from "../../src/lib/scripts/script-guard.js";
import { readMonitoring } from "../../src/lib/scripts/script-monitoring.js";
import { writesWithLegBest } from "../../src/lib/leg-best-writer.js";
import { templateDynastyOf } from "../../src/lib/template-dynasty.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { scriptRuns, scriptSwitches, scripts, workflows } from "../../src/db/schema.js";
import type { DAG } from "../../src/lib/dag-validator.js";

// FACTORY-P3 fleet writer switch (owner 2026-10-29 « 3.B »): the DAG upgrade, the script run recorded by
// content-generation (no declaration of its own, traced), and the roll-back guard on a real Postgres.
const MIGRATIONS = join(__dirname, "../../drizzle");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

/** A cold-email DAG shaped like the fleet's (gate, start-run, serve, leg-best writer chain, generate, send, end-run). */
function coldEmailDag(): DAG {
  return {
    nodes: [
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" }, retries: 0 },
      { id: "check-lead", type: "condition", config: {} },
      { id: "writer-pick", type: "http.call", config: { service: "features", method: "GET", path: "/internal/writer-pick" }, inputMapping: { "query.workflowSlug": "$ref:flow_input.workflowSlug", "query.campaignId": "$ref:flow_input.campaignId" }, retries: 2 },
      { id: "writer-plan", type: "script", config: { code: "export async function main(pick) { return pick; }" }, inputMapping: { pick: "$ref:writer-pick.output" }, retries: 0 },
      { id: "template-head", type: "http.call", config: { service: "content-generation", method: "GET", path: "/internal/template-dynasties/{slug}/head" }, inputMapping: { "params.slug": "$ref:writer-plan.output.templateDynastySlug" }, retries: 2 },
      {
        id: "email-generate",
        type: "http.call",
        config: { service: "content-generation", method: "POST", path: "/generate", body: {} },
        inputMapping: {
          "body.type": "$ref:template-head.output.template.type",
          "body.model": "$ref:writer-plan.output.model",
          "body.leadId": "$ref:fetch-lead.output.lead.leadId",
          "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
        },
        retries: 0,
      },
      { id: "email-send", type: "http.call", config: { service: "email-gateway", method: "POST", path: "/orgs/send" }, inputMapping: { "body.subject": "$ref:email-generate.output.subject", "body.sequence": "$ref:email-generate.output.sequence", "body.metadata.emailGenerationId": "$ref:email-generate.output.id" } },
      { id: "end-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: false } } },
      { id: "end-run-no-lead", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: true } } },
    ],
    edges: [
      { from: "start-run", to: "fetch-lead" },
      { from: "fetch-lead", to: "check-lead" },
      { from: "check-lead", to: "writer-pick", condition: "results['fetch-lead'].found == true" },
      { from: "check-lead", to: "end-run-no-lead", condition: "results['fetch-lead'].found == false" },
      { from: "writer-pick", to: "writer-plan" },
      { from: "writer-plan", to: "template-head" },
      { from: "template-head", to: "email-generate" },
      { from: "email-generate", to: "email-send" },
      { from: "email-send", to: "end-run" },
    ],
  };
}

describe("withScriptWriter: the DAG upgrade", () => {
  it("puts materials -> script -> record where the writer call sat; downstream reads and every writer reader are unchanged", () => {
    const before = coldEmailDag();
    const after = withScriptWriter(before);
    expect(after.nodes.map((n) => n.id)).toEqual([
      "start-run", "fetch-lead", "check-lead", "writer-pick", "writer-plan", "template-head",
      "email-generate-materials", "email-generate-script", "email-generate", "email-send", "end-run", "end-run-no-lead",
    ]);
    expect(after.edges).toContainEqual({ from: "template-head", to: "email-generate-materials" });
    expect(after.edges).toContainEqual({ from: "email-generate-materials", to: "email-generate-script" });
    expect(after.edges).toContainEqual({ from: "email-generate-script", to: "email-generate" });
    expect(after.edges).not.toContainEqual({ from: "template-head", to: "email-generate" });

    const materials = after.nodes.find((n) => n.id === "email-generate-materials")!;
    const gen = before.nodes.find((n) => n.id === "email-generate")!;
    expect(materials.config).toEqual({ ...gen.config, path: "/generate/materials" });
    expect(materials.inputMapping).toEqual(gen.inputMapping);

    const script = after.nodes.find((n) => n.id === "email-generate-script")!;
    expect(script.config).toMatchObject({
      service: "workflow",
      path: "/orgs/scripts/run",
      body: { outcome: "message_written", dynasty: "dy_template_writer_full", recordedBy: "content-generation", trace: true },
      skipIf: "results.email_generate_materials?.existing != null",
    });

    const record = after.nodes.find((n) => n.id === "email-generate")!;
    expect(record.config).toEqual(gen.config);
    expect(record.inputMapping).toEqual({ ...gen.inputMapping, "body.written": "$ref:email-generate-script.output", "body.units": "$ref:email-generate-materials.output.units" });

    // Readers of the writer call still see one /generate with the leg's template head + LLM.
    expect(writesWithLegBest(after)).toBe(true);
    expect(writesWithScript(after)).toBe(true);
    expect(switchableToScript(after)).toBe(false);
    expect(switchableToScript(before)).toBe(true);
    expect(templateDynastyOf(after)).toBe(templateDynastyOf(before));
    // Idempotent.
    expect(withScriptWriter(after)).toBe(after);
  });

  it("refuses a DAG with no or several writer calls", () => {
    const none = { ...coldEmailDag(), nodes: coldEmailDag().nodes.filter((n) => n.id !== "email-generate") };
    expect(() => withScriptWriter(none)).toThrow(/exactly one/);
  });

  it("the converted flow hands the materials step every field the writer call gets, and skips the script on an answered request", () => {
    const flow = dagToOpenFlow(withScriptWriter(coldEmailDag()), "t") as unknown as { value: { modules: Array<{ id: string; skip_if?: { expr: string }; value: { input_transforms?: Record<string, { type: string; expr?: string; value?: unknown }> } }> } };
    const all = JSON.stringify(flow);
    const mod = (id: string) => {
      const found: unknown[] = [];
      const walk = (x: unknown) => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object") {
          if ((x as { id?: string }).id === id) found.push(x);
          Object.values(x).forEach(walk);
        }
      };
      walk(flow);
      return found[0] as { skip_if?: { expr: string }; value: { input_transforms: Record<string, { expr?: string; value?: unknown }> } };
    };
    const materials = mod("email_generate_materials");
    const record = mod("email_generate");
    expect(all).toContain("email_generate_script");
    expect(mod("email_generate_script").skip_if).toEqual({ expr: "results.email_generate_materials?.existing != null" });
    // Both content-generation steps get the served lead's relationship + the instruction, the same way.
    expect(JSON.stringify(materials.value.input_transforms)).toContain("leadRelationship");
    expect(JSON.stringify(record.value.input_transforms)).toContain("results.email_generate_script");
  });
});

// ── The script run, recorded by content-generation ──────────────────────────────────────────────────────────────
const WRITER = `
export default function run(ctx) {
  const lead = ctx.get("lead_identified");
  const voice = ctx.vendor.call("voice.read", {});
  const answer = ctx.vendor.call("llm.complete", { message: "Write to " + lead.content.name, systemPrompt: "SYS " + voice.data.content });
  if (!answer.ok) throw new Error("llm.complete failed: " + String(answer.data.error));
  return { content: { subject: answer.data.json.subject, sequence: [] } };
}`;

function ledger() {
  const calls: unknown[][] = [];
  const deps: LedgerDeps = {
    async createRun(o) { calls.push(["create", o]); return "run-script-1"; },
    async declareOutcomes(runId, orgId, body) { calls.push(["declare", { runId, orgId, body }]); return {}; },
    async closeRun(runId, status, orgId) { calls.push(["close", { runId, status, orgId }]); },
  };
  return { calls, deps };
}
const vendorDeps = (fail = false): VendorDeps => ({
  async complete(body) {
    if (fail) throw new Error("chat-service 500");
    return { content: "{}", json: { subject: "Hi Ana" }, model: "claude-sonnet-4-6", tokensInput: 10, tokensOutput: 5, extra: "whole answer" };
  },
  async judge() { return { answers: {} }; },
  async platformComplete() { throw new Error("not a platform run"); },
  async platformJudge() { throw new Error("not a platform run"); },
  async readSkill() { return { content: "Short, warm.", version: 4 }; },
});
const who = { orgId: "org-test", userId: "user-1", parentRunId: "run-workflow", headers: { "x-brand-id": "brand-1" } };
const runInput = {
  outcome: "message_written",
  dynasty: "dy_template_writer_full",
  subject: { service: "lead-service", id: "lead-42" },
  units: { lead_identified: { content: { name: "Ana" }, subject: { service: "lead-service", id: "lead-42" } } },
  tactics: { llm: { provider: "anthropic", model: "sonnet" } },
};

let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
}, 60_000);
const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true };

describe("a script run recorded by content-generation", () => {
  it("declares nothing (content-generation declares the ONE message_written) and traces the exact request + whole answer", async () => {
    await createScript(db, { outcome: "message_written", dynasty: "dy_template_writer_full", code: WRITER, description: "x" }, author, known);
    const l = ledger();
    const out = await runStoredScript(db, { ...runInput, recordedBy: "content-generation", trace: true }, who, { ledger: l.deps, vendors: vendorDeps() });
    expect(out.status).toBe("made");
    expect(l.calls.map((c) => c[0])).toEqual(["create", "close"]);
    expect(out.declared).toEqual({ produced: [], consumed: [] });
    expect(out.recordedBy).toBe("content-generation");
    expect(out.trace).toEqual([
      { name: "voice.read", args: {}, answer: { ok: true, data: { content: "Short, warm.", version: 4 } } },
      {
        name: "llm.complete",
        args: { message: "Write to Ana", systemPrompt: "SYS Short, warm." },
        answer: { ok: true, data: { content: "{}", json: { subject: "Hi Ana" }, model: "claude-sonnet-4-6", tokensInput: 10, tokensOutput: 5 } },
        sent: { message: "Write to Ana", systemPrompt: "SYS Short, warm.", provider: "anthropic", model: "sonnet" },
        raw: { content: "{}", json: { subject: "Hi Ana" }, model: "claude-sonnet-4-6", tokensInput: 10, tokensOutput: 5, extra: "whole answer" },
      },
    ]);
  });

  it("without recordedBy the run still declares its own outcome (unchanged), and no trace is answered", async () => {
    await createScript(db, { outcome: "message_written", dynasty: "dy_template_writer_full", code: WRITER, description: "x" }, author, known);
    const l = ledger();
    const out = await runStoredScript(db, runInput, who, { ledger: l.deps, vendors: vendorDeps() });
    expect(out.declared.produced).toHaveLength(1);
    expect(out.trace).toBeUndefined();
  });
});

// ── The roll-back guard ─────────────────────────────────────────────────────────────────────────────────────────
describe("the roll-back rule", () => {
  it("binomial tail", () => {
    expect(binomialTail(10, 0, 0.5)).toBe(1);
    expect(binomialTail(10, 11, 0.5)).toBe(0);
    expect(binomialTail(10, 10, 0.5)).toBeCloseTo(1 / 1024, 10);
    expect(binomialTail(100, 5, 0.005)).toBeCloseTo(0.000159, 6);
  });

  it("rolls back only on a real excess: enough runs, above 2 %, beyond chance vs the 0.5 % baseline", () => {
    const at = (runs: number, failed: number) => shouldRollBack({ runs, failed, errorRate: runs ? failed / runs : null }).rollBack;
    expect(at(100, 4)).toBe(false); // 4 % but p = 0.0017: a bad hour by chance happens
    expect(at(100, 5)).toBe(true);
    expect(at(20, 3)).toBe(true);
    expect(at(20, 1)).toBe(false);
    expect(at(MIN_RUNS - 1, MIN_RUNS - 1)).toBe(false); // too few runs to say anything
    expect(at(1000, 15)).toBe(false); // 1.5 %: under the floor
    expect(at(1000, 25)).toBe(true);
  });
});

async function insertWorkflow(over: Partial<typeof workflows.$inferInsert> & { version: number; dag: DAG }) {
  const slug = `sales-cold-email-outreach-test${over.version > 1 ? `-v${over.version}` : ""}`;
  const [row] = await db
    .insert(workflows)
    .values({
      orgId: "org-staff",
      workflowSlug: slug,
      workflowName: slug,
      workflowDynastySlug: "sales-cold-email-outreach-test",
      workflowDynastyName: "Test",
      signature: `sig-${over.version}`,
      workflowDynastySignatureName: "test",
      featureSlug: "sales-cold-email-outreach",
      status: "active",
      ...over,
    })
    .returning();
  return row!;
}

describe("switch + roll-back on a real Postgres", () => {
  async function switched() {
    const from = await insertWorkflow({ version: 10, dag: coldEmailDag() });
    await db.update(workflows).set({ status: "deprecated", deprecationReason: "Upgraded: replaced by version 11." }).where(eq(workflows.id, from.id));
    const to = await insertWorkflow({ version: 11, dag: withScriptWriter(coldEmailDag()), creationType: "upgrade", createdFromWorkflow: from.id });
    const sw = await recordSwitch(db, to.id);
    return { from, to, sw };
  }

  it("records a switch once, refuses what is not one", async () => {
    const { from, to, sw } = await switched();
    expect(sw).toMatchObject({ outcome: SCRIPT_WRITER.outcome, dynasty: SCRIPT_WRITER.dynasty, workflowDynastySlug: "sales-cold-email-outreach-test", fromVersion: 10, toVersion: 11, state: "switched" });
    expect((await recordSwitch(db, to.id)).id).toBe(sw.id);
    await expect(recordSwitch(db, from.id)).rejects.toThrow(/not an upgrade/);
  });

  it("the guard fires on a bad hour: the previous version runs again, the script version is deprecated with why, Monitoring goes red", async () => {
    const { from, to } = await switched();
    const [script] = await db.insert(scripts).values({ outcome: "message_written", dynasty: "dy_template_writer_full", version: 1, code: "x", description: "x", createdBy: "t", orgId: "org-staff", creationType: "scratch" } as typeof scripts.$inferInsert).returning();
    const now = new Date();
    const runsRows = Array.from({ length: 30 }, (_, i) => ({ scriptId: script!.id, orgId: "o", runId: `r${i}`, parentRunId: "p", status: i < 6 ? "failed" : "made", createdAt: now }));
    await db.insert(scriptRuns).values(runsRows);
    const restored: string[] = [];
    const out = await checkGuard(db, { restoreFlow: async (w) => void restored.push(w.id) }, "message_written", now);
    expect(out.checked).toBe(true);
    expect(out.result?.rolledBack).toEqual([{ workflowDynastySlug: "sales-cold-email-outreach-test", fromVersion: 10, toVersion: 11 }]);
    expect(restored).toEqual([from.id]);
    const after = await db.select().from(workflows);
    expect(after.find((w) => w.id === from.id)).toMatchObject({ status: "active", deprecationReason: null });
    expect(after.find((w) => w.id === to.id)).toMatchObject({ status: "deprecated" });
    expect(after.find((w) => w.id === to.id)!.deprecationReason).toMatch(/^Rolled back: the stored script.s error rate on message_written was 20\.0 %/);
    const [sw] = await db.select().from(scriptSwitches);
    expect(sw).toMatchObject({ state: "rolled_back" });
    const view = await guardView(db, "message_written", now);
    expect(view).toMatchObject({ state: "rolled_back", lastHour: { runs: 30, failed: 6 }, switches: [{ fromVersion: 10, toVersion: 11, state: "rolled_back" }] });
    const mw = (await readMonitoring(db, 30, now)).outcomes.find((o) => o.outcome === "message_written")!;
    expect(mw.red).toBe(true);
    expect(mw.guard.state).toBe("rolled_back");
    // A second check finds nothing switched: nothing more happens.
    expect((await checkGuard(db, { restoreFlow: async () => {} }, "message_written", now)).checked).toBe(false);
  });

  it("a healthy hour changes nothing and reads normal", async () => {
    const { from, to } = await switched();
    const [script] = await db.insert(scripts).values({ outcome: "message_written", dynasty: "dy_template_writer_full", version: 1, code: "x", description: "x", createdBy: "t", orgId: "org-staff", creationType: "scratch" } as typeof scripts.$inferInsert).returning();
    const now = new Date();
    await db.insert(scriptRuns).values(Array.from({ length: 100 }, (_, i) => ({ scriptId: script!.id, orgId: "o", runId: `r${i}`, parentRunId: "p", status: i < 1 ? "failed" : "made", createdAt: now })));
    const out = await checkGuard(db, { restoreFlow: async () => {} }, "message_written", now);
    expect(out).toMatchObject({ checked: true, rollBack: false, result: null });
    const rows = await db.select().from(workflows);
    expect(rows.find((w) => w.id === to.id)!.status).toBe("active");
    expect(rows.find((w) => w.id === from.id)!.status).toBe("deprecated");
    const mw = (await readMonitoring(db, 30, now)).outcomes.find((o) => o.outcome === "message_written")!;
    expect(mw.red).toBe(false);
    expect(mw.guard).toMatchObject({ state: "watching", lastHour: { runs: 100, failed: 1, errorRate: 0.01 } });
  });

  it("a manual roll-back of named dynasties leaves the others switched", async () => {
    const { to } = await switched();
    const none = await rollBackSwitches(db, { restoreFlow: async () => {} }, "message_written", "drill", "staff", ["another-dynasty"]);
    expect(none).toEqual({ rolledBack: [], skipped: [] });
    expect((await db.select().from(workflows).where(eq(workflows.id, to.id)))[0]!.status).toBe("active");
  });
});
