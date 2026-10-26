import { and, eq, inArray, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { workflows } from "../db/schema.js";
import type { StatusFilter } from "./status-filter.js";

/**
 * The columns `GET /public/workflows` serves, and nothing else (BOX-OVERLOAD-1026-WORKFLOW).
 *
 * The route used to `select()` every column, so each call pulled the DAG (and description) of
 * every version of the feature out of Postgres and parsed it into the heap, only to drop it:
 * the response never carries either. In production (2026-10-26) one feature held ~6 MB of DAG
 * text (sales-cold-email-outreach 908 versions, ai-meeting-booking 82), its callers
 * (features-service stats, runs-service lead states) kept ~4 of these reads in flight at all
 * times, the single most frequent query on the box, and the parsed DAGs were what grew the
 * container's heap. Reading a column here is a decision: add it only when the response serves it.
 */
export const PUBLIC_WORKFLOW_COLUMNS = {
  id: workflows.id,
  workflowSlug: workflows.workflowSlug,
  workflowName: workflows.workflowName,
  workflowDynastySlug: workflows.workflowDynastySlug,
  workflowDynastyName: workflows.workflowDynastyName,
  version: workflows.version,
  status: workflows.status,
  workflowDynastyStatus: workflows.workflowDynastyStatus,
  featureSlug: workflows.featureSlug,
  createdForBrandId: workflows.createdForBrandId,
  creationType: workflows.creationType,
  createdFromWorkflow: workflows.createdFromWorkflow,
  createdAt: workflows.createdAt,
  executableUntil: workflows.executableUntil,
  executableUntilSource: workflows.executableUntilSource,
  deprecationReason: workflows.deprecationReason,
  deprecatedBy: workflows.deprecatedBy,
  deprecatedAt: workflows.deprecatedAt,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPgDatabase = PgDatabase<PgQueryResultHKT, any, any>;

/** Every version of the given features matching the status filter, light columns only. */
export async function listPublicWorkflowRows(
  database: AnyPgDatabase,
  featureSlugs: string[],
  statusFilter: StatusFilter,
) {
  // "active" here means EXECUTABLE, on both axes: a version of a retired
  // dynasty cannot run, so it must not be served as an active candidate to
  // the rankers reading this route. "deprecated" is the complement of that,
  // so the two filters still partition the same set "all" returns.
  const conditions = [inArray(workflows.featureSlug, featureSlugs)];
  if (statusFilter.kind === "executable") {
    conditions.push(eq(workflows.status, "active"));
    conditions.push(eq(workflows.workflowDynastyStatus, "active"));
  } else if (statusFilter.kind === "retired") {
    conditions.push(
      or(
        eq(workflows.status, "deprecated"),
        eq(workflows.workflowDynastyStatus, "deprecated"),
      )!,
    );
  }
  return database.select(PUBLIC_WORKFLOW_COLUMNS).from(workflows).where(and(...conditions));
}
