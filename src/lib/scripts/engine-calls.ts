/**
 * DISTRY-PRINCIPAL-1119 (owner 2026-11-19: Distry « has access to all Engines as tools, by calling the most performing
 * script … it just waits for the results »; « Make sure every outcome is callable by Distry »).
 *
 * Two things, the SAME for every Engine (never a branch on an outcome, a channel or a client):
 *
 * 1. THE ENGINE LIST: every outcome of features-service's live catalogue, with whether a caller can get one Unit of it
 *    now (at least one live script the Rating could draw: active, proven when a port, past its writing proof when it
 *    writes to people) and, when not, why in plain words; plus what a caller must hand (the materials each runnable
 *    script reads, the channel it states). Read only: nothing spent, no proof started.
 *
 * 2. ONE ENGINE CALL: the Rating's pick (`pickScript`, features-service's script pick, the same a campaign run calls,
 *    never a hand pick), then that script runs on its own runs-service run, a child of the CALLER's run, org-billed and
 *    declared exactly as a campaign's script run (`runStoredScript`). When the pick has nothing to make (nothing, or
 *    unmade with no decision), the Rating's next candidate is asked, in the order of the same draw, up to
 *    `MAX_SCRIPTS_PER_RUN` (the campaign rule, `fallsThrough`). The call is stored (`engine_calls`) so a caller waits
 *    without a client timeout: the start answers once done or after its wait, the poll answers the same row.
 */
import { and, eq, inArray, lt } from "drizzle-orm";
import { engineCalls, scripts, type EngineCallRow, type ScriptRow } from "../../db/schema.js";
import type { AnyPgDb } from "./script-catalogue.js";
import { START_OUTCOME, pickScript, provenness, type Pick as RatingPick } from "./engine.js";
import { MAX_SCRIPTS_PER_RUN, fallsThrough } from "./engine-runner.js";
import { ScriptRunFailed, type MaterialUnit, type RunIdentity, type RunScriptInput, type ScriptRunResult, type SubjectRef } from "./script-runner.js";
import { writerProofDrawsNow } from "./writer-proof.js";

// ── 1. The Engine list ─────────────────────────────────────────────────────────────────────────────

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
  /** Plain words: why no Unit can be asked now. Null when callable. */
  reason: string | null;
  /** Each way to call it: the Units to hand (none = nothing to hand) and the channel to state (null = any). */
  inputs: EngineInputOption[];
  /** The runnable scripts the Rating draws among (their client-readable names). */
  scripts: Array<{ dynasty: string; name: string | null; version: number; units: string[]; channel: string | null }>;
  counts: { scripts: number; live: number; runnable: number };
}

/** The materials a script needs handed: what its code reads minus what it asks another Engine for (tactic `asks`). */
export function unitsToHand(row: Pick<ScriptRow, "materials" | "tactics">): string[] {
  const asks = ((row.tactics ?? {}) as Record<string, unknown>).asks;
  const asked = Array.isArray(asks) ? asks.filter((a): a is string => typeof a === "string") : [];
  return [...new Set((row.materials ?? []).filter((m) => !asked.includes(m)))].sort();
}

const channelOf = (row: Pick<ScriptRow, "tactics">): string | null => {
  const c = ((row.tactics ?? {}) as Record<string, unknown>).channel;
  return typeof c === "string" ? c : null;
};

/** PURE: why an outcome has no runnable script, in words the dashboard shows as-is. */
export function notCallableReason(counts: { scripts: number; live: number; unprovenPorts: number; awaitingWriterProof: number }): string {
  if (counts.scripts === 0) return "No script makes this outcome yet.";
  if (counts.live === 0) return `Every script of this outcome is retired (${counts.scripts} stored).`;
  const parts: string[] = [];
  if (counts.unprovenPorts > 0) parts.push(`${counts.unprovenPorts} not yet proven on their recorded cases`);
  if (counts.awaitingWriterProof > 0) parts.push(`${counts.awaitingWriterProof} waiting to pass their writing proof before writing to people`);
  return `None of its ${counts.live} live scripts can run now: ${parts.join(", ")}.`;
}

/** Every Engine of the live catalogue, callable or not and why. Read only. */
export async function listEngines(db: AnyPgDb): Promise<EngineListing[]> {
  const outcomes = (await catalogueOutcomes()).filter((o) => o.key !== START_OUTCOME);
  const keys = outcomes.map((o) => o.key);
  const rows = keys.length ? await db.select().from(scripts).where(inArray(scripts.outcome, keys)) : [];
  const byOutcome = new Map<string, ScriptRow[]>();
  for (const r of rows) byOutcome.set(r.outcome, [...(byOutcome.get(r.outcome) ?? []), r]);
  const out: EngineListing[] = [];
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
    runnable.sort((a, b) => a.dynasty.localeCompare(b.dynasty));
    const inputs = new Map<string, EngineInputOption>();
    for (const r of runnable) {
      const opt = { units: unitsToHand(r), channel: channelOf(r) };
      inputs.set(JSON.stringify(opt), opt);
    }
    out.push({
      outcome: o.key,
      name: o.name,
      callable: runnable.length > 0,
      reason: runnable.length > 0 ? null : notCallableReason({ scripts: dynasties.size, live: live.length, unprovenPorts, awaitingWriterProof }),
      inputs: [...inputs.values()].sort((a, b) => a.units.length - b.units.length || JSON.stringify(a).localeCompare(JSON.stringify(b))),
      scripts: runnable.map((r) => ({ dynasty: r.dynasty, name: r.name ?? null, version: r.version, units: unitsToHand(r), channel: channelOf(r) })),
      counts: { scripts: dynasties.size, live: live.length, runnable: runnable.length },
    });
  }
  return out;
}

// ── 2. One Engine call ─────────────────────────────────────────────────────────────────────────────

export interface EngineCallInput {
  outcome: string;
  orgId: string;
  userId: string;
  /** The caller's own run: every script run is its child. */
  callerRunId: string;
  /** The caller's downstream headers (brand, user...), forwarded to the run and the vendors. */
  headers: Record<string, string>;
  units: Record<string, MaterialUnit | MaterialUnit[]>;
  request: Record<string, unknown> | null;
  subject?: SubjectRef;
  channel?: string | null;
}

export interface EngineCallDeps {
  run(input: RunScriptInput, who: RunIdentity): Promise<ScriptRunResult>;
  noteScriptRun?(outcome: string): void;
}

/** The pick as a call serves it. */
export function servedPickOf(outcome: string, pick: RatingPick) {
  return {
    outcome,
    dynasty: pick.script.dynasty,
    version: pick.script.version,
    scriptId: pick.script.id,
    name: pick.script.name ?? null,
    basis: pick.basis,
    draws: pick.draws,
  };
}

/** The Request a called script reads: the caller's, with the clock and the brand a campaign run would carry. */
export function callRequestOf(input: Pick<EngineCallInput, "request" | "headers">, now: Date): Record<string, unknown> {
  const r = { ...(input.request ?? {}) };
  if (typeof r.now !== "string") r.now = now.toISOString();
  if (!Array.isArray(r.brandIds)) {
    const brand = input.headers["x-brand-id"] ?? "";
    r.brandIds = brand.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return r;
}

export type StartedCall = { kind: "not_callable"; message: string } | { kind: "started"; call: EngineCallRow; done: Promise<EngineCallRow> };

/**
 * The Rating's pick, stored, then run in the background (the caller waits on `done` or polls the row). Throws when the
 * pick cannot be read (nothing ran, nothing stored); `not_callable` when no script of the Engine can run on what the
 * caller hands.
 */
export async function startEngineCall(db: AnyPgDb, input: EngineCallInput, deps: EngineCallDeps): Promise<StartedCall> {
  const servable = Object.keys(input.units);
  const pick = await pickScript(db, { outcome: input.outcome, servable, channel: input.channel ?? null, orgId: input.orgId });
  if (!pick) {
    return {
      kind: "not_callable",
      message: `no script of Engine ${input.outcome} can run on ${servable.length ? servable.join(", ") : "no Units"}${input.channel ? ` for channel ${input.channel}` : ""}: read GET /internal/engines for what it needs`,
    };
  }
  const [call] = await db.insert(engineCalls).values({ outcome: input.outcome, orgId: input.orgId, callerRunId: input.callerRunId, pick: servedPickOf(input.outcome, pick) }).returning();
  const done = runCall(db, call!.id, input, pick, deps);
  return { kind: "started", call: call!, done };
}

async function runCall(db: AnyPgDb, callId: string, input: EngineCallInput, pick: RatingPick, deps: EngineCallDeps): Promise<EngineCallRow> {
  const request = callRequestOf(input, new Date());
  const who: RunIdentity = { orgId: input.orgId, userId: input.userId, parentRunId: input.callerRunId, headers: input.headers };
  const tried: Array<{ script: string; runId: string | null; status: string; error: string | null }> = [];
  let result: ScriptRunResult | null = null;
  let error: string | null = null;
  try {
    for (const script of pick.ranked.slice(0, MAX_SCRIPTS_PER_RUN)) {
      // As a campaign run states them: the owning service declares the Unit when the script's tactic says so
      // (`recorded_by`), and a Unit naming no subject is about the run that asked for it (as `ctx.ask` does).
      const recordedBy = (script.tactics as Record<string, unknown> | null)?.recorded_by;
      try {
        result = await deps.run(
          {
            outcome: script.outcome,
            dynasty: script.dynasty,
            version: script.version,
            units: input.units,
            request,
            ...(input.subject ? { subject: input.subject } : { fallbackSubject: { service: "runs-service", id: input.callerRunId } }),
            ...(typeof recordedBy === "string" && recordedBy ? { recordedBy } : {}),
            billing: "org",
          },
          who,
        );
      } catch (e) {
        if (!(e instanceof ScriptRunFailed)) throw e;
        result = e.result;
      }
      deps.noteScriptRun?.(input.outcome);
      tried.push({ script: result.scriptSlug, runId: result.runId, status: result.status, error: result.error });
      if (!fallsThrough(result, false)) break;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.error(`[workflow-service] engine call ${callId} ${input.outcome} failed: ${error}`);
  }
  const status = error ? "failed" : (result?.status ?? "failed");
  const [row] = await db
    .update(engineCalls)
    .set({ status, unit: result?.status === "made" ? result.unit : null, error: error ?? result?.error ?? null, tried, finishedAt: new Date() })
    .where(eq(engineCalls.id, callId))
    .returning();
  console.log(`[workflow-service] engine call ${callId} ${input.outcome} for org ${input.orgId}: ${tried.map((t) => `${t.script} ${t.status}`).join(", ") || "no script ran"}${row?.error ? `: ${row.error}` : ""}`);
  return row!;
}

/** Whether a call has ended. */
export const callEnded = (row: Pick<EngineCallRow, "status">) => row.status !== "running";

/** One call, read back by its caller's org. */
export async function readEngineCall(db: AnyPgDb, id: string, orgId: string): Promise<EngineCallRow | null> {
  const [row] = await db.select().from(engineCalls).where(and(eq(engineCalls.id, id), eq(engineCalls.orgId, orgId)));
  return row ?? null;
}

/** When this process started: a call created before it was run by a process that is gone. */
const PROCESS_STARTED_AT = new Date();

/** At boot: a call a dead process left running ended with it (nobody runs it any more). Never touches this process's calls. */
export async function closeOrphanEngineCalls(db: AnyPgDb, startedAt = PROCESS_STARTED_AT): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(engineCalls)
    .set({ status: "failed", error: "interrupted: the service restarted while the script ran; call the Engine again", finishedAt: now })
    .where(and(eq(engineCalls.status, "running"), lt(engineCalls.createdAt, startedAt)))
    .returning({ id: engineCalls.id });
  return rows.length;
}

/** The answer a call serves: the result once ended, else the call still running. */
export function servedCall(row: EngineCallRow) {
  return {
    callId: row.id,
    outcome: row.outcome,
    status: row.status,
    ended: callEnded(row),
    unit: row.unit ?? null,
    error: row.error ?? null,
    pick: row.pick,
    tried: row.tried,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
