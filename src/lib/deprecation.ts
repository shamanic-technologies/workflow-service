import { sql } from "drizzle-orm";
import type { Request } from "express";
import { workflows } from "../db/schema.js";

// DEPRECATION-REASON-1020 (owner 2026-10-20): every deprecation states WHY, and WHO decided it
// WHEN, so staff reading a deprecated workflow months later know why it stopped. Every write
// that makes a row non-executable spreads `recordDeprecation(...)`, every re-activation
// `CLEAR_DEPRECATION`, exactly like `executable-until.ts`.

/** What a deprecation recorded before reasons existed (or with none stated) reads. */
export const NOT_SPECIFIED = "Not specified";

/**
 * Transition (DEPRECATION-REASON-1020): the staff doors (dashboard Research, admin) do not send a
 * reason yet, so a deprecation WITHOUT one is still accepted, recorded "Not specified" (an earlier
 * reason on the row is kept), and logged loud. Flip to true once every caller sends one: the
 * status routes then answer 400 `deprecation_reason_required`.
 */
export const REASON_REQUIRED = false;

export interface DeprecationDecision {
  /** Plain-language why. Undefined = none stated (transition only). */
  reason: string | undefined;
  /** Who decided (staff email, a service name, `user:<id>`), null when unknown. */
  decidedBy: string | null;
}

/** `.set()` fields for a write that deprecates a row (version or dynasty). */
export function recordDeprecation(d: DeprecationDecision) {
  if (d.reason !== undefined) {
    return { deprecationReason: d.reason, deprecatedBy: d.decidedBy, deprecatedAt: sql`now()` };
  }
  // No reason stated: keep a reason already recorded, never overwrite it with "Not specified".
  return {
    deprecationReason: sql`COALESCE(${workflows.deprecationReason}, ${NOT_SPECIFIED})`,
    deprecatedBy: sql`CASE WHEN ${workflows.deprecationReason} IS NULL THEN ${d.decidedBy}::text ELSE ${workflows.deprecatedBy} END`,
    deprecatedAt: sql`CASE WHEN ${workflows.deprecationReason} IS NULL THEN now() ELSE ${workflows.deprecatedAt} END`,
  };
}

/** `.set()` fields for a write that makes a row executable again. */
export const CLEAR_DEPRECATION = { deprecationReason: null, deprecatedBy: null, deprecatedAt: null } as const;

/** Fields for an INSERT born under a retired dynasty: it inherits the dynasty's decision. */
export function deprecationAtBirth(
  executable: boolean,
  source: { deprecationReason: string | null; deprecatedBy: string | null; deprecatedAt: Date | null },
) {
  return executable
    ? CLEAR_DEPRECATION
    : {
        deprecationReason: source.deprecationReason ?? NOT_SPECIFIED,
        deprecatedBy: source.deprecationReason ? source.deprecatedBy : null,
        deprecatedAt: source.deprecationReason ? source.deprecatedAt : null,
      };
}

/** Who decided: the body's `decidedBy`, else the caller's `x-email`, else its `x-user-id`. */
export function resolveDecidedBy(req: Request, bodyDecidedBy: string | undefined): string | null {
  if (bodyDecidedBy) return bodyDecidedBy;
  const email = req.header("x-email");
  if (email) return email;
  const userId = req.header("x-user-id");
  return userId ? `user:${userId}` : null;
}

export interface ServedDeprecation {
  reason: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

/** The `deprecation` block every read serves: null while the row is executable. */
export function servedDeprecation(w: {
  status: string;
  workflowDynastyStatus: string;
  deprecationReason: string | null;
  deprecatedBy: string | null;
  deprecatedAt: Date | null;
}): ServedDeprecation | null {
  if (w.status === "active" && w.workflowDynastyStatus === "active") return null;
  return {
    reason: w.deprecationReason ?? NOT_SPECIFIED,
    decidedBy: w.deprecatedBy ?? null,
    decidedAt: w.deprecatedAt ? w.deprecatedAt.toISOString() : null,
  };
}

/** Log a deprecation that stated no reason (the transition), so the missing callers are visible. */
export function warnMissingReason(route: string, target: string, decidedBy: string | null): void {
  console.warn(
    `[workflow-service] [deprecation-reason-missing] ${route} deprecated "${target}" with no reason ` +
      `(decidedBy=${decidedBy ?? "unknown"}); recorded "${NOT_SPECIFIED}". DEPRECATION-REASON-1020: callers must send \`reason\`.`,
  );
}
