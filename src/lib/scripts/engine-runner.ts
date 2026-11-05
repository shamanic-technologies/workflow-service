/**
 * MIGRATE-1105 S0: ONE campaign run = ONE Engine run of a stored script, with no workflow and no Windmill job.
 *
 * campaign-service dispatches the Engine of the campaign's next outcome (`POST /engines/{outcome}/execute`, the same
 * identity, trigger, audience and admission it sends a workflow) once that Engine is live for the org (engine.ts). The
 * runner then does what every campaign DAG's chassis did, for every Engine the same way:
 *
 *   pick       a due WAIT of this campaign's Engine first (open work moves first, under its first pick: same version,
 *              same materials), else the Rating's pick among the Engine's scripts the run can feed (engine.ts);
 *   run        opened in runs-service NAMED BY THE SCRIPT (`script:<outcome>/<dynasty>`, never a workflow slug), child of
 *              campaign-service's run, carrying the campaign, brand and audience so every dollar lands on it as today;
 *   gate       campaign-service `/gate-check` (refused = the run ends there, no `/end-run`, exactly like a DAG);
 *   start      `/start-run`: the campaign's context for THIS run (brief, offer, audience, people...) = the script's
 *              Request (`ctx.request`);
 *   script     the materials it holds: the Unit the dispatch PUSHED (a trigger occurrence, as a Unit of the campaign's
 *              `fromOutcome`, about the lead it names) and nothing on a proactive run (`fromOutcome` "start": the script
 *              finds its own subject through its vendors and names it in its Unit);
 *   end        `/end-run`, read off the script's status the same way for every Engine (below), then the run is closed.
 *
 * A script that waits (`ctx.wait(days)`) stops: its wait is stored, its run ends, and the campaign's next dispatch once
 * due resumes it. Nothing holds a worker. Every callback names the run as `x-run-id` and the Engine as
 * `x-engine-outcome`; no `x-workflow-slug` leaves this file.
 */
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { engineWaits, scripts, workflowRuns, type EngineWaitRow, type ScriptRow } from "../../db/schema.js";
import type { AnyPgDb } from "./script-catalogue.js";
import { START_OUTCOME, pickScript } from "./engine.js";
import { ScriptRunFailed, scriptTaskName, type LedgerDeps, type MaterialUnit, type RunScriptInput, type ScriptRunResult, type SubjectRef } from "./script-runner.js";

/** An Engine run with no script it can run (nothing pushed it can use): named by its Engine, ends idle. */
export const engineTaskName = (outcome: string) => `engine:${outcome}`;

/** A wait claimed by a run that died is free again after this long. */
export const WAIT_CLAIM_LEASE_MS = 30 * 60_000;

export interface EngineDispatch {
  outcome: string;
  /** The campaign's outcome before this one: "start" (proactive) or the Unit a trigger pushed. */
  fromOutcome: string;
  orgId: string;
  userId: string;
  /** campaign-service's own run (the caller's `x-run-id`). */
  callerRunId: string;
  campaignId: string;
  /** The brand header as received (CSV). */
  brandIdHeader: string;
  featureSlug: string | null;
  audienceId: string | null;
  /** What campaign-service hands a workflow on `/execute`: `trigger` when the dispatch answers an occurrence. */
  inputs: Record<string, unknown>;
}

/** What the run will execute, decided before it is opened (so the run is named by it). */
export type EnginePlan =
  | { kind: "resume"; wait: EngineWaitRow; script: ScriptRow }
  | { kind: "pick"; script: ScriptRow; draws: Array<Record<string, unknown>> }
  | { kind: "none" };

export interface CampaignCallbacks {
  call(path: "/gate-check" | "/start-run" | "/end-run", headers: Record<string, string>, body: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface EngineRunDeps {
  ledger: LedgerDeps;
  campaign: CampaignCallbacks;
  runScript(input: RunScriptInput, who: { orgId: string; userId: string; parentRunId: string; headers: Record<string, string> }, owned: { runId: string; onWait(days: number): Promise<void> }): Promise<ScriptRunResult>;
  /** After a script run (the roll-back guard watches its outcome). */
  noteScriptRun?(outcome: string): void;
}

interface Trigger {
  eventId?: unknown;
  leadId?: unknown;
  person?: unknown;
}

const triggerOf = (d: EngineDispatch): Trigger | null => {
  const t = d.inputs.trigger;
  return t && typeof t === "object" ? (t as Trigger) : null;
};

/** The Unit a dispatch pushed: the trigger occurrence, about the lead it names. */
export function pushedUnits(d: EngineDispatch): { units: Record<string, MaterialUnit>; subject: SubjectRef | undefined } {
  const trigger = triggerOf(d);
  if (!trigger || d.fromOutcome === START_OUTCOME) return { units: {}, subject: undefined };
  const leadId = typeof trigger.leadId === "string" && trigger.leadId ? trigger.leadId : null;
  const subject = leadId ? { service: "lead-service", id: leadId } : undefined;
  return { units: { [d.fromOutcome]: { content: trigger as Record<string, unknown>, ...(subject ? { subject } : {}) } }, subject };
}

/** Claim this campaign's oldest due wait of the Engine (one run takes it; a dead run's claim expires). */
export async function claimDueWait(db: AnyPgDb, d: EngineDispatch, now = new Date()): Promise<EngineWaitRow | null> {
  const leaseEnd = new Date(now.getTime() - WAIT_CLAIM_LEASE_MS);
  const free = and(
    eq(engineWaits.orgId, d.orgId),
    eq(engineWaits.campaignId, d.campaignId),
    eq(engineWaits.outcome, d.outcome),
    lte(engineWaits.dueAt, now),
    or(eq(engineWaits.status, "waiting"), and(eq(engineWaits.status, "claimed"), lte(engineWaits.claimedAt, leaseEnd))),
  );
  const [candidate] = await db.select({ id: engineWaits.id }).from(engineWaits).where(free).orderBy(asc(engineWaits.dueAt)).limit(1);
  if (!candidate) return null;
  const [claimed] = await db
    .update(engineWaits)
    .set({ status: "claimed", claimedAt: now })
    .where(and(eq(engineWaits.id, candidate.id), free))
    .returning();
  return claimed ?? null;
}

/** Decide what the run executes: a due wait first, else the Rating's pick, else nothing. */
export async function planEngineRun(db: AnyPgDb, d: EngineDispatch): Promise<EnginePlan> {
  const wait = await claimDueWait(db, d);
  if (wait) {
    const [script] = await db.select().from(scripts).where(eq(scripts.id, wait.scriptId));
    if (script) return { kind: "resume", wait, script };
    await db.update(engineWaits).set({ status: "resumed" }).where(eq(engineWaits.id, wait.id));
    console.error(`[workflow-service] engine ${d.outcome}: wait ${wait.id} names script ${wait.scriptId}, which no longer exists: dropped`);
  }
  const { units } = pushedUnits(d);
  const pick = await pickScript(db, { outcome: d.outcome, servable: Object.keys(units), channel: d.featureSlug });
  return pick ? { kind: "pick", script: pick.script, draws: pick.draws } : { kind: "none" };
}

export const planTaskName = (d: EngineDispatch, plan: EnginePlan) =>
  plan.kind === "none" ? engineTaskName(d.outcome) : scriptTaskName(plan.script.outcome, plan.script.dynasty);

/** The `/end-run` body a script's status states, the same for every Engine (campaign-service's contract). */
export function endRunBodyOf(result: (Pick<ScriptRunResult, "status" | "error"> & { again?: boolean }) | null, answersOccurrence: boolean): Record<string, unknown> {
  if (!result) return { success: true, stopCampaign: false, noWorkAvailable: true };
  switch (result.status) {
    case "made":
      return { success: true, stopCampaign: false, ...(answersOccurrence ? { delivery: { state: "delivered" } } : {}) };
    case "nothing":
    case "waiting":
      return { success: true, stopCampaign: false, noWorkAvailable: true };
    case "unmade": {
      // A script states its reason as a code, or `<code>: <why>` (the producer's refusal code and its words verbatim).
      const stated = result.error ?? "unmade";
      const split = /^([a-z][a-z0-9_]*): ([\s\S]+)$/.exec(stated);
      const reason = (split ? split[1]! : stated).slice(0, 200);
      // `stopCampaign` = this run's audience had nobody (campaign-service's own vocabulary, decided by equality).
      if (reason === "audience_exhausted") return { success: true, stopCampaign: true };
      // An unfinished look (`again`): a NORMAL run, so the campaign asks again on its short cadence; on an occurrence,
      // nothing is stated about the person (it is redelivered), never a refusal.
      if (result.again === true) return answersOccurrence ? { success: true, stopCampaign: false, noWorkAvailable: true } : { success: true, stopCampaign: false };
      // The occurrence's person is not someone this campaign acts for (a refusal about WHO, final, never redelivered).
      if (reason === "person_not_admitted" && answersOccurrence) return { success: true, stopCampaign: false, personNotAdmitted: { reason: (split ? split[2]! : reason).slice(0, 200) } };
      if (answersOccurrence) return { success: true, stopCampaign: false, delivery: { state: "refused", code: reason, reason: (split ? split[2]! : stated).slice(0, 2000) } };
      return { success: true, stopCampaign: false, noWorkAvailable: true };
    }
    default:
      return { success: false, stopCampaign: false };
  }
}

const finishRow = (db: AnyPgDb, rowId: string, status: "completed" | "failed", result: Record<string, unknown>, error: string | null) =>
  db.update(workflowRuns).set({ status, result, error, completedAt: new Date() }).where(eq(workflowRuns.id, rowId));

/** Execute one Engine run after its run was opened and answered to campaign-service. Never throws. */
export async function executeEngineRun(db: AnyPgDb, rowId: string, runId: string, d: EngineDispatch, plan: EnginePlan, deps: EngineRunDeps): Promise<void> {
  const headers: Record<string, string> = {
    "x-org-id": d.orgId,
    "x-user-id": d.userId,
    "x-run-id": runId,
    "x-campaign-id": d.campaignId,
    "x-brand-id": d.brandIdHeader,
    "x-engine-outcome": d.outcome,
    ...(d.featureSlug ? { "x-feature-slug": d.featureSlug } : {}),
  };
  const releaseWait = async () => {
    if (plan.kind === "resume") await db.update(engineWaits).set({ status: "waiting", claimedAt: null }).where(eq(engineWaits.id, plan.wait.id));
  };
  let started = false;
  try {
    const gate = await deps.campaign.call("/gate-check", headers, {});
    if (gate.allowed === false) {
      await releaseWait();
      await deps.ledger.closeRun(runId, "completed", d.orgId);
      await finishRow(db, rowId, "completed", { gate: "refused", reason: gate.reason ?? null }, null);
      console.log(`[workflow-service] engine ${d.outcome} run=${runId} campaign=${d.campaignId}: gate refused (${String(gate.reason ?? "")})`);
      return;
    }
    const start = await deps.campaign.call("/start-run", headers, {});
    started = true;
    const audienceId = typeof start.audienceId === "string" && start.audienceId ? start.audienceId : d.audienceId;
    const trigger = triggerOf(d);
    const answersOccurrence = !!trigger;
    let result: ScriptRunResult | null = null;
    if (plan.kind !== "none") {
      const pushed = pushedUnits(d);
      const input: RunScriptInput =
        plan.kind === "resume"
          ? {
              outcome: plan.script.outcome,
              dynasty: plan.script.dynasty,
              version: plan.script.version,
              ...(plan.wait.subject ? { subject: plan.wait.subject as SubjectRef } : {}),
              units: (plan.wait.units ?? {}) as Record<string, MaterialUnit>,
            }
          : { outcome: plan.script.outcome, dynasty: plan.script.dynasty, ...(pushed.subject ? { subject: pushed.subject } : {}), units: pushed.units };
      const recordedBy = (plan.script.tactics as Record<string, unknown>)?.recorded_by;
      // `now`: the run's clock, stated once (a script never reads Date.now(), so a replay of the run is the run); the
      // campaign the run is for rides the Request too (a script's door call names it: the writer pick, the send).
      input.request = { campaignId: d.campaignId, ...start, trigger: trigger ?? null, now: new Date().toISOString() };
      if (typeof recordedBy === "string" && recordedBy) input.recordedBy = recordedBy;
      const vendorHeaders: Record<string, string> = { ...headers, ...(audienceId ? { "x-audience-id": audienceId } : {}) };
      delete vendorHeaders["x-engine-outcome"];
      try {
        result = await deps.runScript(input, { orgId: d.orgId, userId: d.userId, parentRunId: d.callerRunId, headers: vendorHeaders }, {
          runId,
          onWait: async (days) => {
            await db.insert(engineWaits).values({
              orgId: d.orgId,
              campaignId: d.campaignId,
              outcome: d.outcome,
              scriptId: plan.script.id,
              subject: input.subject ?? null,
              units: input.units,
              dueAt: new Date(Date.now() + days * 86_400_000),
              fromRunId: runId,
            });
          },
        });
      } catch (e) {
        if (!(e instanceof ScriptRunFailed)) throw e;
        result = e.result;
      }
      deps.noteScriptRun?.(d.outcome);
      // A script whose work produces no outcome by design states its support function (tactic `support: {kind,
      // reason}`); the run is marked once it made its Unit. Never fails the run: a refusal is logged loudly.
      const support = (plan.script.tactics as Record<string, unknown>)?.support as { kind?: unknown; reason?: unknown } | undefined;
      if (result?.status === "made" && support && typeof support.kind === "string" && typeof support.reason === "string" && deps.ledger.markSupport) {
        await deps.ledger
          .markSupport(runId, { kind: support.kind, reason: support.reason, markedBy: `workflow-service engine ${scriptTaskName(plan.script.outcome, plan.script.dynasty)}` })
          .catch((e) => console.error(`[workflow-service] engine run ${runId}: SUPPORT MARK FAILED:`, e instanceof Error ? e.message : e));
      }
      if (plan.kind === "resume") await db.update(engineWaits).set({ status: "resumed", resumedRunId: runId }).where(eq(engineWaits.id, plan.wait.id));
    }
    const endBody = endRunBodyOf(result, answersOccurrence);
    await deps.campaign.call("/end-run", headers, endBody);
    const ok = !result || (result.status !== "failed" && result.status !== "stopped");
    await deps.ledger.closeRun(runId, ok ? "completed" : "failed", d.orgId);
    await finishRow(
      db,
      rowId,
      ok ? "completed" : "failed",
      { script: result ? result.scriptSlug : null, status: result?.status ?? "no_script", endRun: endBody },
      result?.error ?? null,
    );
    console.log(
      `[workflow-service] engine ${d.outcome} run=${runId} campaign=${d.campaignId} ${result ? `${result.scriptSlug} ${result.status}` : "no script it can run: idle"}` +
        `${result?.error ? `: ${result.error}` : ""}`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[workflow-service] engine ${d.outcome} run=${runId} campaign=${d.campaignId} failed: ${message}`);
    await releaseWait().catch(() => {});
    if (started) await deps.campaign.call("/end-run", headers, { success: false, stopCampaign: false }).catch((err) => console.error(`[workflow-service] engine run ${runId}: /end-run failed too:`, err));
    await deps.ledger.closeRun(runId, "failed", d.orgId).catch((err) => console.error(`[workflow-service] engine run ${runId}: closing it failed:`, err));
    await finishRow(db, rowId, "failed", {}, message).catch(() => {});
  }
}

/**
 * At boot: an Engine run a dead process left open (its row active, no workflow, no Windmill job) is closed failed and
 * its campaign told, so the campaign is not held by a run nobody executes.
 */
export async function closeOrphanEngineRuns(db: AnyPgDb, deps: Pick<EngineRunDeps, "ledger" | "campaign">): Promise<number> {
  const orphans = await db
    .select()
    .from(workflowRuns)
    .where(and(sql`${workflowRuns.workflowId} IS NULL`, sql`${workflowRuns.windmillJobId} IS NULL`, sql`${workflowRuns.status} IN ('dispatching', 'queued', 'running')`, eq(workflowRuns.executionScope, ENGINE_EXECUTION_SCOPE)));
  for (const o of orphans) {
    const outcome = String((o.inputs as Record<string, unknown> | null)?.engineOutcome ?? "");
    if (o.runId && o.campaignId) {
      const headers: Record<string, string> = {
        "x-org-id": o.orgId,
        "x-user-id": o.userId ?? "",
        "x-run-id": o.runId,
        "x-campaign-id": o.campaignId,
        "x-brand-id": (o.brandIds ?? []).join(","),
        "x-engine-outcome": outcome,
        ...(o.featureSlug ? { "x-feature-slug": o.featureSlug } : {}),
      };
      await deps.campaign.call("/end-run", headers, { success: false, stopCampaign: false }).catch((e) => console.error(`[workflow-service] orphan engine run ${o.runId}: /end-run:`, e));
      await deps.ledger.closeRun(o.runId, "failed", o.orgId).catch((e) => console.error(`[workflow-service] orphan engine run ${o.runId}: close:`, e));
    }
    await finishRow(db, o.id, "failed", {}, "the process running this Engine run stopped before it ended");
  }
  return orphans.length;
}

/** The admission row's scope for an Engine run (its key is the campaign's, shared with workflow executions). */
export const ENGINE_EXECUTION_SCOPE = "engine";
