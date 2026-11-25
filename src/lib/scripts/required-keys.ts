/**
 * SOLO-PLAN-1125 (owner 2026-11-25): a founder who launches a campaign without our paid plan brings their own keys, and
 * their AI (through our MCP) must ask for EXACTLY the keys that campaign's Plan needs, nothing else.
 *
 * The Plan is read the way a run reads it (PLAN-RECURSIVE-PER-ENGINE-1124): from the Target's Engine, the scripts the
 * campaign's strategy keeps (no campaign yet = the no-campaign strategy), runnable; each script's Units it reads or asks
 * are asked of their own Engine, recursively, never an Engine already above. Each script needs:
 *   - for an LLM call (`llm.complete` / `chat.complete`): the provider of each LLM its tactics state (`llm`, `llms`);
 *   - for any other call of one of our doors: the providers key-service has OBSERVED that endpoint requesting
 *     (`POST /provider-requirements`, the same read `/workflows/{id}/required-providers` uses).
 * A script that asks the LLM completion Engine (one script per model, the founder's own Claude among them) needs no LLM
 * key itself: the completion scripts it may draw each state theirs, and the Rating picks among them, so a provider
 * needed by only SOME scripts of an Engine is one choice among several (`required: false`), never a must.
 * Which keys the org holds: key-service `GET /keys` (the org's own keys), read with the org's identity.
 * No branch on an org, a model or an Engine.
 */
import { and, eq } from "drizzle-orm";
import { scripts, type ScriptRow } from "../../db/schema.js";
import type { AnyPgDb } from "./script-catalogue.js";
import { keptDynastiesFor, provenness, statedLlmsOf } from "./engine.js";
import { asksOf, readMaterials } from "./sandbox.js";
import { CHAT_COMPLETE, JEV_CHOICE, JEV_NOUL, LLM_COMPLETE, SCRIPT_VENDORS, SERVICE_DOOR_VENDORS } from "./vendors.js";
import { PROVIDER_DOMAINS } from "../provider-domains.js";

export interface Endpoint {
  service: string;
  method: string;
  path: string;
}

export interface RequiredKeysDeps {
  /** key-service `POST /provider-requirements`: the providers each endpoint was observed requesting. */
  providersOf(endpoints: Endpoint[]): Promise<Array<Endpoint & { provider: string }>>;
  /** key-service `GET /keys`: the providers the org holds its own key for. */
  orgKeys(orgId: string, userId: string): Promise<string[]>;
}

export interface KeyNeed {
  provider: string;
  domain: string | null;
  /** The org already holds its own key for it. */
  held: boolean;
  /** Every script of an Engine on the Plan that may run needs it (false = some script of each Engine runs without it). */
  required: boolean;
  /** What it is for: the Engine, the script (its client-readable name), the call. */
  for: Array<{ engine: string; script: string; scriptName: string | null; call: string }>;
}

export interface EnginePlanKeys {
  outcome: string;
  scripts: Array<{ dynasty: string; name: string | null; providers: string[]; ready: boolean }>;
  /** At least one of its scripts needs only keys the org holds (an Engine with no script is never ready). */
  ready: boolean;
}

export interface RequiredKeys {
  outcome: string;
  campaignId: string | null;
  keys: KeyNeed[];
  engines: EnginePlanKeys[];
  /** Every Engine on the Plan has a script the org's keys already let run. */
  ready: boolean;
}

/** The judgment endpoint an org-billed `jev.*` call takes (chat-service), and the completion one. */
const JUDGMENT_ENDPOINT: Endpoint = { service: "chat", method: "POST", path: "/orgs/judgments" };
const COMPLETE_ENDPOINT: Endpoint = { service: "chat", method: "POST", path: "/complete" };
const LLM_CALLS = new Set<string>([LLM_COMPLETE, CHAT_COMPLETE]);
const KNOWN_VENDORS = new Set<string>(SCRIPT_VENDORS as readonly string[]);

/** PURE: the vendors a script's code names (any literal of a known vendor: direct calls and helper-wrapped ones). */
export function vendorsNamedIn(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/["'`]([a-z0-9_]+(?:\.[a-z0-9_]+)+)["'`]/gi)) {
    const name = m[1]!;
    if (KNOWN_VENDORS.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** PURE: the endpoint one vendor call reaches (null = no third party behind it: a pick, our voice, a public page). */
export function endpointOfVendor(name: string): Endpoint | null {
  if (name === JEV_NOUL || name === JEV_CHOICE) return JUDGMENT_ENDPOINT;
  if (LLM_CALLS.has(name)) return COMPLETE_ENDPOINT;
  const door = SERVICE_DOOR_VENDORS[name];
  return door ? { service: door.service, method: door.method, path: door.path } : null;
}

const endpointKey = (e: Endpoint) => `${e.service}|${e.method.toUpperCase()}|${e.path}`;

/** Walk the Plan from `outcome` and say which keys it needs, and which the org holds. */
export async function requiredKeys(
  db: AnyPgDb,
  input: { outcome: string; orgId: string; userId: string; campaignId: string | null },
  deps: RequiredKeysDeps,
): Promise<RequiredKeys> {
  // 1. The Plan: every Engine reachable from the Target, its kept runnable scripts.
  const engines = new Map<string, ScriptRow[]>();
  const queue: string[] = [input.outcome];
  while (queue.length > 0) {
    const outcome = queue.shift()!;
    if (engines.has(outcome)) continue;
    const rows = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.outcome, outcome), eq(scripts.status, "active"), eq(scripts.dynastyStatus, "active")));
    const kept = rows.length > 0 ? await keptDynastiesFor(outcome, input.campaignId) : null;
    const live: ScriptRow[] = [];
    for (const row of rows) {
      if (kept && !kept.has(row.dynasty)) continue;
      if (!(await provenness(db, row)).runnable) continue;
      live.push(row);
    }
    engines.set(outcome, live);
    for (const row of live) {
      for (const m of [...(row.materials ?? readMaterials(row.code)), ...asksOf(row)]) if (!engines.has(m) && !queue.includes(m)) queue.push(m);
    }
  }

  // 2. What each script calls: LLM calls by the providers its tactics state, any other call by its endpoint.
  type Need = { provider: string; call: string } | { endpoint: Endpoint; call: string };
  const needsOf = new Map<string, Need[]>();
  const endpoints = new Map<string, Endpoint>();
  for (const rows of engines.values()) {
    for (const row of rows) {
      const needs: Need[] = [];
      const llms = statedLlmsOf(row.tactics);
      for (const name of vendorsNamedIn(row.code)) {
        if (LLM_CALLS.has(name) && llms.length > 0) {
          for (const l of llms) needs.push({ provider: l.provider, call: `${name} (${l.provider} ${l.model})` });
          continue;
        }
        const e = endpointOfVendor(name);
        if (!e) continue;
        endpoints.set(endpointKey(e), e);
        needs.push({ endpoint: e, call: name });
      }
      needsOf.set(row.id, needs);
    }
  }
  const observed = endpoints.size > 0 ? await deps.providersOf([...endpoints.values()]) : [];
  const providersAt = new Map<string, string[]>();
  for (const r of observed) {
    const k = endpointKey(r);
    const list = providersAt.get(k) ?? [];
    if (!list.includes(r.provider)) list.push(r.provider);
    providersAt.set(k, list);
  }
  const held = new Set((await deps.orgKeys(input.orgId, input.userId)).map((p) => p.toLowerCase()));

  // 3. Per script, per Engine, then the keys.
  const byProvider = new Map<string, KeyNeed>();
  const enginesOut: EnginePlanKeys[] = [];
  for (const [outcome, rows] of engines) {
    const scriptsOut: EnginePlanKeys["scripts"] = [];
    for (const row of rows) {
      const providers: string[] = [];
      for (const need of needsOf.get(row.id) ?? []) {
        const list = "provider" in need ? [need.provider] : (providersAt.get(endpointKey(need.endpoint)) ?? []);
        for (const provider of list) {
          if (!providers.includes(provider)) providers.push(provider);
          const k = byProvider.get(provider) ?? { provider, domain: PROVIDER_DOMAINS[provider] ?? null, held: held.has(provider.toLowerCase()), required: false, for: [] };
          if (!k.for.some((f) => f.engine === outcome && f.script === row.dynasty && f.call === need.call)) {
            k.for.push({ engine: outcome, script: row.dynasty, scriptName: row.name ?? null, call: need.call });
          }
          byProvider.set(provider, k);
        }
      }
      scriptsOut.push({ dynasty: row.dynasty, name: row.name ?? null, providers, ready: providers.every((p) => held.has(p.toLowerCase())) });
    }
    // A provider every script of this Engine needs is a must (the Rating cannot run around it).
    if (scriptsOut.length > 0) {
      for (const p of scriptsOut[0]!.providers) if (scriptsOut.every((s) => s.providers.includes(p))) byProvider.get(p)!.required = true;
    }
    enginesOut.push({ outcome, scripts: scriptsOut, ready: scriptsOut.some((s) => s.ready) });
  }
  const keys = [...byProvider.values()].sort((a, b) => Number(b.required) - Number(a.required) || a.provider.localeCompare(b.provider));
  return { outcome: input.outcome, campaignId: input.campaignId, keys, engines: enginesOut, ready: enginesOut.every((e) => e.ready) };
}

/** The production reads: key-service with this service's key, as the org. */
export function productionRequiredKeysDeps(): RequiredKeysDeps {
  const base = (process.env.KEY_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.KEY_SERVICE_API_KEY ?? "";
  const need = () => {
    if (!base || !key) throw new Error("KEY_SERVICE_URL and KEY_SERVICE_API_KEY must be set to read the keys a Plan needs");
  };
  return {
    async providersOf(endpoints) {
      need();
      const res = await fetch(`${base}/provider-requirements`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({ endpoints }),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`key-service POST /provider-requirements -> ${res.status}: ${text.slice(0, 300)}`);
      const body = JSON.parse(text) as { requirements?: unknown };
      if (!Array.isArray(body.requirements)) throw new Error("key-service answered no requirements");
      return body.requirements as Array<Endpoint & { provider: string }>;
    },
    async orgKeys(orgId, userId) {
      need();
      const res = await fetch(`${base}/keys`, {
        headers: { "x-api-key": key, "x-org-id": orgId, "x-user-id": userId },
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`key-service GET /keys -> ${res.status}: ${text.slice(0, 300)}`);
      const body = JSON.parse(text) as { keys?: Array<{ provider?: unknown }> };
      if (!Array.isArray(body.keys)) throw new Error("key-service answered no keys list");
      return body.keys.map((k) => String(k.provider ?? "")).filter(Boolean);
    },
  };
}
