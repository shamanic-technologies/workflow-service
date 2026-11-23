/**
 * ENGINE-GET-ASK-1123: where the Units of an outcome are READ (`ctx.get(outcome, filters)`).
 *
 * The Provider of an outcome is the service that owns its Units. It documents its own read: an operation of its SERVED
 * OpenAPI carrying the tag `provider:<outcome>`. Route, params, query, body and answer are that service's, as its doc
 * states them; nothing here knows an outcome. This module only finds the tagged operations, from the specs the
 * api-registry holds (the client the workflow validator already reads them through), and keeps the index in memory.
 */
import { fetchServiceList, fetchSpecsForServices } from "../api-registry-client.js";

export interface ProviderOperation {
  /** The service that serves it (names `<SERVICE>_SERVICE_URL` / `_API_KEY`, like every run door). */
  service: string;
  method: "GET" | "POST" | "PUT";
  path: string;
  operationId: string | null;
}

/** What one outcome's Provider documents, and the services whose spec could not be read (their tags are unknown). */
export interface ProviderReads {
  operations: ProviderOperation[];
  unread: string[];
}

const TAG_PREFIX = "provider:";
/** The OpenAPI tag a Provider puts on the operation that reads its outcome's Units. */
export const providerTag = (outcome: string) => `${TAG_PREFIX}${outcome}`;

const CALLABLE = ["get", "post", "put"] as const;

/** Every operation tagged `provider:<outcome>` in these specs, by outcome (service then path order: stable). */
export function providerOperationsOf(specs: ReadonlyMap<string, Record<string, unknown>>): Map<string, ProviderOperation[]> {
  const out = new Map<string, ProviderOperation[]>();
  for (const service of [...specs.keys()].sort()) {
    const paths = specs.get(service)?.paths;
    if (!paths || typeof paths !== "object") continue;
    for (const path of Object.keys(paths as Record<string, unknown>).sort()) {
      const item = (paths as Record<string, unknown>)[path];
      if (!item || typeof item !== "object") continue;
      for (const method of CALLABLE) {
        const op = (item as Record<string, unknown>)[method];
        if (!op || typeof op !== "object") continue;
        const { tags, operationId } = op as { tags?: unknown; operationId?: unknown };
        if (!Array.isArray(tags)) continue;
        for (const tag of tags) {
          if (typeof tag !== "string" || !tag.startsWith(TAG_PREFIX) || tag.length === TAG_PREFIX.length) continue;
          const outcome = tag.slice(TAG_PREFIX.length);
          const list = out.get(outcome) ?? [];
          list.push({ service, method: method.toUpperCase() as ProviderOperation["method"], path, operationId: typeof operationId === "string" && operationId ? operationId : null });
          out.set(outcome, list);
        }
      }
    }
  }
  return out;
}

/** A whole index is kept this long; one missing a service's spec only this long (its tags may be the ones asked for). */
export const PROVIDER_INDEX_TTL_MS = 10 * 60_000;
export const PROVIDER_INDEX_PARTIAL_TTL_MS = 60_000;

export interface ProviderIndexSources {
  listServices(): Promise<string[]>;
  fetchSpecs(services: string[]): Promise<Map<string, Record<string, unknown>>>;
  now?(): number;
}

/** A cached reader of the fleet's Provider reads: one registry walk per TTL, shared by concurrent asks. */
export function createProviderIndex(sources: ProviderIndexSources): (outcome: string) => Promise<ProviderReads> {
  const now = sources.now ?? Date.now;
  type Held = { until: number; byOutcome: Map<string, ProviderOperation[]>; unread: string[] };
  let held: Held | null = null;
  let loading: Promise<Held> | null = null;
  const load = async (): Promise<Held> => {
    const services = await sources.listServices();
    const specs = await sources.fetchSpecs(services);
    const unread = services.filter((s) => !specs.has(s)).sort();
    return { until: now() + (unread.length > 0 ? PROVIDER_INDEX_PARTIAL_TTL_MS : PROVIDER_INDEX_TTL_MS), byOutcome: providerOperationsOf(specs), unread };
  };
  return async (outcome) => {
    let index = held;
    if (!index || index.until <= now()) {
      loading ??= load().finally(() => (loading = null));
      index = held = await loading;
    }
    return { operations: index.byOutcome.get(outcome) ?? [], unread: index.unread };
  };
}

let production: ((outcome: string) => Promise<ProviderReads>) | null = null;
/** The production index: every service the api-registry lists, its spec as the registry holds it. */
export function productionProviderReads(outcome: string): Promise<ProviderReads> {
  production ??= createProviderIndex({
    listServices: async () => (await fetchServiceList()).map((s) => s.service),
    fetchSpecs: (services) => fetchSpecsForServices(services),
  });
  return production(outcome);
}
