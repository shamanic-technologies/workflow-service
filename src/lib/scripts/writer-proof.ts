/**
 * PROVEN-BEFORE-PEOPLE-1116 (owner 2026-11-16: « ok pour les tests ou le monitoring. Attention à maîtriser les dépenses
 * toutefois »; DIS-800: `message_sent/dy_answer_lead` on GLM Flash wrote 6 broken emails of ~11 to real prospects,
 * "cold_email_followup", "M3", "subject: ...", with no recorded case that could have shown it first).
 *
 * A WRITER combination (a script version whose code sends to a person, `writesToPerson`, with the LLM and template its
 * tactics state) writes to real people only once it has answered a bounded sample of REAL recorded cases usably.
 * One mechanism for every Engine, never a branch on a model, a script, a channel or a client:
 *
 * 1. CASES. Every production run of a writer script that reached an LLM (`llm.complete` / `chat.complete`) is kept as a
 *    case of its Engine (`writer_cases`, newest `CASES_KEPT_PER_ENGINE` per Engine): the Request, the materials, the run's
 *    tactics and every vendor call with its request and answer, as production saw them. Real personal data: never in git.
 *
 * 2. A PROOF of one version: the script runs in its own sandbox on up to `PROOF_SAMPLE` cases its code can be fed (its
 *    materials held, the cases its own code recorded first). Its LLM calls go LIVE with ITS tactics (platform-billed on
 *    one platform run, support `product_feature`, `brandTools: false`: a proof never acts through a brand's tools);
 *    every other call is answered from the record and NOTHING is sent, booked or written: before its first LLM call a
 *    call the record does not hold is refused (the case does not fit this code: it is skipped, never counted), after it
 *    an unrecorded act is acknowledged. A case is USABLE when the script read the answer without failing AND every field
 *    a person would read (`TO_PERSON_DOORS`) of what it would send is judged a usable value for that field by Jev
 *    (P(yes) >= 0.5), never a regex. Only a case where it WROTE (sent a person something) or broke counts: one where it
 *    decided to send nothing (later, stop: every night-time case) proves nothing about its writing and is passed over.
 *    The first unusable case ends the proof `failed` (no more spend on it); `PROOF_SAMPLE` written usable cases =
 *    `passed`; the spend is bounded from the tokens chat-service answers, priced at the
 *    priciest list rates we buy (`PRICE_BOUND_*`, so the bound is never below the real spend), and the proof stops
 *    `error` at `PROOF_CEILING_CENTS`. Fewer fitting cases = `no_cases` (nothing proven, nothing refused).
 *
 * 3. THE GATE, per Engine (`writer_proof_engines.enforced`, a staff switch, so an Engine is enforced only once its
 *    combinations were proven, never leaving its campaigns with no script): the Rating draws a writer version of an
 *    enforced Engine only when its latest proof passed (or it cannot be proven: fewer than `PROOF_SAMPLE` fitting
 *    cases). An unproven version is proven ONCE in the background the first time the Rating meets it (`auto`); a failed
 *    one stays out until staff re-prove it; an interrupted one is retried at most `AUTO_ATTEMPTS` times. Never a
 *    validator, retry or rewrite on a live send: the proof happens before.
 *
 * 4. A WRITER THAT ASKS ITS MODEL (ONE-WRITER-N-MODELS-1116-ANSWERER): a script that names no model asks the LLM
 *    completion Engine (tactic `asks` holds `llm_completion`) and hands its Unit to a sender, so neither half alone is
 *    the combination a person reads: the pair (writer version, completion script) is. Such a writer states the fields
 *    of its Unit a person reads (tactic `personFields`, dotted paths on its `content`, data, never a branch). Its runs
 *    are kept as cases of ITS Engine (`wrote` = it made its Unit); a pair's proof replays the writer on them with the
 *    completion answered LIVE by that completion script's own code and tactics, and Jev judges the Unit's person
 *    fields. The gate sits on the completion pick asked by such a writer of an enforced Engine: a model is drawn for
 *    that writer only once the pair passed (or cannot be proven yet). A sender that calls no LLM itself is not a
 *    writer combination: it is never gated, its writer's pairs are.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { scripts, writerCases, writerProofEngines, writerProofs, type ScriptRow, type WriterProofRow } from "../../db/schema.js";
import { runScript, type Bridge } from "./sandbox.js";
import { CHAT_COMPLETE, JEV_NOUL, LLM_COMPLETE, LLM_PICK, TEMPLATE_PICK, TO_PERSON_DOORS, callVendor, writesToPerson, type VendorDeps } from "./vendors.js";
import { sameJson, type VendorAnswer } from "./replay.js";
import type { AnyPgDb } from "./script-catalogue.js";

/** Cases one proof answers (owner: « maîtriser les dépenses »: a fixed, small sample). */
export const PROOF_SAMPLE = 5;
/**
 * Cases one proof may look at to find `PROOF_SAMPLE` it wrote on (a case that does not fit costs no LLM call; one where
 * it decided to send nothing costs one, bounded by this and the ceiling).
 */
export const PROOF_MAX_TRIES = 15;
/**
 * The most one proof spends, in US cents: $4, as an upper bound of its LLM spend at Opus list prices, checked after
 * each case (a 5-case proof of the lead answerer bounds at about $2; its real spend on a cheaper LLM is a fraction).
 */
export const PROOF_CEILING_CENTS = 400;
/**
 * The priciest list rates of a writer LLM we buy, US dollars per million tokens (Claude Opus class): the proof's spend
 * bound prices every token at these, so the real spend (chat-service declares it on the proof's run) is never above it.
 */
export const PRICE_BOUND_INPUT_PER_MTOK = 15;
export const PRICE_BOUND_OUTPUT_PER_MTOK = 75;
/** One Jev judgment's bound (it bills input only, a few thousand tokens). */
export const JUDGMENT_BOUND_CENTS = 1;
/** Cases kept per Engine (newest). */
export const CASES_KEPT_PER_ENGINE = 100;
/** An auto proof is retried this many times at most when it was interrupted (error, abandoned); a verdict never is. */
export const AUTO_ATTEMPTS = 3;
/** A running proof older than this was interrupted (a restart): it no longer holds its version out. */
export const PROOF_STALE_MS = 30 * 60_000;
/** Jev's P(yes) at or above which a field is usable. */
export const USABLE_PROBABILITY = 0.5;

const COMPLETIONS = new Set([LLM_COMPLETE, CHAT_COMPLETE]);
/** The Engine a writer asks for its model (ONE-WRITER-N-MODELS-1116). */
export const LLM_COMPLETION_OUTCOME = "llm_completion";
/** The writer tactic naming the fields of its Unit's content a person reads. */
export const PERSON_FIELDS_TACTIC = "personFields";

/** A script whose code calls an LLM door itself. */
export function callsCompletion(code: string): boolean {
  return [...COMPLETIONS].some((name) => code.includes(`"${name}"`) || code.includes(`'${name}'`));
}

/** A script that asks the LLM completion Engine for its model (tactic `asks`). */
export function asksCompletion(row: Pick<ScriptRow, "tactics">): boolean {
  const asks = ((row.tactics ?? {}) as Record<string, unknown>).asks;
  return Array.isArray(asks) && asks.includes(LLM_COMPLETION_OUTCOME);
}

/** The person-facing paths of its Unit a writer that asks its model states (tactic `personFields`); null = none stated. */
export function pairWriterFields(row: Pick<ScriptRow, "tactics">): string[] | null {
  const fields = ((row.tactics ?? {}) as Record<string, unknown>)[PERSON_FIELDS_TACTIC];
  if (!asksCompletion(row) || !Array.isArray(fields)) return null;
  const paths = fields.filter((f): f is string => typeof f === "string" && f.trim() !== "");
  return paths.length > 0 ? paths : null;
}

/**
 * A writer whose model is asked (ONE-WRITER-N-MODELS-1116-ANSWERER / -OTHERS): it asks `llm_completion` and a person
 * reads what it makes, either its Unit's `personFields` (it hands the message to a sender) or what it sends itself
 * (`TO_PERSON_DOORS`, e.g. the founder hello). Proven per (version, completion script).
 */
export function isPairWriter(row: Pick<ScriptRow, "tactics" | "code">): boolean {
  return asksCompletion(row) && (pairWriterFields(row) !== null || writesToPerson(row.code));
}
/** Tactics that name the combination (its LLM and template): a case's run never overrides the combination proven. */
const COMBINATION_TACTICS = ["llm", "llms", "template", "templates"];

export interface RecordedCall {
  name: string;
  args: unknown;
  answer: VendorAnswer;
}

/** A case as production saw it. */
export interface WriterCaseBody {
  units: Record<string, unknown>;
  request: Record<string, unknown> | null;
  tactics: Record<string, unknown>;
  subject: string | null;
  brand: string;
  day: number;
  calls: RecordedCall[];
  /** What an asked Engine answered (`ctx.ask` then `ctx.get(<outcome>)`), by outcome. */
  asked: Record<string, unknown>;
}

export const codeMd5 = (code: string) => createHash("md5").update(code).digest("hex");

/**
 * Keep one production run as a case of its Engine, when its script writes to a person and the run reached an LLM.
 * Returns whether it was kept. Never throws into the run: the caller logs a failure loudly.
 */
export async function recordWriterCase(db: AnyPgDb, row: ScriptRow, input: { runId: string; orgId: string; body: WriterCaseBody; made?: boolean }): Promise<boolean> {
  let wrote: boolean;
  if (isPairWriter(row)) {
    // A writer that asks its model: a case once it asked one; it wrote when it made its Unit for a sender, or sent.
    if (!(LLM_COMPLETION_OUTCOME in (input.body.asked ?? {}))) return false;
    wrote = (pairWriterFields(row) !== null && input.made === true) || input.body.calls.some((c) => c.name in TO_PERSON_DOORS);
  } else {
    if (!writesToPerson(row.code)) return false;
    const firstLlm = input.body.calls.findIndex((c) => COMPLETIONS.has(c.name));
    if (firstLlm < 0) return false;
    wrote = input.body.calls.slice(firstLlm + 1).some((c) => c.name in TO_PERSON_DOORS);
  }
  const inserted = await db
    .insert(writerCases)
    .values({ outcome: row.outcome, runId: input.runId, recordedFrom: `${row.outcome}/${row.dynasty}/v${row.version}`, codeMd5: codeMd5(row.code), wrote, orgId: input.orgId, body: input.body })
    .onConflictDoNothing()
    .returning({ id: writerCases.id });
  if (inserted.length === 0) return false;
  // Newest kept per Engine, written and unwritten cases apart: a burst of runs that sent nothing never prunes the
  // cases where a person was written to, the only ones that exercise a writer.
  await db.execute(sql`
    DELETE FROM writer_cases WHERE outcome = ${row.outcome} AND wrote = ${wrote} AND id NOT IN (
      SELECT id FROM writer_cases WHERE outcome = ${row.outcome} AND wrote = ${wrote} ORDER BY created_at DESC LIMIT ${CASES_KEPT_PER_ENGINE}
    )`);
  return true;
}

/** The materials a version must be HANDED (what it asks another Engine for, tactic `asks`, is not). */
function neededMaterials(row: ScriptRow): string[] {
  const asks = (row.tactics as Record<string, unknown>)?.asks;
  const provided = Array.isArray(asks) ? asks.filter((a): a is string => typeof a === "string") : [];
  return (row.materials ?? []).filter((m) => !provided.includes(m));
}

function fedClause(row: ScriptRow) {
  const needed = neededMaterials(row);
  return needed.length === 0
    ? eq(writerCases.outcome, row.outcome)
    : and(eq(writerCases.outcome, row.outcome), sql`${writerCases.body}->'units' ?& array[${sql.join(needed.map((m) => sql`${m}`), sql`, `)}]::text[]`);
}

/** How many of its Engine's cases a version can be fed. */
export async function fedCaseCount(db: AnyPgDb, row: ScriptRow): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(writerCases).where(fedClause(row));
  return Number(r?.n ?? 0);
}

/** The cases a proof tries, in order: those where production wrote to a person first, its own code's first, newest first. */
async function sampleCases(db: AnyPgDb, row: ScriptRow): Promise<Array<{ id: string; runId: string; recordedFrom: string; body: WriterCaseBody }>> {
  const md5 = codeMd5(row.code);
  const rows = await db
    .select({ id: writerCases.id, runId: writerCases.runId, recordedFrom: writerCases.recordedFrom, codeMd5: writerCases.codeMd5, wrote: writerCases.wrote, body: writerCases.body, createdAt: writerCases.createdAt })
    .from(writerCases)
    .where(fedClause(row))
    .orderBy(desc(writerCases.wrote), desc(writerCases.createdAt))
    .limit(PROOF_MAX_TRIES * 4);
  const rank = (r: { wrote: boolean; codeMd5: string }) => (r.wrote ? 0 : 2) + (r.codeMd5 === md5 ? 0 : 1);
  return [...rows].sort((a, b) => rank(a) - rank(b) || b.createdAt.getTime() - a.createdAt.getTime()).map((r) => ({ id: r.id, runId: r.runId, recordedFrom: r.recordedFrom, body: r.body as WriterCaseBody }));
}

/** Everything a proof needs from the outside: the vendors (platform-billed), and its one platform run. */
export interface ProofDeps {
  vendors: VendorDeps;
  openRun(taskName: string, reason: string): Promise<string>;
  closeRun(runId: string, status: "completed" | "failed"): Promise<void>;
}

/** The spend bound of some tokens, in US cents. */
export const tokensBoundCents = (input: number, output: number) => ((input * PRICE_BOUND_INPUT_PER_MTOK + output * PRICE_BOUND_OUTPUT_PER_MTOK) / 1_000_000) * 100;

/** One sent field a person would read. */
export interface SentField {
  door: string;
  path: string;
  value: string;
}

export interface CaseVerdict {
  caseId: string;
  recordedFrom: string;
  /**
   * The case exercised its writing: it sent something a person reads, or broke. A case where it decided to send nothing
   * (later, stop) proves nothing about what it writes: kept on the proof, never counted in its sample.
   */
  exercised: boolean;
  usable: boolean;
  /** Why it is not usable (the script's failure, the LLM's refusal, or the fields Jev judged unusable). */
  reasons: string[];
  fields: Array<{ door: string; path: string; value: string; probability: number }>;
}

interface LiveReplay {
  /** The script made an LLM call: the case fits this code and counts. */
  reachedWriter: boolean;
  failure: string | null;
  completionErrors: string[];
  sent: SentField[];
  /** The spend bound of its LLM calls, US cents. */
  boundCents: number;
}

/** Every value at a dotted path (`*` = each item of a list). */
export function valuesAt(value: unknown, path: string): unknown[] {
  let current: unknown[] = [value];
  for (const part of path.split(".")) {
    const next: unknown[] = [];
    for (const v of current) {
      if (part === "*") {
        if (Array.isArray(v)) next.push(...v);
      } else if (v && typeof v === "object" && !Array.isArray(v) && part in (v as Record<string, unknown>)) {
        next.push((v as Record<string, unknown>)[part]);
      }
    }
    current = next;
  }
  return current;
}

/** The fields a person would read of one sending call (absent optional fields are not sent, so not judged). */
export function personFields(door: string, args: unknown): SentField[] {
  const paths = TO_PERSON_DOORS[door];
  if (!paths) return [];
  const out: SentField[] = [];
  for (const path of paths) {
    for (const v of valuesAt(args, path)) {
      if (v === undefined || v === null) continue;
      out.push({ door, path, value: typeof v === "string" ? v : JSON.stringify(v) });
    }
  }
  return out;
}

/** Run one version on one case: its LLM live (its own tactics), everything else from the record, nothing sent. */
async function replayLive(row: ScriptRow, c: WriterCaseBody, runId: string, deps: ProofDeps, completion: ScriptRow | null = null): Promise<LiveReplay> {
  const caseTactics = Object.fromEntries(Object.entries(c.tactics ?? {}).filter(([k]) => !COMBINATION_TACTICS.includes(k)));
  const tactics = { ...row.tactics, ...caseTactics };
  const used = new Set<number>();
  const store = new Map<string, unknown>();
  const gotten = new Map<string, number>();
  let asked = false;
  let askedRequest: Record<string, unknown> | null = null;
  let reachedWriter = false;
  const completionErrors: string[] = [];
  const sent: SentField[] = [];
  let boundCents = 0;
  const count = (x: { raw: Record<string, unknown> }) => {
    const i = Number(x.raw.tokensInput);
    const o = Number(x.raw.tokensOutput);
    // A completion that states no tokens is bounded at a whole context window, never at zero.
    boundCents += Number.isFinite(i) && Number.isFinite(o) ? tokensBoundCents(i, o) : tokensBoundCents(200_000, 32_000);
  };

  const fromRecord = (name: string, args: unknown): VendorAnswer | null => {
    let at = c.calls.findIndex((r, i) => !used.has(i) && r.name === name && sameJson(r.args ?? null, args ?? null));
    if (at < 0) at = c.calls.findIndex((r, i) => !used.has(i) && r.name === name);
    if (at < 0) return null;
    used.add(at);
    return c.calls[at]!.answer;
  };

  const bridge: Bridge = async (op, args) => {
    if (op === "get") {
      const outcome = String(args[0]);
      const held = c.units[outcome] as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
      if (held === undefined) {
        if (completion && askedRequest && outcome === LLM_COMPLETION_OUTCOME) {
          // The pair's model answers LIVE: the completion script's own code and tactics, on the proof's run.
          const request = askedRequest;
          askedRequest = null;
          asked = false;
          return await completeLive(request);
        }
        if (asked && outcome in (c.asked ?? {})) {
          asked = false;
          return { v: c.asked[outcome] };
        }
        return { stop: `the case holds no ${outcome}` };
      }
      const list = Array.isArray(held) ? held : [held];
      const n = gotten.get(outcome) ?? 0;
      if (n >= list.length) return { stop: `the case holds ${list.length} ${outcome}` };
      gotten.set(outcome, n + 1);
      const unit = list[n]!;
      const subject = (unit.subject as { id?: string } | undefined)?.id ?? "";
      return { v: { id: `proof:${outcome}:${n}`, outcome, subject, ageDays: 0, content: unit.content } };
    }
    if (op === "ask") {
      asked = true;
      const r = args[0];
      askedRequest = r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
      return { v: null };
    }
    if (op === "vendor") {
      const name = String(args[0]);
      const callArgs = (args[1] ?? null) as Record<string, unknown> | null;
      if (COMPLETIONS.has(name)) {
        reachedWriter = true;
        // Live, with the combination's own tactics, on the proof's platform run; never through a brand's tools.
        const answer = await callVendor(name, { ...(callArgs ?? {}), brandTools: false }, { headers: { "x-run-id": runId }, tactics, billing: "platform", outcome: row.outcome, onCompletion: count }, deps.vendors);
        if (!answer.ok) completionErrors.push(String(answer.data.error ?? "refused").slice(0, 300));
        return { v: answer };
      }
      if (name === LLM_PICK || name === TEMPLATE_PICK) {
        return { v: await callVendor(name, callArgs, { headers: { "x-run-id": runId }, tactics, billing: "platform", outcome: row.outcome }, deps.vendors) };
      }
      if (reachedWriter) sent.push(...personFields(name, callArgs));
      const recorded = fromRecord(name, callArgs);
      if (recorded) return { v: recorded };
      // Before its LLM, a read the record does not hold = the case does not fit this code; after it, an act is
      // acknowledged and never made.
      return { v: reachedWriter ? { ok: true, data: {} } : { ok: false, data: { error: `${name}: not recorded in this case` } } };
    }
    const key = `${String(args[0])}\u0000${String(args[1])}`;
    if (op === "storage.get") return { v: store.get(key) ?? null };
    if (op === "storage.set") {
      store.set(key, args[2]);
      return { v: null };
    }
    if (op === "storage.claim") {
      if (!store.has(key)) store.set(key, args[2] ?? null);
      return { v: store.get(key) ?? null };
    }
    if (op === "storage.delete") {
      store.delete(key);
      return { v: null };
    }
    if (op === "storage.count") return { v: [...store.keys()].filter((k) => k.startsWith(`${String(args[0])}\u0000`)).length };
    return { stop: `${String(op)} is not served in a proof` };
  };

  /** The completion script of the pair, run in its own sandbox: its LLM call live, anything else refused. */
  const completeLive = async (ask: Record<string, unknown>): Promise<{ v: unknown } | { stop: string }> => {
    const c2 = completion!;
    reachedWriter = true;
    const inner: Bridge = async (op, a) => {
      if (op !== "vendor") return { stop: `${String(op)} is not served to a completion in a proof` };
      const name = String(a[0]);
      if (!COMPLETIONS.has(name)) return { v: { ok: false, data: { error: `${name} is not served to a completion in a proof` } } };
      const callArgs = (a[1] ?? null) as Record<string, unknown> | null;
      const answer = await callVendor(name, { ...(callArgs ?? {}), brandTools: false }, { headers: { "x-run-id": runId }, tactics: c2.tactics as Record<string, unknown>, billing: "platform", outcome: c2.outcome, onCompletion: count }, deps.vendors);
      if (!answer.ok) completionErrors.push(String(answer.data.error ?? "refused").slice(0, 300));
      return { v: answer };
    };
    const request = ask.request && typeof ask.request === "object" ? (ask.request as Record<string, unknown>) : null;
    const done = await runScript(c2.code, { subject: null, brand: c.brand ?? "", day: c.day ?? 0, tactics: c2.tactics as Record<string, unknown>, request }, inner);
    if (done.kind !== "done" || !done.result || !done.result.content) {
      const why = done.kind === "error" ? done.message : done.kind === "stopped" ? done.reason : "it made no completion";
      return { stop: `${c2.outcome}/${c2.dynasty} (asked for ${LLM_COMPLETION_OUTCOME}): ${why}` };
    }
    return { v: { id: `proof:${LLM_COMPLETION_OUTCOME}`, outcome: LLM_COMPLETION_OUTCOME, subject: "", ageDays: 0, content: done.result.content } };
  };

  const out = await runScript(row.code, { subject: c.subject ?? null, brand: c.brand ?? "", day: c.day ?? 0, tactics, request: c.request ?? null }, bridge);
  const failure = out.kind === "error" ? out.message : out.kind === "stopped" ? out.reason : null;
  // A writer that asks its model hands its Unit on: what a person reads is its content's person fields.
  const fields = completion ? pairWriterFields(row) : null;
  if (fields && out.kind === "done" && out.result && out.result.content) {
    for (const path of fields) {
      for (const v of valuesAt(out.result.content, path)) {
        if (v === undefined || v === null || v === "") continue;
        sent.push({ door: row.outcome, path, value: typeof v === "string" ? v : JSON.stringify(v) });
      }
    }
  }
  return { reachedWriter, failure, completionErrors, sent, boundCents };
}

/** Jev judges every field a person would read; one judgment call per case. */
async function judgeFields(fields: SentField[], row: ScriptRow, runId: string, deps: ProofDeps): Promise<Array<SentField & { probability: number }>> {
  if (fields.length === 0) return [];
  const questions: Record<string, { instructions: string }> = {};
  // ONE-WRITER-N-MODELS-1116: each field is judged inside the WHOLE message it belongs to (the fields of one send, or
  // of one written Unit). Judged alone, a short subject line read as "a subject line where a message body goes" and
  // failed 24 of 24 cold writer cases whose bodies were fine (2026-11-17); seen with its body, 24 of 24 pass and
  // labels / codes / empty values still fail.
  // Only the field paths: an internal name beside them ("message_written") read as "this is a message body" and failed
  // good subjects (P 0.71 without it, 0.14 with it, same subject, 2026-11-17).
  const message = fields.map((f) => `[${f.path}]\n${f.value.slice(0, 8000)}`).join("\n\n");
  const state: string[] = [`The whole of what a person will read once this is sent, field by field:\n${message}`];
  fields.forEach((f, i) => {
    const key = `f${i}`;
    state.push(`${key} = its field "${f.path}"`);
    questions[key] = {
      instructions:
        `Field ${key} is the "${f.path}" of one message a person will read once it is sent (its name says what it holds: a subject is a ` +
        `subject line, a body is the message itself). Is it a usable value for THAT field: real words written for that person, ` +
        `whole and readable? It is NOT usable when it is empty, a label or a code, the name of a field or of a template, content ` +
        `of another kind than its field holds (a subject line or a quoted email where a body goes, a whole message where a ` +
        `subject goes), or cut off.`,
    };
  });
  const answer = await callVendor(JEV_NOUL, { state: state.join("\n\n"), questions }, { headers: { "x-run-id": runId }, tactics: {}, billing: "platform", outcome: row.outcome }, deps.vendors);
  if (!answer.ok) throw new Error(`the usable-field judgment could not be read: ${String(answer.data.error ?? "")}`);
  const probabilities = answer.data.probabilities as Record<string, number>;
  return fields.map((f, i) => ({ ...f, probability: probabilities[`f${i}`]! }));
}

function verdictOf(caseId: string, recordedFrom: string, live: LiveReplay, judged: Array<SentField & { probability: number }>): CaseVerdict {
  const reasons: string[] = [];
  for (const e of live.completionErrors) reasons.push(`the LLM call failed: ${e}`);
  if (live.failure) reasons.push(`its script could not use the answer: ${live.failure.slice(0, 300)}`);
  for (const f of judged) if (f.probability < USABLE_PROBABILITY) reasons.push(`${f.door} ${f.path} is not usable (P=${f.probability.toFixed(2)}): ${JSON.stringify(f.value.slice(0, 120))}`);
  const exercised = reasons.length > 0 || live.sent.length > 0;
  return { caseId, recordedFrom, exercised, usable: reasons.length === 0, reasons, fields: judged.map((f) => ({ door: f.door, path: f.path, value: f.value.slice(0, 300), probability: f.probability })) };
}

/** The version a proof is about: the dynasty's active one, else (a retired dynasty) its latest. */
export async function proofTarget(db: AnyPgDb, outcome: string, dynasty: string): Promise<ScriptRow | null> {
  const rows = await db.select().from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty))).orderBy(desc(scripts.version));
  return rows.find((r) => r.status === "active") ?? rows[0] ?? null;
}

const inFlight = new Set<string>();
/**
 * A pair is (writer VERSION, completion DYNASTY): a model is one completion dynasty (a new model is a new dynasty), so an
 * upgrade of the completion script's code (byte-identical re-stores included) never orphans a pair's proof; an upgrade
 * of the writer is a new version to prove.
 */
const pairKey = (scriptId: string, completionDynasty: string | null) => (completionDynasty ? `${scriptId}:${completionDynasty}` : scriptId);

/** Prove one version on its Engine's cases. Returns the stored proof. */
export async function proveScript(db: AnyPgDb, deps: ProofDeps, row: ScriptRow, trigger: "auto" | "staff", completion: ScriptRow | null = null): Promise<WriterProofRow> {
  const name = `${row.outcome}/${row.dynasty}/v${row.version}${completion ? ` x ${completion.outcome}/${completion.dynasty}/v${completion.version}` : ""}`;
  if (completion) {
    if (!isPairWriter(row)) throw new ProofError(422, `${row.outcome}/${row.dynasty}/v${row.version} asks no model, or nothing it makes reaches a person (no personFields, no send): it is not a writer whose model is asked`);
    if (completion.outcome !== LLM_COMPLETION_OUTCOME) throw new ProofError(422, `${completion.outcome}/${completion.dynasty} is not an LLM completion script`);
  } else if (!writesToPerson(row.code) || !callsCompletion(row.code)) {
    throw new ProofError(422, `${row.outcome}/${row.dynasty}/v${row.version} writes nothing to a person with an LLM of its own: there is no writer to prove${isPairWriter(row) ? " (it asks its model: prove it with a completion script)" : ""}`);
  }
  const key = pairKey(row.id, completion?.dynasty ?? null);
  if (inFlight.has(key)) throw new ProofError(409, `a proof of ${name} is already running`);
  inFlight.add(key);
  const [proof] = await db
    .insert(writerProofs)
    .values({ scriptId: row.id, outcome: row.outcome, dynasty: row.dynasty, version: row.version, ...(completion ? { completionScriptId: completion.id, completionDynasty: completion.dynasty } : {}), state: "running", trigger, ceilingCents: String(PROOF_CEILING_CENTS) })
    .returning();
  const finish = async (set: Partial<typeof writerProofs.$inferInsert>) => {
    const [done] = await db.update(writerProofs).set({ ...set, finishedAt: new Date() }).where(eq(writerProofs.id, proof!.id)).returning();
    return done!;
  };
  let runId: string | null = null;
  try {
    const candidates = await sampleCases(db, row);
    const available = await fedCaseCount(db, row);
    if (candidates.length < PROOF_SAMPLE) return await finish({ state: "no_cases", casesAvailable: available });
    runId = await deps.openRun(`script-proof:${row.outcome}/${row.dynasty}`, `writer proof of ${name} on recorded cases (PROVEN-BEFORE-PEOPLE-1116)`);
    await db.update(writerProofs).set({ runId }).where(eq(writerProofs.id, proof!.id));
    const verdicts: CaseVerdict[] = [];
    let spend = 0;
    let state: "passed" | "failed" | "no_cases" | "error" = "no_cases";
    let error: string | null = null;
    for (const c of candidates.slice(0, PROOF_MAX_TRIES)) {
      const live = await replayLive(row, c.body, runId, deps, completion);
      spend += live.boundCents;
      if (live.reachedWriter) {
        const judged = live.failure || live.completionErrors.length > 0 ? [] : await judgeFields(live.sent, row, runId, deps);
        if (live.sent.length > 0 && judged.length > 0) spend += JUDGMENT_BOUND_CENTS;
        verdicts.push(verdictOf(c.runId, c.recordedFrom, live, judged));
      }
      if (verdicts.some((v) => !v.usable)) {
        state = "failed";
        break;
      }
      if (verdicts.filter((v) => v.exercised).length >= PROOF_SAMPLE) {
        state = "passed";
        break;
      }
      if (spend >= PROOF_CEILING_CENTS) {
        state = "error";
        error = `stopped at the ceiling: ${spend.toFixed(2)} cents spent after ${verdicts.filter((v) => v.exercised).length} of ${PROOF_SAMPLE} written cases`;
        break;
      }
    }
    await deps.closeRun(runId, "completed");
    const counted = verdicts.filter((v) => v.exercised);
    return await finish({ state, error, sample: counted.length, usable: counted.filter((v) => v.usable).length, casesAvailable: available, cases: verdicts, spendCents: spend.toFixed(4) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[workflow-service] writer proof of ${name} FAILED to run: ${message}`);
    if (runId) await deps.closeRun(runId, "failed").catch((c) => console.error(`[workflow-service] writer proof run ${runId} could not be closed: ${String(c)}`));
    return await finish({ state: "error", error: message.slice(0, 1000) });
  } finally {
    inFlight.delete(key);
  }
}

export class ProofError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Whether an Engine's Rating draws only proven writer combinations. */
export async function engineEnforced(db: AnyPgDb, outcome: string): Promise<boolean> {
  const [r] = await db.select({ enforced: writerProofEngines.enforced }).from(writerProofEngines).where(eq(writerProofEngines.outcome, outcome));
  return r?.enforced === true;
}

export async function setEngineEnforced(db: AnyPgDb, outcome: string, enforced: boolean, decidedBy: string): Promise<void> {
  await db
    .insert(writerProofEngines)
    .values({ outcome, enforced, decidedBy })
    .onConflictDoUpdate({ target: writerProofEngines.outcome, set: { enforced, decidedBy, updatedAt: new Date() } });
}

/** The proofs of one version (alone, or paired with one completion dynasty), newest first. */
async function proofsOf(db: AnyPgDb, scriptId: string, completionDynasty: string | null = null): Promise<WriterProofRow[]> {
  return db
    .select()
    .from(writerProofs)
    .where(and(eq(writerProofs.scriptId, scriptId), completionDynasty ? eq(writerProofs.completionDynasty, completionDynasty) : isNull(writerProofs.completionDynasty)))
    .orderBy(desc(writerProofs.createdAt));
}

export type GateVerdict = { draws: boolean; prove: boolean; why: string };

/** PURE: the gate's decision for one version from its proofs and the cases it can be fed. */
export function gateFor(proofs: Pick<WriterProofRow, "state" | "trigger" | "createdAt" | "casesAvailable">[], fed: number, now: number): GateVerdict {
  const latest = proofs[0];
  if (!latest) return fed < PROOF_SAMPLE ? { draws: true, prove: false, why: "not provable yet: too few cases" } : { draws: false, prove: true, why: "unproven" };
  if (latest.state === "passed") return { draws: true, prove: false, why: "proven" };
  if (latest.state === "failed") return { draws: false, prove: false, why: "failed its proof" };
  if (latest.state === "no_cases") return { draws: true, prove: fed >= latest.casesAvailable + PROOF_SAMPLE, why: "not provable yet: too few fitting cases" };
  if (latest.state === "running" && now - latest.createdAt.getTime() < PROOF_STALE_MS) return { draws: false, prove: false, why: "being proven" };
  // Interrupted (error, abandoned, a stale running): retried at most AUTO_ATTEMPTS times in all.
  const interrupted = proofs.filter((p) => p.state === "error" || p.state === "abandoned" || p.state === "running").length;
  return { draws: false, prove: interrupted < AUTO_ATTEMPTS, why: "its proof did not finish" };
}

let proofContext: { db: AnyPgDb; deps: ProofDeps } | null = null;
/** Production wires the deps at boot; tests set their own (null = no auto proof). */
export function setProofContext(c: { db: AnyPgDb; deps: ProofDeps } | null): void {
  proofContext = c;
}

/**
 * Whether the Rating may draw this version. A version that sends to nobody, or of an Engine not enforced, always may.
 * An unproven one is proven in the background, once (never awaited by the run).
 */
export async function writerProofAllows(db: AnyPgDb, row: ScriptRow): Promise<boolean> {
  // A script that sends but calls no LLM itself (a sender whose writer asks its model) is no combination: its
  // writer's pairs are gated, at the completion pick.
  if (!writesToPerson(row.code) || !callsCompletion(row.code)) return true;
  if (!(await engineEnforced(db, row.outcome))) return true;
  return gateAndProve(db, row, null);
}

/**
 * Whether the Rating may draw `completion` for the writer `writer` that asks it (ONE-WRITER-N-MODELS-1116-ANSWERER).
 * Any other asker, or a writer of an Engine not enforced, always may. An unproven pair is proven in the background, once.
 */
export async function pairProofAllows(db: AnyPgDb, writer: ScriptRow, completion: ScriptRow): Promise<boolean> {
  if (completion.outcome !== LLM_COMPLETION_OUTCOME || !isPairWriter(writer)) return true;
  if (!(await engineEnforced(db, writer.outcome))) return true;
  return gateAndProve(db, writer, completion);
}

async function gateAndProve(db: AnyPgDb, row: ScriptRow, completion: ScriptRow | null): Promise<boolean> {
  const verdict = gateFor(await proofsOf(db, row.id, completion?.dynasty ?? null), await fedCaseCount(db, row), Date.now());
  const name = `${row.outcome}/${row.dynasty}/v${row.version}${completion ? ` x ${completion.dynasty}` : ""}`;
  if (verdict.prove && proofContext && !inFlight.has(pairKey(row.id, completion?.dynasty ?? null))) {
    const ctx = proofContext;
    console.log(`[workflow-service] writer proof of ${name} starts (${verdict.why})`);
    void proveScript(ctx.db, ctx.deps, row, "auto", completion).catch((e) => console.error(`[workflow-service] writer proof of ${name} FAILED to start: ${String(e)}`));
  }
  return verdict.draws;
}

/** At boot: a proof left running by a dead process is abandoned (it holds nothing out any more). */
export async function abandonRunningProofs(db: AnyPgDb): Promise<number> {
  const rows = await db.update(writerProofs).set({ state: "abandoned", finishedAt: new Date(), error: "the process restarted during the proof" }).where(eq(writerProofs.state, "running")).returning({ id: writerProofs.id });
  return rows.length;
}

export interface ProofView {
  outcome: string;
  dynasty: string;
  version: number;
  /** The LLM its tactics state (name), or the completion script's it is paired with, for the chart. */
  llm: string | null;
  /** The LLM completion script this writer is proven with (a writer that asks its model), else null. */
  completion: string | null;
  /** Runnable now (version and dynasty active). */
  live: boolean;
  /** passed | failed | running | error | no_cases | abandoned | unproven */
  state: string;
  usable: number;
  sample: number;
  /** An upper bound of the proof's spend (its real spend is on its runs-service run). */
  spendAtMostUsd: number | null;
  provedAt: string | null;
  failures: string[];
  /** A live combination that failed its proof (what Monitoring shows red). */
  red: boolean;
}

function llmName(tactics: Record<string, unknown>): string | null {
  const one = (v: unknown) => (v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string" ? ((v as { name: string }).name) : v && typeof v === "object" && typeof (v as { model?: unknown }).model === "string" ? (v as { model: string }).model : null);
  const llms = tactics.llms as Record<string, unknown> | undefined;
  return one(tactics.llm) ?? (llms ? one(llms.writer) ?? one(Object.values(llms)[0]) : null);
}

/** Monitoring: every Engine's cases and enforcement, and every writer combination's latest proof. */
export async function readWriterProofs(db: AnyPgDb): Promise<{ engines: Array<{ outcome: string; enforced: boolean; cases: number }>; combinations: ProofView[] }> {
  const caseCounts = await db.select({ outcome: writerCases.outcome, n: sql<number>`count(*)::int` }).from(writerCases).groupBy(writerCases.outcome);
  const enforcedRows = await db.select().from(writerProofEngines);
  const enforced = new Map(enforcedRows.map((r) => [r.outcome, r.enforced]));
  const proofRows = await db.select().from(writerProofs).orderBy(desc(writerProofs.createdAt));
  const latestByScript = new Map<string, WriterProofRow>();
  const latestByPair = new Map<string, WriterProofRow>();
  for (const p of proofRows) {
    if (p.completionDynasty) {
      const k = pairKey(p.scriptId, p.completionDynasty);
      if (!latestByPair.has(k)) latestByPair.set(k, p);
    } else if (!latestByScript.has(p.scriptId)) latestByScript.set(p.scriptId, p);
  }
  const active = await db.select().from(scripts).where(eq(scripts.status, "active"));
  const proven = latestByScript.size > 0 ? await db.select().from(scripts).where(inArray(scripts.id, [...latestByScript.keys()])) : [];
  const rows = new Map<string, ScriptRow>();
  for (const r of [...active, ...proven]) if (writesToPerson(r.code) && callsCompletion(r.code)) rows.set(r.id, r);
  // One line per dynasty: its active version, else the latest proven one.
  const byDynasty = new Map<string, ScriptRow>();
  for (const r of rows.values()) {
    const key = `${r.outcome}/${r.dynasty}`;
    const cur = byDynasty.get(key);
    if (!cur || (r.status === "active" && cur.status !== "active") || (r.status === cur.status && r.version > cur.version)) byDynasty.set(key, r);
  }
  const combinations: ProofView[] = [...byDynasty.values()]
    .map((r): ProofView => {
      const p = latestByScript.get(r.id);
      const live = r.status === "active" && r.dynastyStatus === "active";
      const state = p?.state ?? "unproven";
      return {
        outcome: r.outcome,
        dynasty: r.dynasty,
        version: r.version,
        llm: llmName(r.tactics as Record<string, unknown>),
        completion: null,
        live,
        state,
        usable: p?.usable ?? 0,
        sample: p?.sample ?? 0,
        spendAtMostUsd: p?.spendCents != null ? Number(p.spendCents) / 100 : null,
        provedAt: p?.finishedAt?.toISOString() ?? null,
        failures: ((p?.cases ?? []) as CaseVerdict[]).filter((v) => !v.usable).flatMap((v) => v.reasons).slice(0, 5),
        red: live && state === "failed",
      };
    })
    .concat(await pairViews(db, active, latestByPair))
    .sort((a, b) => Number(b.red) - Number(a.red) || a.outcome.localeCompare(b.outcome) || a.dynasty.localeCompare(b.dynasty) || String(a.completion).localeCompare(String(b.completion)));
  const outcomes = new Set([...caseCounts.map((c) => c.outcome), ...enforcedRows.map((r) => r.outcome)]);
  return {
    engines: [...outcomes].sort().map((o) => ({ outcome: o, enforced: enforced.get(o) === true, cases: Number(caseCounts.find((c) => c.outcome === o)?.n ?? 0) })),
    combinations,
  };
}

/** One line per live (writer that asks its model) x live completion script, with that pair's latest proof. */
async function pairViews(db: AnyPgDb, active: ScriptRow[], latest: Map<string, WriterProofRow>): Promise<ProofView[]> {
  const writers = active.filter((r) => r.dynastyStatus === "active" && isPairWriter(r));
  const completions = active.filter((r) => r.dynastyStatus === "active" && r.outcome === LLM_COMPLETION_OUTCOME);
  const out: ProofView[] = [];
  for (const w of writers) {
    for (const c of completions) {
      const p = latest.get(pairKey(w.id, c.dynasty));
      const state = p?.state ?? "unproven";
      out.push({
        outcome: w.outcome,
        dynasty: w.dynasty,
        version: w.version,
        llm: llmName(c.tactics as Record<string, unknown>),
        completion: `${c.outcome}/${c.dynasty}`,
        live: true,
        state,
        usable: p?.usable ?? 0,
        sample: p?.sample ?? 0,
        spendAtMostUsd: p?.spendCents != null ? Number(p.spendCents) / 100 : null,
        provedAt: p?.finishedAt?.toISOString() ?? null,
        failures: ((p?.cases ?? []) as CaseVerdict[]).filter((v) => !v.usable).flatMap((v) => v.reasons).slice(0, 5),
        red: state === "failed",
      });
    }
  }
  return out;
}

/** The production deps: chat-service vendors + one runs-service platform run per proof. */
export function productionProofDeps(vendors: VendorDeps): ProofDeps {
  const base = (process.env.RUNS_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.RUNS_SERVICE_API_KEY ?? "";
  const need = () => {
    if (!base || !key) throw new Error("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be set to prove a writer");
  };
  return {
    vendors,
    async openRun(taskName, reason) {
      need();
      const res = await fetch(`${base}/v1/platform-runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "x-service-name": "workflow" },
        body: JSON.stringify({ serviceName: "workflow", taskName, support: { kind: "product_feature", reason } }),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`runs-service POST /v1/platform-runs -> ${res.status}: ${text.slice(0, 300)}`);
      return (JSON.parse(text) as { id: string }).id;
    },
    async closeRun(runId, status) {
      need();
      const res = await fetch(`${base}/v1/platform-runs/${encodeURIComponent(runId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-api-key": key, "x-service-name": "workflow" },
        body: JSON.stringify({ status }),
        signal: AbortSignal.timeout(600_000),
      });
      if (!res.ok) throw new Error(`runs-service PATCH /v1/platform-runs/${runId} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    },
  };
}
