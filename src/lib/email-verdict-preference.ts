/**
 * A Cold Email workflow never chooses which email verdicts it accepts (DOTTEREL-EMAIL-FILTER-1020, owner 2026-10-20:
 * « upgrade tous les workflows Doterrel qui ont des filtre sur le type d'email, ça n'a aucun sens business que ce soit
 * là »). Which emails to keep (valid only, + catch-all, + unknown) is the LEAD SOURCING pipe's choice; a cold email
 * serve that states `acceptedEmails` overrides what the client chose there, and features-service's Jev judges it
 * "Catch-all", so the Cold Email pipe's strategies exclude it from the ranking.
 *
 * `scripts/upgrade-drop-email-verdict.mjs` UPGRADES each live dynasty (never a fork) with the one change: the key
 * removed from every lead serve, the "Valid + Catch-all copy." sentence removed from its description, one plain
 * sentence added. Everything else (template, model, the fresh-contacts window) is untouched.
 */
import type { DAG } from "./dag-validator.js";

export const EMAIL_VERDICT_FIELD = "acceptedEmails";
export const EMAIL_VERDICT_FEATURE_SLUGS = ["sales-cold-email-outreach"] as const;

/** The sentence the 2026-10-13 catch-all copies carried (scripts/fork-catch-all-copies.mjs, deleted). */
export const CATCH_ALL_COPY_SENTENCE =
  "Valid + Catch-all copy. Identical to the original except that it sends to confirmed addresses AND to catch-all addresses " +
  "(mail servers that accept every address, so the mailbox cannot be confirmed): its lead-serving step asks for valid and catch-all emails.";

export const NO_EMAIL_VERDICT_MARKER = "No email verdict preference:";
export const NO_EMAIL_VERDICT_SENTENCE =
  `${NO_EMAIL_VERDICT_MARKER} writes to the people the lead sourcing kept, with the email checks the client chose there.`;

const SERVE_PATHS = ["/orgs/buffer/next", "/buffer/next"];
type Node = DAG["nodes"][number];
const isServeNode = (n: Node) =>
  n.type === "http.call" && SERVE_PATHS.includes((n.config as { path?: string } | undefined)?.path ?? "");
const bodyOf = (n: Node) => (n.config as { body?: Record<string, unknown> } | undefined)?.body;
const mapsVerdict = (n: Node) =>
  Object.keys(n.inputMapping ?? {}).some((k) => k === "body" || k === `body.${EMAIL_VERDICT_FIELD}`);

/** PURE: does any lead serve of the DAG state (or map) an email-verdict preference? */
export function statesEmailVerdict(dag: DAG): boolean {
  return dag.nodes.filter(isServeNode).some((n) => bodyOf(n)?.[EMAIL_VERDICT_FIELD] !== undefined || mapsVerdict(n));
}

/**
 * PURE: `dag` with the key removed from every lead serve (the source is never mutated). Throws when a serve builds
 * its body or the field from an input mapping: the preference would arrive at run time and is not ours to guess.
 */
export function withoutEmailVerdict(dag: DAG): DAG {
  const clone = structuredClone(dag);
  for (const n of clone.nodes.filter(isServeNode)) {
    if (mapsVerdict(n)) throw new Error(`serving node ${n.id} maps its body or ${EMAIL_VERDICT_FIELD}; refusing to guess`);
    const body = bodyOf(n);
    if (body && EMAIL_VERDICT_FIELD in body) {
      const { [EMAIL_VERDICT_FIELD]: _dropped, ...rest } = body;
      (n.config as Record<string, unknown>).body = rest;
    }
  }
  return clone;
}

/** PURE: the description without the catch-all copy sentence, with the plain sentence appended once. */
export function noEmailVerdictDescription(description: string | null | undefined): string {
  const base = (description ?? "").split(CATCH_ALL_COPY_SENTENCE).join("").replace(/\s{2,}/g, " ").trim();
  if (base.includes(NO_EMAIL_VERDICT_MARKER)) return base;
  return base === "" ? NO_EMAIL_VERDICT_SENTENCE : `${base} ${NO_EMAIL_VERDICT_SENTENCE}`;
}
