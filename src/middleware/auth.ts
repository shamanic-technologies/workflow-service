import type { Request, Response, NextFunction } from "express";

export function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (!apiKey || apiKey !== process.env.WORKFLOW_SERVICE_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function requireIdentity(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const orgId = req.headers["x-org-id"] as string | undefined;
  const userId = req.headers["x-user-id"] as string | undefined;
  const runId = req.headers["x-run-id"] as string | undefined;

  if (!orgId || !userId || !runId) {
    res.status(400).json({
      error: "x-org-id, x-user-id, and x-run-id headers are required",
    });
    return;
  }

  res.locals.orgId = orgId;
  res.locals.userId = userId;
  res.locals.runId = runId;

  // Optional headers — read if present, never required
  const brandId = req.headers["x-brand-id"] as string | undefined;
  if (brandId) res.locals.brandId = brandId;

  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  const workflowSlug = req.headers["x-workflow-slug"] as string | undefined;
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;
  if (campaignId) res.locals.campaignId = campaignId;
  if (workflowSlug) res.locals.workflowSlug = workflowSlug;
  if (featureSlug) res.locals.featureSlug = featureSlug;

  next();
}

export function requireBrandId(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const brandId = req.headers["x-brand-id"] as string | undefined;
  if (!brandId && !req.body?.inputs?.brandId) {
    res.status(400).json({
      error: "x-brand-id header or inputs.brandId is required for execution endpoints",
    });
    return;
  }
  next();
}

const REQUIRED_EXECUTION_HEADERS = [
  "x-org-id",
  "x-user-id",
  "x-run-id",
  "x-brand-id",
  "x-campaign-id",
  "x-workflow-slug",
  "x-feature-slug",
] as const;

export function requireExecutionHeaders(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const missing = REQUIRED_EXECUTION_HEADERS.filter(
    (h) => !req.headers[h],
  );
  if (missing.length > 0) {
    res.status(400).json({
      error: `Missing required headers for workflow execution: ${missing.join(", ")}`,
    });
    return;
  }
  next();
}
