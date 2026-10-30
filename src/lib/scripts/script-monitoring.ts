/**
 * FACTORY-P3 (4): the Monitoring series of every outcome a stored script can make, one STORED row per day x outcome x
 * path: `script` (runs of our stored scripts, task `script:<outcome>/<dynasty>`) vs `service` (the service task that
 * makes the outcome today). Both are read from runs-service's task outcomes (`GET /internal/stats/task-outcomes`, one
 * time-boxed call per service, once per UTC day): total runs, the latest sample's completed / failed and average
 * whole-subtree cost per run. Daily runs = the total's day-over-day delta (null on a path's first stored day).
 *
 * Served (`GET /internal/scripts/monitoring`) with two verdicts the Monitoring hub reads, never an email:
 * `red` = the script path's error rate is above the service path's on the latest day (with script runs in sample), or
 * the roll-back guard fired / would fire (`guard`, script-guard.ts: last hour, threshold, switched workflows);
 * `readyToDelete` = the service path made ZERO runs on each of the last 7 stored days (its code may then leave its repo).
 *
 * Refreshed once per UTC day by whatever comes first: a read of the series, a workflow write/dispatch, or the sweep a
 * minute after boot. No timer: a quiet service reads nothing.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { scriptMonitoringDays, scripts } from "../../db/schema.js";
import type { AnyPgDb } from "./script-catalogue.js";
import { guardView, shouldRollBack } from "./script-guard.js";

/** Which service task makes each outcome today (a fact of the fleet, read in runs-service). */
export const SERVICE_PATHS: Record<string, { serviceName: string; taskNames: string[] }> = {
  message_written: { serviceName: "content-generation-service", taskNames: ["single-generation"] },
  // The reply judge (a SERVICE switch, script-service-switch.ts): instantly opens one `reply-qualification` run per
  // judgment its own code makes, a child of the org's reply-judging run of the day.
  lead_interested: { serviceName: "instantly-service", taskNames: ["reply-qualification"] },
  // The verification waterfall's DECISION (a SERVICE switch): apollo opens one `email-verification` run per decision
  // its own code makes; each verifier call's run hangs under it (under the script's run once switched).
  email_found: { serviceName: "apollo-service", taskNames: ["email-verification"] },
  // A candidate's decision in a candidates serve (a SERVICE switch): lead-service opens one `candidate-decision` run per
  // decision its own code makes (the screen's Jev hangs under it).
  lead_identified: { serviceName: "lead-service", taskNames: ["candidate-decision"] },
  // A candidates walk of an apollo audience (a SERVICE switch): human-service opens one `candidate-walk` run per walk
  // its own code makes.
  lead_found: { serviceName: "human-service", taskNames: ["candidate-walk"] },
  // An audience split proposal (a SERVICE switch): human-service opens one `audience-split-proposal` run per proposal
  // its own code makes for a caller's run.
  audience_built: { serviceName: "human-service", taskNames: ["audience-split-proposal"] },
};

export const SCRIPT_SERVICE_NAME = "workflow";
export const READY_TO_DELETE_DAYS = 7;
const TASK_OUTCOMES_SAMPLE = 200;

export interface TaskOutcome {
  taskName: string;
  totalRunCount: number;
  sampleSize: number;
  completedCount: number;
  failedCount: number;
  sumCostInUsdCents: string | null;
}

export interface MonitoringDeps {
  taskOutcomes(serviceName: string): Promise<TaskOutcome[]>;
}

function aggregate(tasks: TaskOutcome[]) {
  let total = 0, sample = 0, completed = 0, failed = 0, cost = 0;
  for (const t of tasks) {
    total += Number(t.totalRunCount);
    sample += Number(t.sampleSize);
    completed += Number(t.completedCount);
    failed += Number(t.failedCount);
    cost += Number(t.sumCostInUsdCents ?? 0);
  }
  return { total, sample, completed, failed, avgCost: sample > 0 ? (cost / sample).toFixed(6) : null };
}

const today = (now: Date) => now.toISOString().slice(0, 10);

/** Store today's rows for every outcome with a service path (idempotent: today's rows are replaced). */
export async function refreshMonitoring(db: AnyPgDb, deps: MonitoringDeps, now = new Date()): Promise<number> {
  const day = today(now);
  const byService = new Map<string, TaskOutcome[]>();
  const read = async (service: string) => {
    if (!byService.has(service)) byService.set(service, await deps.taskOutcomes(service));
    return byService.get(service)!;
  };
  let written = 0;
  for (const [outcome, path] of Object.entries(SERVICE_PATHS)) {
    const serviceTasks = (await read(path.serviceName)).filter((t) => path.taskNames.includes(t.taskName));
    const scriptTasks = (await read(SCRIPT_SERVICE_NAME)).filter((t) => t.taskName.startsWith(`script:${outcome}/`));
    for (const [which, serviceName, tasks, names] of [
      ["service", path.serviceName, serviceTasks, path.taskNames],
      ["script", SCRIPT_SERVICE_NAME, scriptTasks, scriptTasks.map((t) => t.taskName)],
    ] as const) {
      const a = aggregate(tasks);
      const row = {
        day, outcome, path: which, serviceName, taskNames: [...names],
        totalRunCount: a.total, sampleSize: a.sample, completedCount: a.completed, failedCount: a.failed, avgCostCents: a.avgCost, computedAt: now,
      };
      await db
        .insert(scriptMonitoringDays)
        .values(row)
        .onConflictDoUpdate({ target: [scriptMonitoringDays.day, scriptMonitoringDays.outcome, scriptMonitoringDays.path], set: row });
      written++;
    }
  }
  return written;
}

let refreshedDay: string | null = null;
let inFlight: Promise<void> | null = null;

/** Refresh at most once per UTC day per process (the DB row is the truth; this only spares the call). */
export function maybeRefreshMonitoring(db: AnyPgDb, deps: MonitoringDeps, now = new Date()): Promise<void> {
  const day = today(now);
  if (refreshedDay === day) return Promise.resolve();
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const [row] = await db.select({ day: scriptMonitoringDays.day }).from(scriptMonitoringDays).where(eq(scriptMonitoringDays.day, day)).limit(1);
      if (!row) {
        const n = await refreshMonitoring(db, deps, now);
        console.log(`[workflow-service] script monitoring: stored ${n} rows for ${day}`);
      }
      refreshedDay = day;
    } catch (err) {
      console.error(`[workflow-service] script monitoring FAILED for ${day}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

let context: { db: AnyPgDb; deps: MonitoringDeps } | null = null;
/** Wire the production db + deps once at boot, so workflow traffic can keep the daily row stored. */
export function setMonitoringContext(c: { db: AnyPgDb; deps: MonitoringDeps } | null): void {
  context = c;
}
/** Rides workflow writes and dispatches (`noteWorkflowWrite`): at most one refresh per UTC day, never awaited. */
export function noteScriptMonitoring(): void {
  if (context) void maybeRefreshMonitoring(context.db, context.deps);
}

/** Test hook. */
export function resetMonitoringMemo(): void {
  refreshedDay = null;
  inFlight = null;
}

type Row = typeof scriptMonitoringDays.$inferSelect;
const errorRate = (r: Row) => (r.completedCount + r.failedCount > 0 ? r.failedCount / (r.completedCount + r.failedCount) : null);

function pathDays(rows: Row[]) {
  const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  return sorted.map((r, i) => ({
    day: r.day,
    runs: i === 0 ? null : r.totalRunCount - sorted[i - 1]!.totalRunCount,
    totalRuns: r.totalRunCount,
    sample: r.sampleSize,
    errorRate: errorRate(r),
    avgCostCents: r.avgCostCents === null ? null : Number(r.avgCostCents),
    tasks: r.taskNames,
  }));
}

/** The served series: per outcome, both paths day by day, the proofs of its stored scripts, and the two verdicts. */
export async function readMonitoring(db: AnyPgDb, days: number, now = new Date()) {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.select().from(scriptMonitoringDays).where(gte(scriptMonitoringDays.day, since)).orderBy(desc(scriptMonitoringDays.day));
  const actives = await db.select().from(scripts).where(and(eq(scripts.status, "active"), eq(scripts.dynastyStatus, "active")));
  const outcomes = [...new Set([...Object.keys(SERVICE_PATHS), ...actives.map((s) => s.outcome)])].sort();
  const guards = new Map(await Promise.all(outcomes.map(async (o) => [o, await guardView(db, o, now)] as const)));
  return {
    since,
    outcomes: outcomes.map((outcome) => {
      const script = pathDays(rows.filter((r) => r.outcome === outcome && r.path === "script"));
      const service = pathDays(rows.filter((r) => r.outcome === outcome && r.path === "service"));
      const lastScript = script.at(-1);
      const lastService = service.at(-1);
      const guard = guards.get(outcome)!;
      // Red = broken: the script path errs more than the service path on the latest stored day, the roll-back guard
      // fired (the switched workflows run their previous version), or the last hour already crosses its rule.
      const red =
        (!!lastScript && lastScript.sample > 0 && lastScript.errorRate !== null && lastScript.errorRate > (lastService?.errorRate ?? 0)) ||
        guard.state === "rolled_back" ||
        (guard.state === "watching" && shouldRollBack(guard.lastHour, guard.baselineErrorRate).rollBack);
      const lastWeek = service.slice(-READY_TO_DELETE_DAYS);
      const readyToDelete = lastWeek.length === READY_TO_DELETE_DAYS && lastWeek.every((d) => d.runs === 0);
      return {
        outcome,
        servicePath: SERVICE_PATHS[outcome] ?? null,
        scripts: actives
          .filter((s) => s.outcome === outcome)
          .map((s) => ({ scriptSlug: `${s.outcome}/${s.dynasty}/v${s.version}`, proof: s.replay ?? null })),
        red,
        readyToDelete,
        guard,
        days: [...new Set([...service, ...script].map((d) => d.day))].sort().map((day) => ({
          day,
          service: service.find((x) => x.day === day) ?? null,
          script: script.find((x) => x.day === day) ?? null,
        })),
      };
    }),
  };
}

/** runs-service's fleet task outcomes, one time-boxed call per service (an aggregate: never retried). */
export function productionMonitoringDeps(): MonitoringDeps {
  return {
    async taskOutcomes(serviceName) {
      const base = (process.env.RUNS_SERVICE_URL ?? "").replace(/\/$/, "");
      const key = process.env.RUNS_SERVICE_API_KEY ?? "";
      if (!base || !key) throw new Error("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be set");
      const res = await fetch(`${base}/internal/stats/task-outcomes?serviceName=${encodeURIComponent(serviceName)}&sample=${TASK_OUTCOMES_SAMPLE}`, {
        headers: { "x-api-key": key },
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`runs-service task-outcomes ${serviceName} -> ${res.status}: ${text.slice(0, 200)}`);
      return (JSON.parse(text) as { tasks: TaskOutcome[] }).tasks;
    },
  };
}
