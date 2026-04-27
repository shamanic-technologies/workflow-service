import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
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
    styleName: text("style_name"),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    featureSlug: text("feature_slug").notNull(),
    category: text("category"),
    channel: text("channel"),
    audienceType: text("audience_type"),
    signature: text("signature").notNull(),
    signatureName: text("signature_name").notNull(),
    version: integer("version").notNull().default(1),
    dag: jsonb("dag").notNull(),
    tags: jsonb("tags").default([]),
    status: text("status").notNull().default("active"),
    upgradedTo: uuid("upgraded_to"),
    forkedFrom: uuid("forked_from"),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: text("created_by_run_id"),
    windmillFlowPath: text("windmill_flow_path"),
    windmillWorkspace: text("windmill_workspace").notNull().default("prod"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_workflows_slug_unique").on(table.slug),
    index("idx_workflows_feature_signature").on(table.featureSlug, table.signatureName),
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
    inputs: jsonb("inputs"),
    result: jsonb("result"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_workflow_runs_workflow").on(table.workflowId),
    index("idx_workflow_runs_status").on(table.status),
  ]
);

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
