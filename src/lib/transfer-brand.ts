import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { workflows, workflowRuns } from "../db/schema.js";

/**
 * Move every row this service holds for one brand from one org to another.
 *
 * What ties a row to the brand, per table:
 *   - workflow_runs: a SOLO-brand `brand_ids` array naming it, OR no `brand_ids`
 *     at all but a `campaign_id` that belongs to the brand (a campaign's brand is
 *     read off its own solo-brand runs here — this service stores no campaign
 *     table). Co-branded runs (several brand ids) are shared history: they stay
 *     in the source org and only get the brand id rewritten.
 *   - workflows: `created_for_brand_id` naming it, OR no brand but a `campaign_id`
 *     of the brand. A workflow with neither is a catalog workflow any org can run;
 *     it is not the brand's and never moves, even when the brand's runs used it.
 *   - `workflow_runs.inputs` (jsonb): the dispatch inputs carry `orgId` and
 *     `brandId` beside the columns, so they are rewritten with them — otherwise
 *     the moved history still names the old org.
 *
 * Idempotent: every statement is guarded on the value it replaces, so a second
 * call finds nothing to change and reports zero. Runs in one transaction.
 * Counts are distinct rows touched per table, read from RETURNING (portable
 * across drivers, unlike a driver-specific rowCount).
 */
export interface TransferBrandParams {
  sourceBrandId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetBrandId?: string;
}

export interface TransferBrandResult {
  updatedTables: Array<{ tableName: "workflows" | "workflow_runs"; count: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPgDb = PgDatabase<PgQueryResultHKT, any, any>;

export async function transferBrand(
  database: AnyPgDb,
  params: TransferBrandParams,
): Promise<TransferBrandResult> {
  const { sourceBrandId, sourceOrgId, targetOrgId } = params;
  const targetBrandId = params.targetBrandId ?? sourceBrandId;
  const brandIds = Array.from(new Set([sourceBrandId, targetBrandId]));

  return database.transaction(async (tx) => {
    const soloBrand: SQL = or(
      ...brandIds.map((b) => sql`${workflowRuns.brandIds} = ARRAY[${b}]::text[]`),
    )!;

    // The brand's campaigns, read off its own solo-brand runs (any org, so a
    // re-run after the move still finds them).
    const campaignRows = await tx
      .selectDistinct({ campaignId: workflowRuns.campaignId })
      .from(workflowRuns)
      .where(and(soloBrand, sql`${workflowRuns.campaignId} IS NOT NULL`));
    const campaignIds = campaignRows.map((r) => r.campaignId!).filter(Boolean);

    const runOfBrand: SQL = campaignIds.length
      ? or(soloBrand, and(isNull(workflowRuns.brandIds), inArray(workflowRuns.campaignId, campaignIds)))!
      : soloBrand;

    const touchedRuns = new Set<string>();
    const touchedWorkflows = new Set<string>();
    const note = (set: Set<string>, rows: Array<{ id: string }>) => rows.forEach((r) => set.add(r.id));

    // 1. workflow_runs → target org, with the orgId their inputs recorded.
    note(
      touchedRuns,
      await tx
        .update(workflowRuns)
        .set({
          orgId: targetOrgId,
          inputs: sql`CASE WHEN ${workflowRuns.inputs}->>'orgId' = ${sourceOrgId}
            THEN jsonb_set(${workflowRuns.inputs}, '{orgId}', to_jsonb(${targetOrgId}::text))
            ELSE ${workflowRuns.inputs} END`,
        })
        .where(and(eq(workflowRuns.orgId, sourceOrgId), runOfBrand))
        .returning({ id: workflowRuns.id }),
    );

    // 2. Repair inputs.orgId on the brand's runs a previous transfer moved to the
    //    target org without touching inputs.
    note(
      touchedRuns,
      await tx
        .update(workflowRuns)
        .set({ inputs: sql`jsonb_set(${workflowRuns.inputs}, '{orgId}', to_jsonb(${targetOrgId}::text))` })
        .where(
          and(
            eq(workflowRuns.orgId, targetOrgId),
            runOfBrand,
            sql`${workflowRuns.inputs}->>'orgId' = ${sourceOrgId}`,
          ),
        )
        .returning({ id: workflowRuns.id }),
    );

    // 3. workflows → target org.
    const workflowOfBrand: SQL = campaignIds.length
      ? or(
          inArray(workflows.createdForBrandId, brandIds),
          and(isNull(workflows.createdForBrandId), inArray(workflows.campaignId, campaignIds)),
        )!
      : inArray(workflows.createdForBrandId, brandIds);
    note(
      touchedWorkflows,
      await tx
        .update(workflows)
        .set({ orgId: targetOrgId })
        .where(and(eq(workflows.orgId, sourceOrgId), workflowOfBrand))
        .returning({ id: workflows.id }),
    );

    // 4. Brand id rewrite, wherever the old id is still referenced (brand ids are
    //    global, so no org filter; co-branded arrays included).
    if (targetBrandId !== sourceBrandId) {
      note(
        touchedWorkflows,
        await tx
          .update(workflows)
          .set({ createdForBrandId: targetBrandId })
          .where(eq(workflows.createdForBrandId, sourceBrandId))
          .returning({ id: workflows.id }),
      );

      note(
        touchedRuns,
        await tx
          .update(workflowRuns)
          .set({ brandIds: sql`array_replace(${workflowRuns.brandIds}, ${sourceBrandId}::text, ${targetBrandId}::text)` })
          .where(sql`${sourceBrandId}::text = ANY(${workflowRuns.brandIds})`)
          .returning({ id: workflowRuns.id }),
      );

      const brandInputsScope: SQL = campaignIds.length
        ? or(
            sql`${workflowRuns.brandIds} && ARRAY[${sql.join(brandIds.map((b) => sql`${b}`), sql`, `)}]::text[]`,
            and(isNull(workflowRuns.brandIds), inArray(workflowRuns.campaignId, campaignIds)),
          )!
        : sql`${workflowRuns.brandIds} && ARRAY[${sql.join(brandIds.map((b) => sql`${b}`), sql`, `)}]::text[]`;
      note(
        touchedRuns,
        await tx
          .update(workflowRuns)
          .set({ inputs: sql`jsonb_set(${workflowRuns.inputs}, '{brandId}', to_jsonb(${targetBrandId}::text))` })
          .where(and(brandInputsScope, sql`${workflowRuns.inputs}->>'brandId' = ${sourceBrandId}`))
          .returning({ id: workflowRuns.id }),
      );
    }

    return {
      updatedTables: [
        { tableName: "workflows", count: touchedWorkflows.size },
        { tableName: "workflow_runs", count: touchedRuns.size },
      ],
    };
  });
}
