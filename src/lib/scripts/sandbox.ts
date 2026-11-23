/**
 * FACTORY-P2-ENGINES: script code kept in the database runs here, in a hard sandbox.
 *
 * Each run gets its OWN QuickJS engine (a WebAssembly module, `quickjs-emscripten`): a separate JavaScript engine
 * with its own heap capped at `SCRIPT_MEMORY_MB` and `SCRIPT_CPU_MS` of its own compute time (time spent waiting on
 * the host, a vendor call, does not count; `SCRIPT_WALL_MS` bounds the whole run). The engine holds the language's
 * built-ins and nothing of Node: no require, no process, no env, no fetch, no timers, no file system, no socket, no
 * database handle, no object of this process. The script sees one object, its context (subject, brand, day, tactics,
 * Request, its Engine's storage, `get` on its materials or from a Provider, `ask`, `consume`, the vendor, `accounts`, `wait`), built inside the
 * engine from copied JSON; every call it makes crosses ONE host function that takes and returns text. So whatever a
 * stored script does, it reaches the outside only through the bridge the host hands it, which answers for the run's
 * own org and identity only (src/lib/scripts/script-runner.ts).
 *
 * Same contract as the GTM Factory runner (gtm-factory `apps/server/src/sandbox.ts`, isolated-vm there): a script
 * written for it runs here unchanged. QuickJS instead of isolated-vm: pure WebAssembly, no native build on the box.
 */
import { transform } from "sucrase";
import { newQuickJSAsyncWASMModule, type QuickJSAsyncContext, type QuickJSHandle } from "quickjs-emscripten";

/**
 * 10 s of the script's OWN compute (MIGRATE-1105 S7): a port that reads a whole thread (the brand team answer, a big
 * Copilot context) computed 2 to 3 s on the box (QuickJS interprets, the box is shared) and 5 of its 60 recorded runs
 * died on the old 2 s; the limit guards a runaway loop, never a normal read of a big thread.
 */
export const SCRIPT_CPU_MS = 10_000;
export const SCRIPT_WALL_MS = 10 * 60_000;
export const SCRIPT_MEMORY_MB = 64;
/** A script that calls its host more often than this is stopped (a loop on a vendor). */
export const SCRIPT_MAX_HOST_CALLS = 500;

/** What a script asks the host for, one call at a time (JSON in, JSON out). */
export type BridgeOp = "get" | "ask" | "consume" | "vendor" | "wait" | "accounts" | "storage.get" | "storage.set" | "storage.delete" | "storage.count" | "storage.claim";
/** The host's answer: a value, or a stop (the run cannot go on now: a piece is missing, it waits). */
export type BridgeAnswer = { v: unknown } | { stop: string };
export type Bridge = (op: BridgeOp, args: unknown[]) => BridgeAnswer | Promise<BridgeAnswer>;

export interface ScriptSpec {
  subject: string | null;
  brand: string;
  day: number;
  tactics: Record<string, unknown>;
  /** For a script whose outcome's subject is the run: the Request of the run that ordered it (null otherwise). */
  request?: Record<string, unknown> | null;
}

/**
 * What a script answers. `unmade` (FACTORY-P3): no Unit, for a reason the WORLD gave (a verifier with no verdict for
 * this address), never a bug: the run closes completed, counted apart from errors by the roll-back guard, and a replay
 * case expecting that failure (`expect.fails`) matches it.
 */
export type ScriptResult = {
  content?: Record<string, unknown>;
  found?: string;
  unmade?: string;
  /**
   * With `unmade`: the look did not FINISH (a budget ran out mid-look), so it is worth asking again soon. Neither idle
   * nor exhausted: the campaign re-runs on its short cadence (MIGRATE-1105 S3, lead-service's `serve_timed_out`).
   */
  again?: boolean;
  /**
   * With `unmade`: no Unit because the SCRIPT decided so, not because the world refused (MON-UNSENT-RED-1111). `done` =
   * the look did its work (write later with the next date set, a stop, an escalation): a completed run, never a sender
   * refusal. `idle` = nothing to do for this person on this campaign now (nobody owed, a relationship not judged yet):
   * the campaign may ask again. Absent = a refusal the world gave (a sender 409, no channel), stated as such.
   */
  decided?: "done" | "idle";
  /**
   * With `unmade`, for the script that ASKED this one (ONE-WRITER-N-MODELS-1116-ANSWERER): what it decided, so its asker
   * acts on it (a writer that decided to write later hands back the date; the sender sets it). Never a Unit.
   */
  answer?: Record<string, unknown>;
  /** Who the Unit is about, when the run was handed no subject (an Engine run that found its own: MIGRATE-1105 S0). */
  subject?: { service: string; id: string };
} | null;

export type RunOutcome =
  | { kind: "done"; result: ScriptResult }
  | { kind: "stopped"; reason: string }
  | { kind: "error"; message: string };

/** Builds the script's context inside the engine: every call goes through `__host`, text in, text out. */
const BOOT = `
// QuickJS ships no Intl. Scripts read a time zone's local time (send windows): Intl.DateTimeFormat is answered by
// the host's own (a pure function of locale, options and an instant; no I/O), through __intl, removed below.
(function (intl) {
  "use strict";
  var call = function (locale, options, instant, method) {
    var a = JSON.parse(intl(JSON.stringify(locale === undefined ? null : locale), JSON.stringify(options || {}), instant, method));
    if (a.error) throw new RangeError(a.error);
    return a.v;
  };
  var instantOf = function (d) { return d === undefined ? Date.now() : d instanceof Date ? d.getTime() : Number(d); };
  function DateTimeFormat(locale, options) {
    if (!(this instanceof DateTimeFormat)) return new DateTimeFormat(locale, options);
    call(locale, options, 0, "check");
    this.__locale = locale; this.__options = options;
  }
  DateTimeFormat.prototype.format = function (d) { return call(this.__locale, this.__options, instantOf(d), "format"); };
  DateTimeFormat.prototype.formatToParts = function (d) { return call(this.__locale, this.__options, instantOf(d), "formatToParts"); };
  DateTimeFormat.prototype.resolvedOptions = function () { return call(this.__locale, this.__options, 0, "resolvedOptions"); };
  if (typeof globalThis.Intl === "undefined") globalThis.Intl = Object.freeze({ DateTimeFormat: DateTimeFormat });
})(__intl);
delete globalThis.__intl;
var __make = (function (host) {
  "use strict";
  var call = function (op, args) {
    var a = JSON.parse(host(op, JSON.stringify(args)));
    if (a && typeof a.stop === "string") throw new Error("stopped: " + a.stop);
    return a ? a.v : undefined;
  };
  var freeze = Object.freeze;
  var deep = function (v) {
    if (v && typeof v === "object") { Object.keys(v).forEach(function (k) { deep(v[k]); }); freeze(v); }
    return v;
  };
  return function make(specJson) {
    var s = JSON.parse(specJson);
    return freeze({
      subject: s.subject,
      brand: s.brand,
      day: s.day,
      tactics: deep(s.tactics),
      request: s.request ? deep(s.request) : null,
      storage: freeze({
        get: function (t, k) { return call("storage.get", [t, k]); },
        set: function (t, k, v) { call("storage.set", [t, k, v === undefined ? null : v]); },
        delete: function (t, k) { call("storage.delete", [t, k]); },
        count: function (t) { return call("storage.count", [t]); },
        claim: function (t, k, v) { return deep(call("storage.claim", [t, k, v === undefined ? null : v])); },
      }),
      get: function (outcome, filters) { return deep(arguments.length > 1 ? call("get", [outcome, filters === undefined ? null : filters]) : call("get", [outcome])); },
      ask: function (request, inputs) {
        if (typeof request === "string") return deep(call("ask", [request, inputs === undefined ? null : inputs]));
        call("ask", [request === undefined ? null : request]);
      },
      consume: function (outcome, subject) { call("consume", [outcome === undefined ? null : outcome, subject === undefined ? null : subject]); },
      vendor: freeze({ call: function (name, args) { return deep(call("vendor", [name, args === undefined ? null : args])); } }),
      accounts: function (channel, role) { return deep(call("accounts", [channel, role])); },
      wait: function (days) { call("wait", [days]); throw new Error("wait"); },
    });
  };
})(__host);
delete globalThis.__host;
`;

/** Transpile a script's TypeScript text to a CommonJS module (type imports vanish; a value import is refused). */
export function transpile(source: string): string {
  const { code } = transform(source, { transforms: ["typescript", "imports"], disableESTransforms: true });
  if (/\brequire\s*\(/.test(code)) throw new Error("a script may only import types: it gets everything else from its context");
  return code;
}

/** The module of a script inside the engine: its default export, the run function. */
const moduleOf = (js: string) =>
  `var __run = (function () { var module = { exports: {} }; (function (module, exports) {\n${js}\n})(module, module.exports); return module.exports.default || module.exports; })();\n` +
  `if (typeof __run !== "function") throw new Error("a script's default export must be its run(ctx) function");\n`;

/**
 * The outcomes a script's code must be HANDED (`ctx.get("...")` with the outcome alone, literals): its materials.
 * ENGINE-GET-ASK-1123: `ctx.get("x", filters)` reads x from its Provider, so it is no material.
 */
export function readMaterials(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?<!storage)\.get\(\s*["'`]([a-z0-9_:.-]+)["'`]\s*,?\s*\)/gi)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

const LITERAL_OUTCOME = /^["'`]([a-z0-9_:.-]+)["'`]$/i;

/** Each `.<method>(...)` call of a text: its first argument as written, and whether it states more than one. */
function callsOf(source: string, method: string): Array<{ first: string; many: boolean }> {
  const out: Array<{ first: string; many: boolean }> = [];
  for (const m of source.matchAll(new RegExp(`\\.${method}\\s*\\(`, "g"))) {
    const start = m.index! + m[0].length;
    let depth = 0;
    let comma = -1;
    let end = -1;
    for (let i = start; i < source.length; i++) {
      const ch = source[i]!;
      if (ch === '"' || ch === "'" || ch === "`") {
        let j = i + 1;
        while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
        i = j;
      } else if (ch === "/" && source[i + 1] === "/") {
        const nl = source.indexOf("\n", i);
        if (nl < 0) break;
        i = nl;
      } else if (ch === "/" && source[i + 1] === "*") {
        const close = source.indexOf("*/", i + 2);
        if (close < 0) break;
        i = close + 1;
      } else if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) {
          end = i;
          break;
        }
        depth--;
      } else if (ch === "," && depth === 0 && comma < 0) comma = i;
    }
    // A call the scan cannot close is left alone (never a refusal invented by the scan).
    if (end < 0) continue;
    out.push({ first: source.slice(start, comma >= 0 ? comma : end).trim(), many: comma >= 0 && source.slice(comma + 1, end).trim() !== "" });
  }
  return out;
}

/**
 * ENGINE-GET-ASK-1123: the Engines a script's code asks for a Unit directly (`ctx.ask("<outcome>", inputs)`, literals).
 * The same effect as tactic `asks` naming them.
 */
export function readAsks(source: string): string[] {
  const out: string[] = [];
  for (const c of callsOf(source, "ask")) {
    const m = LITERAL_OUTCOME.exec(c.first);
    if (m && !out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** The Engines a script asks: its tactic `asks`, and those its code asks directly. */
export function asksOf(row: { tactics?: unknown; code?: string | null }): string[] {
  const stated = ((row.tactics ?? {}) as Record<string, unknown>).asks;
  const out = Array.isArray(stated) ? stated.filter((a): a is string => typeof a === "string") : [];
  for (const a of row.code ? readAsks(row.code) : []) if (!out.includes(a)) out.push(a);
  return out;
}

/** The vendors a script's code calls by a literal name (`ctx.vendor.call("llm.complete", ...)`). */
export function readVendors(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/vendor\.call\(\s*["'`]([a-z0-9_.:-]+)["'`]/gi)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** Thrown when a script's text cannot become a version. */
export class ScriptSourceError extends Error {}

/**
 * Check a script's text before it becomes a version: it transpiles, its module evaluates in the sandbox, its
 * default export is a function, and every Provider it calls is named by a literal (`ctx.get("email_found")`): that
 * is how its materials are read from the code.
 */
export async function validateSource(source: string): Promise<{ materials: string[]; vendors: string[] }> {
  let js: string;
  try {
    js = transpile(source);
  } catch (e) {
    throw new ScriptSourceError(e instanceof Error ? e.message : String(e));
  }
  const calls = (source.match(/\.get\s*\(/g) ?? []).length - (source.match(/storage\.get\s*\(/g) ?? []).length;
  const literal = (source.match(/(?<!storage)\.get\s*\(\s*["'`][a-z0-9_]+["'`]\s*[,)]/g) ?? []).length;
  if (literal !== calls) throw new ScriptSourceError("every ctx.get(...) must name its outcome with a literal string, so the materials can be read from the code");
  // ENGINE-GET-ASK-1123: the direct ask names its Engine the same way (the one-argument Request form is untouched).
  if (callsOf(source, "ask").some((c) => c.many && !LITERAL_OUTCOME.test(c.first))) {
    throw new ScriptSourceError("every ctx.ask(outcome, inputs) must name its outcome with a literal string, so the Engines it asks can be read from the code");
  }
  // Step 2a: a Unit the script declares used (`ctx.consume(outcome, subject)`) names its outcome the same way. It is
  // neither a material to hand nor an asked Engine.
  if (callsOf(source, "consume").some((c) => !LITERAL_OUTCOME.test(c.first))) {
    throw new ScriptSourceError("every ctx.consume(outcome, subject) must name its outcome with a literal string, so what a script may declare used can be read from the code");
  }
  const checked = await evaluate(`${BOOT}${moduleOf(js)}JSON.stringify(null);`, () => ({ stop: "a script calls nothing while it loads" }));
  if (checked.kind !== "done") throw new ScriptSourceError(checked.kind === "error" ? checked.message : checked.reason);
  return { materials: readMaterials(source), vendors: readVendors(source) };
}

/** Run a script once in its own engine. */
export async function runScript(source: string, spec: ScriptSpec, bridge: Bridge): Promise<RunOutcome> {
  let js: string;
  try {
    js = transpile(source);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
  const program =
    `${BOOT}${moduleOf(js)}` +
    `JSON.stringify((function () { var r = __run(__make(${JSON.stringify(JSON.stringify(spec))})); return r === undefined ? null : r; })());`;
  return evaluate(program, bridge);
}

/** Intl.DateTimeFormat for the sandbox: the host's own, a pure function (JSON in, JSON out). */
function hostIntl(localeJson: string, optionsJson: string, instant: number, method: string): string {
  try {
    const locale = JSON.parse(localeJson) as string | string[] | null;
    const options = JSON.parse(optionsJson) as Intl.DateTimeFormatOptions;
    const fmt = new Intl.DateTimeFormat(locale ?? undefined, options);
    if (method === "check") return JSON.stringify({ v: null });
    if (method === "format") return JSON.stringify({ v: fmt.format(new Date(instant)) });
    if (method === "formatToParts") return JSON.stringify({ v: fmt.formatToParts(new Date(instant)) });
    if (method === "resolvedOptions") return JSON.stringify({ v: fmt.resolvedOptions() });
    return JSON.stringify({ error: `Intl.DateTimeFormat has no ${method}` });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** Evaluate a program in a fresh engine with the bridge as its only door; the program's value is JSON text. */
async function evaluate(program: string, bridge: Bridge): Promise<RunOutcome> {
  // A fresh WebAssembly module per run: its own memory, and asyncify allows one suspended host call per module, so
  // concurrent runs never share one.
  const module = await newQuickJSAsyncWASMModule();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(SCRIPT_MEMORY_MB * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);

  const startedAt = Date.now();
  let computeMs = 0;
  let since = startedAt;
  let inHost = false;
  let interrupted: string | null = null;
  runtime.setInterruptHandler(() => {
    if (inHost) return false;
    const now = Date.now();
    if (computeMs + (now - since) > SCRIPT_CPU_MS) interrupted = `the script computed longer than its ${SCRIPT_CPU_MS} ms limit`;
    else if (now - startedAt > SCRIPT_WALL_MS) interrupted = `the script ran longer than its ${SCRIPT_WALL_MS / 60_000} min limit`;
    return interrupted !== null;
  });

  const context: QuickJSAsyncContext = runtime.newContext();
  let stopped: string | null = null;
  let hostCalls = 0;
  const host = context.newAsyncifiedFunction("__host", async (opHandle: QuickJSHandle, argsHandle: QuickJSHandle) => {
    computeMs += Date.now() - since;
    inHost = true;
    try {
      const op = context.getString(opHandle) as BridgeOp;
      const args = JSON.parse(context.getString(argsHandle)) as unknown[];
      hostCalls++;
      let answer: BridgeAnswer;
      if (hostCalls > SCRIPT_MAX_HOST_CALLS) answer = { stop: `the script called its host more than ${SCRIPT_MAX_HOST_CALLS} times` };
      else {
        try {
          answer = await bridge(op, args);
        } catch (e) {
          answer = { stop: e instanceof Error ? e.message : String(e) };
        }
      }
      if ("stop" in answer && stopped === null) stopped = answer.stop;
      return context.newString(JSON.stringify(answer));
    } finally {
      inHost = false;
      since = Date.now();
    }
  });
  context.setProp(context.global, "__host", host);
  host.dispose();
  const intl = context.newFunction("__intl", (localeH: QuickJSHandle, optionsH: QuickJSHandle, instantH: QuickJSHandle, methodH: QuickJSHandle) =>
    context.newString(hostIntl(context.getString(localeH), context.getString(optionsH), context.getNumber(instantH), context.getString(methodH))),
  );
  context.setProp(context.global, "__intl", intl);
  intl.dispose();

  try {
    const evaluated = await context.evalCodeAsync(program, "script.js");
    if (evaluated.error) {
      const dumped = context.dump(evaluated.error) as { message?: string } | string;
      evaluated.error.dispose();
      if (stopped !== null) return { kind: "stopped", reason: stopped };
      if (interrupted !== null) return { kind: "error", message: interrupted };
      const message = typeof dumped === "string" ? dumped : String(dumped?.message ?? JSON.stringify(dumped));
      if (/out of memory/i.test(message)) return { kind: "error", message: `the script went over its ${SCRIPT_MEMORY_MB} MB memory limit` };
      return { kind: "error", message };
    }
    const text = context.getString(evaluated.value);
    evaluated.value.dispose();
    if (stopped !== null) return { kind: "stopped", reason: stopped };
    return { kind: "done", result: JSON.parse(text) as ScriptResult };
  } finally {
    context.dispose();
    // The runtime is NOT disposed: quickjs-emscripten's asyncify build throws while freeing the host function's
    // reference at runtime disposal (its runtime map is cleared first). The whole WebAssembly module is per run and
    // dropped here, so the garbage collector reclaims its memory with it.
  }
}
