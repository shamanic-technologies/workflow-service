import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { workflowRuns, workflows } from "../../src/db/schema.js";
import {
  readEngineMonitoring,
  refreshEngineMonitoring,
  UNASSIGNED_OUTCOME,
  type EngineMonitoringDeps,
} from "../../src/lib/scripts/engine-monitoring.js";
import type { AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";

// MIGRATE-1105 S2b: campaign Engines, script vs workflow, on a real Postgres. A workflow run's outcome is its dynasty's
// leg's toStep; an engine run's is its own `engineOutcome`. Red only when the script fails more than the workflow did.
async function freshDb() {
  const client = new PGlite();
  const dir = join(__dirname, "../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const at = (d: number, h = 12) => new Date(Date.UTC(2026, 10, d, h));

let db: AnyPgDb;
let costCalls: Array<{ orgId: string; runIds: string[] }>;
const deps: EngineMonitoringDeps = {
  legsOf: async (f) =>
    f === "cold"
      ? [
          { workflowDynastySlug: "cold-ballad", legKey: "lead_found_to_conversation", state: "active", decidedAt: "2026-10-01" },
          { workflowDynastySlug: "cold-old", legKey: "lead_found_to_website_visit", state: "deprecated", decidedAt: "2026-10-01" },
          { workflowDynastySlug: "cold-old", legKey: "lead_found_to_conversation", state: "deprecated", decidedAt: "2026-10-05" },
        ]
      : [],
  toStepOf: async (pipeId) => pipeId.split("|")[1]!.split("_to_")[1]!,
  runCosts: async (orgId, runIds) => {
    costCalls.push({ orgId, runIds });
    return new Map(runIds.map((id) => [id, 2]));
  },
};

async function workflow(dynasty: string, featureSlug: string) {
  const [w] = await db
    .insert(workflows)
    .values({
      orgId: ORG_A, workflowSlug: `${dynasty}-v1`, workflowName: dynasty, workflowDynastySlug: dynasty, workflowDynastyName: dynasty,
      featureSlug, signature: dynasty, workflowDynastySignatureName: dynasty, dag: {},
    })
    .returning();
  return w!.id;
}

let n = 0;
async function runs(count: number, o: { workflowId?: string; outcome?: string; org?: string; status: string; at: Date; campaignId?: string | null; error?: string }) {
  for (let i = 0; i < count; i++) {
    n++;
    await db.insert(workflowRuns).values({
      workflowId: o.workflowId ?? null,
      orgId: o.org ?? ORG_A,
      campaignId: o.campaignId === undefined ? "c1" : o.campaignId,
      runId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      status: o.status,
      executionScope: o.workflowId ? "campaign" : "engine",
      inputs: o.workflowId ? {} : { engineOutcome: o.outcome },
      ...(o.error ? (o.workflowId ? { failedReason: o.error } : { error: o.error }) : {}),
      createdAt: o.at,
    });
  }
}

beforeEach(async () => {
  db = await freshDb();
  costCalls = [];
  n = 0;
});

describe("campaign Engine monitoring", () => {
  it("counts each outcome's runs by script vs workflow per day and org, costs completed days, and is not red for a workflow still running", async () => {
    const ballad = await workflow("cold-ballad", "cold");
    const old = await workflow("cold-old", "cold");
    const nobody = await workflow("test-x", "factory-engines-test");
    await runs(30, { workflowId: ballad, status: "completed", at: at(5) });
    await runs(2, { workflowId: ballad, status: "failed", at: at(5) });
    await runs(5, { workflowId: old, status: "completed", at: at(5), org: ORG_B });
    await runs(3, { workflowId: nobody, status: "completed", at: at(5) });
    await runs(4, { workflowId: ballad, status: "completed", at: at(5), campaignId: null });
    await runs(40, { outcome: "conversation", status: "completed", at: at(6) });
    await runs(1, { outcome: "conversation", status: "failed", at: at(6) });
    await runs(3, { workflowId: ballad, status: "completed", at: at(6, 1) });

    const r = await refreshEngineMonitoring(db, deps, at(6, 13));
    expect(r.costedDays).toEqual(["2026-11-05"]);
    // One batch per org, at most 10 finished runs per outcome x path x org (A: 10 conversation + 3 unassigned; B: 5).
    expect(costCalls.map((c) => [c.orgId, c.runIds.length]).sort()).toEqual([[ORG_A, 13], [ORG_B, 5]]);

    const out = await readEngineMonitoring(db, 30, at(6, 13));
    const conv = out.outcomes.find((o) => o.outcome === "conversation")!;
    expect(conv.days.map((d) => [d.day, d.script?.runs ?? 0, d.workflow?.runs ?? 0])).toEqual([["2026-11-05", 0, 37], ["2026-11-06", 41, 3]]);
    // Spend = runs x the sampled cost per run (2 cents), per org; today has no sample yet.
    expect(conv.days[0]!.workflow).toMatchObject({ failed: 2, spendCents: 74, costPerRunCents: 2, sampledRuns: 15 });
    expect(conv.days[1]!.script?.spendCents).toBeNull();
    expect(conv.onWorkflow).toBe(true);
    expect(conv.lastWorkflowDay).toBe("2026-11-06");
    expect(conv.red).toBe(false);
    expect(conv.verdict.scriptErrorRate).toBeCloseTo(1 / 41);
    expect(conv.orgs.map((o) => [o.orgId, o.workflow?.runs ?? 0, o.script?.runs ?? 0])).toEqual([[ORG_A, 35, 41], [ORG_B, 5, 0]]);
    expect(out.outcomes.map((o) => o.outcome)).toEqual(["conversation", UNASSIGNED_OUTCOME]);

    // A second refresh the same day recounts today and costs nothing again.
    costCalls = [];
    await runs(2, { outcome: "conversation", status: "completed", at: at(6, 14) });
    expect((await refreshEngineMonitoring(db, deps, at(6, 15))).costedDays).toEqual([]);
    expect(costCalls).toEqual([]);
    const again = (await readEngineMonitoring(db, 30, at(6, 15))).outcomes.find((o) => o.outcome === "conversation")!;
    expect(again.days[1]!.script?.runs).toBe(43);
    expect(again.days[0]!.workflow?.spendCents).toBe(74);
  });

  it("is red when the script fails more than the workflow did", async () => {
    const ballad = await workflow("cold-ballad", "cold");
    await runs(100, { workflowId: ballad, status: "completed", at: at(3) });
    await runs(1, { workflowId: ballad, status: "failed", at: at(3) });
    await runs(20, { outcome: "conversation", status: "completed", at: at(6) });
    await runs(3, { outcome: "conversation", status: "failed", at: at(6) });
    await refreshEngineMonitoring(db, deps, at(6, 13));
    const conv = (await readEngineMonitoring(db, 30, at(6, 13))).outcomes.find((o) => o.outcome === "conversation")!;
    expect(conv.onWorkflow).toBe(false);
    expect(conv.red).toBe(true);
    expect(conv.verdict.thresholdErrorRate).toBeCloseTo(1 / 101 + 0.01);
  });

  it("counts a run failed by a call with no answer or a billing refusal apart, on both paths, never as red (MON-SCRIPTS-FOLLOWUP-DYNASTIES-1111)", async () => {
    const ballad = await workflow("cold-ballad", "cold");
    await runs(100, { workflowId: ballad, status: "completed", at: at(3) });
    await runs(5, { workflowId: ballad, status: "failed", at: at(3), error: "POST lead/orgs/buffer/next failed (500): Internal server error" });
    await runs(160, { outcome: "conversation", status: "completed", at: at(6) });
    // distribute.you's WhatsApp bridge, 2026-11-11: 87 runs refused 502 while it reconnected; nothing was sent.
    const reconnecting =
      'POST crm/orgs/whatsapp/reach failed (502): {"type":"upstream","code":"bridge_error","error":"WhatsApp bridge: WHATSAPP_RECONNECTING the brand\'s WhatsApp is reconnecting right now"}';
    await runs(29, { outcome: "conversation", status: "failed", at: at(6), error: reconnecting });
    await runs(2, { outcome: "conversation", status: "failed", at: at(6), error: "message_sent/dy_answer_lead/v3 (asked for message_sent) failed: llm.complete failed: fetch failed" });
    await runs(1, { outcome: "conversation", status: "failed", at: at(6), error: "chat-service POST /complete -> 402: Sales funnel max budget reached" });
    await runs(1, { outcome: "conversation", status: "failed", at: at(6), error: "finalize: decision write by email with an empty subject or body" });
    await refreshEngineMonitoring(db, deps, at(6, 13));
    const conv = (await readEngineMonitoring(db, 30, at(6, 13))).outcomes.find((o) => o.outcome === "conversation")!;
    expect(conv.days[0]!.workflow).toMatchObject({ failed: 0, unanswered: 5 });
    expect(conv.days[1]!.script).toMatchObject({ runs: 193, completed: 160, failed: 1, unanswered: 32 });
    expect(conv.verdict.scriptErrorRate).toBeCloseTo(1 / 193);
    expect(conv.verdict.scriptFinishedRuns).toBe(193);
    expect(conv.verdict.workflowErrorRate).toBe(0);
    expect(conv.red).toBe(false);

    // The script's own failures still turn it red.
    await runs(10, { outcome: "conversation", status: "failed", at: at(6, 14), error: "finalize: the next follow-up date is not a date" });
    await refreshEngineMonitoring(db, deps, at(6, 15));
    const red = (await readEngineMonitoring(db, 30, at(6, 15))).outcomes.find((o) => o.outcome === "conversation")!;
    expect(red.days[1]!.script).toMatchObject({ failed: 11, unanswered: 32 });
    expect(red.red).toBe(true);
  });

  it("is never red under 20 finished script runs, nor for an outcome that only runs on a workflow", async () => {
    const ballad = await workflow("cold-ballad", "cold");
    await runs(50, { workflowId: ballad, status: "failed", at: at(6) });
    await runs(5, { outcome: "lead_found", status: "failed", at: at(6) });
    await refreshEngineMonitoring(db, deps, at(6, 13));
    const out = await readEngineMonitoring(db, 30, at(6, 13));
    expect(out.outcomes.every((o) => !o.red)).toBe(true);
  });
});
