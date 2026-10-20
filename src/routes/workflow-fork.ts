import { Router, type Request, type Response } from "express";
import type { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { ForkWorkflowRequestSchema } from "../schemas.js";
import type { DAG } from "../lib/dag-validator.js";
import { computeDAGSignature } from "../lib/dag-signature.js";
import { applyDagPatch, DagPatchError, type DagPatchOperation } from "../lib/dag-patch.js";
import { validateClientDag } from "../lib/validate-client-dag.js";
import { extractDownstreamHeaders } from "../lib/downstream-headers.js";
import { findSignatureConflict, signatureConflictBody, forkWorkflowRow } from "../lib/workflow-lineage.js";
import { LegAssignmentError, PipeResolutionError, fetchPipe } from "../lib/catalogue-client.js";
import { formatWorkflow } from "../lib/format-workflow.js";
import { traceEvent } from "../lib/trace-event.js";
import { constraintErrorResponse } from "../lib/db-error.js";
import { invalidateSpecWatcherCache } from "../lib/spec-watcher.js";
import { noteWorkflowWrite } from "../lib/periodic-cleanup.js";

/**
 * Fork a workflow with a STATED change (WORKFLOW-FORK-PUBLIC-1013).
 *
 * The caller names the source (a version id, or a dynasty slug = its active version) and the change as a JSON
 * Patch on the DAG; nothing else of the source moves. `PUT /workflows/{id}` also forks, but only from a whole DAG
 * sent back by the caller, which for an API/MCP user means round-tripping hundreds of KB to change one key.
 *
 * The copy goes through the same gate and the same insert as every fork: `validateClientDag`, the active-signature
 * conflict check (409 naming the existing copy, so a re-run is idempotent), and `forkWorkflowRow`, which deploys
 * the flow and registers the copy on every pipe its source serves (features-service, active at once). The row
 * belongs to the source's OWNER org, like a prompt-edit fork. The source row is never written.
 */

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WorkflowRow = typeof workflows.$inferSelect;
type ForkRequest = z.infer<typeof ForkWorkflowRequestSchema>;

async function handleFork(req: Request, res: Response, source: WorkflowRow, body: ForkRequest): Promise<void> {
  const orgId = res.locals.orgId as string;
  const userId = res.locals.userId as string;
  const runId = res.locals.runId as string;

  if (body.pipeId) {
    const refusal = await refusePipe(body.pipeId, source.featureSlug, extractDownstreamHeaders(req));
    if (refusal) {
      res.status(400).json({ error: refusal });
      return;
    }
  }

  let dag: DAG;
  try {
    dag = applyDagPatch(source.dag as DAG, body.changes as DagPatchOperation[]);
  } catch (err) {
    if (err instanceof DagPatchError) {
      res.status(422).json({ error: err.message, changeIndex: err.operationIndex });
      return;
    }
    throw err;
  }
  // The pipe the copy is forked for makes it its own workflow even when its steps are the source's.
  if (body.pipeId) dag = { ...dag, forkedForPipe: body.pipeId };

  const signature = computeDAGSignature(dag);
  if (signature === source.signature) {
    res.status(400).json({ error: "The change leaves the workflow's DAG identical; nothing to fork." });
    return;
  }

  const rejection = await validateClientDag(dag, extractDownstreamHeaders(req));
  if (rejection) {
    res.status(400).json(rejection);
    return;
  }

  const conflicting = await findSignatureConflict(source.featureSlug, signature);
  if (conflicting) {
    res.status(409).json(signatureConflictBody(conflicting));
    return;
  }

  const forked = await forkWorkflowRow({
    existing: source,
    dag,
    signature,
    flowScopeOrgId: source.orgId,
    userId,
    runId,
    description: body.description ?? source.description,
    tags: body.tags ?? (source.tags as string[]) ?? [],
    pipeId: body.pipeId,
  });
  if ("nameConflict" in forked) {
    res.status(409).json(forked.nameConflict);
    return;
  }
  const created = forked.row;

  invalidateSpecWatcherCache();
  noteWorkflowWrite();

  traceEvent(runId, {
    service: "workflow-service",
    event: "fork-with-change-complete",
    detail: `fork "${source.workflowSlug}" -> "${created.workflowSlug}" with ${body.changes.length} change(s) (by org ${orgId})`,
    data: { from: source.workflowSlug, to: created.workflowSlug, changes: body.changes.length },
  }, req.headers).catch(() => {});

  res.status(201).json({
    workflow: formatWorkflow(created),
    sourceWorkflow: {
      id: source.id,
      workflowSlug: source.workflowSlug,
      workflowDynastySlug: source.workflowDynastySlug,
      version: source.version,
    },
    changesApplied: body.changes.length,
  });
}

/** Why a copy cannot be forked for `pipeId` (null = it can): the pipe must exist and belong to the source's channel. */
async function refusePipe(
  pipeId: string,
  featureSlug: string,
  downstreamHeaders: ReturnType<typeof extractDownstreamHeaders>,
): Promise<string | null> {
  if (!pipeId.startsWith(`${featureSlug}|`)) {
    return `Pipe "${pipeId}" is not a pipe of the source's channel "${featureSlug}": a copy is forked for a pipe of its own channel`;
  }
  try {
    const pipe = await fetchPipe(pipeId, downstreamHeaders);
    if (pipe.channelSlug !== featureSlug) {
      return `Pipe "${pipeId}" belongs to channel "${pipe.channelSlug}", not to the source's channel "${featureSlug}"`;
    }
    return null;
  } catch (err) {
    if (err instanceof PipeResolutionError) return err.message;
    throw err;
  }
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof Error && err.name === "ZodError") {
    res.status(400).json({ error: "Validation error", details: err });
    return;
  }
  const constraintError = constraintErrorResponse(err);
  if (constraintError) {
    console.error("[workflow-service] fork write rejected by the database:", err);
    res.status(400).json(constraintError);
    return;
  }
  if (err instanceof LegAssignmentError) {
    console.error("[workflow-service] fork written but its pipe assignment failed:", err.message);
    res.status(502).json({ error: err.message, reason: "leg_assignment_failed" });
    return;
  }
  console.error("[workflow-service] fork error:", err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
}

// POST /workflows/:id/fork — any version; the copy branches from exactly it.
router.post("/workflows/:id/fork", requireApiKey, createRateLimit, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
  try {
    const body = ForkWorkflowRequestSchema.parse(req.body);
    const [source] = await db.select().from(workflows).where(eq(workflows.id, req.params.id));
    if (!source) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    await handleFork(req, res, source, body);
  } catch (err) {
    handleError(res, err);
  }
});

// POST /workflows/dynasty/:workflowDynastySlug/fork — the dynasty's active version.
router.post("/workflows/dynasty/:workflowDynastySlug/fork", requireApiKey, createRateLimit, async (req, res) => {
  try {
    const body = ForkWorkflowRequestSchema.parse(req.body);
    const [source] = await db
      .select()
      .from(workflows)
      .where(and(eq(workflows.workflowDynastySlug, req.params.workflowDynastySlug), eq(workflows.status, "active")));
    if (!source) {
      res.status(404).json({ error: `Active workflow not found for dynasty "${req.params.workflowDynastySlug}"` });
      return;
    }
    await handleFork(req, res, source, body);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
