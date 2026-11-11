/**
 * MIGRATE-1105 S2b: the Monitoring series of every CAMPAIGN Engine (the outcome a campaign's leg reaches: conversation,
 * lead_found, threads_post_published, client_satisfied...), so the owner sees in one second which outcomes still run on a
 * workflow. One STORED row per UTC day x outcome x path x org:
 *   - `script`: the campaign run executed its Engine's stored script with no workflow (a `workflow_runs` row with no
 *     workflow, `execution_scope = 'engine'`, its outcome in `inputs.engineOutcome`, engine-runner.ts);
 *   - `workflow`: the campaign ran a workflow; its outcome is the step its dynasty's leg reaches (features-service owns
 *     the dynasty -> leg link, the catalogue owns the leg's `toStep`).
 * Counts (runs, completed, failed) are recomputed from `workflow_runs` (this service's own rows, exact, any past day);
 * spend is a SAMPLE: runs-service's subtree cost of up to `COST_SAMPLE_PER_GROUP` finished runs per day x outcome x
 * path x org, read once per completed day (`POST /v1/runs/costs/batch`, per org), served as cost per run and the day's
 * spend (runs x cost per run, per org, summed).
 *
 * Verdict (never an email): `red` = the script path's recent failure rate (today + yesterday, at least
 * `RED_MIN_RUNS` finished runs) is above the workflow path's over the window (+1 point of noise), or above 2 % when the
 * outcome never ran on a workflow in the window. A failure is the run's OWN: a run that failed because a call got no
 * answer or billing refused it is counted apart (`unanswered`, the roll-back guard's rule: `NO_ANSWER_PATTERN`,
 * `BILLING_REFUSED_PATTERN`) on both paths (MON-SCRIPTS-FOLLOWUP-DYNASTIES-1111: paid_client and client_satisfied read
 * red at 7.7 % and 11 %, 87 of their failures were distribute.you's WhatsApp bridge answering 502 "reconnecting",
 * zero a script error). An outcome still on a workflow is NOT red: it is served
 * `onWorkflow` (a normal "not yet").
 *
 * Refreshed at most every 15 minutes per process, never awaited by a read: the read, workflow traffic, and a sweep a
 * minute after boot (index.ts). No timer.
 */
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { engineMonitoringDays } from "../../db/schema.js";
import type { AnyPgDb } from "./script-catalogue.js";
import { ENGINE_EXECUTION_SCOPE } from "./engine-runner.js";
import { BILLING_REFUSED_PATTERN, NO_ANSWER_PATTERN } from "./script-guard.js";

/** The guard's rule as a Postgres regex (`\b` is a backspace there, `\y` the word boundary). */
const UNANSWERED_SQL_PATTERN = `${NO_ANSWER_PATTERN}|${BILLING_REFUSED_PATTERN}`.replace(/\\b/g, "\\y");

export const ENGINE_BACKFILL_DAYS = 30;
/** Completed days whose spend is still read (older ones keep a null sample). */
export const ENGINE_COST_DAYS = 7;
export const COST_SAMPLE_PER_GROUP = 10;
/** Completed days costed per refresh: the backfill spreads over several refreshes, never one burst. */
const COST_DAYS_PER_REFRESH = 2;
const REFRESH_EVERY_MS = 15 * 60_000;
export const RED_MIN_RUNS = 20;
const RED_NOISE = 0.01;
const RED_FLOOR = 0.02;
/** A workflow run whose dynasty has no leg on record. */
export const UNASSIGNED_OUTCOME = "unassigned";

export interface LegAssignmentView {
  workflowDynastySlug: string;
  legKey: string;
  state: string;
  decidedAt: string;
}

export interface EngineMonitoringDeps {
  /** features-service's dynasty -> leg assignments of one featureSlug (any state). */
  legsOf(featureSlug: string): Promise<LegAssignmentView[]>;
  /** The step a pipe (`<featureSlug>|<legKey>`) reaches, from the catalogue. */
  toStepOf(pipeId: string): Promise<string>;
  /** runs-service subtree cost per run (cents), one org's runs; a run it does not answer is left out. */
  runCosts(orgId: string, runIds: string[]): Promise<Map<string, number>>;
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));

interface RunGroupRow {
  day: string;
  path: "script" | "workflow";
  org_id: string;
  engine_outcome: string | null;
  feature_slug: string | null;
  dynasty: string | null;
  runs: number;
  completed: number;
  failed: number;
  unanswered: number;
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** Resolves a workflow run's outcome from its dynasty, memoized for one refresh. */
function outcomeResolver(deps: EngineMonitoringDeps) {
  const legs = new Map<string, Promise<LegAssignmentView[]>>();
  const steps = new Map<string, Promise<string | null>>();
  return async (featureSlug: string | null, dynasty: string | null): Promise<string> => {
    if (!featureSlug || !dynasty) return UNASSIGNED_OUTCOME;
    if (!legs.has(featureSlug)) legs.set(featureSlug, deps.legsOf(featureSlug));
    const own = (await legs.get(featureSlug)!).filter((a) => a.workflowDynastySlug === dynasty);
    if (own.length === 0) return UNASSIGNED_OUTCOME;
    // The leg it is actively on; a dynasty no longer on any leg keeps its latest one.
    const pick = own.find((a) => a.state === "active") ?? [...own].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0]!;
    const pipeId = `${featureSlug}|${pick.legKey}`;
    if (!steps.has(pipeId)) steps.set(pipeId, deps.toStepOf(pipeId).catch(() => null));
    return (await steps.get(pipeId)!) ?? UNASSIGNED_OUTCOME;
  };
}

/** The day's campaign runs grouped by path, org and what names their outcome. */
async function groupedRuns(db: AnyPgDb, since: string, until: string | null): Promise<RunGroupRow[]> {
  // A workflow run states its failed call in `failed_reason`, an Engine run in `error`.
  const unanswered = sql`coalesce(coalesce(r.failed_reason, r.error) ~* ${UNANSWERED_SQL_PATTERN}, false)`;
  return rowsOf<RunGroupRow>(
    await db.execute(sql`
      SELECT to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             CASE WHEN r.workflow_id IS NULL THEN 'script' ELSE 'workflow' END AS path,
             r.org_id, r.inputs->>'engineOutcome' AS engine_outcome,
             w.feature_slug, w.workflow_dynasty_slug AS dynasty,
             count(*)::int AS runs,
             count(*) FILTER (WHERE r.status = 'completed')::int AS completed,
             count(*) FILTER (WHERE r.status = 'failed' AND NOT ${unanswered})::int AS failed,
             count(*) FILTER (WHERE r.status = 'failed' AND ${unanswered})::int AS unanswered
      FROM workflow_runs r
      LEFT JOIN workflows w ON w.id = r.workflow_id
      WHERE r.created_at >= ${`${since}T00:00:00Z`}::timestamptz
        ${until ? sql`AND r.created_at < ${`${until}T00:00:00Z`}::timestamptz` : sql``}
        AND r.campaign_id IS NOT NULL
        AND (r.workflow_id IS NOT NULL OR r.execution_scope = ${ENGINE_EXECUTION_SCOPE})
      GROUP BY 1, 2, 3, 4, 5, 6
    `),
  );
}

/** Recount every day from `since` (inclusive) to today; the cost sample of an already costed day is kept. */
export async function recountEngineDays(db: AnyPgDb, deps: EngineMonitoringDeps, since: string, now = new Date()): Promise<number> {
  const resolve = outcomeResolver(deps);
  const totals = new Map<string, { day: string; outcome: string; path: string; orgId: string; runs: number; completed: number; failed: number; unanswered: number }>();
  for (const g of await groupedRuns(db, since, null)) {
    const outcome = g.path === "script" ? (g.engine_outcome ?? UNASSIGNED_OUTCOME) : await resolve(g.feature_slug, g.dynasty);
    const key = `${g.day}|${outcome}|${g.path}|${g.org_id}`;
    const t = totals.get(key) ?? { day: g.day, outcome, path: g.path, orgId: g.org_id, runs: 0, completed: 0, failed: 0, unanswered: 0 };
    t.runs += Number(g.runs);
    t.completed += Number(g.completed);
    t.failed += Number(g.failed);
    t.unanswered += Number(g.unanswered);
    totals.set(key, t);
  }
  for (const t of totals.values()) {
    await db
      .insert(engineMonitoringDays)
      .values({ ...t, computedAt: now })
      .onConflictDoUpdate({
        target: [engineMonitoringDays.day, engineMonitoringDays.outcome, engineMonitoringDays.path, engineMonitoringDays.orgId],
        set: { runs: t.runs, completed: t.completed, failed: t.failed, unanswered: t.unanswered, computedAt: now },
      });
  }
  return totals.size;
}

/** Read the cost sample of one completed day: up to N finished runs per outcome x path x org, one batch per org. */
export async function costEngineDay(db: AnyPgDb, deps: EngineMonitoringDeps, day: string): Promise<number> {
  const resolve = outcomeResolver(deps);
  const finished = rowsOf<{ run_id: string; path: "script" | "workflow"; org_id: string; engine_outcome: string | null; feature_slug: string | null; dynasty: string | null }>(
    await db.execute(sql`
      SELECT r.run_id, CASE WHEN r.workflow_id IS NULL THEN 'script' ELSE 'workflow' END AS path, r.org_id,
             r.inputs->>'engineOutcome' AS engine_outcome, w.feature_slug, w.workflow_dynasty_slug AS dynasty
      FROM workflow_runs r
      LEFT JOIN workflows w ON w.id = r.workflow_id
      WHERE r.created_at >= ${`${day}T00:00:00Z`}::timestamptz AND r.created_at < ${`${addDays(day, 1)}T00:00:00Z`}::timestamptz
        AND r.campaign_id IS NOT NULL AND r.run_id IS NOT NULL AND r.status IN ('completed', 'failed')
        AND (r.workflow_id IS NOT NULL OR r.execution_scope = ${ENGINE_EXECUTION_SCOPE})
      ORDER BY r.created_at DESC
    `),
  );
  const samples = new Map<string, { outcome: string; path: string; orgId: string; runIds: string[] }>();
  for (const r of finished) {
    const outcome = r.path === "script" ? (r.engine_outcome ?? UNASSIGNED_OUTCOME) : await resolve(r.feature_slug, r.dynasty);
    const key = `${outcome}|${r.path}|${r.org_id}`;
    const s = samples.get(key) ?? { outcome, path: r.path, orgId: r.org_id, runIds: [] };
    if (s.runIds.length < COST_SAMPLE_PER_GROUP) s.runIds.push(r.run_id);
    samples.set(key, s);
  }
  const byOrg = new Map<string, string[]>();
  for (const s of samples.values()) byOrg.set(s.orgId, [...(byOrg.get(s.orgId) ?? []), ...s.runIds]);
  const costs = new Map<string, number>();
  for (const [orgId, runIds] of byOrg) for (const [id, c] of await deps.runCosts(orgId, runIds)) costs.set(id, c);
  let written = 0;
  for (const s of samples.values()) {
    const known = s.runIds.filter((id) => costs.has(id));
    const cents = known.reduce((sum, id) => sum + costs.get(id)!, 0);
    await db
      .update(engineMonitoringDays)
      .set({ costSampleRuns: known.length, costSampleCents: cents.toFixed(6) })
      .where(and(eq(engineMonitoringDays.day, day), eq(engineMonitoringDays.outcome, s.outcome), eq(engineMonitoringDays.path, s.path), eq(engineMonitoringDays.orgId, s.orgId)));
    written++;
  }
  // A group with no finished run reads a zero sample (nothing to cost), so the day is never asked again.
  await db
    .update(engineMonitoringDays)
    .set({ costSampleRuns: 0, costSampleCents: "0" })
    .where(and(eq(engineMonitoringDays.day, day), isNull(engineMonitoringDays.costSampleRuns)));
  return written;
}

/** One refresh: recount the missing days of the window + yesterday + today, then cost up to 2 completed days. */
export async function refreshEngineMonitoring(db: AnyPgDb, deps: EngineMonitoringDeps, now = new Date()): Promise<{ recounted: number; costedDays: string[] }> {
  const today = dayOf(now);
  const first = addDays(today, -(ENGINE_BACKFILL_DAYS - 1));
  const stored = new Set(
    rowsOf<{ day: string }>(await db.execute(sql`SELECT DISTINCT to_char(day, 'YYYY-MM-DD') AS day FROM engine_monitoring_days WHERE day >= ${first}::date`)).map((r) => r.day),
  );
  let since = addDays(today, -1);
  for (let d = first; d < since; d = addDays(d, 1)) {
    if (!stored.has(d)) {
      since = d;
      break;
    }
  }
  const recounted = await recountEngineDays(db, deps, since, now);
  const uncosted = rowsOf<{ day: string }>(
    await db.execute(sql`
      SELECT DISTINCT to_char(day, 'YYYY-MM-DD') AS day FROM engine_monitoring_days
      WHERE cost_sample_runs IS NULL AND day < ${today}::date AND day >= ${addDays(today, -ENGINE_COST_DAYS)}::date
      ORDER BY 1 DESC
    `),
  ).map((r) => r.day);
  const costedDays: string[] = [];
  for (const day of uncosted.slice(0, COST_DAYS_PER_REFRESH)) {
    await costEngineDay(db, deps, day);
    costedDays.push(day);
  }
  return { recounted, costedDays };
}

let lastRefreshAt = 0;
let inFlight: Promise<void> | null = null;

/** At most one refresh per 15 minutes per process; never throws, never awaited by a read. */
export function maybeRefreshEngineMonitoring(db: AnyPgDb, deps: EngineMonitoringDeps, now = new Date()): Promise<void> {
  if (inFlight) return inFlight;
  if (now.getTime() - lastRefreshAt < REFRESH_EVERY_MS) return Promise.resolve();
  lastRefreshAt = now.getTime();
  inFlight = (async () => {
    try {
      const r = await refreshEngineMonitoring(db, deps, now);
      console.log(`[workflow-service] engine monitoring: recounted ${r.recounted} rows, costed ${r.costedDays.join(", ") || "no day"}`);
    } catch (err) {
      console.error(`[workflow-service] engine monitoring FAILED: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Test hook. */
export function resetEngineMonitoringMemo(): void {
  lastRefreshAt = 0;
  inFlight = null;
}

type Row = typeof engineMonitoringDays.$inferSelect;

interface PathAgg {
  runs: number;
  completed: number;
  /** The runs' own failures. */
  failed: number;
  /** Failed because a call got no answer or billing refused: never a failure of the script or workflow. */
  unanswered: number;
  /** Spend estimated from the cost sample (null when no org of the day has a sample). */
  spendCents: number | null;
  sampledRuns: number;
}

const emptyAgg = (): PathAgg => ({ runs: 0, completed: 0, failed: 0, unanswered: 0, spendCents: null, sampledRuns: 0 });

function add(agg: PathAgg, r: Row): void {
  agg.runs += r.runs;
  agg.completed += r.completed;
  agg.failed += r.failed;
  agg.unanswered += r.unanswered;
  if (r.costSampleRuns && r.costSampleRuns > 0 && r.costSampleCents !== null) {
    agg.spendCents = (agg.spendCents ?? 0) + (Number(r.costSampleCents) / r.costSampleRuns) * r.runs;
    agg.sampledRuns += r.costSampleRuns;
  }
}

/** Finished runs, the unanswered ones included (they finished, through no fault of their own). */
const finishedOf = (a: PathAgg) => a.completed + a.failed + a.unanswered;
const errorRate = (a: PathAgg) => (finishedOf(a) > 0 ? a.failed / finishedOf(a) : null);

function served(a: PathAgg | undefined) {
  if (!a) return null;
  return {
    runs: a.runs,
    completed: a.completed,
    failed: a.failed,
    unanswered: a.unanswered,
    errorRate: errorRate(a),
    spendCents: a.spendCents === null ? null : Number(a.spendCents.toFixed(4)),
    costPerRunCents: a.spendCents === null || a.runs === 0 ? null : Number((a.spendCents / a.runs).toFixed(4)),
    sampledRuns: a.sampledRuns,
  };
}

/** The served series: per Engine outcome, both paths day by day, per org over the window, and the verdict. */
export async function readEngineMonitoring(db: AnyPgDb, days: number, now = new Date()) {
  const today = dayOf(now);
  const since = addDays(today, -(days - 1));
  const rows = await db.select().from(engineMonitoringDays).where(and(gte(engineMonitoringDays.day, since), lt(engineMonitoringDays.day, addDays(today, 1))));
  const outcomes = [...new Set(rows.map((r) => r.outcome))].sort();
  const recentFrom = addDays(today, -1);
  const out = outcomes.map((outcome) => {
    const own = rows.filter((r) => r.outcome === outcome);
    const byDay = new Map<string, { script: PathAgg; workflow: PathAgg; hasScript: boolean; hasWorkflow: boolean }>();
    const byOrg = new Map<string, { script: PathAgg; workflow: PathAgg; lastWorkflowDay: string | null }>();
    const window = { script: emptyAgg(), workflow: emptyAgg() };
    const recentScript = emptyAgg();
    for (const r of own) {
      const d = byDay.get(r.day) ?? { script: emptyAgg(), workflow: emptyAgg(), hasScript: false, hasWorkflow: false };
      const path = r.path === "script" ? "script" : "workflow";
      add(d[path], r);
      if (path === "script") d.hasScript = true;
      else d.hasWorkflow = true;
      byDay.set(r.day, d);
      const o = byOrg.get(r.orgId) ?? { script: emptyAgg(), workflow: emptyAgg(), lastWorkflowDay: null };
      add(o[path], r);
      if (path === "workflow" && r.runs > 0 && (!o.lastWorkflowDay || r.day > o.lastWorkflowDay)) o.lastWorkflowDay = r.day;
      byOrg.set(r.orgId, o);
      add(window[path], r);
      if (path === "script" && r.day >= recentFrom) add(recentScript, r);
    }
    const scriptRate = errorRate(recentScript);
    const workflowRate = errorRate(window.workflow);
    const threshold = workflowRate === null ? RED_FLOOR : workflowRate + RED_NOISE;
    const finished = finishedOf(recentScript);
    const red = finished >= RED_MIN_RUNS && scriptRate !== null && scriptRate > threshold;
    const todayRow = byDay.get(today);
    const lastWorkflowDay = [...byDay.entries()].filter(([, d]) => d.workflow.runs > 0).map(([day]) => day).sort().at(-1) ?? null;
    return {
      outcome,
      red,
      verdict: { scriptErrorRate: scriptRate, scriptFinishedRuns: finished, workflowErrorRate: workflowRate, thresholdErrorRate: threshold },
      /** Still ran on a workflow today: a normal "not yet", never red. */
      onWorkflow: (todayRow?.workflow.runs ?? 0) > 0,
      lastWorkflowDay,
      window: { script: served(window.script), workflow: served(window.workflow) },
      days: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, d]) => ({ day, script: served(d.script), workflow: served(d.workflow) })),
      orgs: [...byOrg.entries()]
        .map(([orgId, o]) => ({ orgId, script: served(o.script), workflow: served(o.workflow), lastWorkflowDay: o.lastWorkflowDay }))
        .sort((a, b) => (b.workflow?.runs ?? 0) - (a.workflow?.runs ?? 0) || (b.script?.runs ?? 0) - (a.script?.runs ?? 0)),
    };
  });
  return { since, minRunsForRed: RED_MIN_RUNS, outcomes: out };
}

/** Production reads: features-service (legs, catalogue) and runs-service (subtree costs, per org, time-boxed). */
export function productionEngineMonitoringDeps(): EngineMonitoringDeps {
  return {
    async legsOf(featureSlug) {
      const { listLegAssignments } = await import("../catalogue-client.js");
      return (await listLegAssignments(featureSlug)).map((a) => ({ workflowDynastySlug: a.workflowDynastySlug, legKey: a.legKey, state: a.state, decidedAt: a.decidedAt }));
    },
    async toStepOf(pipeId) {
      const { fetchPipe } = await import("../catalogue-client.js");
      return (await fetchPipe(pipeId)).toStep;
    },
    async runCosts(orgId, runIds) {
      const base = (process.env.RUNS_SERVICE_URL ?? "").replace(/\/$/, "");
      const key = process.env.RUNS_SERVICE_API_KEY ?? "";
      if (!base || !key) throw new Error("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be set");
      const out = new Map<string, number>();
      for (let i = 0; i < runIds.length; i += 100) {
        const res = await fetch(`${base}/v1/runs/costs/batch`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key, "x-org-id": orgId },
          body: JSON.stringify({ runIds: runIds.slice(i, i + 100) }),
          signal: AbortSignal.timeout(600_000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`runs-service POST /v1/runs/costs/batch (org ${orgId}) -> ${res.status}: ${text.slice(0, 200)}`);
        for (const c of (JSON.parse(text) as { costs: Array<{ runId: string; totalCostInUsdCents: string }> }).costs) out.set(c.runId, Number(c.totalCostInUsdCents));
      }
      return out;
    },
  };
}

let context: { db: AnyPgDb; deps: EngineMonitoringDeps } | null = null;
export function setEngineMonitoringContext(c: { db: AnyPgDb; deps: EngineMonitoringDeps } | null): void {
  context = c;
}
/** Rides workflow traffic (`noteWorkflowWrite`): at most one refresh per 15 minutes, never awaited. */
export function noteEngineMonitoring(): void {
  if (context) void maybeRefreshEngineMonitoring(context.db, context.deps);
}
