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
 *    WHICH candidate runs is features-service's Rating (SCRIPT-VALUE-RATING-1113-WF2, owner 2026-11-13: « un pick =
 *    toujours un script »): `GET /internal/script-pick?outcome=&dynasties=` draws once among the candidates on the value
 *    their runs' chains reached per dollar; its order is the run's fall-through order. Unreadable = throws: the run
 *    makes nothing and is retried, never a default script. No rating rule lives here.
 */
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { scriptSwitches, scripts, type ScriptRow } from "../../db/schema.js";
import { activeVersion, caseCount, type AnyPgDb } from "./script-catalogue.js";
import { SwitchError } from "./script-writer-switch.js";

/** The caller a campaign Engine switch is recorded under. */
export const CAMPAIGN_CALLER = "campaign";
/** The outcome of a proactive campaign's start: nothing to push, the script finds its own subject. */
export const START_OUTCOME = "start";

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

/** A dynasty whose first version was created from scratch (its upgrade chain, re-homes included, never a fork) and holds no case. */
async function bornFromScratch(db: AnyPgDb, row: ScriptRow): Promise<boolean> {
  if ((await caseCount(db, row.outcome, row.dynasty)) > 0) return false;
  let cur: { creationType: string; createdFromScript: string | null; dynasty: string } = row;
  for (let hops = 0; hops < 200 && cur.creationType === "upgrade" && cur.createdFromScript; hops++) {
    const [parent] = await db
      .select({ creationType: scripts.creationType, createdFromScript: scripts.createdFromScript, dynasty: scripts.dynasty })
      .from(scripts)
      .where(eq(scripts.id, cur.createdFromScript));
    if (!parent || parent.dynasty !== row.dynasty) return false;
    cur = parent;
  }
  return cur.creationType === "scratch";
}

/** Switch an Engine on for campaigns: one org (`orgId`), or every org (a proven port). Idempotent while live. */
export async function switchEngine(db: AnyPgDb, input: { outcome: string; dynasty: string; orgId?: string | null }) {
  const orgId = input.orgId ?? null;
  const row = await activeVersion(db, input.outcome, input.dynasty);
  if (!row || row.dynastyStatus !== "active") throw new SwitchError(404, `no live version of ${input.outcome}/${input.dynasty}`);
  const proof = await provenness(db, row);
  if (!proof.runnable) throw new SwitchError(409, `${input.outcome}/${input.dynasty}/v${row.version} is a port not proven on all its recorded cases: it cannot run`);
  // Every client: a proven PORT (it must reproduce production code case for case), or a script CREATED FROM SCRATCH that
  // carries no recorded case (no production code to reproduce: the Rating explores it, the roll-back guard watches it;
  // SCRIPT-VALUE-RATING-1113-WF1, features-service/brussels for the owner). A fork or a port without its proof keeps the rule.
  if (!orgId && !proof.port && !(await bornFromScratch(db, row))) {
    throw new SwitchError(409, `every client is switched only on a proven port (recorded cases replayed 100 %) or a script created from scratch: ${input.outcome}/${input.dynasty} is neither; switch one org first`);
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

/** features-service's answer to one pick (`GET /internal/script-pick`), in its own words. */
export interface ServedPick {
  scriptDynasty: string | null;
  basis: string;
  /** Every candidate in the order of this draw (the pick first). `score` null = picked on cost alone. */
  candidates: Array<{ scriptDynasty: string; runs: number; score: number | null }>;
}

/** Asks features-service which of `dynasties` (`<outcome>/<dynasty>`) runs. Throws when it cannot answer. */
export type ScriptPickReader = (outcome: string, dynasties: string[]) => Promise<ServedPick>;

export const productionScriptPick: ScriptPickReader = async (outcome, dynasties) => {
  const base = (process.env.FEATURES_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.FEATURES_SERVICE_API_KEY ?? "";
  if (!base || !key) throw new Error("FEATURES_SERVICE_URL and FEATURES_SERVICE_API_KEY must be set to read the script pick");
  const res = await fetch(`${base}/internal/script-pick?outcome=${encodeURIComponent(outcome)}&dynasties=${encodeURIComponent(dynasties.join(","))}`, {
    headers: { "x-api-key": key },
    signal: AbortSignal.timeout(600_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`the script pick for ${outcome} among ${dynasties.join(", ")} could not be read (features-service ${res.status}): ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as Partial<ServedPick>;
  if (!Array.isArray(body.candidates) || typeof body.basis !== "string") throw new Error(`features-service answered no pick for ${outcome}: ${text.slice(0, 300)}`);
  return { scriptDynasty: body.scriptDynasty ?? null, basis: body.basis, candidates: body.candidates };
};

let scriptPick: ScriptPickReader = productionScriptPick;
/** Tests swap the reader. */
export function setScriptPickReader(r: ScriptPickReader | null): void {
  scriptPick = r ?? productionScriptPick;
}

export interface Pick {
  script: ScriptRow;
  /** How features-service ranked the candidates (its basis), for the run's log. */
  basis: string;
  /** Every candidate and its served score, in the pick's order, for the run's log. */
  draws: Array<{ dynasty: string; version: number; runs: number; score: number | null }>;
  /**
   * Every candidate in the order of this same pick (`script` first): when the pick has nothing to make for this
   * campaign, the run asks the next one (RATING-UNMADE-FALLTHROUGH-1112), so the Rating still decides the order.
   */
  ranked: ScriptRow[];
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
export async function pickScript(db: AnyPgDb, input: PickInput): Promise<Pick | null> {
  const candidates = readersOfHanded(await candidatesOf(db, input), input.handed).sort((a, b) => a.dynasty.localeCompare(b.dynasty));
  if (candidates.length === 0) return null;
  const keyOf = (c: ScriptRow) => `${input.outcome}/${c.dynasty}`;
  const served = await scriptPick(input.outcome, candidates.map(keyOf));
  const byKey = new Map(candidates.map((c) => [keyOf(c), c]));
  const ranked = served.candidates.map((c) => byKey.get(c.scriptDynasty));
  const picked = served.scriptDynasty ? byKey.get(served.scriptDynasty) : undefined;
  // The pick must name exactly the candidates asked, its choice first: anything else is not a pick we can run.
  if (!picked || ranked[0] !== picked || ranked.some((r) => !r) || new Set(ranked).size !== candidates.length) {
    throw new Error(`features-service's pick for ${input.outcome} does not rank exactly the candidates asked (${[...byKey.keys()].join(", ")}): ${JSON.stringify(served).slice(0, 300)}`);
  }
  const rows = ranked as ScriptRow[];
  return {
    script: picked,
    basis: served.basis,
    draws: rows.map((r, i) => ({ dynasty: r.dynasty, version: r.version, runs: served.candidates[i]!.runs, score: served.candidates[i]!.score })),
    ranked: rows,
  };
}

