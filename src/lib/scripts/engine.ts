/**
 * MIGRATE-1105 S0 (owner 2026-11-05: « IL FAUT MIGRER »): a campaign's next outcome is made by its ENGINE, with no
 * workflow. Two things live here, one for every Engine (never a branch on an outcome, a channel or a client):
 *
 * 1. WHETHER an Engine runs campaigns. A switch row in `script_switches`, caller `campaign` (the same table, guard and
 *    Monitoring as every other switch: the roll-back guard marks it `rolled_back` like a service switch), for ONE org
 *    first (`org_id`) then for every org (`org_id` null): a client is switched only on proof. An org's own row wins
 *    over the fleet row, so one client can be held back or let in alone. Proof: an org switch needs a runnable script
 *    of the Engine (a port runs only when it replays 100 % of its recorded cases, as every run already demands); a
 *    fleet switch needs a PROVEN PORT (recorded cases, 100 %), like every service switch.
 *
 * 2. THE RATING: which script runs, among every live dynasty of the Engine (one active version per dynasty, so the pick
 *    is a dynasty and its head runs). Only a script the run can feed is a candidate: every material its code asks for
 *    (`ctx.get(...)`, read from the code) is one the run holds, a tactic `channel` it states is the campaign's, and the
 *    campaign's STRATEGY keeps it (features-service judges each script's tactics, `GET /internal/script-strategy`).
 *    Thompson sampling on the share of a dynasty's runs that made a Unit (Beta(1 + made, 1 + not made), its runs of the
 *    last 30 days pooled across versions, docs/framework.md §8): a dynasty with little data draws wide and gets tried.
 *    Cost per Unit is not yet in the score (runs-service holds it, per task `script:<outcome>/<dynasty>`): the day it
 *    is, this function is the one place that changes.
 */
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { scriptRuns, scriptSwitches, scripts, type ScriptRow } from "../../db/schema.js";
import { activeVersion, caseCount, type AnyPgDb } from "./script-catalogue.js";
import { SwitchError } from "./script-writer-switch.js";

/** The caller a campaign Engine switch is recorded under. */
export const CAMPAIGN_CALLER = "campaign";
/** The outcome of a proactive campaign's start: nothing to push, the script finds its own subject. */
export const START_OUTCOME = "start";
export const RATING_WINDOW_DAYS = 30;

export interface EngineState {
  outcome: string;
  orgId: string | null;
  live: boolean;
  /** Which row decides: the org's own, the fleet's, or none. */
  scope: "org" | "fleet" | null;
  /** The dynasty the switch was proven on (the Rating picks among every candidate at run time). */
  provenOn: string | null;
  switchedAt: string | null;
  rolledBackAt: string | null;
  rollbackReason: string | null;
}

/** Whether `outcome`'s Engine runs the campaigns of `orgId` (its own latest row, else the fleet's latest row). */
export async function engineState(db: AnyPgDb, outcome: string, orgId: string | null): Promise<EngineState> {
  const rows = await db
    .select()
    .from(scriptSwitches)
    .where(
      and(
        eq(scriptSwitches.outcome, outcome),
        eq(scriptSwitches.callerService, CAMPAIGN_CALLER),
        orgId ? or(eq(scriptSwitches.orgId, orgId), isNull(scriptSwitches.orgId)) : isNull(scriptSwitches.orgId),
      ),
    )
    .orderBy(desc(scriptSwitches.switchedAt));
  const own = orgId ? rows.find((r) => r.orgId === orgId) : undefined;
  const fleet = rows.find((r) => r.orgId === null);
  const deciding = own ?? fleet;
  return {
    outcome,
    orgId,
    live: deciding?.state === "switched",
    scope: own ? "org" : fleet ? "fleet" : null,
    provenOn: deciding?.dynasty ?? null,
    switchedAt: deciding?.switchedAt?.toISOString() ?? null,
    rolledBackAt: deciding?.rolledBackAt?.toISOString() ?? null,
    rollbackReason: deciding?.rollbackReason ?? null,
  };
}

/** A port runs only when it replays 100 % of its recorded cases; a script with no case is not a port. */
async function provenness(db: AnyPgDb, row: ScriptRow): Promise<{ runnable: boolean; port: boolean }> {
  const cases = await caseCount(db, row.outcome, row.dynasty);
  if (cases === 0) return { runnable: true, port: false };
  const proven = !!row.replay && row.replay.cases === cases && row.replay.matches === cases;
  return { runnable: proven, port: proven };
}

/** Switch an Engine on for campaigns: one org (`orgId`), or every org (a proven port). Idempotent while live. */
export async function switchEngine(db: AnyPgDb, input: { outcome: string; dynasty: string; orgId?: string | null }) {
  const orgId = input.orgId ?? null;
  const row = await activeVersion(db, input.outcome, input.dynasty);
  if (!row || row.dynastyStatus !== "active") throw new SwitchError(404, `no live version of ${input.outcome}/${input.dynasty}`);
  const proof = await provenness(db, row);
  if (!proof.runnable) throw new SwitchError(409, `${input.outcome}/${input.dynasty}/v${row.version} is a port not proven on all its recorded cases: it cannot run`);
  if (!orgId && !proof.port) {
    throw new SwitchError(409, `every client is switched only on a proven port (recorded cases replayed 100 %): ${input.outcome}/${input.dynasty} carries none; switch one org first`);
  }
  const scope = and(
    eq(scriptSwitches.outcome, input.outcome),
    eq(scriptSwitches.callerService, CAMPAIGN_CALLER),
    orgId ? eq(scriptSwitches.orgId, orgId) : isNull(scriptSwitches.orgId),
  );
  const [live] = await db.select().from(scriptSwitches).where(and(scope, eq(scriptSwitches.state, "switched")));
  if (live) return live;
  const [created] = await db
    .insert(scriptSwitches)
    .values({ outcome: input.outcome, dynasty: input.dynasty, callerService: CAMPAIGN_CALLER, orgId, scriptVersion: row.version, fromVersion: 0, toVersion: row.version })
    .returning();
  return created!;
}

/** Switch an Engine off for campaigns (one org's row, or the fleet row): its campaigns go back to their workflow. */
export async function switchEngineOff(db: AnyPgDb, input: { outcome: string; orgId?: string | null; reason: string }) {
  const orgId = input.orgId ?? null;
  return db
    .update(scriptSwitches)
    .set({ state: "rolled_back", rolledBackAt: new Date(), rollbackReason: input.reason })
    .where(
      and(
        eq(scriptSwitches.outcome, input.outcome),
        eq(scriptSwitches.callerService, CAMPAIGN_CALLER),
        eq(scriptSwitches.state, "switched"),
        orgId ? eq(scriptSwitches.orgId, orgId) : isNull(scriptSwitches.orgId),
      ),
    )
    .returning();
}

export interface PickInput {
  outcome: string;
  /** The outcomes the run holds a Unit of (its materials): a candidate asks for none other. */
  servable: string[];
  /** The campaign's channel: a script stating a tactic `channel` runs only for it. */
  channel: string | null;
  /**
   * The campaign the run is for: its STRATEGY keeps only some of the Engine's scripts (features-service, the one place
   * that holds strategies and judges each script's tactics, S0-STRATEGY). Absent/null = not a campaign run: no strategy.
   */
  campaignId?: string | null;
  /**
   * The dynasties a strategy keeps, already read by a caller with no campaign (PREVIEW-RATING-PICK-1111:
   * content-generation's preview asks features-service for a strategy's kept scripts itself). Stated = it replaces the
   * campaign read; the Rating then picks among them exactly as a run does.
   */
  keptDynasties?: string[];
  /**
   * The Units an ASKING script handed (`ctx.ask`, LISTICLE-OUTREACH-1110): the work it ordered. Among the candidates,
   * only those reading the most of them serve the ask (`readersOfHanded`); absent / none read = every candidate.
   */
  handed?: string[];
}

/**
 * PURE (LISTICLE-OUTREACH-1110): an asked Engine serves the ask with the scripts that READ what the asker handed. A
 * script whose code reads none of it (it serves people, or reads its occurrence off the Request) answers a different
 * question: the outreach script hands a found address + a written email to the email Engine, and a cold email script
 * that serves its own audience must not answer that ask. Scripts reading more of the handed Units win; when no
 * candidate reads any (an ask handing occurrences a script reads off its Request), nothing is narrowed.
 */
export function readersOfHanded<T extends { materials: string[] | null }>(candidates: T[], handed: readonly string[] | undefined): T[] {
  if (!handed || handed.length === 0) return candidates;
  const read = (c: T) => (c.materials ?? []).filter((m) => handed.includes(m)).length;
  const best = Math.max(0, ...candidates.map(read));
  return best === 0 ? candidates : candidates.filter((c) => read(c) === best);
}

/** The script dynasties a campaign's strategy keeps for one Engine. Throws when it cannot be read (fail closed). */
export type ScriptStrategyReader = (campaignId: string, outcome: string) => Promise<string[]>;

/** features-service `GET /internal/script-strategy`: unreadable = throws, the run runs nothing and is retried. */
export const productionScriptStrategy: ScriptStrategyReader = async (campaignId, outcome) => {
  const base = (process.env.FEATURES_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.FEATURES_SERVICE_API_KEY ?? "";
  if (!base || !key) throw new Error("FEATURES_SERVICE_URL and FEATURES_SERVICE_API_KEY must be set to read a campaign's strategy");
  const res = await fetch(`${base}/internal/script-strategy?campaignId=${encodeURIComponent(campaignId)}&outcome=${encodeURIComponent(outcome)}`, {
    headers: { "x-api-key": key },
    signal: AbortSignal.timeout(600_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`the scripts campaign ${campaignId}'s strategy keeps for ${outcome} could not be read (features-service ${res.status}): ${text.slice(0, 300)}`);
  const kept = (JSON.parse(text) as { keptDynasties?: unknown }).keptDynasties;
  if (!Array.isArray(kept)) throw new Error(`features-service answered no keptDynasties for campaign ${campaignId} x ${outcome}`);
  return kept.map(String);
};

let scriptStrategy: ScriptStrategyReader = productionScriptStrategy;
/** Tests swap the reader. */
export function setScriptStrategyReader(r: ScriptStrategyReader | null): void {
  scriptStrategy = r ?? productionScriptStrategy;
}

export interface Pick {
  script: ScriptRow;
  /** Every candidate and its draw, for the run's log. */
  draws: Array<{ dynasty: string; version: number; made: number; runs: number; draw: number }>;
}

/** The scripts of an Engine this run can run (fed by its materials, its channel, proven when a port). */
export async function candidatesOf(db: AnyPgDb, input: PickInput): Promise<ScriptRow[]> {
  const rows = await db
    .select()
    .from(scripts)
    .where(and(eq(scripts.outcome, input.outcome), eq(scripts.status, "active"), eq(scripts.dynastyStatus, "active")));
  // Read only when there is something to narrow; unreadable throws (never "any script").
  const kept = input.keptDynasties
    ? new Set(input.keptDynasties)
    : input.campaignId && rows.length > 0
      ? new Set(await scriptStrategy(input.campaignId, input.outcome))
      : null;
  const out: ScriptRow[] = [];
  for (const row of rows) {
    if (kept && !kept.has(row.dynasty)) continue;
    // A material the script ASKS another Engine for (tactic `asks`: `ctx.ask(request)` then `ctx.get(<outcome>)`, a
    // child run of that Engine) is not one the run must hold.
    const asks = (row.tactics as Record<string, unknown>)?.asks;
    const provided = Array.isArray(asks) ? asks.filter((a): a is string => typeof a === "string") : [];
    if (!(row.materials ?? []).every((m) => input.servable.includes(m) || provided.includes(m))) continue;
    const channel = (row.tactics as Record<string, unknown>)?.channel;
    if (typeof channel === "string" && channel !== input.channel) continue;
    if (!(await provenness(db, row)).runnable) continue;
    out.push(row);
  }
  return out;
}

/**
 * Whether ANY live script of the Engine can run for a campaign of `channel` (its tactic `channel` is that one, or it
 * states none), whatever materials a run holds. An Engine switched on for an org takes every campaign of that org
 * whose leg reaches the outcome; a campaign no script of the Engine serves is not the Engine's yet: it keeps its
 * workflow (`engine_not_live`) instead of ending idle forever (MIGRATE-1105 S4: one org runs campaigns of several
 * channels on one outcome, migrated one at a time).
 */
export async function servesChannel(db: AnyPgDb, outcome: string, channel: string | null, campaignId?: string | null): Promise<boolean> {
  const rows = await db
    .select()
    .from(scripts)
    .where(and(eq(scripts.outcome, outcome), eq(scripts.status, "active"), eq(scripts.dynastyStatus, "active")));
  // A campaign whose STRATEGY keeps none of them keeps its workflow too, never an idle Engine (unreadable throws).
  const kept = campaignId && rows.length > 0 ? new Set(await scriptStrategy(campaignId, outcome)) : null;
  for (const row of rows) {
    if (kept && !kept.has(row.dynasty)) continue;
    const stated = (row.tactics as Record<string, unknown>)?.channel;
    if (typeof stated === "string" && stated !== channel) continue;
    if ((await provenness(db, row)).runnable) return true;
  }
  return false;
}

/** The Rating's pick for one run (null: no script of this Engine can run on what this run holds). */
export async function pickScript(db: AnyPgDb, input: PickInput, random: () => number = Math.random): Promise<Pick | null> {
  const candidates = readersOfHanded(await candidatesOf(db, input), input.handed);
  if (candidates.length === 0) return null;
  const dynasties = candidates.map((c) => c.dynasty);
  const since = new Date(Date.now() - RATING_WINDOW_DAYS * 86_400_000);
  // A dynasty's runs pooled across its versions, those it made under the outcome it was re-homed from included
  // (MIGRATE-1105 S5: an upgrade onto the fine outcome keeps its record).
  const outcomes = [...new Set([input.outcome, ...(await upgradedFromOutcomes(db, candidates))])];
  const stats = await db
    .select({
      dynasty: scripts.dynasty,
      made: sql<number>`count(*) filter (where ${scriptRuns.status} = 'made')::int`,
      runs: sql<number>`count(*) filter (where ${scriptRuns.status} <> 'running')::int`,
    })
    .from(scriptRuns)
    .innerJoin(scripts, eq(scripts.id, scriptRuns.scriptId))
    .where(and(inArray(scripts.outcome, outcomes), inArray(scripts.dynasty, dynasties), gte(scriptRuns.createdAt, since)))
    .groupBy(scripts.dynasty);
  const by = new Map(stats.map((s) => [s.dynasty, { made: Number(s.made), runs: Number(s.runs) }]));
  const draws = candidates.map((c) => {
    const s = by.get(c.dynasty) ?? { made: 0, runs: 0 };
    return { dynasty: c.dynasty, version: c.version, made: s.made, runs: s.runs, draw: sampleBeta(1 + s.made, 1 + Math.max(0, s.runs - s.made), random) };
  });
  let best = 0;
  for (let i = 1; i < draws.length; i++) if (draws[i]!.draw > draws[best]!.draw) best = i;
  return { script: candidates[best]!, draws };
}

/** The outcomes the candidates' dynasties were upgraded from (their upgrade chain, never across a fork). */
async function upgradedFromOutcomes(db: AnyPgDb, candidates: ScriptRow[]): Promise<string[]> {
  const out = new Set<string>();
  for (const c of candidates) {
    let row: { creationType: string; createdFromScript: string | null; dynasty: string } = c;
    for (let hops = 0; hops < 50 && row.creationType === "upgrade" && row.createdFromScript; hops++) {
      const [parent] = await db
        .select({ outcome: scripts.outcome, dynasty: scripts.dynasty, creationType: scripts.creationType, createdFromScript: scripts.createdFromScript })
        .from(scripts)
        .where(eq(scripts.id, row.createdFromScript));
      if (!parent || parent.dynasty !== c.dynasty) break;
      out.add(parent.outcome);
      row = parent;
    }
  }
  return [...out];
}

/** One draw from Beta(a, b), through two Gamma draws (Marsaglia & Tsang 2000). */
export function sampleBeta(a: number, b: number, random: () => number = Math.random): number {
  const x = sampleGamma(a, random);
  const y = sampleGamma(b, random);
  return x + y === 0 ? 0.5 : x / (x + y);
}

function sampleGamma(k: number, random: () => number): number {
  if (k < 1) return sampleGamma(k + 1, random) * Math.pow(random() || Number.MIN_VALUE, 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(random);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random() || Number.MIN_VALUE;
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normal(random: () => number): number {
  const u = random() || Number.MIN_VALUE;
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
