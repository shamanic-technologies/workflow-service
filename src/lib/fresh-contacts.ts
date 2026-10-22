/**
 * Tactic "Fresh contacts only" (FRESH-CONTACTS-WF-1015, owner 2026-10-15): "never re-contact a person this brand
 * emailed in the last 3 months" is no longer a refusal of the sending service, it is something a WORKFLOW states:
 * its lead serve (lead-service `POST /orgs/buffer/next`) carries `excludeEmailedWithin: "3_months"`, and lead-service
 * hands out nobody the brand emailed inside that window (sales-lead-service #926).
 *
 * Who states it: every workflow that serves people to prospect COLD, i.e. the channels in
 * `FRESH_CONTACTS_FEATURE_SLUGS` (cold email, Lead Sourcing, and the origins that find people the brand never met).
 * Who never does: a play that re-engages people already emailed (a serve stating a `population`, e.g. the contacted
 * pure prospects; the CRM contacts and follow-up channels are not in the list), and Email Sending (the client names
 * the person). `scripts/upgrade-fresh-contacts.mjs` UPGRADES each live dynasty with this one change (never a fork,
 * owner rule), and `scripts/seed-sourcing-workflows.mjs` builds the sourcing DAGs with it, so a seed never flattens it.
 */
import type { DAG } from "./dag-validator.js";

export const FRESH_CONTACTS_WINDOW = "3_months";
export const FRESH_CONTACTS_FIELD = "excludeEmailedWithin";

/** The channels whose serve hands out people to prospect cold. */
export const FRESH_CONTACTS_FEATURE_SLUGS = [
  "sales-cold-email-outreach",
  // Same cold email to buyers, the gift-for-feedback offer: its 9 dynasties were upgraded with the window on 2026-10-16
  // when they were brought back from the pre-guard stale sweep (2026-09-16), so the list now says so.
  "feedback-request-cold-email-outreach",
  "lead-sourcing",
  "sourcing-apollo-cold-filters",
  "sourcing-apollo-buying-signals",
  "sourcing-linkedin-engagement-signals",
] as const;

/** The plain-words marker the description carries: features-service's Jev judges the tactic on DAG + description. */
export const FRESH_CONTACTS_MARKER = "Fresh contacts only:";

export const FRESH_CONTACTS_SENTENCE =
  `${FRESH_CONTACTS_MARKER} never writes to anyone this brand emailed in the last 3 months.`;

const SERVE_PATHS = ["/orgs/buffer/next", "/buffer/next"];
type Node = DAG["nodes"][number];
const isServeNode = (n: Node) =>
  n.type === "http.call" && SERVE_PATHS.includes((n.config as { path?: string } | undefined)?.path ?? "");
const bodyOf = (n: Node) => (n.config as { body?: Record<string, unknown> } | undefined)?.body;

export const isFreshContactsChannel = (featureSlug: string): boolean =>
  (FRESH_CONTACTS_FEATURE_SLUGS as readonly string[]).includes(featureSlug);

/**
 * PURE: does this DAG serve people to prospect cold? It must serve a lead, and no serve may state a `population`
 * (a population of people the brand ALREADY contacted is a re-engagement play: lead-service would skip every one).
 */
export function freshContactsApplies(dag: DAG): boolean {
  const serves = dag.nodes.filter(isServeNode);
  return serves.length > 0 && serves.every((n) => bodyOf(n)?.population === undefined);
}

/** PURE: true when every lead serve of the DAG states the window (and it has one). */
export function statesFreshContacts(dag: DAG): boolean {
  const serves = dag.nodes.filter(isServeNode);
  return serves.length > 0 && serves.every((n) => bodyOf(n)?.[FRESH_CONTACTS_FIELD] === FRESH_CONTACTS_WINDOW);
}

/**
 * PURE: `dag` with every lead serve stating the window (the source is never mutated). Throws when the DAG does not
 * qualify, or a serve builds its body (or the field) from an input mapping: a static key would be overridden at run time.
 */
export function withFreshContacts(dag: DAG): DAG {
  if (!freshContactsApplies(dag)) throw new Error("not a cold serve (no lead serve, or a serve states a population)");
  const clone = structuredClone(dag);
  for (const n of clone.nodes.filter(isServeNode)) {
    const mapped = Object.keys(n.inputMapping ?? {}).some((k) => k === "body" || k === `body.${FRESH_CONTACTS_FIELD}`);
    if (mapped) throw new Error(`serving node ${n.id} maps its body or ${FRESH_CONTACTS_FIELD}; refusing to override`);
    const config = n.config as Record<string, unknown>;
    config.body = { ...(bodyOf(n) ?? {}), [FRESH_CONTACTS_FIELD]: FRESH_CONTACTS_WINDOW };
  }
  return clone;
}

/** PURE: the description with the plain-words sentence appended once. */
export function freshContactsDescription(description: string | null | undefined): string {
  const base = (description ?? "").trim();
  if (base.includes(FRESH_CONTACTS_MARKER)) return base;
  return base === "" ? FRESH_CONTACTS_SENTENCE : `${base} ${FRESH_CONTACTS_SENTENCE}`;
}
