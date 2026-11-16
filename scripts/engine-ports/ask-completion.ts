/**
 * ONE-WRITER-N-MODELS-1116-OTHERS (owner 2026-11-16: « Je pensais qu'on avait qu'un script, et que le choix du model
 * est orthogonal / indépendant du script ??? », « Le best LLM pour écrire un cold email script 1 n'est peut-être pas le
 * même que pour un cold email script 2, ou un autre engine »).
 *
 * Every script that named the model it writes or judges with is UPGRADED, from its STORED code (the source of truth),
 * so it ASKS the LLM completion Engine instead: each completion it made through `llm.complete` / `chat.complete` with
 * a model it read off its own tactics (`llm.pick`, tactic `llm` / `llms`) becomes
 *
 *   ctx.ask({ units: {}, request: <the same call minus provider and model> }); ctx.get("llm_completion")
 *
 * and the Rating (features-service, told who asks) picks the model for THAT script. Only the call's model moves: the
 * prompt, schema, every other field and everything the script does with the answer stay byte for byte.
 *
 * The rewrite is mechanical and anchored, the same for every script:
 *   - a `...pickLlm(ctx, "<place>")` spread inside a call is removed (the call states no model any more);
 *   - `ctx.vendor.call("llm.complete", X)` -> `askCompletion(ctx, X)` (same `{ok, data}` answer, data = chat's answer);
 *   - `must|tolerated(ctx, "llm.complete", X)` -> `askCompletionData(ctx, X)` (the answer's data, as those returned);
 *   - `ctx.vendor.call("chat.complete", X)` -> `askChatCompletion(ctx, X)` (data = the parsed JSON, as before);
 *   - the per-script edits (`Edit`) that remove its own model read (a `llm.pick` call, `provider: llm.provider`);
 *   - the now unused `pickLlm` helper removed; the three helpers appended.
 * A script still naming a model call (`"llm.complete"`, `"chat.complete"`, `"llm.pick"`) after it throws.
 *
 * A completion the child cannot make stops the asking script with the child's reason (a tolerated reading call used to
 * answer `{ok:false}` and let the run go on: the run now fails and is retried, nothing written on a failed read).
 *
 * The recorded cases of a port are RESTATED under the same rule (`restateCase`): each recorded completion call leaves
 * `calls` and becomes, in order, a Unit of `llm_completion` the case holds (`{answer, llm}`), its recorded request the
 * asked Request (`asks`); a `llm.pick` call leaves the record; the case's `llm`/`llms` tactics go. A case whose record
 * holds a FAILED completion is excluded (a failed child stops the run: a different behaviour, never restated).
 */
import { applyEdits, type Edit } from "./cold-email-one-writer.js";

export const COMPLETION_OUTCOME = "llm_completion";
export const MODEL_CALLS = ["llm.complete", "chat.complete"];

export const COMPLETION_HELPERS = `
/**
 * ONE-WRITER-N-MODELS-1116: this script names no model. Each completion it needs is ASKED of the LLM completion
 * Engine (the Rating picks the model for this script); the request is the call as written, minus the model.
 */
function askCompletion(ctx: any, call: Record<string, unknown>): { ok: true; data: Record<string, any> } {
  const request: Record<string, unknown> = {};
  for (const k of Object.keys(call)) if (k !== "provider" && k !== "model") request[k] = call[k];
  ctx.ask({ units: {}, request });
  const done: any = ctx.get("${COMPLETION_OUTCOME}");
  if (!done || !done.content) throw new Error("${COMPLETION_OUTCOME}: " + String((done && done.unmade) || "no completion") + ". Nothing is written: the run is retried later.");
  return { ok: true, data: done.content.answer };
}
function askCompletionData(ctx: any, call: Record<string, unknown>): any {
  return askCompletion(ctx, call).data;
}
/** A JSON answer, read as chat.complete read it: the parsed object, else a refusal. */
function askChatCompletion(ctx: any, call: Record<string, unknown>): { ok: boolean; data: Record<string, any> } {
  const json = askCompletion(ctx, call).data.json;
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, data: { error: "chat.complete: the model answered no JSON object" } };
  return { ok: true, data: json };
}
`;

/** Removes `...pickLlm(ctx, "<place>")` spreads (with their trailing comma) and returns the places they read. */
export function dropPickLlmSpreads(code: string): { code: string; places: string[] } {
  const places: string[] = [];
  const out = code.replace(/\.\.\.pickLlm\(ctx, "([a-z_]+)"(?:, "[a-z_]+")?\),\s*/g, (_m, place: string) => {
    places.push(place);
    return "";
  });
  return { code: out, places };
}

/** Removes one top-level `function <name>(` (and its doc comment) when nothing else references it. */
export function withoutUnusedFunction(code: string, name: string): string {
  const head = `function ${name}(`;
  const at = code.indexOf(head);
  if (at < 0) return code;
  const uses = code.split(`${name}(`).length - 1;
  if (uses > 1) return code;
  const end = code.indexOf("\n}\n", at);
  if (end < 0) throw new Error(`function ${name} has no closing brace`);
  let start = at;
  const before = code.slice(0, at);
  const doc = before.lastIndexOf("/**");
  if (doc >= 0 && before.slice(doc).trimEnd().endsWith("*/") && !before.slice(doc).includes("\n\n")) start = doc;
  return code.slice(0, start) + code.slice(end + 3);
}

export function namesAModelCall(code: string): boolean {
  return /"llm\.complete"|"chat\.complete"|"llm\.pick"/.test(code);
}

/**
 * The upgrade of one script's stored code: its own edits first (anchors found exactly once), then the mechanical
 * routing, then the helpers. `what` names it in an error.
 */
export function askCompletionSource(stored: string, edits: Edit[], what: string): string {
  if (stored.includes("function askCompletion(")) throw new Error(`${what}: already asks its completions`);
  let code = applyEdits(stored, edits, what);
  code = dropPickLlmSpreads(code).code;
  code = code.split('ctx.vendor.call("llm.complete", ').join("askCompletion(ctx, ");
  code = code.split('must(ctx, "llm.complete", ').join("askCompletionData(ctx, ");
  code = code.split('tolerated(ctx, "llm.complete", ').join("askCompletionData(ctx, ");
  code = code.split('ctx.vendor.call("chat.complete", ').join("askChatCompletion(ctx, ");
  code = withoutUnusedFunction(code, "pickLlm");
  code = withoutUnusedFunction(code, "llmFor");
  if (namesAModelCall(code)) throw new Error(`${what}: still names a model call after the rewrite (an anchor is missing: re-read the stored code)`);
  if (/pickLlm\(|llmFor\(/.test(code)) throw new Error(`${what}: still reads a model (pickLlm)`);
  return code.trimEnd() + "\n" + COMPLETION_HELPERS;
}

/** The script's tactics without the model, plus what it asks. */
export function askCompletionTactics(current: Record<string, unknown>): Record<string, unknown> {
  const { llm: _llm, llms: _llms, ...rest } = current;
  const asks = Array.isArray(rest.asks) ? (rest.asks as string[]) : [];
  return { ...rest, asks: asks.includes(COMPLETION_OUTCOME) ? asks : [...asks, COMPLETION_OUTCOME] };
}

interface RecordedCall {
  name: string;
  args?: Record<string, unknown> | null;
  answer: { ok: boolean; data: Record<string, unknown> };
}

/**
 * One recorded case restated: completions move from the vendor record to the Units the case holds, in order, their
 * recorded requests become the asks (when every one was recorded). `llm` = the model the record wrote with (the
 * case's tactic, else the dynasty's).
 */
/**
 * A service door that made the completion for the script (e.g. human-service's split door) and is now replaced by an
 * asked completion: its recorded answer was the parsed JSON (`json`), and `drop` names request fields only the door
 * took (its in-flight token).
 */
export interface DoorAsCompletion {
  name: string;
  drop: string[];
}

export function restateCase(c: Record<string, any>, dynastyLlm: Record<string, unknown> | null, doors: DoorAsCompletion[] = []): { case: Record<string, any> } | { excluded: string } {
  const calls: RecordedCall[] = Array.isArray(c.calls) ? c.calls : [];
  const kept: RecordedCall[] = [];
  const completions: Array<Record<string, unknown>> = [];
  const asks: Array<Record<string, unknown>> = [];
  let allRecorded = true;
  const tactics = (c.tactics ?? {}) as Record<string, unknown>;
  const llm = (tactics.llm as Record<string, unknown> | undefined) ?? dynastyLlm ?? null;
  // The model each completion was written with: the record's own pick, in order, else the case's / dynasty's tactic.
  const picks: Array<Record<string, unknown>> = [];
  for (const call of calls) {
    if (call.name === "llm.pick") {
      const d = (call.answer?.data ?? {}) as Record<string, unknown>;
      if (call.answer?.ok && typeof d.provider === "string" && typeof d.model === "string") picks.push({ provider: d.provider, model: d.model, ...(typeof d.name === "string" ? { name: d.name } : {}) });
      continue;
    }
    const door = doors.find((d) => d.name === call.name);
    if (!MODEL_CALLS.includes(call.name) && !door) {
      kept.push(call);
      continue;
    }
    if (!call.answer?.ok) return { excluded: `its record holds a failed ${call.name} (a failed completion now stops the run)` };
    const answer = call.name === "chat.complete" || door ? { json: call.answer.data } : call.answer.data;
    completions.push({ answer, llm: picks.shift() ?? llm });
    if (call.args && typeof call.args === "object") {
      const drop = new Set(["provider", "model", ...(door?.drop ?? [])]);
      const request: Record<string, unknown> = {};
      for (const k of Object.keys(call.args)) if (!drop.has(k)) request[k] = (call.args as Record<string, unknown>)[k];
      asks.push({ units: {}, request });
    } else allRecorded = false;
  }
  if (completions.length === 0) return { case: c };
  const { llm: _l, llms: _ls, ...restTactics } = tactics;
  const out: Record<string, any> = { ...c, calls: kept, units: { ...(c.units ?? {}), [COMPLETION_OUTCOME]: completions } };
  if (c.tactics !== undefined) out.tactics = restTactics;
  // The record's other asks interleave with the completions in an order the record does not keep: unchecked then.
  if (allRecorded && (c.asks === undefined || (Array.isArray(c.asks) && c.asks.length === 0))) out.asks = asks;
  else delete out.asks;
  return { case: out };
}
