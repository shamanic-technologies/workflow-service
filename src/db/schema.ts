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
  date,
  bigint,
  numeric,
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
    /** The leaf step a failed run failed at, and its error (failed-step.ts, migration 0047). */
    failedStep: text("failed_step"),
    failedReason: text("failed_reason"),
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

// FACTORY-P2-ENGINES: scripts as data (src/lib/scripts/*). Migration 0042.
export const scripts = pgTable(
  "scripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outcome: text("outcome").notNull(),
    dynasty: text("dynasty").notNull(),
    version: integer("version").notNull(),
    code: text("code").notNull(),
    materials: jsonb("materials").$type<string[]>().notNull().default([]),
    vendors: jsonb("vendors").$type<string[]>().notNull().default([]),
    tactics: jsonb("tactics").$type<Record<string, unknown>>().notNull().default({}),
    description: text("description").notNull(),
    status: text("status").notNull().default("active"),
    dynastyStatus: text("dynasty_status").notNull().default("active"),
    creationType: text("creation_type").notNull(),
    createdFromScript: uuid("created_from_script"),
    orgId: text("org_id").notNull(),
    createdBy: text("created_by").notNull(),
    replay: jsonb("replay").$type<{ cases: number; matches: number } | null>(),
    deprecationReason: text("deprecation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_scripts_version").on(table.outcome, table.dynasty, table.version),
    uniqueIndex("idx_scripts_active").on(table.outcome, table.dynasty).where(sql`status = 'active'`),
  ]
);
export type ScriptRow = typeof scripts.$inferSelect;

export const scriptCases = pgTable(
  "script_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outcome: text("outcome").notNull(),
    dynasty: text("dynasty").notNull(),
    caseId: text("case_id").notNull(),
    body: jsonb("body").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_script_cases_case").on(table.outcome, table.dynasty, table.caseId)]
);

export const scriptStorage = pgTable(
  "script_storage",
  {
    orgId: text("org_id").notNull(),
    outcome: text("outcome").notNull(),
    tableName: text("table_name").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.outcome, table.tableName, table.key] })]
);

export const scriptRuns = pgTable(
  "script_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scriptId: uuid("script_id").notNull(),
    orgId: text("org_id").notNull(),
    runId: text("run_id").notNull(),
    parentRunId: text("parent_run_id").notNull(),
    subject: jsonb("subject"),
    status: text("status").notNull(),
    result: jsonb("result"),
    error: text("error"),
    vendorCalls: jsonb("vendor_calls").notNull().default([]),
    declared: jsonb("declared"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("idx_script_runs_script").on(table.scriptId, table.createdAt)]
);

// FACTORY-P3: the daily Monitoring series per outcome x path (src/lib/scripts/script-monitoring.ts). Migration 0043.
export const scriptMonitoringDays = pgTable(
  "script_monitoring_days",
  {
    day: date("day", { mode: "string" }).notNull(),
    outcome: text("outcome").notNull(),
    path: text("path").notNull(),
    serviceName: text("service_name").notNull(),
    taskNames: jsonb("task_names").$type<string[]>().notNull(),
    totalRunCount: bigint("total_run_count", { mode: "number" }).notNull(),
    sampleSize: integer("sample_size").notNull(),
    completedCount: integer("completed_count").notNull(),
    failedCount: integer("failed_count").notNull(),
    avgCostCents: numeric("avg_cost_cents"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.day, table.outcome, table.path] })]
);

// FACTORY-P3 fleet writer switch: each workflow dynasty upgraded from content-generation's writer to a stored script,
// and the version a roll-back re-activates (src/lib/scripts/script-writer-switch.ts). Migration 0044.
export const scriptSwitches = pgTable(
  "script_switches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outcome: text("outcome").notNull(),
    dynasty: text("dynasty").notNull(),
    /** A workflow switch: the dynasty upgraded onto the script (null on a SERVICE switch). */
    workflowDynastySlug: text("workflow_dynasty_slug"),
    fromWorkflowId: uuid("from_workflow_id"),
    fromVersion: integer("from_version"),
    toWorkflowId: uuid("to_workflow_id"),
    toVersion: integer("to_version"),
    /** A SERVICE switch (migration 0045): the service that makes the outcome in its own code and now calls the script. */
    callerService: text("caller_service"),
    /** The script version a service switch was proven on. */
    scriptVersion: integer("script_version"),
    state: text("state").notNull().default("switched"),
    switchedAt: timestamp("switched_at", { withTimezone: true }).notNull().defaultNow(),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    rollbackReason: text("rollback_reason"),
  },
  (table) => [uniqueIndex("idx_script_switches_to").on(table.toWorkflowId), index("idx_script_switches_outcome").on(table.outcome, table.state)]
);
