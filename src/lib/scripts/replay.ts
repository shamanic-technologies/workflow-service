/**
 * FACTORY-P2-ENGINES: prove a script against real recorded cases (ported from gtm-factory `packages/core/src/replay.ts`).
 *
 * A case is what a production system did once: the Units the work started from, every vendor call it made in order
 * (the answer it got, and the request it sent when that was recorded) and what it produced. The replay runs the
 * script IN THE SAME SANDBOX a live run uses, on those Units, with a vendor that answers from the record, then checks:
 * the same calls in the same order, the same requests where recorded, the same result. A dynasty that carries cases
 * is a PORT: a version of it is stored only when every case matches (src/lib/scripts/script-catalogue.ts). Cases hold
 * real personal data: they live in `script_cases`, never in git, and a failure report names a case by id only.
 */
import { runScript, type Bridge } from "./sandbox.js";

export interface VendorAnswer {
  ok: boolean;
  data: Record<string, unknown>;
}

/** One recorded vendor call: its name, the request when it was recorded, and the answer. */
export interface RecordedCall {
  name: string;
  args?: Record<string, unknown>;
  answer: VendorAnswer;
}

export interface AccountView {
  id: string;
  channel: string;
  address: string;
  role: string;
  status: "connected" | "to_reconnect";
  sentToday: number;
  sentWeek: number;
  readWeek: number;
}

/** One recorded unit of work (the gtm-factory `ReplayCase`, byte-compatible). */
export interface ReplayCase {
  id: string;
  units: Record<string, Record<string, unknown> | Record<string, unknown>[]>;
  subject?: string | null;
  tactics?: Record<string, unknown>;
  day?: number;
  request?: Record<string, unknown>;
  asks?: Record<string, unknown>[];
  accounts?: AccountView[];
  calls: RecordedCall[];
  expect: { content?: Record<string, unknown>; found?: string; nothing?: true; fails?: string };
}

export interface ReplayReport {
  id: string;
  match: boolean;
  diffs: string[];
}

export interface ReplaySummary {
  cases: number;
  matches: number;
  failures: ReplayReport[];
}

/** Deep equality on JSON values (key order does not matter, an undefined key is absent). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameJson(x, bb[i]));
  }
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** The first place two values differ, for a readable report. */
export function firstDiff(path: string, a: unknown, b: unknown): string {
  if (typeof a === "string" && typeof b === "string") {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return `${path}: differs at char ${i}: got ${JSON.stringify(a.slice(Math.max(0, i - 30), i + 60))}, want ${JSON.stringify(b.slice(Math.max(0, i - 30), i + 60))}`;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) {
      const x = (a as Record<string, unknown>)[k];
      const y = (b as Record<string, unknown>)[k];
      if (!sameJson(x, y)) return firstDiff(`${path}.${k}`, x, y);
    }
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: ${a.length} items, want ${b.length}`;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return firstDiff(`${path}[${i}]`, a[i], b[i]);
  }
  return `${path}: got ${JSON.stringify(a)?.slice(0, 200)}, want ${JSON.stringify(b)?.slice(0, 200)}`;
}

const REPLAY_STOP = "__replay_stop__";

/** Run one script on one case, in the sandbox, and compare. */
export async function replayCase(source: string, c: ReplayCase): Promise<ReplayReport> {
  const diffs: string[] = [];
  const gotten = new Map<string, number>();
  const asked: unknown[] = [];
  const store = new Map<string, unknown>();
  let next = 0;
  const stop = (why: string) => {
    diffs.push(why);
    return { stop: REPLAY_STOP };
  };
  const bridge: Bridge = (op, args) => {
    if (op === "get") {
      const outcome = String(args[0]);
      const held = c.units[outcome];
      if (held === undefined) return stop(`asked for ${outcome}, which the case does not hold`);
      const n = gotten.get(outcome) ?? 0;
      gotten.set(outcome, n + 1);
      const list = Array.isArray(held) ? held : [held];
      return { v: { id: `${c.id}:${outcome}:${n}`, outcome, subject: c.subject ?? "", ageDays: 0, content: list[Math.min(n, list.length - 1)] } };
    }
    if (op === "vendor") {
      const name = String(args[0]);
      const rec = c.calls[next];
      if (!rec) return stop(`call ${next + 1} ${name}: the record made no more calls`);
      if (rec.name !== name) return stop(`call ${next + 1}: called ${name}, the record called ${rec.name}`);
      const sent = (args[1] ?? {}) as Record<string, unknown>;
      if (rec.args !== undefined && !sameJson(sent, rec.args)) diffs.push(`call ${next + 1} ${name}: ${firstDiff("request", sent, rec.args)}`);
      next++;
      return { v: rec.answer };
    }
    if (op === "ask") {
      asked.push(args[0]);
      return { v: null };
    }
    if (op === "accounts") return { v: (c.accounts ?? []).filter((a) => a.channel === args[0] && a.role === args[1]) };
    if (op === "wait") return stop(`asked to wait ${String(args[0])} days`);
    const key = `${String(args[0])}\u0000${String(args[1])}`;
    if (op === "storage.get") return { v: store.get(key) ?? null };
    if (op === "storage.set") {
      store.set(key, args[2]);
      return { v: null };
    }
    if (op === "storage.delete") {
      store.delete(key);
      return { v: null };
    }
    if (op === "storage.count") return { v: [...store.keys()].filter((k) => k.startsWith(`${String(args[0])}\u0000`)).length };
    return stop(`${String(op)} asked`);
  };

  const out = await runScript(
    source,
    { subject: c.subject ?? null, brand: "replay", day: c.day ?? 0, tactics: c.tactics ?? {}, request: c.request ?? null },
    bridge,
  );
  if (out.kind === "stopped") {
    if (out.reason !== REPLAY_STOP) diffs.push(`stopped: ${out.reason}`);
    return { id: c.id, match: false, diffs };
  }
  const failed = out.kind === "error" ? out.message : null;
  const result = out.kind === "done" ? out.result : null;
  if (c.asks !== undefined && !sameJson(asked, c.asks)) diffs.push(firstDiff("asks", asked, c.asks));
  if (next < c.calls.length) diffs.push(`made ${next} calls, the record made ${c.calls.length} (next: ${c.calls[next]!.name})`);
  const want = c.expect;
  if (want.fails !== undefined) {
    if (failed === null) diffs.push(`returned a result, the record failed: ${want.fails}`);
    else if (!failed.includes(want.fails)) diffs.push(`failed with "${failed.slice(0, 200)}", want a failure naming "${want.fails}"`);
  } else if (failed !== null) {
    diffs.push(`failed: ${failed.slice(0, 300)}`);
  } else if (want.nothing) {
    if (result !== null) diffs.push(`returned ${JSON.stringify(result).slice(0, 200)}, the record made nothing`);
  } else {
    if (want.content !== undefined && !sameJson(result?.content, want.content)) diffs.push(firstDiff("content", result?.content, want.content));
    if (want.found !== undefined && result?.found !== want.found) diffs.push(`found ${String(result?.found)}, want ${want.found}`);
  }
  return { id: c.id, match: diffs.length === 0, diffs };
}

/** Every case of a script: how many match, and the reports of those that do not. */
export async function replayAll(source: string, cases: readonly ReplayCase[]): Promise<ReplaySummary> {
  const reports: ReplayReport[] = [];
  for (const c of cases) reports.push(await replayCase(source, c));
  return { cases: cases.length, matches: reports.filter((r) => r.match).length, failures: reports.filter((r) => !r.match) };
}
