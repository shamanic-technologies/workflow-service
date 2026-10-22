/**
 * A sourcing workflow that states WHO it finds (LEAK-1012, owner 2026-10-14).
 *
 * Two funnels of one offer on one lead source (e.g. CRM contacts: a WhatsApp funnel and an email funnel) each run a
 * workflow on that source's pipe. Owner rule: "who a source pipe finds is that PIPE's lead strategy, never a
 * per-funnel/per-campaign audience pick", and "who to skip lives in the pipe's lead strategy or inside the
 * workflow". So the difference is stated by the workflow: a copy of the generic sourcing workflow whose serve call
 * (lead-service `POST /orgs/buffer/next`) says `reachableBy: [...]` (`"email"` | `"phone"`, every listed method
 * required; absent = unchanged), and whose description says it plainly, because features-service's Jev judges a
 * tactic on what the workflow DOES (DAG + description), never on its name.
 *
 * Generic over every sourcing pipe: nothing here names a channel. `scripts/fork-reachable-by-copies.mjs` forks the
 * copy (`POST /workflows/dynasty/{slug}/fork`, registered on the source's pipe), and `scripts/seed-sourcing-workflows.mjs`
 * rebuilds a copy from the current generic DAG + the same change, so the seed never flattens a copy back.
 */
import type { DAG } from "./dag-validator.js";
import type { DagPatchOperation } from "./dag-patch.js";
import { applyDagPatch } from "./dag-patch.js";

export const CONTACT_METHODS = ["email", "phone"] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];

const SERVE_PATHS = ["/orgs/buffer/next", "/buffer/next"];

/** The plain-words marker every copy's description carries; the seed and the fork script read it. */
export const REACHABLE_BY_MARKER = "Finds only people";

const METHOD_WORDS: Record<ContactMethod, string> = {
  email: "people with a deliverable email address",
  phone: "people with a phone number (reachable on WhatsApp)",
};

type Node = DAG["nodes"][number];
const isServeNode = (n: Node) =>
  n.type === "http.call" && SERVE_PATHS.includes((n.config as { path?: string } | undefined)?.path ?? "");

/** Sorted, deduped, every member a known method; throws otherwise (fail loud: a typo must not fork a copy). */
export function normalizeMethods(methods: readonly string[]): ContactMethod[] {
  if (methods.length === 0) throw new Error("reachableBy needs at least one contact method");
  const unknown = methods.filter((m) => !(CONTACT_METHODS as readonly string[]).includes(m));
  if (unknown.length > 0) throw new Error(`unknown contact method(s): ${unknown.join(", ")} (allowed: ${CONTACT_METHODS.join(", ")})`);
  return [...new Set(methods as ContactMethod[])].sort();
}

/**
 * PURE: the JSON Patch that makes every lead-serving node of `dag` state `reachableBy`. Throws when the DAG serves
 * no lead, or when a serving node builds its body (or `reachableBy`) from an input mapping: a static key there
 * would be overridden at run time, silently.
 */
export function reachableByChanges(dag: DAG, methods: readonly string[]): DagPatchOperation[] {
  const value = normalizeMethods(methods);
  const nodes = dag.nodes.filter(isServeNode);
  if (nodes.length === 0) throw new Error("no lead-serving node (POST /orgs/buffer/next) in DAG");
  return nodes.map((n) => {
    const mapped = Object.keys(n.inputMapping ?? {}).some((k) => k === "body" || k === "body.reachableBy");
    if (mapped) throw new Error(`serving node ${n.id} maps its body or reachableBy; refusing to override`);
    const body = (n.config as { body?: Record<string, unknown> } | undefined)?.body;
    return body === undefined
      ? { op: "add" as const, path: `/nodes/${n.id}/config/body`, value: { reachableBy: value } }
      : { op: "add" as const, path: `/nodes/${n.id}/config/body/reachableBy`, value };
  });
}

/** PURE: `dag` with the change applied (the source is never mutated). */
export function withReachableBy(dag: DAG, methods: readonly string[]): DAG {
  return applyDagPatch(dag, reachableByChanges(dag, methods));
}

/** PURE: the `reachableBy` a DAG's serving nodes state, or null when none states one. Throws when they disagree. */
export function reachableByOf(dag: DAG): ContactMethod[] | null {
  const stated = dag.nodes
    .filter(isServeNode)
    .map((n) => (n.config as { body?: { reachableBy?: string[] } } | undefined)?.body?.reachableBy)
    .filter((v): v is string[] => Array.isArray(v))
    .map((v) => normalizeMethods(v).join(","));
  if (stated.length === 0) return null;
  if (new Set(stated).size > 1) throw new Error(`serving nodes disagree on reachableBy: ${[...new Set(stated)].join(" vs ")}`);
  return stated[0].split(",") as ContactMethod[];
}

/** PURE: the copy's description: the source's own, then who the copy finds, in plain words. */
export function reachableByDescription(sourceDescription: string | null | undefined, methods: readonly string[]): string {
  const value = normalizeMethods(methods);
  const who = value.map((m) => METHOD_WORDS[m].replace(/^people /, "")).join(" and ");
  const sentence = `${REACHABLE_BY_MARKER} ${who}, leaving anyone else to another workflow.`;
  const base = (sourceDescription ?? "").trim();
  return base === "" ? sentence : `${base} ${sentence}`;
}

export const isReachableByCopy = (description: string | null | undefined): boolean =>
  typeof description === "string" && description.includes(REACHABLE_BY_MARKER);
