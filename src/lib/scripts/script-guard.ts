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
import { SERVICE_DOOR_VENDORS } from "./vendors.js";
import { CAMPAIGN_CALLER } from "./engine.js";

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
  /**
   * Failures of a kind the old path ALSO suffers (the same upstream call failing in the workflows' own runs over the
   * last SHARED_FAILURE_DAYS): counted apart, never a script error (see `sharedFailureKinds`).
   */
  shared?: number;
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

/**
 * A failure's KIND = the upstream call that failed, named the way the old path names it (`POST lead/orgs/buffer/next`):
 * a script's error starts with the door it called (`lead.serve: Lead serve setup failed`), a workflow run's
 * `failed_reason` with the call (`POST lead/orgs/buffer/next failed (500): ...`).
 * INCIDENT 2026-11-06 16:52 UTC: 4 lead-service serve timeouts (human-service held every serve of one org behind a stuck
 * re-decision) rolled the cold-email Engine back for every org, while the old workflows failed the SAME serve the same
 * way (153 times in 7 days). A failure both paths share says nothing about the script: it is counted apart, like a
 * billing refusal. A failure only the script has (a call the old path never failed, a throw in its own code) stays an
 * error.
 */
export function scriptFailureKind(error: string | null | undefined): string | null {
  const door = /^([a-z0-9_]+(?:\.[a-z0-9_]+)+):/i.exec(error ?? "")?.[1];
  const d = door ? SERVICE_DOOR_VENDORS[door] : undefined;
  return d ? `${d.method} ${d.service}${d.path}` : null;
}

export const workflowFailureKind = (reason: string | null | undefined): string | null =>
  /^((?:GET|POST|PUT|PATCH|DELETE) \S+) failed\b/.exec(reason ?? "")?.[1] ?? null;

/** How far back the old path's own failures are read, and how long that read is kept (it scans the failed runs). */
export const SHARED_FAILURE_DAYS = 7;
const SHARED_KINDS_TTL_MS = 30 * 60_000;
let sharedKindsMemo = new WeakMap<object, { at: number; kinds: Set<string> }>();

/** The upstream calls the old path's workflow runs failed at over the last SHARED_FAILURE_DAYS (read at most every 30 min). */
export async function sharedFailureKinds(db: AnyPgDb, now = new Date()): Promise<Set<string>> {
  const memo = sharedKindsMemo.get(db as object);
  if (memo && now.getTime() - memo.at < SHARED_KINDS_TTL_MS) return memo.kinds;
  const since = new Date(now.getTime() - SHARED_FAILURE_DAYS * 86_400_000);
  const rows = await db
    .selectDistinct({ kind: sql<string | null>`substring(${workflowRuns.failedReason} from '^(?:GET|POST|PUT|PATCH|DELETE) [^ ]+')` })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.status, "failed"), gte(workflowRuns.createdAt, since)));
  const kinds = new Set(rows.map((r: { kind: string | null }) => r.kind).filter((k: string | null): k is string => !!k));
  sharedKindsMemo.set(db as object, { at: now.getTime(), kinds });
  return kinds;
}

/**
 * WHOSE runs judge a switch (MIGRATE-1105 S6, INCIDENT 2026-11-07 19:46 UTC: 6 failures in three orgs rolled the cold
 * email Engine back for SIX orgs, two of which had not failed once, and the instantly send switch with them): a campaign
 * Engine switch for one org is judged on that org's runs only; a service switch on its own dynasty's runs (and its org
 * when it names one); an org-less campaign switch on every run of the Engine.
 */
export interface GuardScope {
  orgId?: string | null;
  dynasty?: string | null;
}
export const scopeOfSwitch = (sw: Pick<typeof scriptSwitches.$inferSelect, "callerService" | "orgId" | "dynasty">): GuardScope =>
  sw.callerService && sw.callerService !== CAMPAIGN_CALLER ? { dynasty: sw.dynasty, orgId: sw.orgId ?? null } : { orgId: sw.orgId ?? null };
const scopeKey = (s: GuardScope) => `${s.orgId ?? "*"}|${s.dynasty ?? "*"}`;
const scopeLabel = (s: GuardScope) => [s.orgId ? `org ${s.orgId}` : null, s.dynasty ? `dynasty ${s.dynasty}` : null].filter(Boolean).join(", ") || "every org";

/**
 * A call that got NO answer (undici's `fetch failed`: the host refused, reset or timed out the connection) is the box's
 * or the network's, never the script's code: counted apart like a failure the old path shares (2026-11-07 19:46: three
 * of the six counted failures were `ctx.get(message_written): fetch failed`, during a box load spike).
 */
export const NO_ANSWER_PATTERN = "fetch failed";
const noAnswer = (error: string | null | undefined) => !!error && error.toLowerCase().includes(NO_ANSWER_PATTERN);

export async function lastHour(db: AnyPgDb, outcome: string, now = new Date(), scope: GuardScope = {}): Promise<WindowStats> {
  const since = new Date(now.getTime() - WINDOW_MINUTES * 60_000);
  const scoped = and(
    eq(scripts.outcome, outcome),
    gte(scriptRuns.createdAt, since),
    ...(scope.orgId ? [eq(scriptRuns.orgId, scope.orgId)] : []),
    ...(scope.dynasty ? [eq(scripts.dynasty, scope.dynasty)] : []),
  );
  const [row] = await db
    .select({
      runs: sql<number>`count(*) filter (where ${scriptRuns.status} <> 'running')::int`,
      failed: sql<number>`count(*) filter (where ${scriptRuns.status} in ('failed', 'stopped') and not ${billingRefused(scriptRuns.error)})::int`,
      unmade: sql<number>`count(*) filter (where ${scriptRuns.status} = 'unmade' or (${scriptRuns.status} in ('failed', 'stopped') and ${billingRefused(scriptRuns.error)}))::int`,
    })
    .from(scriptRuns)
    .innerJoin(scripts, eq(scripts.id, scriptRuns.scriptId))
    .where(scoped);
  const runs = Number(row?.runs ?? 0);
  let failed = Number(row?.failed ?? 0);
  let shared = 0;
  if (failed > 0) {
    const errors = await db
      .select({ error: scriptRuns.error })
      .from(scriptRuns)
      .innerJoin(scripts, eq(scripts.id, scriptRuns.scriptId))
      .where(and(scoped, sql`${scriptRuns.status} in ('failed', 'stopped')`, sql`not ${billingRefused(scriptRuns.error)}`));
    const answered = errors.filter((e: { error: string | null }) => !noAnswer(e.error));
    shared = errors.length - answered.length;
    const kinds = answered.map((e: { error: string | null }) => scriptFailureKind(e.error));
    if (kinds.some((k: string | null) => k !== null)) {
      const old = await sharedFailureKinds(db, now);
      shared += kinds.filter((k: string | null) => k !== null && old.has(k)).length;
    }
    failed -= shared;
  }
  return { runs, failed, errorRate: runs > 0 ? failed / runs : null, unmade: Number(row?.unmade ?? 0), shared };
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

/** The scope of a campaign Engine run in `workflow_runs` (engine-runner.ts ENGINE_EXECUTION_SCOPE). */
const ENGINE_SCOPE = "engine";

/**
 * The campaigns a campaign Engine switch would STRAND if rolled back: those its Engine ran for over the last
 * SHARED_FAILURE_DAYS whose old path cannot run (no workflow run of theirs ever, or the dynasty of their last workflow
 * has no active version left). INCIDENT 2026-11-06 18:05 UTC: the guard rolled lead_found back for every org onto
 * sourcing workflows deprecated (their code deleted) on 11-05: sourcing ran 0 times fleet-wide for 3 hours. A roll-back
 * onto nothing is no safety net: the switch stays, the failure is red on Monitoring (the guard verdict stays red while
 * the switch is watched), never an idle campaign.
 */
export async function campaignsWithoutOldPath(db: AnyPgDb, outcome: string, orgId: string | null, now = new Date()): Promise<string[]> {
  const since = new Date(now.getTime() - SHARED_FAILURE_DAYS * 86_400_000);
  const rows = await db.execute(sql`
    with engine_campaigns as (
      select distinct campaign_id from workflow_runs
      where execution_scope = ${ENGINE_SCOPE} and inputs->>'engineOutcome' = ${outcome} and campaign_id is not null
        and created_at >= ${since.toISOString()}::timestamptz ${orgId ? sql`and org_id = ${orgId}` : sql``}
    ),
    last_workflow as (
      select distinct on (r.campaign_id) r.campaign_id, w.workflow_dynasty_slug
      from workflow_runs r join workflows w on w.id = r.workflow_id
      where r.campaign_id in (select campaign_id from engine_campaigns)
      order by r.campaign_id, r.created_at desc
    )
    select e.campaign_id from engine_campaigns e left join last_workflow l on l.campaign_id = e.campaign_id
    where l.workflow_dynasty_slug is null or not exists (
      select 1 from workflows a where a.workflow_dynasty_slug = l.workflow_dynasty_slug and a.status = 'active' and a.workflow_dynasty_status = 'active'
    )
    order by 1`);
  const list = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as Array<{ campaign_id: string }>;
  return list.map((r) => r.campaign_id);
}

/**
 * Re-activate the previous version of every switched dynasty of `outcome` and deprecate the script version, one
 * transaction per dynasty (the active version is flipped BEFORE the previous one goes live: one active per dynasty).
 * A SERVICE switch (script-service-switch.ts) is only marked rolled_back: its caller reads that and runs its own code.
 */
export async function rollBackSwitches(
  db: AnyPgDb,
  deps: RollbackDeps,
  outcome: string,
  reasonAll: string,
  decidedBy: string,
  /** Only these dynasties (a drill, a manual roll-back); default every switched one. */
  onlyDynasties?: string[],
  /** The automatic guard: a campaign Engine switch whose old path cannot run for one of its campaigns stays switched. */
  opts: { holdStranded?: boolean; onlyIds?: string[]; reasonOf?: (sw: typeof scriptSwitches.$inferSelect) => string } = {},
): Promise<RollbackResult> {
  const all = await db.select().from(scriptSwitches).where(and(eq(scriptSwitches.outcome, outcome), eq(scriptSwitches.state, "switched")));
  const named = onlyDynasties ? all.filter((r) => onlyDynasties.includes(switchLabel(r))) : all;
  const rows = opts.onlyIds ? named.filter((r) => opts.onlyIds!.includes(r.id)) : named;
  const out: RollbackResult = { rolledBack: [], skipped: [] };
  for (const sw of rows) {
    const reason = opts.reasonOf ? opts.reasonOf(sw) : reasonAll;
    if (sw.callerService === CAMPAIGN_CALLER && opts.holdStranded) {
      const stranded = await campaignsWithoutOldPath(db, outcome, sw.orgId ?? null);
      if (stranded.length > 0) {
        const why = `held switched: the old path cannot run for ${stranded.length} campaign(s) (${stranded.slice(0, 3).join(", ")}${stranded.length > 3 ? ", ..." : ""}); red on Monitoring`;
        console.error(`[workflow-service] script guard: ${outcome} ${switchLabel(sw)} org=${sw.orgId ?? "every org"} would roll back (${reason}) but ${why}`);
        out.skipped.push({ workflowDynastySlug: switchLabel(sw), reason: why });
        continue;
      }
    }
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
  // Each live switch is judged on ITS OWN runs (scopeOfSwitch); the fleet window is served beside it.
  const liveRows = await db.select().from(scriptSwitches).where(and(eq(scriptSwitches.outcome, outcome), eq(scriptSwitches.state, "switched")));
  const scopes = new Map<string, { scope: GuardScope; ids: string[] }>();
  for (const sw of liveRows) {
    const scope = scopeOfSwitch(sw);
    const k = scopeKey(scope);
    scopes.set(k, { scope, ids: [...(scopes.get(k)?.ids ?? []), sw.id] });
  }
  const failing: Array<{ ids: string[]; reason: string; window: WindowStats; pValue: number | null }> = [];
  for (const { scope, ids } of scopes.values()) {
    const sw = scopeKey(scope) === scopeKey({}) ? w : await lastHour(db, outcome, now, scope);
    const v = shouldRollBack(sw, baseline.errorRate);
    if (!v.rollBack) continue;
    failing.push({
      ids,
      window: sw,
      pValue: v.pValue,
      reason:
        `the stored script's error rate on ${outcome} was ${(100 * sw.errorRate!).toFixed(1)} % over the last ${WINDOW_MINUTES} minutes for ${scopeLabel(scope)} ` +
        `(${sw.failed} of ${sw.runs} runs${sw.shared ? `; ${sw.shared} more failed at a call the old path also fails or that got no answer, not counted` : ""}), above ${(100 * thresholdFor(baseline.errorRate)).toFixed(1)} % and above the service path's ${(100 * baseline.errorRate).toFixed(1)} % ` +
        `${baseline.source} baseline beyond chance (p = ${v.pValue!.toExponential(1)})`,
    });
  }
  const verdict = failing.length > 0 ? { rollBack: true, pValue: failing[0]!.pValue } : shouldRollBack({ ...w, failed: 0, errorRate: 0 }, baseline.errorRate);
  if (failing.length === 0) {
    const flows = await workflowWindow(db, outcome, now);
    const flowVerdict = flows ? shouldRollBack(flows.window, flows.baseline.errorRate) : { rollBack: false, pValue: null };
    if (!flows || !flowVerdict.rollBack) return { checked: true as const, window: w, rollBack: false, pValue: verdict.pValue, workflows: flows?.window ?? null, result: null };
    const flowReason =
      `the switched workflows failed ${(100 * flows.window.errorRate!).toFixed(1)} % of their runs at the switched steps over the last ${WINDOW_MINUTES} minutes ` +
      `(${flows.window.failed} of ${flows.window.runs}, at ${flows.steps.join("/")}), above ${(100 * thresholdFor(flows.baseline.errorRate)).toFixed(1)} % and above their previous versions' ` +
      `${(100 * flows.baseline.errorRate).toFixed(1)} % ${flows.baseline.source} rate beyond chance (p = ${flowVerdict.pValue!.toExponential(1)})`;
    const result = await rollBackSwitches(db, deps, outcome, flowReason, "workflow-service script guard", undefined, { holdStranded: true });
    return { checked: true as const, window: w, ...flowVerdict, workflows: flows.window, result };
  }
  const reasonById = new Map(failing.flatMap((f) => f.ids.map((id) => [id, f.reason] as const)));
  const result = await rollBackSwitches(db, deps, outcome, failing[0]!.reason, "workflow-service script guard", undefined, {
    holdStranded: true,
    onlyIds: [...reasonById.keys()],
    reasonOf: (sw) => reasonById.get(sw.id)!,
  });
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
  sharedKindsMemo = new WeakMap();
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
