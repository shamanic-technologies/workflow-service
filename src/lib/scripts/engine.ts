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
 *    (`ctx.get(...)`, read from the code) is one the run holds, or one its Engine can make for the same campaign
 *    (PLAN-RECURSIVE-PER-ENGINE-1124: asked one level deeper, recursively, never an Engine already asked above), a tactic
 *    `channel` it states is the campaign's, and the
 *    campaign's STRATEGY keeps it (features-service judges each script's tactics, `GET /internal/script-strategy`).
 *    WHICH candidate runs is features-service's Rating (SCRIPT-VALUE-RATING-1113-WF2, owner 2026-11-13: « un pick =
 *    toujours un script »): `GET /internal/script-pick?outcome=&dynasties=` draws once among the candidates on the value
 *    their runs' chains reached per dollar; its order is the run's fall-through order. Unreadable = throws: the run
 *    makes nothing and is retried, never a default script. No rating rule lives here.
 */
import { asksOf } from "./sandbox.js";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { scriptSwitches, scripts, type ScriptRow } from "../../db/schema.js";
import { activeVersion, caseCount, type AnyPgDb } from "./script-catalogue.js";
import { SwitchError } from "./script-writer-switch.js";
import { LLM_COMPLETION_OUTCOME, pairProofAllows, pendingProof, writerProofAllows } from "./writer-proof.js";

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

/**
 * Whether `outcome`'s Engine runs the campaigns of `orgId` (its own latest row, else the fleet's latest row) AND holds a
 * script that can run (TARGET-CONVERSATION-NO-SCRIPT-1121: Positive reply read `live: true` off a switch row while every
 * one of its scripts had moved to finer Engines, so a campaign launched on it was dispatched and refused every tick).
 * A switch row with no runnable script is not live: the state never promises a run nothing can make.
 */
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
  const latestOwn = orgId ? rows.find((r) => r.orgId === orgId) : undefined;
  const fleet = rows.find((r) => r.orgId === null);
  // An org's own row wins over the fleet row, EXCEPT an org row stopped BEFORE the fleet was switched on: switching every
  // client is the later decision and covers that org too (ENGINE-STALE-ORG-ROLLBACK-1122: the staff test org's lead_found
  // row, rolled back by the guard on 2026-11-06 18:05, outlived the fleet switch of 21:34 and refused every launch of a
  // Lead Sourcing funnel there for 16 days while every other client ran the Engine). A hold placed AFTER the fleet
  // switch still wins; an org switched on alone still runs when the fleet row is off.
  const staleOwn =
    latestOwn?.state === "rolled_back" &&
    fleet?.state === "switched" &&
    (latestOwn.rolledBackAt ?? latestOwn.switchedAt).getTime() < fleet.switchedAt.getTime();
  const own = staleOwn ? undefined : latestOwn;
  const deciding = own ?? fleet;
  return {
    outcome,
    orgId,
    live: deciding?.state === "switched" && (await holdsRunnableScript(db, outcome)),
    scope: own ? "org" : fleet ? "fleet" : null,
    provenOn: deciding?.dynasty ?? null,
    switchedAt: deciding?.switchedAt?.toISOString() ?? null,
    rolledBackAt: deciding?.rolledBackAt?.toISOString() ?? null,
    rollbackReason: deciding?.rollbackReason ?? null,
  };
}

/** Whether any active version of a live dynasty of `outcome` can run (a port only when proven 100 %). */
export async function holdsRunnableScript(db: AnyPgDb, outcome: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(scripts)
    .where(and(eq(scripts.outcome, outcome), eq(scripts.status, "active"), eq(scripts.dynastyStatus, "active")));
  for (const row of rows) if ((await provenness(db, row)).runnable) return true;
  return false;
}

/** A port runs only when it replays 100 % of its recorded cases; a script with no case is not a port. */
export async function provenness(db: AnyPgDb, row: ScriptRow): Promise<{ runnable: boolean; port: boolean }> {
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
  /**
   * The org the run acts for (LOCAL-CLAUDE-RATING-1116): a script is drawn only where the LLM it states runs AS STATED
   * for that org (chat-service decides; an org on local Claude runs a non-Claude LLM as Claude). Absent = not asked.
   */
  orgId?: string | null;
  /**
   * ONE-WRITER-N-MODELS-1116: the ASKING script (`<outcome>/<dynasty>`) when a script asks another Engine (`ctx.ask`):
   * the Rating keeps a note per (asking script, candidate) and falls back to the asking Engine, then the candidate
   * alone (features-service). Absent = the pick of a campaign's own run.
   */
  askedBy?: string | null;
  /**
   * WEBSEARCH-PICK-1119: request features the asked script's model must honour (`ctx.ask` request's own `webSearch` /
   * `imageUrl`). A script whose stated LLM refuses them (chat-service: the direct-vendor paths are text-only) is never
   * drawn: every run it would make 400s. Absent / all false = not asked.
   */
  needs?: LlmNeeds;
  /**
   * PLAN-RECURSIVE-PER-ENGINE-1124 (owner 2026-11-24: « À chaque Engine en partant de la fin (Target), on demande à Jev
   * de filtrer les scripts possibles et puis le Rating nous donne le meilleur parmi la liste possible. Et ainsi de suite
   * récursivement »): the Engines already asked above this pick, the top one first. A script needing a Unit the run does
   * not hold is a candidate when that Unit's Engine can make it for the same campaign (its own candidates, one level
   * deeper, recursively); an Engine already in the chain, or this one, is never asked again (no loop).
   */
  chain?: string[];
  /**
   * Internal to the recursion: a reachability look one level deeper, never a draw. It waits for no proof (a version
   * whose proof is still running counts as reachable: the draw itself will wait for it).
   */
  reachOnly?: boolean;
}

/** PURE: the Engines a pick for `outcome` under `chain` may not ask again (the chain, then itself). */
export const askedAbove = (outcome: string, chain: readonly string[] | undefined): string[] => [...(chain ?? []), outcome];

/** Request features a pick must see honoured, as chat-service judges them (`GET /internal/local-llm/served-llms`). */
export interface LlmNeeds {
  webSearch?: boolean;
  imageUrl?: boolean;
}

/** PURE: the features an asked Request carries for its model (`request.request.webSearch` / `.imageUrl`), none = {}. */
export function needsOfAsk(request: unknown): LlmNeeds {
  const inner = request && typeof request === "object" ? (request as Record<string, unknown>).request : null;
  if (!inner || typeof inner !== "object") return {};
  const r = inner as Record<string, unknown>;
  const on = (v: unknown) => v === true || v === "true";
  const imageUrl = typeof r.imageUrl === "string" ? r.imageUrl.trim() !== "" : on(r.imageUrl);
  return { ...(on(r.webSearch) ? { webSearch: true } : {}), ...(imageUrl ? { imageUrl: true } : {}) };
}

const anyNeed = (n: LlmNeeds | undefined) => n?.webSearch === true || n?.imageUrl === true;

/** One LLM as a script's tactics state it (`llm` / `llms[place]`): provider + chat-service LLM dynasty slug. */
export interface StatedLlm {
  provider: string;
  model: string;
}

/** PURE: every LLM a script's tactics state (`llm`, every `llms[place]`), deduped; none = the script states none. */
export function statedLlmsOf(tactics: unknown): StatedLlm[] {
  const t = (tactics ?? {}) as Record<string, unknown>;
  const raw: unknown[] = [t.llm, ...(t.llms && typeof t.llms === "object" && !Array.isArray(t.llms) ? Object.values(t.llms as Record<string, unknown>) : [])];
  const out = new Map<string, StatedLlm>();
  for (const l of raw) {
    if (!l || typeof l !== "object") continue;
    const { provider, model } = l as Record<string, unknown>;
    if (typeof provider === "string" && typeof model === "string") out.set(`${provider}/${model}`, { provider, model });
  }
  return [...out.values()];
}

/**
 * For one org, which of `llms` may be drawn (key `<provider>/<model>`): it runs AS STATED (false = chat-service would run
 * another model in its place, e.g. an org on local Claude) AND, when `needs` asks, its model takes such a request
 * (WEBSEARCH-PICK-1119). Throws when it cannot be read (fail closed: the run picks nothing, retried).
 */
export type LlmServingReader = (orgId: string, llms: StatedLlm[], needs?: LlmNeeds) => Promise<Map<string, boolean>>;

/**
 * chat-service `GET /internal/local-llm/served-llms` (the one owner of which model serves which LLM for an org). A row
 * answering `runsAsStated: null` names an LLM chat-service does not serve at all: the script cannot run as stated
 * anywhere, so it is not drawn (false), logged. Unreadable = throws.
 */
export const productionLlmServing: LlmServingReader = async (orgId, llms, needs) => {
  const asked = anyNeed(needs);
  const needsQuery = `${needs?.webSearch ? "&webSearch=true" : ""}${needs?.imageUrl ? "&imageUrl=true" : ""}`;
  const base = (process.env.CHAT_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.CHAT_SERVICE_API_KEY ?? "";
  if (!base || !key) throw new Error("CHAT_SERVICE_URL and CHAT_SERVICE_API_KEY must be set to read which LLMs an org runs as stated");
  const out = new Map<string, boolean>();
  for (let i = 0; i < llms.length; i += 50) {
    const names = llms.slice(i, i + 50).map((l) => `${l.provider}/${l.model}`);
    const res = await fetch(`${base}/internal/local-llm/served-llms?orgId=${encodeURIComponent(orgId)}&llms=${encodeURIComponent(names.join(","))}${needsQuery}`, {
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(600_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`which LLMs org ${orgId} runs as stated could not be read (chat-service ${res.status}): ${text.slice(0, 300)}`);
    const rows = (JSON.parse(text) as { llms?: unknown }).llms;
    if (!Array.isArray(rows)) throw new Error(`chat-service answered no llms for org ${orgId}: ${text.slice(0, 300)}`);
    for (const r of rows as Array<{ llm?: unknown; runsAsStated?: unknown; acceptsRequest?: unknown; error?: unknown }>) {
      if (typeof r.llm !== "string") continue;
      if (r.runsAsStated === null) {
        console.warn(`[workflow-service] chat-service serves no ${r.llm}: a script stating it is not drawn (${String(r.error ?? "")})`);
        out.set(r.llm, false);
        continue;
      }
      if (typeof r.runsAsStated !== "boolean") throw new Error(`chat-service answered ${JSON.stringify(r.runsAsStated)} for ${r.llm} (org ${orgId})`);
      if (asked && typeof r.acceptsRequest !== "boolean") throw new Error(`chat-service answered no acceptsRequest for ${r.llm} asked ${needsQuery} (org ${orgId})`);
      out.set(r.llm, r.runsAsStated === true && (!asked || r.acceptsRequest === true));
    }
  }
  return out;
};

let llmServing: LlmServingReader = productionLlmServing;
/** Tests swap the reader (null = production). */
export function setLlmServingReader(r: LlmServingReader | null): void {
  llmServing = r ?? productionLlmServing;
}

/**
 * PURE (LOCAL-CLAUDE-RATING-1116, owner 2026-11-16 « par design sans avoir besoin de changer les briefs »): keep the
 * scripts every stated LLM of which runs as stated. A script stating none is kept. Nothing is keyed on a client, a model
 * or an outcome: the serving answer is chat-service's.
 */
export function runsAsStated<T extends { tactics: unknown }>(rows: T[], served: ReadonlyMap<string, boolean>): T[] {
  return rows.filter((r) =>
    statedLlmsOf(r.tactics).every((l) => {
      const v = served.get(`${l.provider}/${l.model}`);
      if (v === undefined) throw new Error(`no answer on whether ${l.provider}/${l.model} runs as stated`);
      return v;
    }),
  );
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

/**
 * Asks features-service which of `dynasties` (`<outcome>/<dynasty>`) runs, for `askedBy` (the asking script, when a
 * script asks another Engine). Throws when it cannot answer.
 */
export type ScriptPickReader = (outcome: string, dynasties: string[], askedBy?: string | null) => Promise<ServedPick>;

export const productionScriptPick: ScriptPickReader = async (outcome, dynasties, askedBy) => {
  const base = (process.env.FEATURES_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.FEATURES_SERVICE_API_KEY ?? "";
  if (!base || !key) throw new Error("FEATURES_SERVICE_URL and FEATURES_SERVICE_API_KEY must be set to read the script pick");
  const res = await fetch(`${base}/internal/script-pick?outcome=${encodeURIComponent(outcome)}&dynasties=${encodeURIComponent(dynasties.join(","))}${askedBy ? `&askedBy=${encodeURIComponent(askedBy)}` : ""}`, {
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
  // ONE-WRITER-N-MODELS-1116-ANSWERER: the writer asking for its model; a pair (writer, model) of an enforced Engine
  // is drawn only once proven. Read once per pick.
  let asker: ScriptRow | null | undefined;
  const askingWriter = async (): Promise<ScriptRow | null> => {
    if (asker !== undefined) return asker;
    const at = input.askedBy ? input.askedBy.indexOf("/") : -1;
    asker = at > 0 ? await activeVersion(db, input.askedBy!.slice(0, at), input.askedBy!.slice(at + 1)) : null;
    return asker;
  };
  // PROVEN-BEFORE-PEOPLE-1116: a writer of an enforced Engine is drawn only once proven on recorded cases (a model
  // asked by such a writer: the pair). A refusal while its proof runs in this process is noted in `awaiting`.
  const proofAllows = async (row: ScriptRow, note = true): Promise<boolean> => {
    if (!(await writerProofAllows(db, row))) {
      const proof = pendingProof(row, null);
      if (note && proof) awaiting.push({ row, proof });
      return false;
    }
    if (input.outcome === LLM_COMPLETION_OUTCOME && input.askedBy) {
      const writer = await askingWriter();
      if (writer && !(await pairProofAllows(db, writer, row))) {
        const proof = pendingProof(writer, row);
        if (note && proof) awaiting.push({ row, proof });
        return false;
      }
    }
    return true;
  };
  const out: ScriptRow[] = [];
  // Rows held back only by a proof running right now (NEW-WRITER-FIRST-RUN-1121): waited for when nothing else is drawable.
  const awaiting: Array<{ row: ScriptRow; proof: Promise<unknown> }> = [];
  // PLAN-RECURSIVE-PER-ENGINE-1124: whether a Unit the run does not hold can be asked of its Engine for this campaign
  // (one look per outcome per pick). The deeper look reads the same campaign's strategy for THAT Engine, holds no Unit,
  // and carries the chain, so a loop ends unreachable instead of recursing.
  const above = askedAbove(input.outcome, input.chain);
  const reach = new Map<string, Promise<boolean>>();
  const reachable = (m: string, asker: ScriptRow): Promise<boolean> => {
    if (above.includes(m)) return Promise.resolve(false);
    let r = reach.get(m);
    if (!r) {
      r = candidatesOf(db, {
        outcome: m,
        servable: [],
        channel: input.channel,
        campaignId: input.campaignId ?? null,
        orgId: input.orgId ?? null,
        askedBy: `${input.outcome}/${asker.dynasty}`,
        chain: above,
        reachOnly: true,
      }).then((c) => c.length > 0);
      reach.set(m, r);
    }
    return r;
  };
  for (const row of rows) {
    if (kept && !kept.has(row.dynasty)) continue;
    // A material the script ASKS another Engine for (tactic `asks`: `ctx.ask(request)` then `ctx.get(<outcome>)`, a
    // child run of that Engine) is not one the run must hold; one it reads without asking is asked of its Engine by the
    // run itself (script-runner) when that Engine can make it here.
    const provided = asksOf(row);
    let fed = true;
    for (const m of row.materials ?? []) {
      if (input.servable.includes(m) || provided.includes(m)) continue;
      if (!(await reachable(m, row))) {
        fed = false;
        break;
      }
    }
    if (!fed) continue;
    const channel = (row.tactics as Record<string, unknown>)?.channel;
    if (typeof channel === "string" && channel !== input.channel) continue;
    if (!(await provenness(db, row)).runnable) continue;
    if (await proofAllows(row, !input.reachOnly)) out.push(row);
    else if (input.reachOnly && pendingProof(row, null)) out.push(row);
  }
  // A version whose proof is still running is not refused: when nothing else can be drawn, the pick waits for those
  // proofs (bounded by the proof's own ceiling) and draws whatever passed, never "no script" for a new version.
  if (out.length === 0 && awaiting.length > 0) {
    await Promise.allSettled(awaiting.map((a) => a.proof));
    for (const { row } of awaiting) if (await proofAllows(row, false)) out.push(row);
  }
  // LOCAL-CLAUDE-RATING-1116: only where its stated LLM runs as stated for this org (one read per pick), and
  // WEBSEARCH-PICK-1119: only where that model takes what the asked request needs (web search, an image).
  const needs = anyNeed(input.needs) ? input.needs : undefined;
  if (!input.orgId) {
    if (needs) throw new Error(`a pick for ${input.outcome} needs ${JSON.stringify(needs)} but names no org: which model takes it cannot be read`);
    return out;
  }
  const stated = new Map<string, StatedLlm>();
  for (const r of out) for (const l of statedLlmsOf(r.tactics)) stated.set(`${l.provider}/${l.model}`, l);
  if (stated.size === 0) return out;
  return runsAsStated(out, await llmServing(input.orgId, [...stated.values()], needs));
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
  const served = input.askedBy ? await scriptPick(input.outcome, candidates.map(keyOf), input.askedBy) : await scriptPick(input.outcome, candidates.map(keyOf));
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

