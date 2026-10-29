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
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { scriptRuns, scriptSwitches, scripts, workflows } from "../../db/schema.js";
import type { AnyPgDb } from "./script-catalogue.js";
import { CLEAR_DEPRECATION, recordDeprecation } from "../deprecation.js";
import { STILL_EXECUTABLE, stopExecutable } from "../executable-until.js";
import { serviceSwitchLabel } from "./script-service-switch.js";

export const WINDOW_MINUTES = 60;
export const MIN_RUNS = 20;
/** content-generation's writer error rate, the service path the script replaced. */
export const BASELINE_ERROR_RATE = 0.005;
export const THRESHOLD_ERROR_RATE = 0.02;
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
  failed: number;
  errorRate: number | null;
}

export function shouldRollBack(w: WindowStats): { rollBack: boolean; pValue: number | null } {
  if (w.runs < MIN_RUNS || w.errorRate === null) return { rollBack: false, pValue: null };
  const pValue = binomialTail(w.runs, w.failed, BASELINE_ERROR_RATE);
  return { rollBack: w.errorRate > THRESHOLD_ERROR_RATE && pValue < ALPHA, pValue };
}

/** The last hour of finished script runs of one outcome. */
export async function lastHour(db: AnyPgDb, outcome: string, now = new Date()): Promise<WindowStats> {
  const since = new Date(now.getTime() - WINDOW_MINUTES * 60_000);
  const [row] = await db
    .select({
      runs: sql<number>`count(*) filter (where ${scriptRuns.status} <> 'running')::int`,
      failed: sql<number>`count(*) filter (where ${scriptRuns.status} in ('failed', 'stopped'))::int`,
    })
    .from(scriptRuns)
    .innerJoin(scripts, eq(scripts.id, scriptRuns.scriptId))
    .where(and(eq(scripts.outcome, outcome), gte(scriptRuns.createdAt, since)));
  const runs = Number(row?.runs ?? 0);
  const failed = Number(row?.failed ?? 0);
  return { runs, failed, errorRate: runs > 0 ? failed / runs : null };
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

/** Check one outcome now; roll back when the rule says so. */
export async function checkGuard(db: AnyPgDb, deps: RollbackDeps, outcome: string, now = new Date()) {
  const [live] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scriptSwitches)
    .where(and(eq(scriptSwitches.outcome, outcome), eq(scriptSwitches.state, "switched")));
  if (!live || Number(live.n) === 0) return { checked: false as const };
  const w = await lastHour(db, outcome, now);
  const verdict = shouldRollBack(w);
  if (!verdict.rollBack) return { checked: true as const, window: w, ...verdict, result: null };
  const reason =
    `the stored script's error rate on ${outcome} was ${(100 * w.errorRate!).toFixed(1)} % over the last ${WINDOW_MINUTES} minutes ` +
    `(${w.failed} of ${w.runs} runs), above ${(100 * THRESHOLD_ERROR_RATE).toFixed(0)} % and above the service path's ${(100 * BASELINE_ERROR_RATE).toFixed(1)} % ` +
    `baseline beyond chance (p = ${verdict.pValue!.toExponential(1)})`;
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

/** Test hook. */
export function resetGuardMemo(): void {
  lastCheck = new Map();
  inFlight.clear();
}

/** The guard block the Monitoring series serves per outcome. */
export async function guardView(db: AnyPgDb, outcome: string, now = new Date()) {
  const rows = await db.select().from(scriptSwitches).where(eq(scriptSwitches.outcome, outcome));
  const window = await lastHour(db, outcome, now);
  const switched = rows.filter((r) => r.state === "switched");
  const rolled = rows.filter((r) => r.state === "rolled_back").sort((a, b) => (b.rolledBackAt?.getTime() ?? 0) - (a.rolledBackAt?.getTime() ?? 0));
  const state: "off" | "watching" | "rolled_back" = switched.length > 0 ? "watching" : rolled.length > 0 ? "rolled_back" : "off";
  return {
    state,
    windowMinutes: WINDOW_MINUTES,
    lastHour: window,
    baselineErrorRate: BASELINE_ERROR_RATE,
    thresholdErrorRate: THRESHOLD_ERROR_RATE,
    minRuns: MIN_RUNS,
    rolledBackAt: state === "rolled_back" ? (rolled[0]?.rolledBackAt?.toISOString() ?? null) : null,
    reason: state === "rolled_back" ? (rolled[0]?.rollbackReason ?? null) : null,
    switches: rows
      .sort((a, b) => switchLabel(a).localeCompare(switchLabel(b)))
      .map((r) => ({
        workflowDynastySlug: switchLabel(r),
        fromVersion: r.fromVersion ?? 0,
        toVersion: r.toVersion ?? 0,
        state: r.state as "switched" | "rolled_back",
        // A service switch: the caller service (fromVersion 0 = its own code, toVersion = the script version).
        ...(r.callerService ? { callerService: r.callerService } : {}),
      })),
  };
}
