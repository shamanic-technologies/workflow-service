import rateLimit from "express-rate-limit";
import type { Request } from "express";

/**
 * Rate limit for workflow execution endpoints.
 * 60 requests per minute per orgId — generous for normal use,
 * prevents abuse (e.g. spamming free-node workflows).
 */
export const executeRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    // Rate limit per org — orgId is always set by requireIdentity middleware
    // which runs before this middleware (applied at app.use level in index.ts).
    // The fallback to "unknown" is defensive only.
    return (req.res?.locals.orgId as string) ?? "unknown";
  },
  message: {
    error: "Too many workflow executions — limit is 60 per minute per organization",
  },
});
