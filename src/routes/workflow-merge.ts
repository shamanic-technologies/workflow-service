import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { DynastyMergeRequestSchema, DynastyUnmergeRequestSchema } from "../schemas.js";
import { activeLegsOfDynasty } from "../lib/catalogue-client.js";
import { extractDownstreamHeaders } from "../lib/downstream-headers.js";
import { resolveDecidedBy } from "../lib/deprecation.js";
import {
  mergeRefusal,
  loadOpenMerges,
  formatMerge,
  applyMerge,
  applyUnmerge,
  openMergeOf,
  recordedVersions,
} from "../lib/dynasty-merge.js";
import { getWindmillClient } from "../lib/windmill-client.js";
import { syncFlowToWindmill } from "../lib/startup-validator.js";
import { constraintErrorResponse } from "../lib/db-error.js";
import { noteWorkflowWrite } from "../lib/periodic-cleanup.js";

// TPL-DYNASTY-1021-WF: merge a duplicate workflow dynasty into its survivor on the same pipe, and undo it.
// The invariants (non-destructive, reversible, same pipe only) are in src/lib/dynasty-merge.ts.

const router = Router();

function handleError(res: import("express").Response, err: unknown, route: string): void {
  if (err instanceof Error && err.name === "ZodError") {
    res.status(400).json({ error: "Validation error", details: err });
    return;
  }
  const constraintError = constraintErrorResponse(err);
  if (constraintError) {
    console.error(`[workflow-service] ${route}: write rejected by the database:`, err);
    res.status(400).json(constraintError);
    return;
  }
  console.error(`[workflow-service] ${route} error:`, err);
  res.status(500).json({ error: "Internal server error" });
}

// POST /workflows/dynasty/:workflowDynastySlug/merge — absorb this dynasty into `intoWorkflowDynastySlug`.
router.post("/workflows/dynasty/:workflowDynastySlug/merge", requireApiKey, async (req, res) => {
  try {
    const absorbedSlug = req.params.workflowDynastySlug;
    const body = DynastyMergeRequestSchema.parse(req.body);
    const decidedBy = resolveDecidedBy(req, body.decidedBy);

    const absorbed = await db.select().from(workflows).where(eq(workflows.workflowDynastySlug, absorbedSlug));
    const survivor = await db.select().from(workflows).where(eq(workflows.workflowDynastySlug, body.intoWorkflowDynastySlug));
    if (absorbed.length === 0 || survivor.length === 0) {
      res.status(404).json({ error: `No workflows found for workflowDynastySlug: ${absorbed.length === 0 ? absorbedSlug : body.intoWorkflowDynastySlug}` });
      return;
    }

    // features-service owns which pipe each dynasty serves: both must be on the same one.
    const headers = extractDownstreamHeaders(req);
    const [absorbedLegs, survivorLegs] = await Promise.all([
      activeLegsOfDynasty(absorbed[0].featureSlug, absorbedSlug, headers),
      activeLegsOfDynasty(survivor[0].featureSlug, body.intoWorkflowDynastySlug, headers),
    ]);
    const refusal = mergeRefusal({ absorbedSlug, absorbed, survivor, absorbedLegs, survivorLegs, openMerges: await loadOpenMerges() });
    if (refusal) {
      res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
      return;
    }

    const merge = await applyMerge(db, { absorbed, survivor, legKeys: absorbedLegs, reason: body.reason, decidedBy });
    noteWorkflowWrite();
    console.log(`[workflow-service] Dynasty "${absorbedSlug}" merged into "${body.intoWorkflowDynastySlug}" (${absorbed.length} version(s)) by ${decidedBy ?? "unknown"}`);
    res.status(201).json({ merge: formatMerge(merge, await loadOpenMerges()), deprecatedVersions: absorbed.length });
  } catch (err) {
    handleError(res, err, "POST dynasty merge");
  }
});

// POST /workflows/dynasty/:workflowDynastySlug/unmerge — restore an absorbed dynasty exactly as it was.
router.post("/workflows/dynasty/:workflowDynastySlug/unmerge", requireApiKey, async (req, res) => {
  try {
    const absorbedSlug = req.params.workflowDynastySlug;
    const body = DynastyUnmergeRequestSchema.parse(req.body);
    const decidedBy = resolveDecidedBy(req, body.decidedBy);

    const open = await openMergeOf(db, absorbedSlug);
    if (!open) {
      res.status(404).json({ error: `${absorbedSlug} is not merged into any dynasty`, code: "not_merged" });
      return;
    }
    const { prior, rows } = await recordedVersions(db, open);
    const missing = prior.find((p) => !rows.has(p.id));
    if (missing) {
      res.status(409).json({ error: `Version ${missing.id} recorded by the merge no longer exists: cannot restore exactly`, code: "version_missing" });
      return;
    }

    // The flow of every version that runs again goes back to Windmill BEFORE the row goes live (the orphan cleanup
    // deletes the flows of deprecated workflows): a restored row without its flow would 404 on every execute.
    const client = getWindmillClient();
    if (client) {
      for (const p of prior.filter((v) => v.status === "active" && v.workflowDynastyStatus === "active")) {
        const row = rows.get(p.id)!;
        try {
          await syncFlowToWindmill(row, client);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(502).json({ error: `Could not restore the Windmill flow for "${row.workflowSlug}": ${msg}` });
          return;
        }
      }
    }

    const closed = await applyUnmerge(db, open, { reason: body.reason, decidedBy });
    noteWorkflowWrite();
    console.log(`[workflow-service] Dynasty "${absorbedSlug}" un-merged from "${open.survivorDynastySlug}" (${prior.length} version(s) restored) by ${decidedBy ?? "unknown"}`);
    res.json({ merge: formatMerge(closed, await loadOpenMerges()), restoredVersions: prior.length });
  } catch (err) {
    handleError(res, err, "POST dynasty unmerge");
  }
});

export default router;
