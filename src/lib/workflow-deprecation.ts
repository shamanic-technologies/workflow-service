/**
 * Helpers for marking workflows as deprecated and cleaning up their
 * associated Windmill flows.
 */

import { eq } from "drizzle-orm";
import { workflows } from "../db/schema.js";
import type { db as DbInstance } from "../db/index.js";
import type { WindmillClient } from "./windmill-client.js";

type Database = typeof DbInstance;

/**
 * Mark a workflow as deprecated and (optionally) delete its Windmill flow.
 *
 * The Windmill flow is deleted when:
 *   - a Windmill client is provided AND
 *   - the workflow has a windmill_flow_path AND
 *   - either no active-campaign set is provided OR the workflow's slug is not in it.
 *
 * Errors from Windmill are logged but never re-thrown — deletion is best-effort
 * since the row is already deprecated in the DB.
 */
export async function deprecateWorkflow(
  database: Database,
  workflowId: string,
  windmillClient: WindmillClient | null,
  activeCampaignSlugs?: Set<string>,
): Promise<void> {
  const [wf] = await database
    .select({
      id: workflows.id,
      workflowSlug: workflows.workflowSlug,
      windmillFlowPath: workflows.windmillFlowPath,
      status: workflows.status,
    })
    .from(workflows)
    .where(eq(workflows.id, workflowId));

  if (!wf) {
    throw new Error(`deprecateWorkflow: workflow ${workflowId} not found`);
  }

  await database
    .update(workflows)
    .set({ status: "deprecated", updatedAt: new Date() })
    .where(eq(workflows.id, workflowId));

  if (!windmillClient || !wf.windmillFlowPath) {
    return;
  }

  if (activeCampaignSlugs && activeCampaignSlugs.has(wf.workflowSlug)) {
    console.log(
      `[workflow-service] Keeping Windmill flow for "${wf.workflowSlug}" — used by active campaign`,
    );
    return;
  }

  try {
    await windmillClient.deleteFlow(wf.windmillFlowPath);
    console.log(
      `[workflow-service] Deleted Windmill flow "${wf.windmillFlowPath}" for deprecated workflow "${wf.workflowSlug}"`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404")) {
      // Already gone — fine.
      return;
    }
    console.warn(
      `[workflow-service] Failed to delete Windmill flow "${wf.windmillFlowPath}" for "${wf.workflowSlug}":`,
      msg,
    );
  }
}
