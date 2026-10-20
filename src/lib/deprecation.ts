import { sql } from "drizzle-orm";
import type { Request } from "express";

// DEPRECATION-REASON-1020 (owner 2026-10-20): every deprecation states WHY, and WHO decided it
// WHEN, so staff reading a deprecated workflow months later know why it stopped. Every write
// that makes a row non-executable spreads `recordDeprecation(...)`, every re-activation
// `CLEAR_DEPRECATION`, exactly like `executable-until.ts`.

/** What a deprecation recorded before reasons existed (or with none stated) reads. */
export const NOT_SPECIFIED = "Not specified";

export interface DeprecationDecision {
  /** Plain-language why (required: the status routes refuse a deprecation without one). */
  reason: string;
  /** Who decided (staff email, a service name, `user:<id>`), null when unknown. */
  decidedBy: string | null;
}

/** `.set()` fields for a write that deprecates a row (version or dynasty). */
export function recordDeprecation(d: DeprecationDecision) {
  return { deprecationReason: d.reason, deprecatedBy: d.decidedBy, deprecatedAt: sql`now()` };
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
