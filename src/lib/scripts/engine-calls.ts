/**
 * DISTRY-PRINCIPAL-1119: THE ENGINE LIST, the SAME for every Engine (never a branch on an outcome, a channel or a client):
 * every outcome of features-service's live catalogue, with whether one Unit of it can be made now (at least one live
 * script the Rating could draw: active, proven when a port, past its writing proof when it writes to people) and, when
 * not, why in plain words; plus what a run must hand (the materials each runnable script reads, the channel it states).
 * Read only: nothing spent, no proof started.
 *
 * DISTRY-CALL-IS-CAMPAIGN-1121 (owner 2026-11-21: « tout appel de Distry sur un de ces engines est TOUJOURS une campagne,
 * obligatoirement »): Distry gets a Unit through a campaign (campaign-service creates it, the campaign Engine run makes
 * it); the direct Engine call route and its campaign-door list are deleted. A script missing something stops with a
 * plain reason, never a rule here. So `callable` = a CAMPAIGN can make it for the org asked: the Engine is switched on for
 * that org's campaigns (its own row, else the fleet's) AND one runnable script needs no Unit handed (a campaign hands
 * none); otherwise not callable, with the reason. A listing that offered an Engine every campaign refuses
 * (`engine_not_live`) would hand Distry a tool that only ever fails (DISTRY-CALL-IS-CAMPAIGN-1121 AC, 2026-11-21).
 *
 * ENGINE-GET-ASK-1123 (owner 2026-11-23: an ask « peut être hors campaign », the 11-21 rule is lifted): Distry asks an
 * Engine like a Script does, through `POST /internal/engines/{outcome}/make`, with no campaign. `callable` keeps its
 * meaning (a campaign); `ask` says the same for a direct ask, from the same reads: possible as soon as one script is
 * runnable (the campaign switch is not read: no campaign is involved), and what the caller must hand or state.
 */
import { asksOf } from "./sandbox.js";
import { inArray } from "drizzle-orm";
import { engineReasons, scripts, type ScriptRow } from "../../db/schema.js";
import type { AnyPgDb } from "./script-catalogue.js";
import { START_OUTCOME, engineState, provenness } from "./engine.js";
import { writerProofDrawsNow } from "./writer-proof.js";

/** One outcome of the live catalogue (features-service `GET /public/catalogue/steps`). */
export interface CatalogueOutcome {
  key: string;
  name: string;
}

/** Reads every outcome of the live catalogue. Throws when it cannot be read (a list never guesses). */
export type CatalogueOutcomesReader = () => Promise<CatalogueOutcome[]>;

export const productionCatalogueOutcomes: CatalogueOutcomesReader = async () => {
  const base = (process.env.FEATURES_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.FEATURES_SERVICE_API_KEY ?? "";
  if (!base) throw new Error("FEATURES_SERVICE_URL must be set to read the catalogue of outcomes");
  const res = await fetch(`${base}/public/catalogue/steps`, { headers: key ? { "x-api-key": key } : {}, signal: AbortSignal.timeout(600_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`the catalogue of outcomes could not be read (features-service ${res.status}): ${text.slice(0, 300)}`);
  const rows = (JSON.parse(text) as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) throw new Error(`features-service answered no rows of outcomes: ${text.slice(0, 300)}`);
  return rows.map((r) => {
    const row = r as { key?: unknown; name?: unknown };
    if (typeof row.key !== "string" || typeof row.name !== "string") throw new Error(`features-service served an outcome with no key or name: ${JSON.stringify(r).slice(0, 200)}`);
    return { key: row.key, name: row.name };
  });
};

let catalogueOutcomes: CatalogueOutcomesReader = productionCatalogueOutcomes;
/** Tests swap the reader (null = production). */
export function setCatalogueOutcomesReader(r: CatalogueOutcomesReader | null): void {
  catalogueOutcomes = r ?? productionCatalogueOutcomes;
}

/** What a caller hands for one runnable script: the materials it reads (by outcome) and the channel it states. */
export interface EngineInputOption {
  units: string[];
  channel: string | null;
}

export interface EngineListing {
  outcome: string;
  name: string;
  callable: boolean;
  /** Switched on for campaigns of the org asked (its own row, else the fleet's; no org = the fleet's). */
  liveForCampaigns: boolean;
  /** Plain words: why no Unit can be asked now. Null when callable. */
  reason: string | null;
  /**
   * A DIRECT ask (`POST /internal/engines/{outcome}/make`, no campaign): `possible` = one script is runnable now;
   * `needsNothing` = one of them reads no handed Unit and states no channel; `reason` = plain words, why not possible or
   * what the caller must hand / state (null when an ask handing nothing works).
   */
  ask: { possible: boolean; needsNothing: boolean; reason: string | null };
  /** Each way to call it: the Units to hand (none = nothing to hand) and the channel to state (null = any). */
  inputs: EngineInputOption[];
  /** The runnable scripts the Rating draws among (their client-readable names). */
  scripts: Array<{ dynasty: string; name: string | null; version: number; units: string[]; channel: string | null }>;
  /** `runnable` = the live scripts the Rating can draw. */
  counts: { scripts: number; live: number; runnable: number };
}

/** The materials a script needs handed: what its code reads minus what it asks another Engine for (tactic `asks`). */
export function unitsToHand(row: Pick<ScriptRow, "materials" | "tactics"> & { code?: string | null }): string[] {
  const asked = asksOf(row);
  return [...new Set((row.materials ?? []).filter((m) => !asked.includes(m)))].sort();
}

const channelOf = (row: Pick<ScriptRow, "tactics">): string | null => {
  const c = ((row.tactics ?? {}) as Record<string, unknown>).channel;
  return typeof c === "string" ? c : null;
};

/**
 * PURE: why an outcome has no runnable script, in words the dashboard shows as-is. A reason staff STATED for the Engine
 * (`engine_reasons`, DISTRY-ENGINES-1119: an outcome no script can make on demand) wins; an Engine whose retired scripts
 * all live on under other outcomes says where they went (`movedTo`, those outcomes' names).
 */
export function notCallableReason(counts: {
  scripts: number;
  live: number;
  unprovenPorts: number;
  awaitingWriterProof: number;
  stated?: string | null;
  movedTo?: string[];
}): string {
  if (counts.stated) return counts.stated;
  if (counts.scripts === 0) return "No script makes this outcome yet.";
  if (counts.live === 0 && counts.movedTo && counts.movedTo.length) {
    return `Its scripts moved to ${counts.movedTo.join(", ")}, which make this work now: ask ${counts.movedTo.length > 1 ? "those Engines" : "that Engine"} instead.`;
  }
  if (counts.live === 0) return `Every script of this outcome is retired (${counts.scripts} stored).`;
  const parts: string[] = [];
  if (counts.unprovenPorts > 0) parts.push(`${counts.unprovenPorts} not yet proven on their recorded cases`);
  if (counts.awaitingWriterProof > 0) parts.push(`${counts.awaitingWriterProof} waiting to pass their writing proof before writing to people`);
  return `None of its ${counts.live} live scripts can run now: ${parts.join(", ")}.`;
}

/** The names of the outcomes where EVERY one of these dynasties runs now (empty when one of them runs nowhere else). */
function movedTo(dynasties: string[], outcome: string, liveHome: Map<string, Set<string>>, nameOf: Map<string, string>): string[] {
  const homes = new Set<string>();
  for (const d of dynasties) {
    const elsewhere = [...(liveHome.get(d) ?? [])].filter((o) => o !== outcome);
    if (!elsewhere.length) return [];
    for (const o of elsewhere) homes.add(o);
  }
  return [...homes].sort().map((o) => nameOf.get(o) ?? o);
}

/**
 * PURE: why runnable scripts still give no campaign a Unit. Switched off by the guard or staff = their reason; never
 * switched on = said so; every runnable script needs a handed Unit = another Engine asks it inside its own run.
 */
export function notForCampaignsReason(input: { live: boolean; rollbackReason: string | null; unitsNeeded: string[] }): string {
  if (!input.live) {
    return input.rollbackReason
      ? `Switched off for campaigns: ${input.rollbackReason}.`
      : "Not switched on for campaigns yet: a campaign on it would be refused.";
  }
  return `Each of its scripts needs Units a campaign does not hand (${input.unitsNeeded.join(", ")}): another Engine asks it inside its own run.`;
}

/**
 * PURE: what a direct ask must hand or state, read off the ways the runnable scripts can be called (`inputs`). Null when
 * one of them takes nothing; no way at all = null too (the caller says why nothing is runnable).
 */
export function askNeedsReason(inputs: EngineInputOption[]): string | null {
  if (inputs.length === 0 || inputs.some((i) => i.units.length === 0 && i.channel === null)) return null;
  const ways = inputs.map((i) => `${i.units.length ? `hand ${i.units.join(" and ")} in units` : "hand nothing"}${i.channel ? ` and state channel ${i.channel}` : ""}`);
  return `A direct ask must ${ways.join(", or ")}.`;
}

/** Every Engine of the live catalogue, callable by a campaign of `orgId` (no org = the fleet's) or not and why. Read only. */
export async function listEngines(db: AnyPgDb, orgId: string | null = null): Promise<EngineListing[]> {
  const outcomes = (await catalogueOutcomes()).filter((o) => o.key !== START_OUTCOME);
  const keys = outcomes.map((o) => o.key);
  const rows = keys.length ? await db.select().from(scripts).where(inArray(scripts.outcome, keys)) : [];
  const byOutcome = new Map<string, ScriptRow[]>();
  for (const r of rows) byOutcome.set(r.outcome, [...(byOutcome.get(r.outcome) ?? []), r]);
  const stated = new Map((await db.select().from(engineReasons)).map((r) => [r.outcome, r.reason] as const));
  const nameOf = new Map(outcomes.map((o) => [o.key, o.name] as const));
  // Where a dynasty runs now: an outcome whose dynasties are all retired may have had them moved (re-homed) elsewhere.
  const liveHome = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.status !== "active" || r.dynastyStatus !== "active") continue;
    liveHome.set(r.dynasty, new Set([...(liveHome.get(r.dynasty) ?? []), r.outcome]));
  }
  type Tally = { all: ScriptRow[]; dynasties: Set<string>; live: ScriptRow[]; runnable: ScriptRow[]; unprovenPorts: number; awaitingWriterProof: number };
  const tally = new Map<string, Tally>();
  for (const o of outcomes) {
    const all = byOutcome.get(o.key) ?? [];
    const dynasties = new Set(all.map((r) => r.dynasty));
    const live = all.filter((r) => r.status === "active" && r.dynastyStatus === "active");
    const runnable: ScriptRow[] = [];
    let unprovenPorts = 0;
    let awaitingWriterProof = 0;
    for (const r of live) {
      if (!(await provenness(db, r)).runnable) {
        unprovenPorts++;
        continue;
      }
      if (!(await writerProofDrawsNow(db, r))) {
        awaitingWriterProof++;
        continue;
      }
      runnable.push(r);
    }
    tally.set(o.key, { all, dynasties, live, runnable, unprovenPorts, awaitingWriterProof });
  }
  const out: EngineListing[] = [];
  for (const o of outcomes) {
    const { dynasties, live, runnable, unprovenPorts, awaitingWriterProof } = tally.get(o.key)!;
    runnable.sort((a, b) => a.dynasty.localeCompare(b.dynasty));
    const inputs = new Map<string, EngineInputOption>();
    for (const r of runnable) {
      const opt = { units: unitsToHand(r), channel: channelOf(r) };
      inputs.set(JSON.stringify(opt), opt);
    }
    const state = await engineState(db, o.key, orgId);
    const needNothing = runnable.some((r) => unitsToHand(r).length === 0);
    const callable = runnable.length > 0 && state.live && needNothing;
    const ways = [...inputs.values()].sort((a, b) => a.units.length - b.units.length || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const notRunnable = () =>
      notCallableReason({
        scripts: dynasties.size,
        live: live.length,
        unprovenPorts,
        awaitingWriterProof,
        stated: stated.get(o.key) ?? null,
        movedTo: movedTo([...dynasties], o.key, liveHome, nameOf),
      });
    const askNeeds = askNeedsReason(ways);
    out.push({
      outcome: o.key,
      name: o.name,
      callable,
      liveForCampaigns: state.live,
      reason: callable
        ? null
        : runnable.length > 0
          ? notForCampaignsReason({
              live: state.live,
              rollbackReason: state.rollbackReason,
              unitsNeeded: [...new Set(runnable.flatMap((r) => unitsToHand(r)))].sort(),
            })
          : notRunnable(),
      ask: { possible: runnable.length > 0, needsNothing: runnable.length > 0 && askNeeds === null, reason: runnable.length > 0 ? askNeeds : notRunnable() },
      inputs: ways,
      scripts: runnable.map((r) => ({ dynasty: r.dynasty, name: r.name ?? null, version: r.version, units: unitsToHand(r), channel: channelOf(r) })),
      counts: { scripts: dynasties.size, live: live.length, runnable: runnable.length },
    });
  }
  return out;
}
