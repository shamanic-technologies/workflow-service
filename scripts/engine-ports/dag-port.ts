/**
 * MIGRATE-1105 S4b: ONE generic port of a campaign DAG into a stored script, byte for byte what Windmill ran.
 *
 * The DAG is converted exactly as it ran (`dagToOpenFlow`, the same converter, so every step the converter adds or
 * rewrites is in: the brief on LLM bodies, the campaign's WhatsApp line, the settled-thread wait, the named lead on a
 * serve...). The flow's modules then become one synchronous `run(ctx)`, in their order:
 *   - a SCRIPT step = the step's own code in its own closure (its `main` called with the step's input expressions,
 *     verbatim); `async`/`await` dropped (a script calls its host synchronously), code that calls `fetch` refused;
 *   - a CALL step (`f/nodes/http_call`) = the door that serves its producer, method and path (`doorFor`), asked with the
 *     request the step's input expressions build, read the way the old call step read it (`skip`, `tolerateFailure`,
 *     `skipOnRefusalCodes`, `validateResponse`, its retries): `callStep` below is `scripts/nodes/http-call.ts` on a door;
 *   - a CONDITION = an `if` on its branch expressions, verbatim;
 *   - the campaign chassis is the Engine runner's: gate-check is not called, `results.start_run` is the run's Request
 *     (`/start-run`'s answer), and an end-run's body is turned into the script's result the runner states the same end
 *     from (`endOf`, `engine-runner.ts` `endRunBodyOf`);
 *   - `runnerSteps` (the steps whose work the runner does now: the run's own ledger declarations) are left out, named.
 * The clock: `new Date()` / `Date.now()` read the run's clock (`ctx.request.now`), never the host's.
 * `flow_input` is what a run states: its campaign, its own run (`request.runId`), its trigger, its day.
 */
import { dagToOpenFlow, type OpenFlow } from "../../src/lib/dag-to-openflow.js";
import type { DAG } from "../../src/lib/dag-validator.js";
import { doorFor } from "../../src/lib/scripts/windmill-cases.js";
import { SERVICE_DOOR_VENDORS, VOICE_READ, VOICE_SKILL_SLUG } from "../../src/lib/scripts/vendors.js";

type Transform = { type: "javascript"; expr: string } | { type: "static"; value: unknown };
type Module = { id: string; value: Record<string, any>; retry?: { constant?: { attempts: number } }; stop_after_if?: { expr: string } };

const CALL_PATH = "f/nodes/http_call";
const CHASSIS = new Set(["/gate-check", "/start-run", "/end-run"]);
/** The fields of a call step that build its request or say how it is read (everything else is identity the run holds). */
const CALL_FIELDS = ["service", "method", "path", "params", "query", "body", "skip", "tolerateFailure", "skipOnRefusalCodes", "validateResponse", "pollWhile", "omitHeaders"] as const;

const exprOf = (t: Transform | undefined): string => (!t ? "undefined" : t.type === "static" ? JSON.stringify(t.value) : `(${t.expr})`);

/** A step's `main` parameter names, in order (Windmill maps its inputs by name). */
function paramsOf(code: string, id: string): string[] {
  const m = /export\s+async\s+function\s+main\s*\(([^)]*)\)/.exec(code);
  if (!m) throw new Error(`${id}: not a Windmill step (export async function main)`);
  return m[1]!.split(",").map((p) => p.trim().replace(/[:=].*$/, "").trim()).filter(Boolean);
}

/** A step's code as a synchronous function in its own closure (two steps may define the same helper). */
function stepFunction(code: string, id: string): string {
  if (/\bfetch\s*\(/.test(code)) throw new Error(`${id}: calls fetch itself; a script reaches out only through its doors (name it in runnerSteps if the runner does its work)`);
  const sync = code
    .replace(/export\s+async\s+function\s+main\s*\(/, "function main(")
    .replace(/\basync\s+function\b/g, "function")
    .replace(/\basync\s*\(/g, "(")
    .replace(/\bawait\s+/g, "");
  if (/\bawait\b|\basync\b/.test(sync)) throw new Error(`${id}: still awaits something after the port; port it by hand`);
  return `const step_${id} = (function () {\n${sync}\nreturn main;\n})();`;
}

export interface DagPortOptions {
  /** One line naming what the script does (the head comment). */
  title: string;
  /** Step ids (DAG node ids) whose work the Engine runner does now: left out. */
  runnerSteps?: string[];
  /**
   * The Unit a reactive run answers (the campaign's from outcome, its trigger occurrence), read through `ctx.get`, so
   * the Rating offers this script only to a run that holds one. Absent = a proactive script (it finds its own person).
   */
  reads?: string;
}

interface Built {
  functions: string[];
  doors: Set<string>;
}

function moduleCode(m: Module, b: Built, runnerSteps: Set<string>, depth: number): string {
  const pad = "  ".repeat(depth);
  const v = m.value;
  if (runnerSteps.has(m.id)) return `${pad}// ${m.id}: the Engine runner's (left out)\n`;
  if (v.type === "rawscript") {
    if (!v.content) return `${pad}// ${m.id}: empty step\n`;
    b.functions.push(stepFunction(v.content, m.id));
    const it = (v.input_transforms ?? {}) as Record<string, Transform>;
    const args = paramsOf(v.content, m.id).map((p) => exprOf(it[p]));
    return `${pad}results.${m.id} = step_${m.id}(${args.join(", ")});\n`;
  }
  if (v.type === "branchone") {
    let out = "";
    v.branches.forEach((br: { expr: string; modules: Module[] }, i: number) => {
      out += `${pad}${i === 0 ? "if" : "else if"} (${br.expr}) {\n${br.modules.map((x) => moduleCode(x, b, runnerSteps, depth + 1)).join("")}${pad}}\n`;
    });
    if (v.default?.length) out += `${pad}else {\n${v.default.map((x: Module) => moduleCode(x, b, runnerSteps, depth + 1)).join("")}${pad}}\n`;
    return out;
  }
  if (v.type !== "script" || v.path !== CALL_PATH) throw new Error(`${m.id}: a ${v.type} step (${String(v.path ?? "")}) has no port`);
  const it = (v.input_transforms ?? {}) as Record<string, Transform>;
  const s = (k: string) => (it[k]?.type === "static" ? (it[k] as { value: unknown }).value : undefined);
  const service = String(s("service") ?? "");
  const method = String(s("method") ?? "");
  const path = String(s("path") ?? "");
  // A DAG's legacy writer pick (`withLegBestLlm`, features `/internal/writer-pick`) ports to the Rating's LLM pick for the
  // script's own Engine and its writer call (LLM-PICK-SCRIPTS-1112: the stored follow-ups were upgraded the same way; the
  // writer pick's door is deleted, WRITER-PICK-LAST-CALLERS-1113).
  if (service === "features" && method === "GET" && path === "/internal/writer-pick") {
    b.doors.add("llm.pick");
    const skip = it.skip !== undefined ? `, skip: ${exprOf(it.skip)}` : "";
    return `${pad}results.${m.id} = callStep(ctx, "llm.pick", { service: "script", method: "TACTIC", path: " llm", query: {"place":"writer"}${skip} }, ${m.retry?.constant?.attempts ?? 0});\n`;
  }
  if (service === "campaign" && CHASSIS.has(path)) {
    if (path === "/gate-check") return `${pad}// gate_check: the Engine runner's\n`;
    if (path === "/start-run") return `${pad}results.${m.id} = START;\n`;
    return `${pad}return endOf(${exprOf(it.body)}, ${JSON.stringify(m.id)});\n`;
  }
  // Our one voice, read live (`voice.read`), as windmill-cases.ts reads the recorded skill read.
  const voice = service === "chat" && method === "GET" && path === "/internal/skills/{slug}" && (s("params") as { slug?: unknown } | undefined)?.slug === VOICE_SKILL_SLUG ? VOICE_READ : null;
  const door = voice ?? doorFor(service, method, path) ?? Object.entries(SERVICE_DOOR_VENDORS).find(([, d]) => !d.asRun && d.service === service && d.method === method && d.path === path)?.[0];
  if (!door) throw new Error(`${m.id}: ${method} ${service} ${path} has no door (add one to SERVICE_DOOR_VENDORS)`);
  b.doors.add(door);
  const fields = CALL_FIELDS.filter((f) => it[f] !== undefined).map((f) => `${f}: ${exprOf(it[f])}`);
  // Path parameters in the door's names when the step named them otherwise, by position (as windmill-cases.ts reads them).
  const doorPath = SERVICE_DOOR_VENDORS[door]?.path ?? path;
  const doorNames = [...doorPath.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!);
  const stepNames = [...path.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!);
  if (doorNames.length === stepNames.length && stepNames.some((n, i) => n !== doorNames[i])) {
    fields.push(`rename: ${JSON.stringify(Object.fromEntries(stepNames.map((n, i) => [n, doorNames[i]])))}`);
  }
  const retries = m.retry?.constant?.attempts ?? 0;
  return `${pad}results.${m.id} = callStep(ctx, ${JSON.stringify(door)}, { ${fields.join(", ")} }, ${retries});\n`;
}

/** The script, built from the DAG (the one the old workflow stored). */
export function portDag(dag: DAG, opts: DagPortOptions): string {
  const flow: OpenFlow = dagToOpenFlow(dag, opts.title);
  const runnerSteps = new Set((opts.runnerSteps ?? []).map((id) => id.replace(/-/g, "_")));
  const b: Built = { functions: [], doors: new Set() };
  const body = (flow.value.modules as unknown as Module[]).map((m) => moduleCode(m, b, runnerSteps, 1)).join("");
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** ${opts.title} (MIGRATE-1105 S4b: the old DAG's own steps, in its order, on doors). */`,
    PORT_RUNTIME,
    ...b.functions,
    `
export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  if (typeof R.now !== "string" || !R.now) throw new Error("the run carries no clock (request.now)");
  NOW_MS = RealDate.parse(R.now);
  TRIGGER = R.trigger ?? null;
  const START = R;
  const flow_input: any = {
    campaignId: R.campaignId ?? null,
    runId: R.runId ?? null,
    trigger: R.trigger ?? null,
    currentDate: R.now.slice(0, 10),
    brandId: Array.isArray(R.brandIds) ? R.brandIds.join(",") : (R.brandId ?? null),
    featureSlug: R.featureSlug ?? null,
  };
  const results: any = {};
${opts.reads ? `  ctx.get(${JSON.stringify(opts.reads)});\n` : ""}${body}  throw new Error("the run reached no end");
}
`,
  ].join("\n");
}

/**
 * What every port carries: no console (a script's words are its result), no URL class (the one thing steps read off a
 * URL is its host), the run's clock, and `callStep` = the old call step (`scripts/nodes/http-call.ts`) read on a door.
 */
export const PORT_RUNTIME = `
const console = { log: (..._a: unknown[]) => {}, error: (..._a: unknown[]) => {}, warn: (..._a: unknown[]) => {} };
const URL = function (this: { hostname: string; href: string }, u: string) {
  const m = /^[a-z][a-z0-9+.-]*:[/][/](?:[^@/?#]*@)?([^/?#:]+)(?::[0-9]+)?(?:[/?#]|$)/i.exec(String(u));
  if (!m) throw new TypeError("Invalid URL: " + String(u));
  this.hostname = m[1]!.toLowerCase();
  this.href = String(u);
} as unknown as new (u: string) => { hostname: string; href: string };
/** The run's clock: a Date made with no argument, and Date.now(), are the run's \`now\`. */
const RealDate: any = (globalThis as any).Date;
let NOW_MS = 0;
let TRIGGER: any = null;
const Date: any = function (this: unknown, ...a: unknown[]) {
  if (!(this instanceof (Date as any))) return new RealDate(NOW_MS).toString();
  return a.length === 0 ? new RealDate(NOW_MS) : new (RealDate as any)(...a);
};
Date.prototype = RealDate.prototype;
Date.now = () => NOW_MS;
Date.parse = RealDate.parse;
Date.UTC = RealDate.UTC;

/** The sender's human sentence on a refusal body: \`details\` when a sentence, else \`error\` (http-call readRefusalReason). */
function refusalReason(o: any): string | null {
  if (!o || typeof o !== "object") return null;
  if (typeof o.details === "string" && o.details.trim() !== "") return o.details;
  if (o.details && typeof o.details === "object") {
    const nested = refusalReason(o.details);
    if (nested !== null) return nested;
  }
  if (typeof o.error === "string" && o.error.trim() !== "") return o.error;
  return null;
}
function readField(obj: any, field: string): unknown {
  if (obj && typeof obj === "object" && field in obj) return obj[field];
  return field.split(".").reduce((v: any, k) => (v && typeof v === "object" ? v[k] : undefined), obj);
}
const plain = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
/** A body or query as the old step sent it: undefined keys gone, the converter's workflowSlug gone (a script runs none). */
function sent(v: unknown): any {
  if (!plain(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined && k !== "workflowSlug") out[k] = x;
  return out;
}

/** One old call step, on its door: the same request, read the same way (http-call.ts). */
function callStep(ctx: any, door: string, s: any, retries: number): any {
  if (s.skip === true) return { ok: false, skipped: true, notCalled: true };
  const where = String(s.method) + " " + String(s.service) + String(s.path);
  let args: Record<string, unknown>;
  if (door === "llm.complete") args = sent(s.body ?? {});
  else if (door === "voice.read") args = {};
  else if (door === "lead.serve") args = Object.fromEntries(Object.entries(sent(s.method === "GET" ? s.query ?? {} : s.body ?? {})).filter(([, v]) => v !== null));
  else {
    args = {};
    const params = plain(s.params) && plain(s.rename) ? Object.fromEntries(Object.entries(s.params).map(([k, v]) => [s.rename[k] ?? k, v])) : s.params;
    if (plain(params) && Object.keys(params).length) args.params = params;
    const q = sent(s.query);
    if (plain(q) && Object.keys(q).length) args.query = q;
    if (s.method !== "GET") args.body = sent(s.body ?? {});
    if (Array.isArray(s.omitHeaders) && s.omitHeaders.length) args.omitHeaders = s.omitHeaders;
    if (plain(s.pollWhile)) args.pollWhile = s.pollWhile;
  }
  for (let attempt = 0; ; attempt++) {
    const r: { ok: boolean; data: any } = ctx.vendor.call(door, args);
    if (r.ok) {
      const result = door === "lead.serve" || door === "voice.read" ? r.data : r.data ?? {};
      if (s.validateResponse && readField(result, s.validateResponse.field) !== s.validateResponse.equals) {
        throw new Error(where + " validation failed: expected " + s.validateResponse.field + "=" + JSON.stringify(s.validateResponse.equals) + ", got " + JSON.stringify(readField(result, s.validateResponse.field)));
      }
      return result;
    }
    const status = r.data.status;
    const body = plain(r.data.body) ? r.data.body : {};
    const text = Object.keys(body).length ? JSON.stringify(body) : String(r.data.error ?? "");
    const codes: string[] = Array.isArray(s.skipOnRefusalCodes) ? s.skipOnRefusalCodes : [];
    if (codes.length && typeof status === "number" && status >= 400 && status < 500) {
      const code = typeof r.data.code === "string" ? r.data.code : null;
      if (code !== null && (codes.includes(code) || (status === 409 && codes.includes("*")))) {
        const reason = refusalReason(body) ?? code;
        return { ok: false, skipped: true, status, code, reason, refusal: text, delivery: { state: "refused", code, reason } };
      }
    }
    if (s.tolerateFailure === true) return { ok: false, status: typeof status === "number" ? status : 0, error: text };
    if (attempt < retries) continue;
    throw new Error(where + " failed (" + String(status ?? "") + "): " + text.slice(0, 1000));
  }
}

/**
 * The old end-run's body as the result the Engine runner states that same end from (engine-runner.ts endRunBodyOf):
 * failed = a throw; nobody left = audience_exhausted; nothing to do = null; not admitted / refused = unmade with the
 * producer's code and words; a delivered occurrence or any other normal run = made (an unfinished look on a run with
 * no occurrence: a normal run that made nothing).
 */
function endOf(body: any, end: string): ScriptResult {
  const b = plain(body) ? body : {};
  const delivery = plain(b.delivery) ? b.delivery : null;
  const refused = delivery && delivery.state === "refused";
  if (b.success !== true && !refused) throw new Error("the run ended failed (" + end + ")");
  if (b.stopCampaign === true) return { unmade: "audience_exhausted: nobody left to serve" };
  if (plain(b.personNotAdmitted)) return { unmade: "person_not_admitted: " + String(b.personNotAdmitted.reason ?? "") };
  if (refused) return { unmade: String(delivery.code ?? "refused") + ": " + String(delivery.reason ?? delivery.code ?? ""), ...(TRIGGER ? {} : { again: true }) };
  if (b.noWorkAvailable === true) return null;
  if (TRIGGER || (delivery && delivery.state === "delivered")) return { content: { end: b, step: end } };
  return { unmade: end + ": nothing made this run", again: true };
}
`;
