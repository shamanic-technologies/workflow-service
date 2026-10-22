import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    createdForBrandId: text("created_for_brand_id"),
    humanId: text("human_id"),
    campaignId: text("campaign_id"),
    subrequestId: text("subrequest_id"),
    workflowSlug: text("workflow_slug").notNull(),
    workflowName: text("workflow_name").notNull(),
    workflowDynastySlug: text("workflow_dynasty_slug").notNull(),
    workflowDynastyName: text("workflow_dynasty_name").notNull(),
    description: text("description"),
    featureSlug: text("feature_slug").notNull(),
    category: text("category"),
    channel: text("channel"),
    audienceType: text("audience_type"),
    signature: text("signature").notNull(),
    workflowDynastySignatureName: text("workflow_dynasty_signature_name").notNull(),
    version: integer("version").notNull().default(1),
    dag: jsonb("dag").notNull(),
    tags: jsonb("tags").default([]),
    status: text("status").notNull().default("active"),
    // Dynasty-level status, independent of the per-version `status` above. Marks
    // an entire lineage active/deprecated on demand (staff action). All rows
    // sharing a workflow_dynasty_slug carry the same value.
    workflowDynastyStatus: text("workflow_dynasty_status").notNull().default("active"),
    creationType: text("creation_type").notNull().default("scratch"),
    createdFromWorkflow: uuid("created_from_workflow"),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: text("created_by_run_id"),
    windmillFlowPath: text("windmill_flow_path"),
    windmillWorkspace: text("windmill_workspace").notNull().default("prod"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    executableUntil: timestamp("executable_until", { withTimezone: true }),
    executableUntilSource: text("executable_until_source"),
    // DEPRECATION-REASON-1020: why, who and when a deprecation was decided. NULL while executable;
    // rows deprecated before 2026-10-20 read 'Not specified' with no who/when.
    deprecationReason: text("deprecation_reason"),
    deprecatedBy: text("deprecated_by"),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_workflows_workflow_slug_unique").on(table.workflowSlug),
    index("idx_workflows_dynasty_slug").on(table.workflowDynastySlug),
    index("idx_workflows_feature_signature").on(table.featureSlug, table.workflowDynastySignatureName),
  ]
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").references(() => workflows.id),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    campaignId: text("campaign_id"),
    brandIds: text("brand_ids").array(),
    featureSlug: text("feature_slug"),
    workflowSlug: text("workflow_slug"),
    subrequestId: text("subrequest_id"),
    runId: text("run_id"),

    windmillJobId: text("windmill_job_id"),
    windmillWorkspace: text("windmill_workspace").notNull().default("prod"),
    status: text("status").notNull().default("queued"),
    executionScope: text("execution_scope"),
    executionKey: text("execution_key"),
    conflictPolicy: text("conflict_policy"),
    attributionContext: jsonb("attribution_context"),
    inputs: jsonb("inputs"),
    result: jsonb("result"),
    error: text("error"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }),
    dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_workflow_runs_workflow").on(table.workflowId),
    index("idx_workflow_runs_status").on(table.status),
    index("idx_workflow_runs_execution_key").on(table.executionKey),
    uniqueIndex("idx_workflow_runs_active_execution_key_unique")
      .on(table.executionKey)
      .where(sql`execution_key IS NOT NULL AND status IN ('dispatching', 'queued', 'running')`),
  ]
);

// TPL-DYNASTY-1021-WF: a dynasty merged into another one on the same pipe (src/lib/dynasty-merge.ts).
export const workflowDynastyMerges = pgTable(
  "workflow_dynasty_merges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    absorbedDynastySlug: text("absorbed_dynasty_slug").notNull(),
    survivorDynastySlug: text("survivor_dynasty_slug").notNull(),
    featureSlug: text("feature_slug").notNull(),
    legKeys: jsonb("leg_keys").notNull(),
    reason: text("reason").notNull(),
    decidedBy: text("decided_by"),
    mergedAt: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
    absorbedPriorState: jsonb("absorbed_prior_state").notNull(),
    unmergedAt: timestamp("unmerged_at", { withTimezone: true }),
    unmergedBy: text("unmerged_by"),
    unmergeReason: text("unmerge_reason"),
  },
  (table) => [
    uniqueIndex("idx_dynasty_merges_open_absorbed").on(table.absorbedDynastySlug).where(sql`unmerged_at IS NULL`),
    index("idx_dynasty_merges_survivor").on(table.survivorDynastySlug),
  ]
);

export type WorkflowDynastyMerge = typeof workflowDynastyMerges.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;

// WF-SHORT-LINE-1023: what sets each dynasty apart from its siblings on one pipe (src/lib/sibling-line-refresher.ts).
export const workflowSiblingLines = pgTable(
  "workflow_sibling_lines",
  {
    featureSlug: text("feature_slug").notNull(),
    legKey: text("leg_key").notNull(),
    workflowDynastySlug: text("workflow_dynasty_slug").notNull(),
    line: text("line").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.featureSlug, table.legKey, table.workflowDynastySlug] }),
    index("idx_sibling_lines_dynasty").on(table.workflowDynastySlug),
  ]
);

export const workflowSiblingLinePipes = pgTable(
  "workflow_sibling_line_pipes",
  {
    featureSlug: text("feature_slug").notNull(),
    legKey: text("leg_key").notNull(),
    siblingsKey: text("siblings_key").notNull(),
    state: text("state").notNull(),
    problem: text("problem"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.featureSlug, table.legKey] })]
);
