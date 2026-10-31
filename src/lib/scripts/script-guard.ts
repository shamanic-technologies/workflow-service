/**
 * FACTORY-P3 fleet writer switch: the safety net. The switched workflows are re-activated on their previous version
 * (the content-generation writer) as soon as the stored script writes clearly worse than the path it replaced.
 *
 * The rule, measured on THIS service's own record of every script run (`script_runs`, no fleet aggregate) over the
 * last 60 minutes, per outcome with switched workflows:
 *   - at least MIN_RUNS finished runs (below that an hour says nothing: 1 failure in 3 runs is not a signal), and
 *   - an error rate (failed + stopped over finished) above THRESHOLD_ERROR_RATE, and
 *   - a one-sided binomial test against the service path's baseline (BASELINE_ERROR_RATE, content-generation's
 *     measured writer error rate) below ALPHA, i.e. the excess is not chance.
 * Why this margin (market practice): Flagger's default canary gate is a 99 % request success rate per interval (1 %
 * errors) and Argo Rollouts' analysis runs a fixed success floor; Netflix/Google's Kayenta and the Google SRE workbook
 * ("Canarying releases") judge the canary against its CONTROL with a statistical test rather than a raw delta, so a few
 * random failures never trip it. We take both: an absolute floor of 4x our 0.5 % baseline (2 %) and a 99.9 %
 * confidence that the canary is worse. At ~100 writes/hour that is 5 failures or more; at 20 writes, 3 or more.
 *
 * The roll-back re-activates each switched workflow's PREVIOUS version (its Windmill flow restored first) and
 * deprecates the script version with the reason, in one transaction per dynasty; the switch row is marked
 * `rolled_back`, which the Monitoring series serves red. Never an email.
 * Evaluated after every script run of a switched outcome (at most once a minute per process): no timer.
 */
import { and, desc, eq, gt, gte, inArray, sql, type AnyColumn } from "drizzle-orm";
import { scriptMonitoringDays, scriptRuns, scriptSwitches, scripts, workflowRuns, workflows } from "../../db/schema.js";
import type { AnyPgDb } from "./script-catalogue.js";
import type { DAG } from "../dag-validator.js";
import { CLEAR_DEPRECATION, recordDeprecation } from "../deprecation.js";
import { STILL_EXECUTABLE, stopExecutable } from "../executable-until.js";
import { serviceSwitchLabel } from "./script-service-switch.js";

export const WINDOW_MINUTES = 60;
export const MIN_RUNS = 20;
/**
 * The baseline when the service path has no measured day yet (content-generation's writer, 2026-10-29). Every outcome
 * is held to its OWN service path's measured error rate once one is stored (`measuredBaseline`).
 */
export const BASELINE_ERROR_RATE = 0.005;
/** The absolute floor; the threshold is the larger of it and 4x the baseline (2 % at the 0.5 % writer baseline). */
export const THRESHOLD_ERROR_RATE = 0.02;
export const THRESHOLD_BASELINE_MULTIPLE = 4;

export interface Baseline {
  errorRate: number;
  /** `measured` = the service path's latest stored day (Monitoring series); `default` = none stored yet. */
  source: "measured" | "default";
  day: string | null;
  sample: number;
}

/** The service path's error rate the script is held to: its latest stored Monitoring day with a sample. */
export async function measuredBaseline(db: AnyPgDb, outcome: string): Promise<Baseline> {
  const [row] = await db
    .select()
    .from(scriptMonitoringDays)
    .where(and(eq(scriptMonitoringDays.outcome, outcome), eq(scriptMonitoringDays.path, "service"), gt(scriptMonitoringDays.sampleSize, 0)))
    .orderBy(desc(scriptMonitoringDays.day))
    .limit(1);
  const done = row ? row.completedCount + row.failedCount : 0;
  if (!row || done === 0) return { errorRate: BASELINE_ERROR_RATE, source: "default", day: null, sample: 0 };
  return { errorRate: row.failedCount / done, source: "measured", day: row.day, sample: done };
}

export const thresholdFor = (baseline: number) => Math.max(THRESHOLD_ERROR_RATE, THRESHOLD_BASELINE_MULTIPLE * baseline);
export const ALPHA = 0.001;
const CHECK_EVERY_MS = 60_000;

/** P(X >= k) for X ~ Binomial(n, p), in log space (n is at most a few thousand). */
export function binomialTail(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  const logP = Math.log(p);
  const logQ = Math.log(1 - p);
  let logC = 0; // log C(n, 0)
  let total = 0;
  for (let i = 0; i <= n; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    if (i >= k) total += Math.exp(logC + i * logP + (n - i) * logQ);
  }
  return Math.min(1, total);
}

export interface WindowStats {
  runs: number;
  /** Script errors: failed + stopped. A failure the world gave (`unmade`) is NOT one. */
  failed: number;
  errorRate: number | null;
  /** Runs that made no Unit for a reason the world gave (a verifier with no verdict), counted apart. */
  unmade?: number;
}

export function shouldRollBack(w: WindowStats, baseline: number = BASELINE_ERROR_RATE): { rollBack: boolean; pValue: number | null } {
  if (w.runs < MIN_RUNS || w.errorRate === null) return { rollBack: false, pValue: null };
  // A baseline of 0 would make any single error "beyond chance": test against at least the default.
  const pValue = binomialTail(w.runs, w.failed, Math.max(baseline, BASELINE_ERROR_RATE));
  return { rollBack: w.errorRate > thresholdFor(baseline) && pValue < ALPHA, pValue };
}

/** The last hour of finished script runs of one outcome. */
/**
 * A failure billing gave (INCIDENT 2026-10-31 01:32 UTC: the writer rolled back on 3 runs whose org had reached the
 * max budget its owner set on that sales funnel; chat-service answered 402 to the script's LLM call, exactly as it
 * answers content-generation's own call, which then fails the same step). Not the script's error: counted apart, on
 * both sides of every comparison (the script runs and the switched workflows' runs vs their previous versions).
 */
export const BILLING_REFUSED_PATTERN = "insufficient.credits|max budget";
export const billingRefused = (col: AnyColumn) => sql`coalesce(${col} ~* ${BILLING_REFUSED_PATTERN}, false)`;
/** The same rule on a stored reason (tests and readers). */
export const isBillingRefused = (reason: string | null | undefined) => !!reason && new RegExp(BILLING_REFUSED_PATTERN, "i").test(reason);

export async function lastHour(db: AnyPgDb, outcome: string, now = new Date()): Promise<WindowStats> {
  const since = new Date(now.getTime() - WINDOW_MINUTES * 60_000);
  const [row] = await db
    .select({
      runs: sql<number>`count(*) filter (where ${scriptRuns.status} <> 'running')::int`,
      failed: sql<number>`count(*) filter (where ${scriptRuns.status} in ('failed', 'stopped') and not ${billingRefused(scriptRuns.error)})::int`,
      unmade: sql<number>`count(*) filter (where ${scriptRuns.status} = 'unmade' or (${scriptRuns.status} in ('failed', 'stopped') and ${billingRefused(scriptRuns.error)}))::int`,
    })
    .from(scriptRuns)
    .innerJoin(scripts, eq(scripts.id, scriptRuns.scriptId))
    .where(and(eq(scripts.outcome, outcome), gte(scriptRuns.createdAt, since)));
  const runs = Number(row?.runs ?? 0);
  const failed = Number(row?.failed ?? 0);
  return { runs, failed, errorRate: runs > 0 ? failed / runs : null, unmade: Number(row?.unmade ?? 0) };
}

export interface RollbackDeps {
  /** Re-create a version's Windmill flow when missing (a deprecated version's flow may have been cleaned up). */
  restoreFlow(workflow: typeof workflows.$inferSelect): Promise<void>;
}

export interface RollbackResult {
  rolledBack: Array<{ workflowDynastySlug: string; fromVersion: number; toVersion: number }>;
  skipped: Array<{ workflowDynastySlug: string; reason: string }>;
}

/** A switch row named the way Monitoring and a roll-back by name read it: its dynasty, or `service:<caller>`. */
const switchLabel = (r: typeof scriptSwitches.$inferSelect) => (r.callerService ? serviceSwitchLabel(r.callerService) : r.workflowDynastySlug!);

/**
 * Re-activate the previous version of every switched dynasty of `outcome` and deprecate the script version, one
 * transaction per dynasty (the active version is flipped BEFORE the previous one goes live: one active per dynasty).
 * A SERVICE switch (script-service-switch.ts) is only marked rolled_back: its caller reads that and runs its own code.
 */
export async function rollBackSwitches(
  db: AnyPgDb,
  deps: RollbackDeps,
  outcome: string,
  reason: string,
  decidedBy: string,
  /** Only these dynasties (a drill, a manual roll-back); default every switched one. */
  onlyDynasties?: string[],
): Promise<RollbackResult> {
  const all = await db.select().from(scriptSwitches).where(and(eq(scriptSwitches.outcome, outcome), eq(scriptSwitches.state, "switched")));
  const rows = onlyDynasties ? all.filter((r) => onlyDynasties.includes(switchLabel(r))) : all;
  const out: RollbackResult = { rolledBack: [], skipped: [] };
  for (const sw of rows) {
    if (sw.callerService) {
      await db
        .update(scriptSwitches)
        .set({ state: "rolled_back", rolledBackAt: new Date(), rollbackReason: reason })
        .where(and(eq(scriptSwitches.id, sw.id), eq(scriptSwitches.state, "switched")));
      console.warn(`[workflow-service] script guard: ${outcome} ${switchLabel(sw)} rolled back to the service's own code: ${reason}`);
      out.rolledBack.push({ workflowDynastySlug: switchLabel(sw), fromVersion: sw.fromVersion ?? 0, toVersion: sw.toVersion ?? 0 });
      continue;
    }
    if (!sw.fromWorkflowId || !sw.toWorkflowId) {
      out.skipped.push({ workflowDynastySlug: switchLabel(sw), reason: "a workflow switch without its versions" });
      continue;
    }
    const pair = await db.select().from(workflows).where(inArray(workflows.id, [sw.fromWorkflowId, sw.toWorkflowId]));
    const slug = switchLabel(sw);
    const from = pair.find((w) => w.id === sw.fromWorkflowId);
    const to = pair.find((w) => w.id === sw.toWorkflowId);
    if (!from || !to) {
      out.skipped.push({ workflowDynastySlug: slug, reason: "a version of the switch is gone" });
      continue;
    }
    if (to.status !== "active") {
      // The dynasty moved on (a later upgrade): the switch row stays, the guard names it.
      out.skipped.push({ workflowDynastySlug: slug, reason: `v${sw.toVersion} is no longer the active version` });
      continue;
    }
    await deps.restoreFlow(from);
    await db.transaction(async (tx) => {
      await tx
        .update(workflows)
        .set({ status: "deprecated", ...stopExecutable(), ...recordDeprecation({ reason: `Rolled back: ${reason}`, decidedBy }), updatedAt: new Date() })
        .where(eq(workflows.id, to.id));
      await tx
        .update(workflows)
        .set({ status: "active", ...(from.workflowDynastyStatus === "active" ? { ...STILL_EXECUTABLE, ...CLEAR_DEPRECATION } : {}), updatedAt: new Date() })
        .where(eq(workflows.id, from.id));
      await tx
        .update(scriptSwitches)
        .set({ state: "rolled_back", rolledBackAt: new Date(), rollbackReason: reason })
        .where(eq(scriptSwitches.id, sw.id));
    });
    console.warn(`[workflow-service] script guard: ${slug} rolled back v${sw.toVersion} -> v${sw.fromVersion}: ${reason}`);
    out.rolledBack.push({ workflowDynastySlug: slug, fromVersion: sw.fromVersion!, toVersion: sw.toVersion! });
  }
  return out;
}

/** How long before a workflow switch the dynasty's own failure rate is read (its previous version's baseline). */
export const WORKFLOW_BASELINE_DAYS = 7;

/**
 * The switched WORKFLOWS' own runs (INCIDENT 2026-10-30: the script made every email, `made`, no error, and every
 * cold-email run still failed one step later: content-generation's record step answered 413 on the script's traced
 * answer, so no email was queued for ~22 hours while the script-run window read healthy). A switch is judged on what
 * the workflow it changed actually finishes, not only on the script run inside it: the last hour of `workflow_runs` of
 * every switched version (failed over finished) against the same dynasties' previous versions over the
 * WORKFLOW_BASELINE_DAYS before the switch (measured; 0.5 % when they ran nothing).
 */
export async function workflowWindow(db: AnyPgDb, outcome: string, now = new Date()): Promise<{ window: WindowStats; baseline: Baseline; steps: string[] } | null> {
  const live = await db
    .select()
    .from(scriptSwitches)
    .where(and(eq(scriptSwitches.outcome, outcome), eq(scriptSwitches.state, "switched")));
  const switched = live.filter((r) => r.toWorkflowId && r.fromWorkflowId);
  if (switched.length === 0) return null;
  // Only failures AT the steps the switch changed count (owner 2026-10-30: a vendor outage at the send step, Primeforge,
  // must never roll a writer back): the switched versions' writer steps vs the previous versions' writer call.
  const versions = await db.select().from(workflows).where(inArray(workflows.id, switched.flatMap((r) => [r.toWorkflowId!, r.fromWorkflowId!])));
  const steps = [...new Set(versions.flatMap((w) => switchedStepIds(w.dag as DAG)))].sort();
  const since = new Date(now.getTime() - WINDOW_MINUTES * 60_000);
  const count = async (ids: string[], from: Date, to: Date) => {
    const [row] = await db
      .select({
        runs: sql<number>`count(*) filter (where ${workflowRuns.status} in ('completed', 'failed'))::int`,
        failed: sql<number>`count(*) filter (where ${workflowRuns.status} = 'failed' and ${workflowRuns.failedStep} in (${sql.join(steps.map((x) => sql`${x}`), sql`, `)}) and not ${billingRefused(workflowRuns.failedReason)})::int`,
      })
      .from(workflowRuns)
      .where(and(inArray(workflowRuns.workflowId, ids), gte(workflowRuns.createdAt, from), sql`${workflowRuns.createdAt} <= ${to.toISOString()}::timestamptz`));
    return { runs: Number(row?.runs ?? 0), failed: Number(row?.failed ?? 0) };
  };
  const cur = await count(switched.map((r) => r.toWorkflowId!), since, now);
  const firstSwitch = new Date(Math.min(...switched.map((r) => r.switchedAt.getTime())));
  const before = await count(switched.map((r) => r.fromWorkflowId!), new Date(firstSwitch.getTime() - WORKFLOW_BASELINE_DAYS * 86_400_000), firstSwitch);
  const baseline: Baseline =
    before.runs > 0 && before.failed > 0
      ? { errorRate: before.failed / before.runs, source: "measured", day: firstSwitch.toISOString().slice(0, 10), sample: before.runs }
      : { errorRate: BASELINE_ERROR_RATE, source: "default", day: null, sample: before.runs };
  return { window: { runs: cur.runs, failed: cur.failed, errorRate: cur.runs > 0 ? cur.failed / cur.runs : null }, baseline, steps };
}

/** The Windmill module ids of the steps a writer switch changes (the writer call, its materials read, the script). */
export function switchedStepIds(dag: DAG | null | undefined): string[] {
  return (dag?.nodes ?? [])
    .filter((n) => n.type === "http.call" && ((n.config?.service === "content-generation" && (n.config?.path === "/generate" || n.config?.path === "/generate/materials")) || (n.config?.service === "workflow" && n.config?.path === "/orgs/scripts/run")))
    .map((n) => n.id.replace(/-/g, "_"));
}

/** Check one outcome now; roll back when the rule says so (the script runs, or the switched workflows' own runs). */
export async function checkGuard(db: AnyPgDb, deps: RollbackDeps, outcome: string, now = new Date()) {
  const [live] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scriptSwitches)
    .where(and(eq(scriptSwitches.outcome, outcome), eq(scriptSwitches.state, "switched")));
  if (!live || Number(live.n) === 0) return { checked: false as const };
  const w = await lastHour(db, outcome, now);
  const baseline = await measuredBaseline(db, outcome);
  const verdict = shouldRollBack(w, baseline.errorRate);
  if (!verdict.rollBack) {
    const flows = await workflowWindow(db, outcome, now);
    const flowVerdict = flows ? shouldRollBack(flows.window, flows.baseline.errorRate) : { rollBack: false, pValue: null };
    if (!flows || !flowVerdict.rollBack) return { checked: true as const, window: w, ...verdict, workflows: flows?.window ?? null, result: null };
    const flowReason =
      `the switched workflows failed ${(100 * flows.window.errorRate!).toFixed(1)} % of their runs at the switched steps over the last ${WINDOW_MINUTES} minutes ` +
      `(${flows.window.failed} of ${flows.window.runs}, at ${flows.steps.join("/")}), above ${(100 * thresholdFor(flows.baseline.errorRate)).toFixed(1)} % and above their previous versions' ` +
      `${(100 * flows.baseline.errorRate).toFixed(1)} % ${flows.baseline.source} rate beyond chance (p = ${flowVerdict.pValue!.toExponential(1)})`;
    const result = await rollBackSwitches(db, deps, outcome, flowReason, "workflow-service script guard");
    return { checked: true as const, window: w, ...flowVerdict, workflows: flows.window, result };
  }
  const reason =
    `the stored script's error rate on ${outcome} was ${(100 * w.errorRate!).toFixed(1)} % over the last ${WINDOW_MINUTES} minutes ` +
    `(${w.failed} of ${w.runs} runs), above ${(100 * thresholdFor(baseline.errorRate)).toFixed(1)} % and above the service path's ${(100 * baseline.errorRate).toFixed(1)} % ` +
    `${baseline.source} baseline beyond chance (p = ${verdict.pValue!.toExponential(1)})`;
  const result = await rollBackSwitches(db, deps, outcome, reason, "workflow-service script guard");
  return { checked: true as const, window: w, ...verdict, result };
}

let lastCheck = new Map<string, number>();
const inFlight = new Map<string, Promise<unknown>>();
let guardContext: { db: AnyPgDb; deps: RollbackDeps } | null = null;

export function setGuardContext(c: { db: AnyPgDb; deps: RollbackDeps } | null): void {
  guardContext = c;
}

/** After a script run: check its outcome at most once a minute per process, never awaited, never thrown. */
export function noteScriptRunForGuard(outcome: string, now = Date.now()): Promise<unknown> | null {
  if (!guardContext) return null;
  if (inFlight.has(outcome) || now - (lastCheck.get(outcome) ?? 0) < CHECK_EVERY_MS) return null;
  lastCheck.set(outcome, now);
  const ctx = guardContext;
  const p = checkGuard(ctx.db, ctx.deps, outcome)
    .catch((err) => console.error(`[workflow-service] script guard FAILED for ${outcome}: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => inFlight.delete(outcome));
  inFlight.set(outcome, p);
  return p;
}

/**
 * A workflow run finished (the run poll): check every outcome with a live workflow switch, each at most once a minute
 * (a switched flow can fail AFTER its script, where no script run notes anything).
 */
export function noteWorkflowRunForGuard(now = Date.now()): void {
  if (!guardContext) return;
  const ctx = guardContext;
  void ctx.db
    .selectDistinct({ outcome: scriptSwitches.outcome })
    .from(scriptSwitches)
    .where(and(eq(scriptSwitches.state, "switched"), sql`${scriptSwitches.toWorkflowId} is not null`))
    .then((rows: Array<{ outcome: string }>) => rows.forEach((r) => noteScriptRunForGuard(r.outcome, now)))
    .catch((err: unknown) => console.error(`[workflow-service] script guard (workflow runs) FAILED: ${err instanceof Error ? err.message : String(err)}`));
}

/** Test hook. */
export function resetGuardMemo(): void {
  lastCheck = new Map();
  inFlight.clear();
}

/** The guard block the Monitoring series serves per outcome. */
export async function guardView(db: AnyPgDb, outcome: string, now = new Date()) {
  const rows = await db.select().from(scriptSwitches).where(eq(scriptSwitches.outcome, outcome));
  const window = await lastHour(db, outcome, now);
  const baseline = await measuredBaseline(db, outcome);
  const switched = rows.filter((r) => r.state === "switched");
  const rolled = rows.filter((r) => r.state === "rolled_back").sort((a, b) => (b.rolledBackAt?.getTime() ?? 0) - (a.rolledBackAt?.getTime() ?? 0));
  const state: "off" | "watching" | "rolled_back" = switched.length > 0 ? "watching" : rolled.length > 0 ? "rolled_back" : "off";
  return {
    state,
    windowMinutes: WINDOW_MINUTES,
    lastHour: window,
    baselineErrorRate: baseline.errorRate,
    baselineSource: baseline.source,
    thresholdErrorRate: thresholdFor(baseline.errorRate),
    minRuns: MIN_RUNS,
    rolledBackAt: state === "rolled_back" ? (rolled[0]?.rolledBackAt?.toISOString() ?? null) : null,
    reason: state === "rolled_back" ? (rolled[0]?.rollbackReason ?? null) : null,
    switches: rows
      .sort((a, b) => switchLabel(a).localeCompare(switchLabel(b)))
      .map((r) => ({
        workflowDynastySlug: switchLabel(r),
        fromVersion: r.fromVersion ?? 0,
        toVersion: r.toVersion ?? 0,
        state: r.state as "switched" | "rolled_back" | "shadow",
        // A service switch: the caller service (fromVersion 0 = its own code, toVersion = the script version).
        ...(r.callerService ? { callerService: r.callerService } : {}),
      })),
  };
}
