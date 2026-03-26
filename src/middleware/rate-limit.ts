import rateLimit from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";

const isTest = process.env.NODE_ENV === "test";

const orgKeyGenerator = (req: Request) =>
  (req.res?.locals.orgId as string) ?? "unknown";

const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();

/**
 * Rate limit for workflow execution endpoints.
 * 60 requests per minute per orgId.
 */
export const executeRateLimit = isTest
  ? passthrough
  : rateLimit({
      windowMs: 60 * 1000,
      limit: 60,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      keyGenerator: orgKeyGenerator,
      message: {
        error: "Too many workflow executions — limit is 60 per minute per organization",
      },
    });

/**
 * Rate limit for workflow creation/generation endpoints.
 * 10 requests per minute per orgId — creation is an admin action,
 * not something users call in tight loops.
 */
export const createRateLimit = isTest
  ? passthrough
  : rateLimit({
      windowMs: 60 * 1000,
      limit: 10,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      keyGenerator: orgKeyGenerator,
      message: {
        error: "Too many workflow creations — limit is 10 per minute per organization",
      },
    });
