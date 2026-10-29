/**
 * FACTORY-P2-ENGINES: one production order of a stored script, as a workflow STEP (`POST /orgs/scripts/run`, called
 * by an `http.call` node like `/orgs/agent/turns`).
 *
 * The run is accounted like any run today (cost-accounting doctrine): it opens its OWN runs-service run, a child of
 * the caller's (`x-run-id`), under one task name per dynasty (`script:<outcome>/<dynasty>`, so stats pool per
 * dynasty); every vendor the script calls is one of our metered doors called with THAT run as `x-run-id`, so the
 * spend lands on it (chat-service declares an LLM call's cost itself); then the run declares on the ledger what it
 * consumed (each material the script asked for that names its subject) and what it produced (its outcome, on the
 * run's subject, only when the script made a Unit), and is closed. A declaration runs-service refuses fails the step
 * loudly: untracked spend is a bug.
 *
 * Isolation (src/lib/scripts/sandbox.ts): the code runs in its own engine and reaches the outside only through this
 * bridge, which answers for the caller's org and identity alone: the materials the step was handed, its Engine's
 * storage for THIS org, and the vendors with this run's identity. No env, no DB handle, no other org.
 */
import { and, eq, sql } from "drizzle-orm";
import { scriptRuns, scriptStorage, scripts, type ScriptRow } from "../../db/schema.js";
import { runScript, type Bridge, type ScriptResult } from "./sandbox.js";
import { callVendor, type VendorDeps } from "./vendors.js";
import { ScriptCatalogueError, activeVersion, caseCount, dynastyVersions, type AnyPgDb } from "./script-catalogue.js";

export interface SubjectRef {
  service: string;
  id: string;
}

export interface MaterialUnit {
  content: Record<string, unknown>;
  /** The ledger subject this Unit is about: when stated, the run declares it consumed once the script asks for it. */
  subject?: SubjectRef;
}

export interface RunScriptInput {
  outcome: string;
  dynasty: string;
  /** Pin one version (default: the dynasty's active one). */
  version?: number;
  /** Who or what the Unit it makes is about: the subject its produced outcome is declared on. */
  subject: SubjectRef;
  /** The materials, by outcome; a list when the script may ask the same outcome again. */
  units: Record<string, MaterialUnit | MaterialUnit[]>;
  /** The run's tactics, on top of the script's own. */
  tactics?: Record<string, unknown>;
  request?: Record<string, unknown> | null;
  /**
   * The service that RECORDS the Unit declares its occurrences on this run, with its own never-lost machinery
   * (FACTORY-P3 fleet writer: content-generation stores the email row and declares its ONE `message_written` on the
   * script's run). The run then declares nothing itself: one declaration per Unit, never two.
   */
  recordedBy?: string;
  /** Answer every vendor call (args, answer; a completion's exact request + whole answer) for the recording service. */
  trace?: boolean;
}

export interface RunIdentity {
  orgId: string;
  userId: string;
  /** The caller's run: the script's run is its child. */
  parentRunId: string;
  /** Every downstream header of the caller (brand, campaign, workflow slug...), forwarded to the run and the vendors. */
  headers: Record<string, string>;
}

export interface LedgerDeps {
  createRun(opts: { parentRunId: string; orgId: string; userId: string; taskName: string; headers: Record<string, string> }): Promise<string>;
  declareOutcomes(runId: string, orgId: string, body: { produced: OccurrenceInput[]; consumed: OccurrenceInput[] }): Promise<Record<string, unknown>>;
  closeRun(runId: string, status: "completed" | "failed", orgId: string): Promise<void>;
}

export interface OccurrenceInput {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
}

export interface ScriptRunResult {
  scriptId: string;
  scriptSlug: string;
  version: number;
  runId: string;
  status: "made" | "nothing" | "stopped" | "failed";
  unit: { outcome: string; subject: SubjectRef; content: Record<string, unknown>; found?: string } | null;
  error: string | null;
  vendorCalls: Array<{ name: string; ok: boolean; error?: string; ms: number }>;
  declared: { produced: OccurrenceInput[]; consumed: OccurrenceInput[] };
  /** Who declares this run's occurrences when not the run itself. */
  recordedBy?: string;
  /** Every vendor call in order (only when the step asked `trace: true`). */
  trace?: Array<{ name: string; args: unknown; answer: unknown; sent?: Record<string, unknown>; raw?: Record<string, unknown> }>;
}

/** The step failed after its run was opened (the run is closed failed, declared, and named). */
export class ScriptRunFailed extends Error {
  constructor(readonly result: ScriptRunResult) {
    super(result.error ?? result.status);
  }
}

export const scriptTaskName = (outcome: string, dynasty: string) => `script:${outcome}/${dynasty}`;

async function resolveVersion(db: AnyPgDb, input: RunScriptInput): Promise<ScriptRow> {
  let row: ScriptRow | null;
  if (input.version !== undefined) {
    const [pinned] = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.outcome, input.outcome), eq(scripts.dynasty, input.dynasty), eq(scripts.version, input.version)));
    row = pinned ?? null;
  } else {
    row = await activeVersion(db, input.outcome, input.dynasty);
    if (!row) {
      const [any] = await dynastyVersions(db, input.outcome, input.dynasty);
      if (any?.dynastyStatus === "deprecated") throw new ScriptCatalogueError(410, "dynasty_retired", `${input.outcome}/${input.dynasty} is retired: it does not run`);
    }
  }
  if (!row) throw new ScriptCatalogueError(404, "not_found", `no ${input.version !== undefined ? `version ${input.version} of ` : "active version of "}${input.outcome}/${input.dynasty}`);
  if (row.dynastyStatus !== "active") throw new ScriptCatalogueError(410, "dynasty_retired", `${input.outcome}/${input.dynasty} is retired: it does not run`);
  // A port runs for real only once proven (writes already refuse an unproven version; this guards a case loaded later).
  const cases = await caseCount(db, row.outcome, row.dynasty);
  if (cases > 0 && (!row.replay || row.replay.cases !== cases || row.replay.matches !== cases)) {
    throw new ScriptCatalogueError(
      409,
      "not_proven",
      `${row.outcome}/${row.dynasty}/v${row.version} is a port with ${cases} recorded cases and is not proven on all of them (${row.replay?.matches ?? 0}/${row.replay?.cases ?? 0}): replay it, then upgrade`,
    );
  }
  return row;
}

/** Run a stored script as a step. Opens, declares and closes its runs-service run. */
export async function runStoredScript(
  db: AnyPgDb,
  input: RunScriptInput,
  who: RunIdentity,
  deps: { ledger: LedgerDeps; vendors: VendorDeps },
): Promise<ScriptRunResult> {
  const row = await resolveVersion(db, input);
  const scriptSlug = `${row.outcome}/${row.dynasty}/v${row.version}`;
  const runId = await deps.ledger.createRun({
    parentRunId: who.parentRunId,
    orgId: who.orgId,
    userId: who.userId,
    taskName: scriptTaskName(row.outcome, row.dynasty),
    headers: who.headers,
  });
  const [record] = await db
    .insert(scriptRuns)
    .values({ scriptId: row.id, orgId: who.orgId, runId, parentRunId: who.parentRunId, subject: input.subject, status: "running" })
    .returning({ id: scriptRuns.id });

  const tactics = { ...row.tactics, ...(input.tactics ?? {}) };
  const vendorHeaders = { ...who.headers, "x-org-id": who.orgId, "x-user-id": who.userId, "x-run-id": runId };
  const gotten = new Map<string, number>();
  const consumed: OccurrenceInput[] = [];
  const vendorCalls: ScriptRunResult["vendorCalls"] = [];
  const trace: NonNullable<ScriptRunResult["trace"]> = [];

  const bridge: Bridge = async (op, args) => {
    if (op === "get") {
      const outcome = String(args[0]);
      const held = input.units[outcome];
      if (held === undefined) return { stop: `the script asked for ${outcome}, which this step was not handed (materials: ${Object.keys(input.units).join(", ") || "none"})` };
      const n = gotten.get(outcome) ?? 0;
      const list = Array.isArray(held) ? held : [held];
      if (n >= list.length) return { stop: `the script asked for ${outcome} a ${n + 1}th time; this step holds ${list.length}` };
      gotten.set(outcome, n + 1);
      const unit = list[n]!;
      if (unit.subject) consumed.push({ outcomeKey: outcome, subjectService: unit.subject.service, subjectId: unit.subject.id });
      return { v: { id: `${runId}:${outcome}:${n}`, outcome, subject: unit.subject?.id ?? "", ageDays: 0, content: unit.content } };
    }
    if (op === "vendor") {
      const name = String(args[0]);
      const t = Date.now();
      let exchange: { sent: Record<string, unknown>; raw: Record<string, unknown> } | null = null;
      const answer = await callVendor(
        name,
        (args[1] ?? null) as Record<string, unknown> | null,
        { headers: vendorHeaders, tactics, ...(input.trace ? { onCompletion: (x) => (exchange = x) } : {}) },
        deps.vendors,
      );
      vendorCalls.push({ name, ok: answer.ok, ms: Date.now() - t, ...(answer.ok ? {} : { error: String(answer.data.error ?? "").slice(0, 300) }) });
      if (input.trace) trace.push({ name, args: args[1] ?? null, answer, ...(exchange ? (exchange as { sent: Record<string, unknown>; raw: Record<string, unknown> }) : {}) });
      return { v: answer };
    }
    if (op === "storage.get" || op === "storage.set" || op === "storage.delete" || op === "storage.count") {
      return { v: await storageOp(db, who.orgId, row.outcome, op, args) };
    }
    if (op === "ask") return { stop: "ctx.ask: no Provider serves a run-subject piece to a stored script yet" };
    if (op === "accounts") return { stop: "ctx.accounts: connected accounts are not served to stored scripts yet" };
    if (op === "wait") return { stop: `the script asked to wait ${String(args[0])} days: a stored script step does not wait` };
    return { stop: `${String(op)} is not a script context call` };
  };

  const out = await runScript(row.code, { subject: input.subject.id, brand: who.headers["x-brand-id"] ?? "", day: Math.floor(Date.now() / 86_400_000), tactics, request: input.request ?? null }, bridge);
  const made = out.kind === "done" && out.result !== null && typeof out.result === "object" ? (out.result as NonNullable<ScriptResult>) : null;
  const status: ScriptRunResult["status"] = out.kind === "error" ? "failed" : out.kind === "stopped" ? "stopped" : made && made.content ? "made" : "nothing";
  // A Unit recorded by its owning service is declared there (one declaration, never two).
  const produced: OccurrenceInput[] =
    status === "made" && !input.recordedBy ? [{ outcomeKey: row.outcome, subjectService: input.subject.service, subjectId: input.subject.id }] : [];
  if (input.recordedBy) consumed.length = 0;
  let error: string | null = out.kind === "error" ? out.message : out.kind === "stopped" ? out.reason : null;

  let declaredOk = true;
  if (produced.length > 0 || consumed.length > 0) {
    try {
      await deps.ledger.declareOutcomes(runId, who.orgId, { produced, consumed });
    } catch (e) {
      declaredOk = false;
      error = `${error ? `${error}; ` : ""}the ledger refused the declaration: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const finalStatus: ScriptRunResult["status"] = declaredOk ? status : "failed";
  const result: ScriptRunResult = {
    scriptId: row.id,
    scriptSlug,
    version: row.version,
    runId,
    status: finalStatus,
    unit: finalStatus === "made" && made?.content ? { outcome: row.outcome, subject: input.subject, content: made.content, ...(made.found ? { found: made.found } : {}) } : null,
    error,
    vendorCalls,
    declared: { produced: declaredOk ? produced : [], consumed: declaredOk ? consumed : [] },
    ...(input.recordedBy ? { recordedBy: input.recordedBy } : {}),
    ...(input.trace ? { trace } : {}),
  };
  await deps.ledger.closeRun(runId, finalStatus === "made" || finalStatus === "nothing" ? "completed" : "failed", who.orgId);
  await db
    .update(scriptRuns)
    .set({
      status: finalStatus,
      result: result.unit,
      error,
      vendorCalls,
      declared: result.declared,
      finishedAt: new Date(),
    })
    .where(eq(scriptRuns.id, record!.id));
  if (finalStatus === "failed" || finalStatus === "stopped") throw new ScriptRunFailed(result);
  return result;
}

/** An Engine's storage, scoped to (org, outcome): a script never reads another org's or another Engine's notes. */
async function storageOp(db: AnyPgDb, orgId: string, outcome: string, op: string, args: unknown[]): Promise<unknown> {
  const table = String(args[0] ?? "");
  if (!table || table.length > 64) throw new Error("storage: a table name is 1-64 characters");
  const scope = and(eq(scriptStorage.orgId, orgId), eq(scriptStorage.outcome, outcome), eq(scriptStorage.tableName, table));
  if (op === "storage.count") {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(scriptStorage).where(scope);
    return Number(row?.n ?? 0);
  }
  const key = String(args[1] ?? "");
  if (!key || key.length > 512) throw new Error("storage: a key is 1-512 characters");
  const where = and(scope, eq(scriptStorage.key, key));
  if (op === "storage.get") {
    const [row] = await db.select({ value: scriptStorage.value }).from(scriptStorage).where(where);
    return row ? row.value : null;
  }
  if (op === "storage.delete") {
    await db.delete(scriptStorage).where(where);
    return null;
  }
  const value = args[2] ?? null;
  if (JSON.stringify(value).length > 64_000) throw new Error("storage: a note is at most 64 KB of JSON");
  await db
    .insert(scriptStorage)
    .values({ orgId, outcome, tableName: table, key, value })
    .onConflictDoUpdate({ target: [scriptStorage.orgId, scriptStorage.outcome, scriptStorage.tableName, scriptStorage.key], set: { value, updatedAt: new Date() } });
  return null;
}

/** The production ledger: runs-service with this service's key. */
export function productionLedgerDeps(): LedgerDeps {
  const base = (process.env.RUNS_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.RUNS_SERVICE_API_KEY ?? "";
  const need = () => {
    if (!base || !key) throw new Error("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be set to run scripts");
  };
  return {
    async createRun(opts) {
      need();
      const headers: Record<string, string> = { ...opts.headers, "content-type": "application/json", "x-api-key": key, "x-org-id": opts.orgId, "x-user-id": opts.userId, "x-run-id": opts.parentRunId };
      const res = await fetch(`${base}/v1/runs`, { method: "POST", headers, body: JSON.stringify({ serviceName: "workflow", taskName: opts.taskName }), signal: AbortSignal.timeout(600_000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`runs-service POST /v1/runs -> ${res.status}: ${text.slice(0, 300)}`);
      return (JSON.parse(text) as { id: string }).id;
    },
    async declareOutcomes(runId, orgId, body) {
      need();
      const res = await fetch(`${base}/v1/runs/${encodeURIComponent(runId)}/outcomes`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "x-org-id": orgId },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`runs-service POST /v1/runs/${runId}/outcomes -> ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
    async closeRun(runId, status, orgId) {
      need();
      const res = await fetch(`${base}/v1/runs/${encodeURIComponent(runId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-api-key": key, "x-org-id": orgId },
        body: JSON.stringify({ status }),
        signal: AbortSignal.timeout(600_000),
      });
      if (!res.ok) throw new Error(`runs-service PATCH /v1/runs/${runId} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    },
  };
}
