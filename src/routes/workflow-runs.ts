import { Router } from "express";
import { eq, and, inArray } from "drizzle-orm";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { db } from "../db/index.js";
import { workflows, workflowRuns } from "../db/schema.js";
import { requireApiKey, requireExecutionHeaders } from "../middleware/auth.js";
import { executeRateLimit } from "../middleware/rate-limit.js";
import { getWindmillClient } from "../lib/windmill-client.js";
import { collectServiceEnvs } from "../lib/service-envs.js";
import { createRun } from "../lib/runs-client.js";
import { ExecuteWorkflowSchema, ExecuteByNameSchema } from "../schemas.js";
import { parseWindmillError } from "../lib/error-parser.js";
import { resolveFeatureDynastySlugs } from "../lib/features-client.js";
import { extractDownstreamHeaders } from "../lib/downstream-headers.js";

const router = Router();

function formatRun(r: typeof workflowRuns.$inferSelect) {
  const base = {
    ...r,
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt?.toISOString() ?? null,
  };

  if (r.status === "failed" && r.error) {
    const parsed = parseWindmillError(r.error);
    return {
      ...base,
      errorSummary: {
        failedStep: parsed.failedStep,
        message: parsed.message,
        rootCause: parsed.rootCause,
      },
    };
  }

  return base;
}

// POST /workflows/by-slug/:slug/execute — Execute a workflow by slug
router.post(
  "/workflows/by-slug/:slug/execute",
  requireApiKey,
  requireExecutionHeaders,
  executeRateLimit,
  async (req, res) => {
    try {
      const body = ExecuteByNameSchema.parse(req.body);
      const orgId = res.locals.orgId as string;

      // Look up workflow by slug — only active workflows can be executed
      let [workflow] = await db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.slug, req.params.slug),
            eq(workflows.status, "active"),
          )
        );

      if (!workflow) {
        // Check if deprecated — follow upgrade chain to find active replacement
        const [deprecated] = await db
          .select()
          .from(workflows)
          .where(eq(workflows.slug, req.params.slug));

        if (deprecated && deprecated.status === "deprecated") {
          // Follow upgrade chain to the latest active version
          let currentId = deprecated.upgradedTo;
          let depth = 0;
          while (currentId && depth < 10) {
            const [candidate] = await db
              .select()
              .from(workflows)
              .where(eq(workflows.id, currentId));

            if (!candidate) break;
            if (candidate.status === "active") {
              workflow = candidate;
              console.log(
                `[workflow-service] Execute by slug: "${req.params.slug}" is deprecated, following upgrade chain to "${candidate.slug}" (${candidate.id})`,
              );
              break;
            }
            currentId = candidate.upgradedTo;
            depth++;
          }

          if (!workflow) {
            // Dead end — no active workflow at the end of the chain
            let upgradedToSlug: string | null = null;
            if (deprecated.upgradedTo) {
              const [replacement] = await db
                .select()
                .from(workflows)
                .where(eq(workflows.id, deprecated.upgradedTo));
              upgradedToSlug = replacement?.slug ?? null;
            }
            res.status(410).json({
              error: "Workflow has been deprecated",
              upgradedTo: deprecated.upgradedTo,
              upgradedToSlug,
            });
            return;
          }
        } else {
          console.warn(
            `[workflow-service] Execute by slug: workflow "${req.params.slug}" not found (no active workflow with this slug)`,
          );
          res.status(404).json({
            error: `Workflow "${req.params.slug}" not found`,
          });
          return;
        }
      }

      if (!workflow.windmillFlowPath) {
        res
          .status(400)
          .json({ error: "Workflow has no Windmill flow path" });
        return;
      }

      const userId = res.locals.userId as string;
      const callerRunId = res.locals.runId as string;
      const brandId = res.locals.brandId as string;
      const campaignId = res.locals.campaignId as string;
      const featureSlug = res.locals.featureSlug as string;

      // Create a child run in runs-service (links to caller's run via parentRunId)
      let ownRunId: string | null = null;
      try {
        const { runId: newRunId } = await createRun({
          parentRunId: callerRunId,
          orgId,
          userId,
          taskName: "execute-workflow",
          workflowSlug: workflow.slug,
          campaignId,
          brandId,
        });
        ownRunId = newRunId;
      } catch (err) {
        console.error("[workflow-service] Failed to create run in runs-service:", err);
        res.status(502).json({ error: "Failed to create run in runs-service" });
        return;
      }

      // Run in Windmill — inject identity + tracking headers so every node receives them
      let windmillJobId: string | null = null;
      const client = getWindmillClient();
      if (client) {
        try {
          const flowInputs = { ...body.inputs, orgId, userId, runId: ownRunId, workflowSlug: workflow.slug, campaignId, brandId, featureSlug, serviceEnvs: collectServiceEnvs() };
          windmillJobId = await client.runFlow(
            workflow.windmillFlowPath,
            flowInputs
          );
        } catch (err) {
          console.error(
            "[workflow-service] Failed to run flow in Windmill:",
            err
          );
          res
            .status(502)
            .json({ error: "Failed to start workflow in Windmill" });
          return;
        }
      }

      // Create workflow run in DB
      const [run] = await db
        .insert(workflowRuns)
        .values({
          workflowId: workflow.id,
          orgId,
          userId,
          campaignId,
          brandId,
          featureSlug,
          workflowSlug: workflow.slug,
          subrequestId: (body.inputs?.subrequestId as string | undefined) ?? workflow.subrequestId,
          runId: ownRunId,
          windmillJobId,
          windmillWorkspace: workflow.windmillWorkspace,
          status: "queued",
          inputs: body.inputs,
        })
        .returning();

      console.log(
        `[workflow-service] Workflow "${workflow.slug}" execution started: runId=${ownRunId}, windmillJobId=${windmillJobId ?? "none"}`,
      );

      res.status(201).json(formatRun(run));
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "ZodError") {
        res.status(400).json({ error: "Validation error", details: err });
        return;
      }
      console.error("[workflow-service] POST execute-by-slug error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /workflows/:id/execute — Execute a workflow
router.post("/workflows/:id/execute", requireApiKey, requireExecutionHeaders, executeRateLimit, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
  try {
    const body = ExecuteWorkflowSchema.parse(req.body ?? {});
    const orgId = res.locals.orgId as string;

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.id, req.params.id),
          eq(workflows.status, "active"),
        )
      );

    if (!workflow) {
      // Check if deprecated — return 410 with upgrade info instead of 404
      const [deprecated] = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, req.params.id));

      if (deprecated && deprecated.status === "deprecated") {
        res.status(410).json({
          error: "Workflow has been deprecated",
          upgradedTo: deprecated.upgradedTo,
        });
        return;
      }

      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    if (!workflow.windmillFlowPath) {
      res
        .status(400)
        .json({ error: "Workflow has no Windmill flow path" });
      return;
    }

    const executeUserId = res.locals.userId as string;
    const callerRunId = res.locals.runId as string;
    const execBrandId = res.locals.brandId as string;
    const execCampaignId = res.locals.campaignId as string;
    const execFeatureSlug = res.locals.featureSlug as string;

    // Create a child run in runs-service (links to caller's run via parentRunId)
    let ownRunId: string | null = null;
    try {
      const { runId: newRunId } = await createRun({
        parentRunId: callerRunId,
        orgId,
        userId: executeUserId,
        taskName: "execute-workflow",
        workflowSlug: workflow.slug,
        campaignId: execCampaignId,
        brandId: execBrandId,
      });
      ownRunId = newRunId;
    } catch (err) {
      console.error("[workflow-service] Failed to create run in runs-service:", err);
      res.status(502).json({ error: "Failed to create run in runs-service" });
      return;
    }

    // Run in Windmill — inject identity + tracking headers so every node receives them
    let windmillJobId: string | null = null;
    const client = getWindmillClient();
    if (client) {
      try {
        const flowInputs = { ...body.inputs, orgId, userId: executeUserId, runId: ownRunId, workflowSlug: workflow.slug, campaignId: execCampaignId, brandId: execBrandId, featureSlug: execFeatureSlug, serviceEnvs: collectServiceEnvs() };
        windmillJobId = await client.runFlow(
          workflow.windmillFlowPath,
          flowInputs
        );
      } catch (err) {
        console.error("[workflow-service] Failed to run flow in Windmill:", err);
        res
          .status(502)
          .json({ error: "Failed to start workflow in Windmill" });
        return;
      }
    }

    // Create workflow run in DB
    const [run] = await db
      .insert(workflowRuns)
      .values({
        workflowId: workflow.id,
        orgId,
        userId: executeUserId,
        campaignId: execCampaignId,
        brandId: execBrandId,
        featureSlug: execFeatureSlug,
        workflowSlug: workflow.slug,
        subrequestId: (body.inputs?.subrequestId as string | undefined) ?? workflow.subrequestId,
        runId: ownRunId,
        windmillJobId,
        windmillWorkspace: workflow.windmillWorkspace,
        status: "queued",
        inputs: body.inputs,
      })
      .returning();

    res.status(201).json(formatRun(run));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    console.error("[workflow-service] POST execute error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflow-runs/:id — Get a workflow run (with live poll if running)
router.get("/workflow-runs/:id", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid run ID format" });
    return;
  }
  try {
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, req.params.id));

    if (!run) {
      res.status(404).json({ error: "Workflow run not found" });
      return;
    }

    // If still active, poll Windmill for latest status
    const pollClient = getWindmillClient();
    if (
      pollClient &&
      (run.status === "queued" || run.status === "running") &&
      run.windmillJobId
    ) {
      try {
        const job = await pollClient.getJob(run.windmillJobId);

        if (!job.running) {
          const success = job.success ?? false;
          const newStatus = success ? "completed" : "failed";

          const [updated] = await db
            .update(workflowRuns)
            .set({
              status: newStatus,
              result: success ? (job.result as Record<string, unknown>) : null,
              error: success ? null : (typeof job.result === "string" ? job.result : JSON.stringify(job.result ?? "Unknown error")),
              completedAt: new Date(),
            })
            .where(eq(workflowRuns.id, run.id))
            .returning();

          res.json(formatRun(updated));
          return;
        } else if (run.status === "queued") {
          const [updated] = await db
            .update(workflowRuns)
            .set({ status: "running", startedAt: new Date() })
            .where(eq(workflowRuns.id, run.id))
            .returning();

          res.json(formatRun(updated));
          return;
        }
      } catch (err) {
        console.error(
          "[workflow-service] Failed to poll Windmill job:",
          err
        );
        // Return what we have in DB
      }
    }

    res.json(formatRun(run));
  } catch (err) {
    console.error("[workflow-service] GET by id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflow-runs — List runs
router.get("/workflow-runs", requireApiKey, async (req, res) => {
  try {
    const { workflowId, orgId, campaignId, featureSlug, featureDynastySlug, workflowSlug, workflowDynastySlug, status } = req.query;

    const conditions = [];

    if (workflowId && typeof workflowId === "string") {
      conditions.push(eq(workflowRuns.workflowId, workflowId));
    }
    if (orgId && typeof orgId === "string") {
      conditions.push(eq(workflowRuns.orgId, orgId));
    }
    if (campaignId && typeof campaignId === "string") {
      conditions.push(eq(workflowRuns.campaignId, campaignId));
    }
    if (featureSlug && typeof featureSlug === "string") {
      conditions.push(eq(workflowRuns.featureSlug, featureSlug));
    }
    if (featureDynastySlug && typeof featureDynastySlug === "string") {
      const versionedSlugs = await resolveFeatureDynastySlugs(featureDynastySlug, extractDownstreamHeaders(req));
      conditions.push(inArray(workflowRuns.featureSlug, versionedSlugs));
    }
    if (workflowSlug && typeof workflowSlug === "string") {
      conditions.push(eq(workflowRuns.workflowSlug, workflowSlug));
    }
    if (workflowDynastySlug && typeof workflowDynastySlug === "string") {
      // Resolve via subquery: find all workflow IDs with this dynasty slug
      const dynastyWorkflows = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(eq(workflows.dynastySlug, workflowDynastySlug));
      const wfIds = dynastyWorkflows.map((w) => w.id);
      if (wfIds.length === 0) {
        res.json({ workflowRuns: [] });
        return;
      }
      conditions.push(inArray(workflowRuns.workflowId, wfIds));
    }
    if (status && typeof status === "string") {
      conditions.push(eq(workflowRuns.status, status));
    }

    const results =
      conditions.length > 0
        ? await db
            .select()
            .from(workflowRuns)
            .where(and(...conditions))
        : await db.select().from(workflowRuns);

    res.json({ workflowRuns: results.map(formatRun) });
  } catch (err) {
    console.error("[workflow-service] GET list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflow-runs/:id/debug — Get per-step execution details from Windmill
router.get("/workflow-runs/:id/debug", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid run ID format" });
    return;
  }
  try {
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, req.params.id));

    if (!run) {
      res.status(404).json({ error: "Workflow run not found" });
      return;
    }

    if (!run.windmillJobId) {
      res.status(400).json({ error: "Run has no Windmill job ID" });
      return;
    }

    const debugClient = getWindmillClient();
    if (!debugClient) {
      res.status(503).json({ error: "Windmill client not configured" });
      return;
    }

    const job = await debugClient.getJob(run.windmillJobId);

    res.json({
      runId: run.id,
      windmillJobId: run.windmillJobId,
      status: run.status,
      flowStatus: job.flow_status ?? null,
      result: job.result ?? null,
    });
  } catch (err) {
    console.error("[workflow-service] GET debug error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /workflow-runs/:id/cancel — Cancel a run
router.post("/workflow-runs/:id/cancel", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid run ID format" });
    return;
  }
  try {
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, req.params.id));

    if (!run) {
      res.status(404).json({ error: "Workflow run not found" });
      return;
    }

    if (run.status !== "queued" && run.status !== "running") {
      res.status(400).json({ error: `Cannot cancel run with status: ${run.status}` });
      return;
    }

    // Cancel in Windmill
    if (run.windmillJobId) {
      const cancelClient = getWindmillClient();
      if (cancelClient) {
        try {
          await cancelClient.cancelJob(run.windmillJobId, "Cancelled by user");
        } catch (err) {
          console.error("[workflow-service] Failed to cancel Windmill job:", err);
        }
      }
    }

    const [updated] = await db
      .update(workflowRuns)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(workflowRuns.id, run.id))
      .returning();

    res.json(formatRun(updated));
  } catch (err) {
    console.error("[workflow-service] POST cancel error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
