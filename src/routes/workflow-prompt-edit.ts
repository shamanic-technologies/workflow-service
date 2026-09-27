import { Router, type Request, type Response } from "express";
import type { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { PromptEditRequestSchema } from "../schemas.js";
import type { DAG } from "../lib/dag-validator.js";
import { computeDAGSignature } from "../lib/dag-signature.js";
import { summarizeContentGeneration } from "../lib/content-generation-summary.js";
import { fetchPromptTemplate, createPromptVersion } from "../lib/content-generation-client.js";
import { checkPromptVariableContract, repointPromptTemplate } from "../lib/prompt-edit.js";
import { validateClientDag } from "../lib/validate-client-dag.js";
import { extractDownstreamHeaders } from "../lib/downstream-headers.js";
import {
  findSignatureConflict,
  signatureConflictBody,
  upgradeWorkflowRow,
  forkWorkflowRow,
} from "../lib/workflow-lineage.js";
import { formatWorkflow } from "../lib/format-workflow.js";
import { traceEvent } from "../lib/trace-event.js";
import { constraintErrorResponse } from "../lib/db-error.js";
import { invalidateSpecWatcherCache } from "../lib/spec-watcher.js";
import { noteWorkflowWrite } from "../lib/periodic-cleanup.js";

/**
 * Edit the prompt a workflow writes with, then UPGRADE its dynasty or FORK it.
 *
 * A content-generation template is shared platform-wide by type, so the edit is
 * never written onto the existing type: it is stored as a NEW type
 * (content-generation `PUT /prompts`, which inserts `<base>-vN` and never touches
 * the source) and only the new workflow row is repointed at it.
 *
 * Every refusal happens BEFORE anything is written, except one: a DAG that
 * fails validation after the template was stored leaves that template unused.
 * That is harmless — nothing renders a type no workflow names — and it is the
 * price of validating the exact DAG that would be stored.
 *
 * Staff-only is enforced at the gateway (api-service `requireStaff`): an upgrade
 * changes what every campaign on the dynasty sends, for every client.
 */

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WorkflowRow = typeof workflows.$inferSelect;
type PromptEditRequest = z.infer<typeof PromptEditRequestSchema>;

async function handlePromptEdit(
  req: Request,
  res: Response,
  source: WorkflowRow,
  body: PromptEditRequest,
): Promise<void> {
  const orgId = res.locals.orgId as string;
  const userId = res.locals.userId as string;
  const runId = res.locals.runId as string;
  const dsHeaders = extractDownstreamHeaders(req);

  // An upgrade builds on the dynasty's CURRENT version. Upgrading from a
  // superseded one would silently drop whatever the versions after it changed.
  if (body.action === "upgrade" && source.status !== "active") {
    const [active] = await db
      .select({ id: workflows.id, workflowSlug: workflows.workflowSlug })
      .from(workflows)
      .where(
        and(
          eq(workflows.workflowDynastySlug, source.workflowDynastySlug),
          eq(workflows.status, "active"),
        ),
      );
    res.status(409).json({
      error: active
        ? `"${source.workflowSlug}" is not the active version of its dynasty; upgrade "${active.workflowSlug}" instead.`
        : `Dynasty "${source.workflowDynastySlug}" has no active version to upgrade.`,
      activeWorkflowId: active?.id ?? null,
      activeWorkflowSlug: active?.workflowSlug ?? null,
    });
    return;
  }

  const templateType = summarizeContentGeneration(source.dag as DAG).contentPromptType;
  if (!templateType) {
    res.status(409).json({
      error:
        `"${source.workflowSlug}" does not write with a single fixed prompt template ` +
        `(no content-generation call, a template chosen at run time, or several different ones), ` +
        `so there is no prompt to edit.`,
    });
    return;
  }

  let template;
  try {
    template = await fetchPromptTemplate(templateType, dsHeaders);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!template) {
    res.status(409).json({
      error: `Template "${templateType}" that "${source.workflowSlug}" renders does not exist in content-generation.`,
    });
    return;
  }

  if (body.prompt === template.prompt) {
    res.status(400).json({ error: "The edited prompt is identical to the current one; nothing to change." });
    return;
  }

  const contractBreak = checkPromptVariableContract(template.prompt, body.prompt);
  if (contractBreak) {
    res.status(422).json(contractBreak);
    return;
  }

  let version;
  try {
    version = await createPromptVersion(templateType, body.prompt, template.variables, dsHeaders);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!version.created || version.template.type === templateType) {
    // content-generation judged the text identical — which our own equality
    // check just ruled out. Never repoint a DAG at the type it already renders.
    res.status(502).json({
      error: `content-generation did not store a new template for "${templateType}" (answered with "${version.template.type}").`,
    });
    return;
  }
  const newType = version.template.type;

  const dag = repointPromptTemplate(source.dag as DAG, templateType, newType);
  const rejection = await validateClientDag(dag, dsHeaders);
  if (rejection) {
    res.status(400).json(rejection);
    return;
  }

  const signature = computeDAGSignature(dag);
  const conflicting = await findSignatureConflict(source.featureSlug, signature);
  if (conflicting) {
    res.status(409).json(signatureConflictBody(conflicting));
    return;
  }

  // The new row belongs to the workflow's OWNER, not to the staff member making
  // the edit: the upgrade route writes the caller's org, which is right for a
  // customer editing their own workflow and wrong here.
  let created: WorkflowRow;
  if (body.action === "upgrade") {
    created = await upgradeWorkflowRow({
      existing: source,
      dag,
      signature,
      orgId: source.orgId,
      userId,
      runId,
      description: source.description ?? "",
      category: source.category,
      channel: source.channel,
      audienceType: source.audienceType,
    });
  } else {
    const forked = await forkWorkflowRow({
      existing: source,
      dag,
      signature,
      flowScopeOrgId: source.orgId,
      userId,
      runId,
      description: source.description,
      tags: (source.tags as string[]) ?? [],
    });
    if ("nameConflict" in forked) {
      res.status(409).json(forked.nameConflict);
      return;
    }
    created = forked.row;
  }

  invalidateSpecWatcherCache();
  noteWorkflowWrite();

  traceEvent(runId, {
    service: "workflow-service",
    event: "prompt-edit-complete",
    detail: `${body.action} "${source.workflowSlug}" -> "${created.workflowSlug}" with template "${templateType}" -> "${newType}" (by org ${orgId})`,
    data: {
      action: body.action,
      from: source.workflowSlug,
      to: created.workflowSlug,
      previousTemplate: templateType,
      template: newType,
    },
  }, req.headers).catch(() => {});

  res.status(201).json({
    action: body.action === "upgrade" ? "upgraded" : "forked",
    workflow: formatWorkflow(created),
    sourceWorkflow: {
      id: source.id,
      workflowSlug: source.workflowSlug,
      workflowDynastySlug: source.workflowDynastySlug,
      version: source.version,
    },
    promptTemplate: { previousType: templateType, type: newType },
  });
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof Error && err.name === "ZodError") {
    res.status(400).json({ error: "Validation error", details: err });
    return;
  }
  const constraintError = constraintErrorResponse(err);
  if (constraintError) {
    console.error("[workflow-service] prompt-edit write rejected by the database:", err);
    res.status(400).json(constraintError);
    return;
  }
  console.error("[workflow-service] prompt-edit error:", err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
}

// POST /workflows/:id/prompt-edit — any version; fork branches from exactly it,
// upgrade requires it to be the dynasty's active version.
router.post("/workflows/:id/prompt-edit", requireApiKey, createRateLimit, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
  try {
    const body = PromptEditRequestSchema.parse(req.body);
    const [source] = await db.select().from(workflows).where(eq(workflows.id, req.params.id));
    if (!source) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    await handlePromptEdit(req, res, source, body);
  } catch (err) {
    handleError(res, err);
  }
});

// POST /workflows/dynasty/:workflowDynastySlug/prompt-edit — the dynasty's active version.
router.post(
  "/workflows/dynasty/:workflowDynastySlug/prompt-edit",
  requireApiKey,
  createRateLimit,
  async (req, res) => {
    try {
      const body = PromptEditRequestSchema.parse(req.body);
      const [source] = await db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.workflowDynastySlug, req.params.workflowDynastySlug),
            eq(workflows.status, "active"),
          ),
        );
      if (!source) {
        res.status(404).json({
          error: `Active workflow not found for dynasty "${req.params.workflowDynastySlug}"`,
        });
        return;
      }
      await handlePromptEdit(req, res, source, body);
    } catch (err) {
      handleError(res, err);
    }
  },
);

export default router;
