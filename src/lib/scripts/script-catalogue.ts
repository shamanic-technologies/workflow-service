/**
 * FACTORY-P2-ENGINES: the script catalogue. A script is code stored as data that makes ONE Unit of its outcome (a
 * features-service step key, the same key it declares on runs-service's ledger) or none. Its versions form a
 * dynasty, with the workflow semantics: an UPGRADE is the next version of the same idea (the previous version is
 * deprecated in the same transaction, exactly one active version per dynasty), a FORK is a new idea (a new dynasty,
 * version 1, the source untouched), and a dynasty can be retired as a whole. Stats pool per dynasty: every run of
 * every version opens its runs-service run under ONE task name per dynasty (`script:<outcome>/<dynasty>`).
 *
 * PORT rule: a dynasty that carries recorded cases (`script_cases`, real production cases, never in git) is a port of
 * existing code. Every version of it must replay 100 % of its cases in the sandbox BEFORE it is stored: a version
 * that does not match is refused and nothing is written. A behaviour change to a port is therefore a FORK (a new
 * idea, measured by the ledger like any other). A dynasty with no cases is a new idea and runs on its next tick.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { scriptCases, scripts, type ScriptRow } from "../../db/schema.js";
import { replayAll, type ReplayCase, type ReplaySummary } from "./replay.js";
import { ScriptSourceError, validateSource } from "./sandbox.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPgDb = PgDatabase<PgQueryResultHKT, any, any>;

export const SLUG_RE = /^[a-z][a-z0-9_]{1,62}$/;

export class ScriptCatalogueError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface CatalogueDeps {
  /** True when the outcome is a features-service catalogue step (the ledger refuses any other key). */
  isKnownOutcome(outcome: string): Promise<boolean>;
}

export interface Author {
  orgId: string;
  /** Who wrote it (staff email, else `user:<id>`). */
  createdBy: string;
}

/** A script as served: everything but the code (read on `GET /scripts/{id}`). */
export function summarizeScript(row: ScriptRow, caseCount: number) {
  return {
    id: row.id,
    outcome: row.outcome,
    dynasty: row.dynasty,
    version: row.version,
    scriptSlug: `${row.outcome}/${row.dynasty}/v${row.version}`,
    description: row.description,
    materials: row.materials,
    vendors: row.vendors,
    tactics: row.tactics,
    status: row.status,
    dynastyStatus: row.dynastyStatus,
    runnable: row.status === "active" && row.dynastyStatus === "active",
    creationType: row.creationType,
    createdFromScript: row.createdFromScript,
    createdBy: row.createdBy,
    replay: row.replay ?? null,
    cases: caseCount,
    deprecationReason: row.deprecationReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serveScript(row: ScriptRow, caseCount: number) {
  return { ...summarizeScript(row, caseCount), code: row.code };
}

function checkSlug(kind: string, value: string): void {
  if (!SLUG_RE.test(value)) throw new ScriptCatalogueError(400, `invalid_${kind}`, `${kind} must be a lowercase slug (letters, digits, underscores): ${value}`);
}

async function checkOutcome(outcome: string, deps: CatalogueDeps): Promise<void> {
  checkSlug("outcome", outcome);
  if (!(await deps.isKnownOutcome(outcome))) {
    throw new ScriptCatalogueError(400, "unknown_outcome", `${outcome} is not a step of the features-service catalogue: a script makes one catalogue outcome`);
  }
}

async function readSource(code: string) {
  try {
    return await validateSource(code);
  } catch (e) {
    if (e instanceof ScriptSourceError) throw new ScriptCatalogueError(400, "invalid_code", e.message);
    throw e;
  }
}

export async function loadCases(db: AnyPgDb, outcome: string, dynasty: string): Promise<ReplayCase[]> {
  const rows = await db
    .select({ body: scriptCases.body })
    .from(scriptCases)
    .where(and(eq(scriptCases.outcome, outcome), eq(scriptCases.dynasty, dynasty)))
    .orderBy(asc(scriptCases.caseId));
  return rows.map((r) => r.body as ReplayCase);
}

export async function caseCount(db: AnyPgDb, outcome: string, dynasty: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scriptCases)
    .where(and(eq(scriptCases.outcome, outcome), eq(scriptCases.dynasty, dynasty)));
  return Number(row?.n ?? 0);
}

/** Replay a code on its dynasty's cases; null when the dynasty carries none (a new idea). */
export async function proveOnCases(db: AnyPgDb, outcome: string, dynasty: string, code: string): Promise<ReplaySummary | null> {
  const cases = await loadCases(db, outcome, dynasty);
  if (cases.length === 0) return null;
  return replayAll(code, cases);
}

/** A failure report trimmed for a response: case ids and the first differences, never a case body. */
function failureDetails(summary: ReplaySummary) {
  return {
    cases: summary.cases,
    matches: summary.matches,
    failures: summary.failures.slice(0, 5).map((f) => ({ id: f.id, diffs: f.diffs.slice(0, 3).map((d) => d.slice(0, 300)) })),
  };
}

async function requireProven(db: AnyPgDb, outcome: string, dynasty: string, code: string): Promise<{ cases: number; matches: number } | null> {
  const summary = await proveOnCases(db, outcome, dynasty, code);
  if (summary === null) return null;
  if (summary.matches !== summary.cases) {
    throw new ScriptCatalogueError(
      422,
      "replay_failed",
      `${outcome}/${dynasty} is a port: this code matches ${summary.matches} of its ${summary.cases} recorded cases, every one must match. A behaviour change to a port is a fork.`,
      { replay: failureDetails(summary) },
    );
  }
  return { cases: summary.cases, matches: summary.matches };
}

export async function activeVersion(db: AnyPgDb, outcome: string, dynasty: string): Promise<ScriptRow | null> {
  const [row] = await db
    .select()
    .from(scripts)
    .where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty), eq(scripts.status, "active")));
  return row ?? null;
}

export async function dynastyVersions(db: AnyPgDb, outcome: string, dynasty: string): Promise<ScriptRow[]> {
  return db
    .select()
    .from(scripts)
    .where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty)))
    .orderBy(desc(scripts.version));
}

export async function listScripts(
  db: AnyPgDb,
  filter: { outcome?: string; dynasty?: string; status: "active" | "deprecated" | "all" },
): Promise<ScriptRow[]> {
  const rows = await db
    .select()
    .from(scripts)
    .orderBy(asc(scripts.outcome), asc(scripts.dynasty), desc(scripts.version));
  return rows.filter((r) => {
    if (filter.outcome && r.outcome !== filter.outcome) return false;
    if (filter.dynasty && r.dynasty !== filter.dynasty) return false;
    const runnable = r.status === "active" && r.dynastyStatus === "active";
    if (filter.status === "active") return runnable;
    if (filter.status === "deprecated") return !runnable;
    return true;
  });
}

export interface CreateInput {
  outcome: string;
  dynasty: string;
  code: string;
  description: string;
  tactics?: Record<string, unknown>;
}

/** A new idea: a new dynasty, version 1. */
export async function createScript(db: AnyPgDb, input: CreateInput, author: Author, deps: CatalogueDeps): Promise<ScriptRow> {
  await checkOutcome(input.outcome, deps);
  checkSlug("dynasty", input.dynasty);
  const [taken] = await db
    .select({ id: scripts.id })
    .from(scripts)
    .where(and(eq(scripts.outcome, input.outcome), eq(scripts.dynasty, input.dynasty)))
    .limit(1);
  if (taken) throw new ScriptCatalogueError(409, "dynasty_exists", `${input.outcome}/${input.dynasty} exists: upgrade it, or fork it under a new dynasty name`);
  const read = await readSource(input.code);
  const replay = await requireProven(db, input.outcome, input.dynasty, input.code);
  const [row] = await db
    .insert(scripts)
    .values({
      outcome: input.outcome,
      dynasty: input.dynasty,
      version: 1,
      code: input.code,
      materials: read.materials,
      vendors: read.vendors,
      tactics: input.tactics ?? {},
      description: input.description,
      creationType: "scratch",
      orgId: author.orgId,
      createdBy: author.createdBy,
      replay,
    })
    .returning();
  return row!;
}

export interface UpgradeInput {
  code: string;
  description?: string;
  tactics?: Record<string, unknown>;
}

/** The next version of the same idea; the previous active version is deprecated in the same transaction. */
export async function upgradeScript(db: AnyPgDb, outcome: string, dynasty: string, input: UpgradeInput, author: Author): Promise<ScriptRow> {
  const current = await activeVersion(db, outcome, dynasty);
  if (!current) {
    const any = await dynastyVersions(db, outcome, dynasty);
    if (any.length === 0) throw new ScriptCatalogueError(404, "not_found", `no script ${outcome}/${dynasty}`);
    throw new ScriptCatalogueError(409, "no_active_version", `${outcome}/${dynasty} has no active version to upgrade`);
  }
  if (current.code === input.code && input.tactics === undefined) {
    throw new ScriptCatalogueError(400, "no_change", "the code is the active version's, byte for byte: nothing to upgrade");
  }
  const read = await readSource(input.code);
  const replay = await requireProven(db, outcome, dynasty, input.code);
  return db.transaction(async (tx) => {
    await tx
      .update(scripts)
      .set({ status: "deprecated", deprecationReason: `Upgraded: replaced by version ${current.version + 1}`, updatedAt: new Date() })
      .where(eq(scripts.id, current.id));
    const [row] = await tx
      .insert(scripts)
      .values({
        outcome,
        dynasty,
        version: current.version + 1,
        code: input.code,
        materials: read.materials,
        vendors: read.vendors,
        tactics: input.tactics ?? current.tactics,
        description: input.description ?? current.description,
        dynastyStatus: current.dynastyStatus,
        creationType: "upgrade",
        createdFromScript: current.id,
        orgId: author.orgId,
        createdBy: author.createdBy,
        replay,
      })
      .returning();
    return row!;
  });
}

export interface ForkInput {
  dynasty: string;
  description: string;
  code?: string;
  tactics?: Record<string, unknown>;
}

/** A different idea: a new dynasty (version 1) from a source version; the source is never written. */
export async function forkScript(db: AnyPgDb, outcome: string, sourceDynasty: string, input: ForkInput, author: Author): Promise<ScriptRow> {
  const source = await activeVersion(db, outcome, sourceDynasty);
  if (!source) throw new ScriptCatalogueError(404, "not_found", `no active version of ${outcome}/${sourceDynasty} to fork`);
  checkSlug("dynasty", input.dynasty);
  const [taken] = await db
    .select({ id: scripts.id })
    .from(scripts)
    .where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, input.dynasty)))
    .limit(1);
  if (taken) throw new ScriptCatalogueError(409, "dynasty_exists", `${outcome}/${input.dynasty} exists: pick a new dynasty name`);
  const code = input.code ?? source.code;
  const read = await readSource(code);
  const [row] = await db
    .insert(scripts)
    .values({
      outcome,
      dynasty: input.dynasty,
      version: 1,
      code,
      materials: read.materials,
      vendors: read.vendors,
      tactics: input.tactics ?? source.tactics,
      description: input.description,
      creationType: "fork",
      createdFromScript: source.id,
      orgId: author.orgId,
      createdBy: author.createdBy,
      replay: await requireProven(db, outcome, input.dynasty, code),
    })
    .returning();
  return row!;
}

/**
 * Retire or restore a whole dynasty. Retiring writes both axes (every version deprecated), restoring brings back ONE
 * version, the highest, so a dynasty never has two active versions.
 */
export async function setDynastyStatus(db: AnyPgDb, outcome: string, dynasty: string, status: "active" | "deprecated", reason: string): Promise<ScriptRow[]> {
  const versions = await dynastyVersions(db, outcome, dynasty);
  if (versions.length === 0) throw new ScriptCatalogueError(404, "not_found", `no script ${outcome}/${dynasty}`);
  await db.transaction(async (tx) => {
    if (status === "deprecated") {
      await tx
        .update(scripts)
        .set({ status: "deprecated", dynastyStatus: "deprecated", deprecationReason: reason, updatedAt: new Date() })
        .where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty)));
    } else {
      await tx.update(scripts).set({ dynastyStatus: "active", updatedAt: new Date() }).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty)));
      await tx.update(scripts).set({ status: "active", deprecationReason: null, updatedAt: new Date() }).where(eq(scripts.id, versions[0]!.id));
    }
  });
  return dynastyVersions(db, outcome, dynasty);
}

/** Store (or replace) a dynasty's recorded cases. Idempotent per case id. */
export async function putCases(db: AnyPgDb, outcome: string, dynasty: string, cases: ReplayCase[], source: string): Promise<{ stored: number; total: number }> {
  checkSlug("outcome", outcome);
  checkSlug("dynasty", dynasty);
  for (const c of cases) {
    if (!c || typeof c.id !== "string" || !c.id || !Array.isArray(c.calls) || typeof c.units !== "object" || typeof c.expect !== "object") {
      throw new ScriptCatalogueError(400, "invalid_case", `a case needs id, units, calls and expect (case ${String((c as { id?: unknown })?.id)})`);
    }
  }
  for (const c of cases) {
    await db
      .insert(scriptCases)
      .values({ outcome, dynasty, caseId: c.id, body: c, source })
      .onConflictDoUpdate({ target: [scriptCases.outcome, scriptCases.dynasty, scriptCases.caseId], set: { body: c, source } });
  }
  return { stored: cases.length, total: await caseCount(db, outcome, dynasty) };
}

/** The production check that an outcome is a features-service catalogue step (`GET /public/catalogue/steps`). */
export function productionCatalogueDeps(): CatalogueDeps {
  return {
    async isKnownOutcome(outcome) {
      const base = (process.env.FEATURES_SERVICE_URL ?? "").replace(/\/$/, "");
      if (!base) throw new Error("FEATURES_SERVICE_URL must be set to check a script's outcome");
      const res = await fetch(`${base}/public/catalogue/steps`, { signal: AbortSignal.timeout(600_000) });
      if (!res.ok) throw new Error(`features-service GET /public/catalogue/steps -> ${res.status}`);
      const body = (await res.json()) as { rows?: Array<{ key?: unknown }> };
      return (body.rows ?? []).some((r) => r.key === outcome);
    },
  };
}
