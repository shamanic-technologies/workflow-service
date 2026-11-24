/**
 * FACTORY-P2-ENGINES: one production order of a stored script, as a workflow STEP (`POST /orgs/scripts/run`, called
 * by an `http.call` node like `/orgs/figures/read`).
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
import { asksOf, runScript, type Bridge, type ScriptResult } from "./sandbox.js";
import { callVendor, readProvider, type VendorDeps } from "./vendors.js";
import { providerTag } from "./provider-index.js";
import { ScriptCatalogueError, activeVersion, caseCount, dynastyVersions, type AnyPgDb } from "./script-catalogue.js";
import { needsOfAsk, pickScript } from "./engine.js";
import { recordWriterCase, type RecordedCall } from "./writer-proof.js";

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
  /**
   * Who or what the Unit it makes is about: the subject its produced outcome is declared on. Absent (an Engine run that
   * finds its own subject, e.g. a proactive campaign's find): the Unit the script makes names it (`result.subject`).
   */
  subject?: SubjectRef;
  /**
   * The subject when neither the run nor the Unit names one (ONE-WRITER-N-MODELS-1116-OTHERS: an asked child, e.g. a
   * completion, is about what its asker is about, else about the asking run).
   */
  fallbackSubject?: SubjectRef;
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
  /**
   * The units were HANDED by an asking script (`ctx.ask`, MIGRATE-1105 S1b): they are the work it ordered, so once this
   * run makes its Unit or states why not (`unmade`), each one naming a subject is consumed here, read or not (the rep
   * call consumes the reply or form fill the answering script handed it, as the old workflow declared). Never on a run
   * that makes nothing, fails or stops.
   */
  consumesHanded?: boolean;
  /**
   * Who pays the vendors: `platform` only through the service-key door `POST /internal/scripts/run` (a service's own
   * sweep with no org request, billed as that service's own code was: chat-service's platform doors, on this run).
   */
  billing?: "org" | "platform";
  /**
   * PLAN-RECURSIVE-PER-ENGINE-1124: the Engines asked above this run, the top one first (absent = this run is the top).
   * A Unit this run reads without holding it is asked of its Engine, never one already in the chain (nor this one).
   */
  askChain?: string[];
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
  /** `scriptSlug` (`<outcome>/<dynasty>/v<version>`): the stored script the run executes, stated to runs-service so the ledger
   *  measures each script apart (MON-SCRIPT-PRICES-2-1111); absent on a run that executes none (an idle Engine run). */
  createRun(opts: { parentRunId: string; orgId: string; userId: string; taskName: string; scriptSlug?: string; headers: Record<string, string> }): Promise<string>;
  declareOutcomes(runId: string, orgId: string, body: { produced: OccurrenceInput[]; consumed: OccurrenceInput[] }): Promise<Record<string, unknown>>;
  closeRun(runId: string, status: "completed" | "failed", orgId: string): Promise<void>;
  /**
   * LEDGER-HISTORY-1024: a run that by design produces no outcome states which support function it served (runs-service
   * owner door), so its spend reads support instead of undeclared. Optional: only an Engine run whose script states
   * tactic `support` asks it.
   */
  markSupport?(runId: string, mark: { kind: string; reason: string; markedBy: string }): Promise<void>;
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
  /** `unmade` = no Unit for a reason the world gave (the script's `unmade`), never an error. */
  status: "made" | "nothing" | "unmade" | "waiting" | "stopped" | "failed";
  unit: { outcome: string; subject: SubjectRef | null; content: Record<string, unknown>; found?: string } | null;
  error: string | null;
  /** On `unmade`: the script said the look did not finish (ask again soon, never idle). */
  again?: boolean;
  /** On `unmade`: the script's own decision (`done` = completed look, `idle` = nothing to do now), never a refusal. */
  decided?: "done" | "idle";
  /** On `unmade`: what the script decided, handed back to the script that asked it (never a Unit). */
  answer?: Record<string, unknown>;
  vendorCalls: Array<{ name: string; ok: boolean; error?: string; ms: number; brandToolCalls?: number }>;
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

/**
 * MIGRATE-1105 S0, an Engine run (engine-runner.ts): the caller opened the run itself (named by the script) and closes
 * it after the campaign's `/end-run`; a script that asks to wait (`ctx.wait(days)`) stops, its wait recorded by the
 * caller (`onWait`), and its run ends `waiting` (resumed later), never failed.
 */
export interface OwnedRun {
  runId: string;
  onWait(days: number): Promise<void>;
}

const WAIT_STOP = "__wait__:";
/** An asked Engine made nothing for a Unit the script read without holding it: the script ends `unmade` with that reason. */
const UNMADE_STOP = "__unmade__:";

/** The code a run states when a Unit it reads would be asked of an Engine already asked above it (a loop). */
export const ASK_CYCLE = "ask_cycle";

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
  owned?: OwnedRun,
): Promise<ScriptRunResult> {
  const row = await resolveVersion(db, input);
  const scriptSlug = `${row.outcome}/${row.dynasty}/v${row.version}`;
  const runId =
    owned?.runId ??
    (await deps.ledger.createRun({
      parentRunId: who.parentRunId,
      orgId: who.orgId,
      userId: who.userId,
      taskName: scriptTaskName(row.outcome, row.dynasty),
      scriptSlug,
      headers: who.headers,
    }));
  const [record] = await db
    .insert(scriptRuns)
    .values({ scriptId: row.id, orgId: who.orgId, runId, parentRunId: who.parentRunId, subject: input.subject ?? null, status: "running" })
    .returning({ id: scriptRuns.id });

  const tactics = { ...row.tactics, ...(input.tactics ?? {}) };
  const vendorHeaders = { ...who.headers, "x-org-id": who.orgId, "x-user-id": who.userId, "x-run-id": runId };
  const gotten = new Map<string, number>();
  const consumed: OccurrenceInput[] = [];
  // ONE-WRITER-N-MODELS-1116: the Units asked children made, consumed by this run even when its own Unit is declared
  // by the owning service (`recordedBy`): only this run knows it asked them.
  const askedConsumed: OccurrenceInput[] = [];
  // ENGINE-GET-ASK-1123 (owner 2026-11-23, option A): the Units the SCRIPT says it used (`ctx.consume`), e.g. one it
  // read from a Provider and reused. A read alone declares nothing; like the asked ones, only this run knows them, so
  // they are declared here even when its own Unit is declared by the owning service (`recordedBy`).
  const usedConsumed: OccurrenceInput[] = [];
  const vendorCalls: ScriptRunResult["vendorCalls"] = [];
  const trace: NonNullable<ScriptRunResult["trace"]> = [];

  // The Request this run hands the next piece it orders (`ctx.ask`), consumed by that `ctx.get`.
  let asked: Record<string, unknown> | null = null;
  // PLAN-RECURSIVE-PER-ENGINE-1124: the Units asked of their Engine because the script read them without holding them.
  const implicit = new Map<string, unknown>();
  // PROVEN-BEFORE-PEOPLE-1116: what this run saw, kept as a case of its Engine when its script writes to a person.
  const recorded: RecordedCall[] = [];
  const askedUnits: Record<string, unknown> = {};
  // ENGINE-GET-ASK-1123: the Units the direct asks (`ctx.ask(outcome, inputs)`) got, in order (a case replays them so).
  const orders: Array<{ outcome: string; unit: unknown }> = [];
  // The run's own tactics (the row's, then what the caller stated), as every vendor call reads them.
  const asks = asksOf({ tactics, code: row.code });
  // PLAN-RECURSIVE-PER-ENGINE-1124: the Engines asked down to this run (this one last): never asked again below it.
  const chain = [...(input.askChain ?? []), row.outcome];

  /** Order ONE new Unit of an outcome from its Engine (the Rating's pick, a child run), consumed by this run. */
  const order = async (outcome: string, request: Record<string, unknown>) => {
    const provided = await provide(db, outcome, request, { orgId: who.orgId, userId: who.userId, runId, subject: input.subject ?? null, headers: who.headers, askedBy: `${row.outcome}/${row.dynasty}`, chain, billing: input.billing, ...(input.trace ? { trace } : {}) }, deps);
    if ("v" in provided) {
      askedUnits[outcome] = provided.v;
      // ONE-WRITER-N-MODELS-1116: the Unit an asked child made is consumed by the asking run (a completion by its
      // writer, a written message by its sender), so the ledger's chain links them and the child is credited with
      // what the asker's work led to.
      const made = provided.v as { content?: unknown; run?: { unit?: { subject?: SubjectRef | null } | null } | null };
      const sub = made.content ? made.run?.unit?.subject : null;
      if (sub && !askedConsumed.some((c) => c.outcomeKey === outcome && c.subjectService === sub.service && c.subjectId === sub.id)) {
        askedConsumed.push({ outcomeKey: outcome, subjectService: sub.service, subjectId: sub.id });
      }
    }
    return provided;
  };

  const bridge: Bridge = async (op, args) => {
    if (op === "get" && args.length > 1) {
      // ENGINE-GET-ASK-1123, `ctx.get(outcome, filters)`: READ Units that exist, from the outcome's Provider.
      const outcome = String(args[0]);
      const name = providerTag(outcome);
      const t = Date.now();
      const read = await readProvider(outcome, args[1], { headers: vendorHeaders, tactics, billing: input.billing ?? "org", callerRunId: who.parentRunId, outcome: row.outcome }, deps.vendors);
      if ("stop" in read) return read;
      const answer = read.answer;
      vendorCalls.push({ name, ok: answer.ok, ms: Date.now() - t, ...(answer.ok ? {} : { error: String(answer.data.error ?? "").slice(0, 300) }) });
      recorded.push({ name, args: args[1] ?? null, answer });
      if (input.trace) trace.push({ name, args: args[1] ?? null, answer });
      return { v: answer };
    }
    if (op === "get") {
      const outcome = String(args[0]);
      const held = input.units[outcome];
      if (held === undefined && asked) {
        const request = asked;
        asked = null;
        return order(outcome, request);
      }
      if (held === undefined) {
        // PLAN-RECURSIVE-PER-ENGINE-1124: a Unit this run does not hold is asked of its Engine (the Rating's pick among
        // what the campaign's strategy keeps there, one level deeper; its own missing Units the same way), once per
        // outcome; an Engine already asked above never again. Made nothing = this script makes nothing, for that reason.
        if (chain.includes(outcome)) return { stop: `${UNMADE_STOP}${ASK_CYCLE}: ${outcome} is already asked above this run (${chain.join(" > ")})` };
        if (!implicit.has(outcome)) {
          const got = await order(outcome, { units: {} });
          if ("stop" in got) return got;
          const unit = got.v as { content?: unknown; unmade?: unknown };
          if (!unit.content) return { stop: `${UNMADE_STOP}${typeof unit.unmade === "string" && unit.unmade ? unit.unmade : `${outcome} made nothing`}` };
          implicit.set(outcome, got.v);
        }
        return { v: implicit.get(outcome) };
      }
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
        { headers: vendorHeaders, tactics, billing: input.billing ?? "org", callerRunId: who.parentRunId, outcome: row.outcome, asks, ...(input.trace ? { onCompletion: (x) => (exchange = x) } : {}) },
        deps.vendors,
      );
      // BRAND-TOOLS-EVERY-SCRIPT-1109: how many brand tool calls a completion made, on the run's record (any vendor that serves it).
      const brandToolCalls = answer.ok && typeof answer.data.brandToolCalls === "number" ? answer.data.brandToolCalls : undefined;
      vendorCalls.push({ name, ok: answer.ok, ms: Date.now() - t, ...(answer.ok ? {} : { error: String(answer.data.error ?? "").slice(0, 300) }), ...(brandToolCalls !== undefined ? { brandToolCalls } : {}) });
      recorded.push({ name, args: args[1] ?? null, answer });
      if (input.trace) trace.push({ name, args: args[1] ?? null, answer, ...(exchange ? (exchange as { sent: Record<string, unknown>; raw: Record<string, unknown> }) : {}) });
      return { v: answer };
    }
    if (op === "storage.get" || op === "storage.set" || op === "storage.delete" || op === "storage.count" || op === "storage.claim") {
      return { v: await storageOp(db, who.orgId, row.outcome, op, args) };
    }
    if (op === "ask" && typeof args[0] === "string") {
      // ENGINE-GET-ASK-1123, `ctx.ask(outcome, inputs)`: MAKE one new Unit now and hand it back. The same order as
      // `ctx.ask(request)` then `ctx.get(outcome)`; `inputs` is that Request as stated, no `units` = none handed.
      const outcome = args[0];
      const inputs = args[1] ?? {};
      if (typeof inputs !== "object" || Array.isArray(inputs)) return { stop: `ctx.ask(${outcome}, inputs): inputs is one object (what that Engine's scripts take)` };
      const request = inputs as Record<string, unknown>;
      const provided = await order(outcome, request.units === undefined || request.units === null ? { ...request, units: {} } : request);
      if ("v" in provided) orders.push({ outcome, unit: provided.v });
      return provided;
    }
    if (op === "ask") {
      const request = args[0];
      if (!request || typeof request !== "object" || Array.isArray(request)) return { stop: "ctx.ask takes one Request object" };
      asked = request as Record<string, unknown>;
      return { v: null };
    }
    if (op === "consume") {
      const outcome = typeof args[0] === "string" ? args[0].trim() : "";
      if (!outcome) return { stop: "ctx.consume(outcome, subject): outcome is the Unit's outcome, a literal string" };
      const sub = subjectOf(args[1]);
      if (!sub) return { stop: `ctx.consume(${outcome}, subject): subject is {service, id}, the subject the Unit is declared under on the ledger (as its Provider states it)` };
      if (!usedConsumed.some((c) => c.outcomeKey === outcome && c.subjectService === sub.service && c.subjectId === sub.id)) {
        usedConsumed.push({ outcomeKey: outcome, subjectService: sub.service, subjectId: sub.id });
      }
      return { v: null };
    }
    if (op === "accounts") return { stop: "ctx.accounts: connected accounts are not served to stored scripts yet" };
    if (op === "wait") {
      const days = Number(args[0]);
      if (!owned) return { stop: `the script asked to wait ${String(args[0])} days: a stored script step does not wait` };
      if (!Number.isFinite(days) || days < 0 || days > 365) return { stop: `ctx.wait takes 0 to 365 days, not ${String(args[0])}` };
      await owned.onWait(days);
      return { stop: `${WAIT_STOP}${days}` };
    }
    return { stop: `${String(op)} is not a script context call` };
  };

  const day = Math.floor(Date.now() / 86_400_000);
  const out = await runScript(row.code, { subject: input.subject?.id ?? null, brand: who.headers["x-brand-id"] ?? "", day, tactics, request: input.request ?? null }, bridge);
  const made = out.kind === "done" && out.result !== null && typeof out.result === "object" ? (out.result as NonNullable<ScriptResult>) : null;
  const waited = out.kind === "stopped" && out.reason.startsWith(WAIT_STOP);
  const unmadeBelow = out.kind === "stopped" && out.reason.startsWith(UNMADE_STOP) ? out.reason.slice(UNMADE_STOP.length) : null;
  let status: ScriptRunResult["status"] = out.kind === "error" ? "failed" : waited ? "waiting" : unmadeBelow !== null ? "unmade" : out.kind === "stopped" ? "stopped" : made && made.content ? "made" : made && typeof made.unmade === "string" && made.unmade ? "unmade" : "nothing";
  // The subject a Unit is about: the run's, else the one the Unit names (an Engine run that found its own subject).
  const subject: SubjectRef | null = input.subject ?? subjectOf(made?.subject) ?? input.fallbackSubject ?? null;
  let error: string | null = out.kind === "error" ? out.message : waited ? `waits ${out.reason.slice(WAIT_STOP.length)} days` : unmadeBelow !== null ? unmadeBelow : out.kind === "stopped" ? out.reason : status === "unmade" ? made!.unmade! : null;
  if (status === "made" && !input.recordedBy && !subject) {
    status = "failed";
    error = "the script made a Unit without naming who it is about (`subject: {service, id}` in its result): nothing can be declared on the ledger";
  }
  // A Unit recorded by its owning service is declared there (one declaration, never two).
  const produced: OccurrenceInput[] =
    status === "made" && !input.recordedBy && subject ? [{ outcomeKey: row.outcome, subjectService: subject.service, subjectId: subject.id }] : [];
  if (input.consumesHanded && (status === "made" || status === "unmade")) {
    for (const [outcome, held] of Object.entries(input.units)) {
      for (const unit of Array.isArray(held) ? held : [held]) {
        if (!unit.subject) continue;
        if (consumed.some((c) => c.outcomeKey === outcome && c.subjectService === unit.subject!.service && c.subjectId === unit.subject!.id)) continue;
        consumed.push({ outcomeKey: outcome, subjectService: unit.subject.service, subjectId: unit.subject.id });
      }
    }
  }
  if (input.recordedBy) consumed.length = 0;
  for (const c of [...askedConsumed, ...usedConsumed]) {
    if (!consumed.some((x) => x.outcomeKey === c.outcomeKey && x.subjectService === c.subjectService && x.subjectId === c.subjectId)) consumed.push(c);
  }

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
    unit:
      finalStatus === "made" && made?.content
        ? { outcome: row.outcome, subject, content: made.content, ...(made.found ? { found: made.found } : {}) }
        : null,
    error,
    ...(finalStatus === "unmade" && made?.again === true ? { again: true } : {}),
    ...(finalStatus === "unmade" && (made?.decided === "done" || made?.decided === "idle") ? { decided: made.decided } : {}),
    ...(finalStatus === "unmade" && made?.answer && typeof made.answer === "object" && !Array.isArray(made.answer) ? { answer: made.answer } : {}),
    vendorCalls,
    declared: { produced: declaredOk ? produced : [], consumed: declaredOk ? consumed : [] },
    ...(input.recordedBy ? { recordedBy: input.recordedBy } : {}),
    ...(input.trace ? { trace } : {}),
  };
  // A run the caller opened is closed by the caller (after the campaign's `/end-run`).
  if (!owned) await deps.ledger.closeRun(runId, finalStatus === "failed" || finalStatus === "stopped" ? "failed" : "completed", who.orgId);
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
  try {
    await recordWriterCase(db, row, {
      runId,
      orgId: who.orgId,
      body: { units: input.units, request: input.request ?? null, tactics: input.tactics ?? {}, subject: input.subject?.id ?? null, brand: who.headers["x-brand-id"] ?? "", day, calls: recorded, asked: askedUnits, ...(orders.length > 0 ? { orders } : {}) },
      made: finalStatus === "made",
    });
  } catch (e) {
    console.error(`[workflow-service] ${scriptSlug} run ${runId}: its writer case could NOT be kept: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (finalStatus === "failed" || finalStatus === "stopped") throw new ScriptRunFailed(result);
  return result;
}

/**
 * MIGRATE-1105 S2, a Provider piece: `ctx.ask(request)` then `ctx.get(<outcome>)` on an outcome the run does not hold
 * runs THAT Engine's script as a CHILD run of the asking script's run, and hands back its Unit. ONE mechanism for every
 * Engine: the child is picked by the same Rating as an Engine run (`pickScript`: fed by the Request's units, the
 * campaign's channel), runs with its own runs-service run (`script:<outcome>/<dynasty>`, same identity and campaign
 * headers, no workflow slug), its own `script_runs` row, so its Engine keeps its runs, Monitoring, guard and Rating.
 *
 * The Request: `units` (the child's materials, `{<outcome>: {content, subject?}}`), optional `request` (its
 * `ctx.request`), `tactics`, `subject`, `recordedBy`, `trace` (as `POST /orgs/scripts/run` takes them).
 * No candidate = an answer `unmade: "no_script: ..."` the asking script reads (never a fallback script). A child that
 * fails or stops stops the asking script with the child's reason (unmade / nothing = an answer); a child cannot wait (no nested waits
 * yet: its `ctx.wait` is refused like a step's). The Unit read back carries `run` = the child's whole result (the
 * `POST /orgs/scripts/run` answer), so a recording service can store and declare it on the child's run.
 */
/** The code an asked Engine answers when no script of it may run for this campaign. */
export const NO_SCRIPT = "no_script";

async function provide(
  db: AnyPgDb,
  outcome: string,
  request: Record<string, unknown>,
  parent: {
    orgId: string;
    userId: string;
    runId: string;
    /** The asking run's own subject (null when it names none until it ends, e.g. a post). */
    subject: SubjectRef | null;
    headers: Record<string, string>;
    askedBy: string;
    /** The Engines asked down to the asking run (it last): the child carries it, and none of them is asked again. */
    chain: string[];
    billing?: RunScriptInput["billing"];
    /**
     * The asking run's trace, when it is traced: the child is traced too and its calls land in it, in order, so a
     * reader of the asker's trace (content-generation reads the writer's one completion) sees the completion its
     * asked model made (ONE-WRITER-N-MODELS-1116: the writer asks a completion, it calls no LLM itself).
     */
    trace?: NonNullable<ScriptRunResult["trace"]>;
  },
  deps: { ledger: LedgerDeps; vendors: VendorDeps },
): Promise<{ v: unknown } | { stop: string }> {
  const rawUnits = request.units;
  if (!rawUnits || typeof rawUnits !== "object" || Array.isArray(rawUnits)) return { stop: `ctx.ask for ${outcome}: the Request names no units (the materials its script reads)` };
  const units: Record<string, MaterialUnit | MaterialUnit[]> = {};
  for (const [k, v] of Object.entries(rawUnits as Record<string, unknown>)) {
    const list = Array.isArray(v) ? v : [v];
    if (!list.every((u) => u && typeof u === "object" && (u as MaterialUnit).content && typeof (u as MaterialUnit).content === "object")) {
      return { stop: `ctx.ask for ${outcome}: unit ${k} is not {content, subject?}` };
    }
    units[k] = v as MaterialUnit | MaterialUnit[];
  }
  // PLAN-RECURSIVE-PER-ENGINE-1124: an Engine already asked above is never asked again: an answer, never a loop.
  if (parent.chain.includes(outcome)) return { v: { id: `${parent.runId}:${outcome}:${ASK_CYCLE}`, outcome, subject: "", ageDays: 0, content: null, unmade: `${ASK_CYCLE}: ${outcome} is already asked above this run (${parent.chain.join(" > ")})`, run: null } };
  const pick = await pickScript(db, { outcome, servable: Object.keys(units), handed: Object.keys(units), channel: parent.headers["x-feature-slug"] ?? null, campaignId: parent.headers["x-campaign-id"] ?? null, orgId: parent.headers["x-org-id"] ?? null, askedBy: parent.askedBy, needs: needsOfAsk(request), chain: parent.chain });
  // No script of that Engine this campaign may run (none live, or its strategy keeps none): an ANSWER the asking script
  // reads (`unmade: "no_script: ..."`, no content, no child run), never a fallback script and never a stop: the asker
  // decides (MIGRATE-1105 S1b: the answering script asks for a rep call, and a campaign whose strategy keeps no call
  // script still gets its answer).
  if (!pick) return { v: { id: `${parent.runId}:${outcome}:no_script`, outcome, subject: "", ageDays: 0, content: null, unmade: `${NO_SCRIPT}: no live script of that Engine can run on ${Object.keys(units).join(", ") || "nothing"}`, run: null } };
  const headers = { ...parent.headers };
  delete headers["x-workflow-slug"];
  // ONE-WRITER-N-MODELS-1116-OTHERS: an ask naming no subject, whose child names none either, makes a Unit about the
  // asker's own subject (a reply judge's completion is about the reply it judges), else about the asking RUN itself
  // (a post's reading completions are about the run that asked them): never a Unit about nobody, so the asker's
  // consumption links the chain.
  const subject = subjectOf(request.subject);
  const fallbackSubject: SubjectRef = parent.subject ?? { service: "runs-service", id: parent.runId };
  let child: ScriptRunResult;
  try {
    child = await runStoredScript(
      db,
      {
        outcome,
        dynasty: pick.script.dynasty,
        version: pick.script.version,
        units,
        ...(subject ? { subject } : { fallbackSubject }),
        ...(request.request && typeof request.request === "object" ? { request: request.request as Record<string, unknown> } : {}),
        ...(request.tactics && typeof request.tactics === "object" ? { tactics: request.tactics as Record<string, unknown> } : {}),
        ...(typeof request.recordedBy === "string" ? { recordedBy: request.recordedBy } : {}),
        ...(request.trace === true || parent.trace ? { trace: true } : {}),
        consumesHanded: true,
        askChain: parent.chain,
        // A child bills as its asker does (a platform-billed run's asked completion is platform-billed too).
        ...(parent.billing ? { billing: parent.billing } : {}),
      },
      { orgId: parent.orgId, userId: parent.userId, parentRunId: parent.runId, headers },
      deps,
    );
  } catch (e) {
    if (e instanceof ScriptRunFailed) {
      if (parent.trace && e.result.trace) parent.trace.push(...e.result.trace);
      return { stop: `${e.result.scriptSlug} (asked for ${outcome}) ${e.result.status}: ${e.result.error ?? ""}` };
    }
    return { stop: `ctx.get(${outcome}): ${e instanceof Error ? e.message : String(e)}` };
  }
  if (parent.trace && child.trace) parent.trace.push(...child.trace);
  // A child that made no Unit for a reason the world gave (`unmade`, or nothing) is an ANSWER the asking script reads
  // (`{outcome, unmade, run}`, no content) and decides on, e.g. by returning `{unmade}` itself: a stop would fail the
  // asking run and the campaign would redeliver its occurrence, re-running the child for the same verdict.
  if (child.status === "unmade" || child.status === "nothing") {
    // `decided`: the child's own decision (a child that made nothing at all = nothing to do now), so an asking script
    // that forwards the answer states it as such, never as a refusal (MON-UNSENT-RED-1111).
    const decided = child.status === "nothing" ? "idle" : child.decided;
    return { v: { id: `${child.runId}:${outcome}`, outcome, subject: "", ageDays: 0, content: null, unmade: child.error ?? "nothing", ...(decided ? { decided } : {}), ...(child.answer ? { answer: child.answer } : {}), run: child } };
  }
  if (child.status !== "made" || !child.unit) return { stop: `${child.scriptSlug} (asked for ${outcome}) made no Unit: ${child.status}${child.error ? ` (${child.error})` : ""}` };
  return { v: { id: `${child.runId}:${outcome}`, outcome, subject: child.unit.subject?.id ?? "", ageDays: 0, content: child.unit.content, run: child } };
}

function subjectOf(v: unknown): SubjectRef | null {
  if (!v || typeof v !== "object") return null;
  const { service, id } = v as { service?: unknown; id?: unknown };
  return typeof service === "string" && service.trim() && typeof id === "string" && id.trim() ? { service: service.trim(), id: id.trim() } : null;
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
  if (op === "storage.claim") {
    // Insert-if-absent, atomic (the unique key): the FIRST note written under the key wins and every caller reads the
    // winner's note back, so two runs racing on one key cannot both believe they own it (SCRIPT-VALUE-RATING-1113-WF1).
    await db.insert(scriptStorage).values({ orgId, outcome, tableName: table, key, value }).onConflictDoNothing();
    const [row] = await db.select({ value: scriptStorage.value }).from(scriptStorage).where(where);
    return row ? row.value : null;
  }
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
      if (!opts.orgId) {
        // A PLATFORM run (fleet work, no org): child of the caller's own platform run.
        const res = await fetch(`${base}/v1/platform-runs`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key, "x-service-name": "workflow" },
          body: JSON.stringify({ serviceName: "workflow", taskName: opts.taskName, parentRunId: opts.parentRunId, ...(opts.scriptSlug ? { scriptSlug: opts.scriptSlug } : {}) }),
          signal: AbortSignal.timeout(600_000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`runs-service POST /v1/platform-runs -> ${res.status}: ${text.slice(0, 300)}`);
        return (JSON.parse(text) as { id: string }).id;
      }
      const headers: Record<string, string> = { ...opts.headers, "content-type": "application/json", "x-api-key": key, "x-org-id": opts.orgId, "x-user-id": opts.userId, "x-run-id": opts.parentRunId };
      // A service's own sweep runs for an org with no person behind it (instantly's reply-judging run): no user.
      if (!opts.userId) delete headers["x-user-id"];
      const res = await fetch(`${base}/v1/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ serviceName: "workflow", taskName: opts.taskName, ...(opts.scriptSlug ? { scriptSlug: opts.scriptSlug } : {}) }),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`runs-service POST /v1/runs -> ${res.status}: ${text.slice(0, 300)}`);
      return (JSON.parse(text) as { id: string }).id;
    },
    async declareOutcomes(runId, orgId, body) {
      need();
      if (!orgId) throw new Error("a platform run (no org) declares nothing here: its occurrences are its caller service's (recordedBy)");
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
      if (!orgId) {
        const res = await fetch(`${base}/v1/platform-runs/${encodeURIComponent(runId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-api-key": key, "x-service-name": "workflow" },
          body: JSON.stringify({ status }),
          signal: AbortSignal.timeout(600_000),
        });
        if (!res.ok) throw new Error(`runs-service PATCH /v1/platform-runs/${runId} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
        return;
      }
      const res = await fetch(`${base}/v1/runs/${encodeURIComponent(runId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-api-key": key, "x-org-id": orgId },
        body: JSON.stringify({ status }),
        signal: AbortSignal.timeout(600_000),
      });
      if (!res.ok) throw new Error(`runs-service PATCH /v1/runs/${runId} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    },
    async markSupport(runId, mark) {
      need();
      const res = await fetch(`${base}/v1/platform-runs/support-marks/apply`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "x-service-name": "workflow" },
        body: JSON.stringify({ ...mark, runIds: [runId] }),
        signal: AbortSignal.timeout(600_000),
      });
      if (!res.ok) throw new Error(`runs-service POST /v1/platform-runs/support-marks/apply -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    },
  };
}
