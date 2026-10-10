import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows } from "../db/schema.js";
import type { DAG } from "./dag-validator.js";
import { dagToOpenFlow } from "./dag-to-openflow.js";
import { getWindmillClient } from "./windmill-client.js";
import {
  pickWorkflowDynastySignatureName,
  workflowDynastySignatureNameToDisplay,
} from "./workflow-dynasty-signature-name.js";

/**
 * The two lineage writes that turn a DAG into a NEW workflow row next to an
 * existing one: an UPGRADE (next version of the same dynasty, predecessor
 * deprecated) and a FORK (version 1 of a new dynasty, source untouched).
 *
 * They live here rather than inline in the routes because more than one route
 * performs them — `POST /workflows/upgrade`, `PUT /workflows/{id}` and the
 * prompt-edit routes — and the invariants they carry (deprecate-before-insert,
 * a retired dynasty stays retired, the conflict check runs before Windmill is
 * touched) must not drift between copies.
 */

type WorkflowRow = typeof workflows.$inferSelect;

export function generateFlowPath(scope: string, slug: string): string {
  const sanitized = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `f/workflows/${scope}/${sanitized}`;
}

/** Convert feature slug to display name: "pr-cold-email-outreach" → "PR Cold Email Outreach" */
export function featureSlugToName(slug: string): string {
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Compose slug with version suffix: no -v1 for v1, -v2 for v2+. */
export function composeSlug(base: string, version: number): string {
  return version >= 2 ? `${base}-v${version}` : base;
}

/** Compose display name with version suffix: no v1 for v1, v2 for v2+. */
export function composeName(base: string, version: number): string {
  return version >= 2 ? `${base} v${version}` : base;
}

export interface SignatureConflict {
  id: string;
  workflowSlug: string;
  workflowName: string;
}

/**
 * An active workflow in the same feature already holding this signature. The
 * partial unique index `idx_workflows_active_sig` would reject the insert with a
 * raw Postgres 500, so every write path asks first and answers a clean 409 —
 * BEFORE the Windmill flow is created, so a conflict leaves no orphan flow.
 */
export async function findSignatureConflict(
  featureSlug: string,
  signature: string,
): Promise<SignatureConflict | null> {
  const [conflicting] = await db
    .select({
      id: workflows.id,
      workflowSlug: workflows.workflowSlug,
      workflowName: workflows.workflowName,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.featureSlug, featureSlug),
        eq(workflows.signature, signature),
        eq(workflows.status, "active"),
      )
    );
  return conflicting ?? null;
}

export function signatureConflictBody(conflicting: SignatureConflict) {
  return {
    error: "A workflow with this DAG signature already exists",
    existingWorkflowId: conflicting.id,
    existingWorkflowSlug: conflicting.workflowSlug,
    existingWorkflowName: conflicting.workflowName,
  };
}

export interface UpgradeWorkflowParams {
  /** The dynasty's currently-active version. */
  existing: WorkflowRow;
  dag: DAG;
  signature: string;
  /** Org the new row is written under (and the Windmill flow path scope). */
  orgId: string;
  userId: string;
  runId: string;
  description: string;
  category: WorkflowRow["category"];
  channel: WorkflowRow["channel"];
  audienceType: WorkflowRow["audienceType"];
}

/**
 * Inserts the next version of `existing`'s dynasty and deprecates `existing`.
 * The caller has already checked for a signature conflict.
 */
export async function upgradeWorkflowRow(params: UpgradeWorkflowParams): Promise<WorkflowRow> {
  const { existing, dag, signature, orgId, userId, runId } = params;

  // The dynasty signature name is immutable per dynasty — reuse the existing one.
  const newVersion = existing.version + 1;
  const newSlug = composeSlug(existing.workflowDynastySlug, newVersion);
  const newName = composeName(existing.workflowDynastyName, newVersion);

  const openFlow = dagToOpenFlow(dag, newSlug);
  const flowPath = generateFlowPath(orgId, newSlug);
  const client = getWindmillClient();
  if (client) {
    try {
      await client.createFlow({
        path: flowPath,
        summary: newSlug,
        description: params.description,
        value: openFlow.value,
        schema: openFlow.schema,
      });
    } catch (err) {
      console.error("[workflow-service] upgrade: failed to create Windmill flow:", err);
    }
  }

  // Atomic: deprecate predecessor (status='deprecated') BEFORE inserting the new
  // active row. The partial unique index idx_workflows_active_signame
  // (feature_slug, signature_name) WHERE status='active' would otherwise reject
  // the insert because the predecessor still occupies the (feature_slug, signame)
  // slot. Wrapping in a transaction guarantees both rows commit together.
  let created: WorkflowRow;
  await db.transaction(async (tx) => {
    await tx
      .update(workflows)
      .set({ status: "deprecated", updatedAt: new Date() })
      .where(eq(workflows.id, existing.id));

    const [row] = await tx
      .insert(workflows)
      .values({
        orgId,
        createdForBrandId: existing.createdForBrandId,
        humanId: existing.humanId,
        workflowSlug: newSlug,
        workflowName: newName,
        workflowDynastySlug: existing.workflowDynastySlug,
        workflowDynastyName: existing.workflowDynastyName,
        description: params.description,
        featureSlug: existing.featureSlug,
        category: params.category,
        channel: params.channel,
        audienceType: params.audienceType,
        tags: (existing.tags as string[]) ?? [],
        signature,
        workflowDynastySignatureName: existing.workflowDynastySignatureName,
        version: newVersion,
        dag,
        windmillFlowPath: flowPath,
        // A retired dynasty stays retired across an upgrade. Without this the
        // column defaults to 'active' and upgrading a retired lineage silently
        // un-retires it — the row would execute again while the operator who
        // retired it is told nothing.
        workflowDynastyStatus: existing.workflowDynastyStatus,
        creationType: "upgrade",
        createdFromWorkflow: existing.id,
        createdByUserId: userId,
        createdByRunId: runId,
      })
      .returning();
    created = row;
  });

  // Windmill cleanup of the predecessor flow happens AFTER the DB commit so a
  // rolled-back transaction does not leave Windmill in an inconsistent state.
  // Failures here are logged but never re-thrown — the row is already deprecated.
  if (client && existing.windmillFlowPath) {
    try {
      await client.deleteFlow(existing.windmillFlowPath);
      console.log(
        `[workflow-service] upgrade: deleted Windmill flow "${existing.windmillFlowPath}" for deprecated predecessor "${existing.workflowSlug}"`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("404")) {
        console.warn(
          `[workflow-service] upgrade: failed to delete Windmill flow "${existing.windmillFlowPath}" for "${existing.workflowSlug}":`,
          msg,
        );
      }
    }
  }

  return created!;
}

export interface ForkWorkflowParams {
  /** The version being forked. It is kept exactly as it is. */
  existing: WorkflowRow;
  dag: DAG;
  signature: string;
  /** Scope of the new Windmill flow path (the caller's org). */
  flowScopeOrgId: string;
  userId: string;
  runId: string;
  description: string | null;
  tags: string[];
}

export type ForkResult =
  | { row: WorkflowRow }
  | { nameConflict: { error: string; detail?: string } };

/**
 * Inserts version 1 of a NEW dynasty carrying `dag`, created from `existing`.
 * The source is always kept active. The caller has already checked for a
 * signature conflict.
 */
export async function forkWorkflowRow(params: ForkWorkflowParams): Promise<ForkResult> {
  const { existing, dag, signature } = params;

  // Names are burned for life within a feature_slug (any status, any org).
  // No org filter, no status filter.
  const existingFeatureRows = await db
    .select({ workflowDynastySignatureName: workflows.workflowDynastySignatureName })
    .from(workflows)
    .where(eq(workflows.featureSlug, existing.featureSlug));
  const burnedNames = new Set(existingFeatureRows.map((w) => w.workflowDynastySignatureName));
  const workflowDynastySignatureName = pickWorkflowDynastySignatureName(signature, burnedNames);

  const featureName = featureSlugToName(existing.featureSlug);
  const newWorkflowDynastySlug = `${existing.featureSlug}-${workflowDynastySignatureName}`;
  const newWorkflowDynastyName = `${featureName} ${workflowDynastySignatureNameToDisplay(workflowDynastySignatureName)}`;
  const newWorkflowSlug = newWorkflowDynastySlug; // v1 has no version suffix
  const newWorkflowName = newWorkflowDynastyName;

  const openFlow = dagToOpenFlow(dag, newWorkflowSlug);
  const flowPath = generateFlowPath(params.flowScopeOrgId, newWorkflowSlug);
  const client = getWindmillClient();

  if (client) {
    try {
      await client.createFlow({
        path: flowPath,
        summary: newWorkflowSlug,
        description: params.description ?? undefined,
        value: openFlow.value,
        schema: openFlow.schema,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("already exists")) {
        try {
          await client.updateFlow(flowPath, {
            summary: newWorkflowSlug,
            description: params.description ?? undefined,
            value: openFlow.value,
            schema: openFlow.schema,
          });
        } catch (updateErr) {
          console.error("[workflow-service] Failed to update existing forked flow in Windmill:", updateErr);
        }
      } else {
        console.error("[workflow-service] Failed to create forked flow in Windmill:", err);
      }
    }
  }

  let forked: WorkflowRow;
  try {
    const [row] = await db
      .insert(workflows)
      .values({
        orgId: existing.orgId,
        createdForBrandId: existing.createdForBrandId,
        featureSlug: existing.featureSlug,
        humanId: existing.humanId,
        campaignId: existing.campaignId,
        subrequestId: existing.subrequestId,
        workflowSlug: newWorkflowSlug,
        workflowName: newWorkflowName,
        workflowDynastySlug: newWorkflowDynastySlug,
        workflowDynastyName: newWorkflowDynastyName,
        description: params.description,
        category: existing.category,
        channel: existing.channel,
        audienceType: existing.audienceType,
        tags: params.tags,
        signature,
        workflowDynastySignatureName,
        version: 1,
        dag,
        status: "active",
        creationType: "fork",
        createdFromWorkflow: existing.id,
        windmillFlowPath: flowPath,
        createdByUserId: params.userId,
        createdByRunId: params.runId,
      })
      .returning();
    forked = row;
  } catch (dbErr: unknown) {
    if (dbErr instanceof Error && "code" in dbErr && (dbErr as { code?: string }).code === "23505") {
      return {
        nameConflict: {
          error: "A workflow with this name already exists",
          detail: (dbErr as { detail?: string }).detail,
        },
      };
    }
    throw dbErr;
  }

  console.log(
    `[workflow-service] fork: "${existing.workflowSlug}" (${existing.id}) -> "${newWorkflowSlug}" (${forked.id}) [source kept active]`,
  );

  return { row: forked };
}
