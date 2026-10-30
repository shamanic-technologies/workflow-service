/**
 * FACTORY-P2-ENGINES: script code kept in the database runs here, in a hard sandbox.
 *
 * Each run gets its OWN QuickJS engine (a WebAssembly module, `quickjs-emscripten`): a separate JavaScript engine
 * with its own heap capped at `SCRIPT_MEMORY_MB` and `SCRIPT_CPU_MS` of its own compute time (time spent waiting on
 * the host, a vendor call, does not count; `SCRIPT_WALL_MS` bounds the whole run). The engine holds the language's
 * built-ins and nothing of Node: no require, no process, no env, no fetch, no timers, no file system, no socket, no
 * database handle, no object of this process. The script sees one object, its context (subject, brand, day, tactics,
 * Request, its Engine's storage, `get` on its materials, `ask`, the vendor, `accounts`, `wait`), built inside the
 * engine from copied JSON; every call it makes crosses ONE host function that takes and returns text. So whatever a
 * stored script does, it reaches the outside only through the bridge the host hands it, which answers for the run's
 * own org and identity only (src/lib/scripts/script-runner.ts).
 *
 * Same contract as the GTM Factory runner (gtm-factory `apps/server/src/sandbox.ts`, isolated-vm there): a script
 * written for it runs here unchanged. QuickJS instead of isolated-vm: pure WebAssembly, no native build on the box.
 */
import { transform } from "sucrase";
import { newQuickJSAsyncWASMModule, type QuickJSAsyncContext, type QuickJSHandle } from "quickjs-emscripten";

export const SCRIPT_CPU_MS = 2_000;
export const SCRIPT_WALL_MS = 10 * 60_000;
export const SCRIPT_MEMORY_MB = 64;
/** A script that calls its host more often than this is stopped (a loop on a vendor). */
export const SCRIPT_MAX_HOST_CALLS = 500;

/** What a script asks the host for, one call at a time (JSON in, JSON out). */
export type BridgeOp = "get" | "ask" | "vendor" | "wait" | "accounts" | "storage.get" | "storage.set" | "storage.delete" | "storage.count";
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
export type ScriptResult = { content?: Record<string, unknown>; found?: string; unmade?: string } | null;

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
      }),
      get: function (outcome) { return deep(call("get", [outcome])); },
      ask: function (request) { call("ask", [request === undefined ? null : request]); },
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

/** The outcomes a script's code asks its Providers for (`ctx.get("...")`, literals): its materials. */
export function readMaterials(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?<!storage)\.get\(\s*["'`]([a-z0-9_:.-]+)["'`]\s*\)/gi)) if (!out.includes(m[1]!)) out.push(m[1]!);
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
  const literal = (source.match(/(?<!storage)\.get\s*\(\s*["'`][a-z0-9_]+["'`]\s*\)/g) ?? []).length;
  if (literal !== calls) throw new ScriptSourceError("every ctx.get(...) must name its outcome with a literal string, so the materials can be read from the code");
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
