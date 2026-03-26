import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// --- Security scheme ---
registry.registerComponent("securitySchemes", "apiKey", {
  type: "apiKey",
  in: "header",
  name: "x-api-key",
});

// --- DAG schemas ---

export const DAGNodeSchema = z
  .object({
    id: z.string().min(1).describe("Unique identifier for this node within the DAG. Used in edges and $ref input mappings."),
    type: z.string().min(1).describe(
      "Node type. Use \"http.call\" to call any microservice (recommended), or a specific node type. " +
      "http.call config requires: service (name, e.g. \"stripe\"), method (HTTP verb), path (endpoint path). " +
      "Native flow control types: " +
      "\"condition\" — if/then/else branching (uses Windmill branchone). " +
      "Outgoing edges with 'condition' define branches; nodes downstream of a conditional edge are nested inside that branch. " +
      "Outgoing edges without 'condition' define after-branch steps that always execute. " +
      "\"wait\" — sleep/delay. \"for-each\" — loop over items (body nodes are nested inside the loop). " +
      "Legacy named types: stripe.createProduct, client.createUser, transactional-email.send."
    ),
    config: z.record(z.unknown()).optional().describe(
      "Static parameters passed to the node. For http.call: { service, method, path, body?, query?, headers? }. " +
      "For wait: { seconds }. For for-each: { iterator, parallel?, skipFailures? }. " +
      "Each key becomes a direct parameter of the underlying script. " +
      "Special config keys (stripped before passing to script): " +
      "retries (number) — override default retry count; " +
      "validateResponse ({ field, equals }) — throw error if response[field] !== equals, triggers onError handler; " +
      "stopAfterIf (string) — native Windmill stop_after_if. JS expression evaluated after step completes using 'result' variable, " +
      "stops the entire flow gracefully (no onError, no subsequent steps) when true. Example: \"result.found == false\". " +
      "For conditional branching (run some steps but not others), use a \"condition\" node instead; " +
      "skipIf (string) — native Windmill skip_if. JS expression evaluated before this step runs, " +
      "skips only this step when true. Can reference previous results via results.<module_id>. " +
      "Example: \"results.fetch_lead.found == false\". For multi-step skipping, prefer a \"condition\" node."
    ),
    inputMapping: z.record(z.string()).optional().describe(
      "Dynamic input references using $ref syntax. " +
      "Use \"$ref:flow_input.fieldName\" for workflow execution inputs, " +
      "or \"$ref:node-id.output.fieldName\" for a previous node's output. " +
      "Keys in inputMapping override same-named keys in config."
    ),
    retries: z.number().int().min(0).optional().describe(
      "Number of retry attempts on failure. Defaults to 3 if omitted. " +
      "Set to 0 for non-idempotent operations (e.g., sending emails, consuming queue items) to prevent duplicates."
    ),
  })
  .openapi("DAGNode");

export const DAGEdgeSchema = z
  .object({
    from: z.string().min(1).describe("Source node ID — this node runs first."),
    to: z.string().min(1).describe("Target node ID — runs after the source completes."),
    condition: z.string().optional().describe(
      "JavaScript expression for conditional branching. Only used when source node is type \"condition\". " +
      "Edges WITH condition: target node (and its chain) are nested inside that branch — they only execute when the condition is true. " +
      "Edges WITHOUT condition from a condition node: target is an after-branch step that always executes. " +
      "Expressions can reference previous results (results.<module_id>.<field>) or flow_input. " +
      "Example: \"results.fetch_lead.found == true\""
    ),
  })
  .openapi("DAGEdge");

export const DAGSchema = z
  .object({
    nodes: z.array(DAGNodeSchema).min(1).describe("The steps of the workflow. Must contain at least one node."),
    edges: z.array(DAGEdgeSchema).describe("Execution order between nodes. Empty array for single-node workflows."),
    onError: z.string().optional().describe(
      "Node ID of an error handler that runs when any node in the DAG fails (including validateResponse failures). " +
      "Auto-injected parameters (available as script params, no inputMapping needed): " +
      "failedNodeId (string) — the module ID of the step that failed; " +
      "errorMessage (string) — the error message text. " +
      "Can also access outputs from previously completed nodes via $ref syntax. " +
      "Use this to call end-run with success: false. " +
      "Tip: check errorMessage to distinguish expected stops (e.g. 'validation failed: expected found=true') from real errors."
    ),
  })
  .openapi("DAG");

// --- Workflow enums ---

export const WorkflowCategorySchema = z
  .enum(["sales", "pr", "outlets", "journalists"])
  .describe("Workflow category.")
  .openapi("WorkflowCategory");

export const WorkflowChannelSchema = z
  .enum(["email", "database"])
  .describe("Workflow distribution channel.")
  .openapi("WorkflowChannel");

export const WorkflowAudienceTypeSchema = z
  .enum(["cold-outreach", "discovery"])
  .describe("Workflow audience type.")
  .openapi("WorkflowAudienceType");

// --- Workflow schemas ---

export const CreateWorkflowSchema = z
  .object({
    createdForBrandId: z.string().optional().describe("Optional brand ID — records which brand context created this workflow."),
    campaignId: z.string().optional().describe("Optional campaign ID for scoping."),
    subrequestId: z.string().optional().describe("Optional subrequest ID for cost tracking."),
    name: z.string().min(1).describe("Workflow name. Must be unique within the orgId. Used to execute by name later."),
    description: z.string().optional().describe("Human-readable description of what this workflow does."),
    featureSlug: z.string().min(1).describe("Feature slug from features-service. Required — used to build the workflow name and for feature-level grouping."),
    category: WorkflowCategorySchema.optional().describe("Optional workflow category tag."),
    channel: WorkflowChannelSchema.optional().describe("Optional workflow channel tag."),
    audienceType: WorkflowAudienceTypeSchema.optional().describe("Optional workflow audience type tag."),
    tags: z.array(z.string()).optional().describe(
      "Free-form tags for filtering/grouping (e.g. channels used in the DAG: [\"email\", \"linkedin\"])."
    ),
    dag: DAGSchema,
  })
  .openapi("CreateWorkflowRequest");

export const UpdateWorkflowSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional().describe("Updated tags for filtering/grouping."),
    dag: DAGSchema.optional(),
  })
  .openapi("UpdateWorkflowRequest");

export const WorkflowResponseSchema = z
  .object({
    id: z.string().uuid().describe("Workflow UUID."),
    orgId: z.string().describe("Organization ID."),
    featureSlug: z.string().describe("Feature slug from features-service. Used for naming and feature-level grouping."),
    createdForBrandId: z.string().nullable(),
    humanId: z.string().nullable().describe("Human ID if this workflow was generated in a human expert's style."),
    campaignId: z.string().nullable(),
    subrequestId: z.string().nullable(),
    styleName: z.string().nullable().describe("Base style name used for versioned naming (e.g. 'hormozi'). Null for non-styled workflows."),
    name: z.string().describe("Workflow name. Use this with orgId to execute via /workflows/by-name/{name}/execute."),
    displayName: z.string().nullable().describe("Human-readable display name. Falls back to name if not set."),
    description: z.string().nullable(),
    category: WorkflowCategorySchema.nullable().describe("Optional workflow category tag."),
    channel: WorkflowChannelSchema.nullable().describe("Optional workflow channel tag."),
    audienceType: WorkflowAudienceTypeSchema.nullable().describe("Optional workflow audience type tag."),
    tags: z.array(z.string()).describe("Free-form tags for filtering/grouping (e.g. [\"email\", \"linkedin\"])."),
    signature: z.string().describe("Deterministic SHA-256 hash of the canonical DAG JSON. Changes when any node, edge, or config changes."),
    signatureName: z.string().describe("Human-readable name for this signature (e.g. 'Sequoia'). Used to distinguish workflow variants within the same feature."),
    dag: z.unknown().describe("The DAG definition as submitted."),
    status: z.enum(["active", "deprecated"]).describe("Workflow lifecycle status. Only active workflows can be executed."),
    upgradedTo: z.string().uuid().nullable().describe("If deprecated, the ID of the replacement workflow."),
    forkedFrom: z.string().uuid().nullable().describe("If this workflow was forked from another, the ID of the original workflow."),
    createdByUserId: z.string().nullable().describe("User ID that created this workflow."),
    createdByRunId: z.string().nullable().describe("Run ID that created this workflow."),
    windmillFlowPath: z.string().nullable().describe("Internal Windmill flow path (managed automatically)."),
    windmillWorkspace: z.string().describe("Windmill workspace (managed automatically)."),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("WorkflowResponse");

export const TemplateContractIssueSchema = z
  .object({
    nodeId: z.string().describe("DAG node ID that calls content-generation."),
    templateType: z.string().describe("Prompt template type (e.g. 'cold-email')."),
    field: z.string().describe("Variable name or template type."),
    severity: z.enum(["error", "warning"]).describe("'error' = missing required variable, 'warning' = extra/unknown variable."),
    reason: z.string().describe("Human-readable explanation of the issue."),
  })
  .openapi("TemplateContractIssue");

export const TemplateRefSchema = z
  .object({
    nodeId: z.string().describe("DAG node ID."),
    templateType: z.string().describe("Prompt template type used by this node."),
    variablesProvided: z.array(z.string()).describe("Variable names the workflow provides to this node."),
  })
  .openapi("TemplateRef");

export const ValidationResultSchema = z
  .object({
    valid: z.boolean(),
    errors: z
      .array(z.object({ field: z.string(), message: z.string() }))
      .optional(),
    templateContract: z
      .object({
        valid: z.boolean(),
        templateRefs: z.array(TemplateRefSchema).describe("Content-generation template references found in the DAG."),
        issues: z.array(TemplateContractIssueSchema).describe("Variable mismatches between workflow and prompt templates."),
      })
      .optional()
      .describe("Template contract validation result. Present when content-generation service is reachable."),
  })
  .openapi("ValidationResult");

// --- Workflow Run schemas ---

export const ExecuteWorkflowSchema = z
  .object({
    inputs: z.record(z.unknown()).optional().describe(
      "Runtime inputs for the workflow. Accessible in nodes via $ref:flow_input.fieldName."
    ),
  })
  .openapi("ExecuteWorkflowRequest");

export const WorkflowRunResponseSchema = z
  .object({
    id: z.string().uuid().describe("Run UUID. Use this to poll status via GET /workflow-runs/{id}."),
    workflowId: z.string().uuid().nullable(),
    orgId: z.string(),
    campaignId: z.string().nullable(),
    brandId: z.string().nullable(),
    featureSlug: z.string().nullable().describe("Feature slug from features-service. Used for per-feature analytics."),
    workflowName: z.string().nullable().describe("Name of the workflow that was executed."),
    subrequestId: z.string().nullable(),
    userId: z.string().nullable().describe("User ID from the execution context."),
    runId: z.string().nullable().describe("Runs-service run ID for this execution (auto-created)."),
    windmillJobId: z.string().nullable().describe("Internal Windmill job ID (managed automatically)."),
    windmillWorkspace: z.string(),
    status: z.string().describe("Run status: queued, running, completed, failed, or cancelled."),
    inputs: z.unknown().nullable().describe("The inputs that were passed at execution time."),
    result: z.unknown().nullable().describe("Workflow result (available when status is completed). Contains the output of the last node."),
    error: z.string().nullable().describe("Error message (available when status is failed). Raw Windmill error — use errorSummary for a clean version."),
    errorSummary: z.object({
      failedStep: z.string().nullable().describe("Which workflow step failed (e.g. 'fetch_lead', 'send_email')."),
      message: z.string().describe("Clean error message with stack traces stripped."),
      rootCause: z.string().describe("Innermost root cause extracted from nested service error chains."),
    }).optional().describe("Parsed error summary (present only when status is 'failed'). Use rootCause for user-facing messages."),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("WorkflowRunResponse");

// --- Deploy schemas ---

export const DeployWorkflowItemSchema = z
  .object({
    createdForBrandId: z.string().optional().describe("Optional brand ID — records which brand context created this workflow."),
    featureSlug: z.string().min(1).describe("Feature slug from features-service. Required — used to build the workflow name."),
    description: z.string().optional().describe("Human-readable description."),
    category: WorkflowCategorySchema.optional().describe("Optional workflow category tag."),
    channel: WorkflowChannelSchema.optional().describe("Optional workflow channel tag."),
    audienceType: WorkflowAudienceTypeSchema.optional().describe("Optional workflow audience type tag."),
    tags: z.array(z.string()).optional().describe("Free-form tags for filtering/grouping (e.g. [\"email\", \"linkedin\"])."),
    dag: DAGSchema,
  })
  .openapi("DeployWorkflowItem");

export const DeployWorkflowsSchema = z
  .object({
    workflows: z.array(DeployWorkflowItemSchema).min(1).describe("The workflows to deploy."),
  })
  .openapi("DeployWorkflowsRequest");

export const DeployWorkflowResultSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().describe("Auto-generated workflow name: {featureSlug}-{signatureName}."),
    featureSlug: z.string().describe("Feature slug used to build the name."),
    tags: z.array(z.string()).describe("Tags assigned to this workflow."),
    signature: z.string().describe("SHA-256 hash of the canonical DAG JSON."),
    signatureName: z.string().describe("Human-readable name for this DAG variant (auto-generated by workflow-service)."),
    action: z.enum(["created", "updated"]),
  })
  .openapi("DeployWorkflowResult");

export const DeployWorkflowsResponseSchema = z
  .object({
    workflows: z.array(DeployWorkflowResultSchema),
  })
  .openapi("DeployWorkflowsResponse");

// --- Deprecated workflow response ---

export const WorkflowDeprecatedResponseSchema = z
  .object({
    error: z.literal("Workflow has been deprecated"),
    upgradedTo: z.string().uuid().nullable().describe(
      "ID of the replacement workflow. Null if no replacement was set."
    ),
    upgradedToName: z.string().nullable().optional().describe(
      "Name of the replacement workflow (for by-name lookups)."
    ),
  })
  .openapi("WorkflowDeprecatedResponse");

// --- Execute by name schema ---

export const ExecuteByNameSchema = z
  .object({
    inputs: z.record(z.unknown()).optional().describe(
      "Runtime inputs for the workflow. Accessible in nodes via $ref:flow_input.fieldName."
    ),
  })
  .openapi("ExecuteByNameRequest");

// --- Style schema ---

export const WorkflowStyleTypeSchema = z
  .enum(["human", "brand"])
  .describe('Style source type. "human" for an industry expert, "brand" for a company/organization.')
  .openapi("WorkflowStyleType");

export const WorkflowStyleSchema = z
  .object({
    type: WorkflowStyleTypeSchema,
    humanId: z.string().optional().describe(
      "Human ID from human-service. Required when type is 'human'."
    ),
    brandId: z.string().optional().describe(
      "Brand ID from brand-service. Required when type is 'brand'."
    ),
    name: z.string().min(1).describe(
      "Display name of the human or brand (e.g. 'Hormozi', 'My Brand'). " +
      "Used to build the signatureName (e.g. 'hormozi-v1')."
    ),
  })
  .refine(
    (data) => {
      if (data.type === "human") return !!data.humanId;
      if (data.type === "brand") return !!data.brandId;
      return true;
    },
    {
      message: "humanId is required when type is 'human'; brandId is required when type is 'brand'",
    }
  )
  .openapi("WorkflowStyle");

// --- Generate schemas ---

export const GenerateWorkflowHintsSchema = z
  .object({
    services: z.array(z.string()).optional().describe(
      "Scope generation to these services. Reduces prompt size and improves accuracy."
    ),
    nodeTypes: z.array(z.string()).optional().describe(
      "Suggest specific node types for the LLM to use."
    ),
    expectedInputs: z.array(z.string()).optional().describe(
      "Expected flow_input field names (e.g. campaignId, email)."
    ),
  })
  .openapi("GenerateWorkflowHints");

export const GenerateWorkflowSchema = z
  .object({
    description: z.string().min(10).describe(
      "Natural language description of the desired workflow. Be specific about the steps, services, and data flow."
    ),
    featureSlug: z.string().min(1).describe(
      "Feature slug from features-service. Required — used to build the workflow name."
    ),
    hints: GenerateWorkflowHintsSchema.optional().describe(
      "Optional hints to guide generation."
    ),
    style: WorkflowStyleSchema.optional().describe(
      "Optional style configuration. When provided, the workflow is generated in the style of the specified human or brand, " +
      "and the signatureName uses the style name with auto-versioning (e.g. 'hormozi-v1')."
    ),
  })
  .openapi("GenerateWorkflowRequest");

export const GenerateWorkflowResponseSchema = z
  .object({
    workflow: DeployWorkflowResultSchema.describe(
      "The deployed workflow metadata."
    ),
    dag: DAGSchema.describe("The generated DAG definition."),
    generatedDescription: z.string().describe(
      "LLM-generated description of what this workflow does."
    ),
  })
  .openapi("GenerateWorkflowResponse");

// --- Shared stats schemas ---

export const EmailStatsSchema = z
  .object({
    sent: z.number().describe("Total emails sent."),
    delivered: z.number().describe("Total emails delivered."),
    opened: z.number().describe("Total emails opened."),
    clicked: z.number().describe("Total link clicks."),
    replied: z.number().describe("Total replies received."),
    bounced: z.number().describe("Total emails bounced."),
    unsubscribed: z.number().describe("Total unsubscribes."),
    recipients: z.number().describe("Total unique recipients."),
  })
  .openapi("EmailStats");

export const WorkflowStatsSchema = z
  .object({
    totalCostInUsdCents: z.number().describe("Total cost across all completed runs of this workflow."),
    totalOutcomes: z.number().describe("Total replies or clicks (depending on objective) across all runs."),
    costPerOutcome: z.number().nullable().describe("Cost per reply or cost per click in USD cents. Null if no outcomes yet."),
    completedRuns: z.number().describe("Number of completed runs used in the calculation."),
    email: z.object({
      transactional: EmailStatsSchema.describe("Aggregated transactional email stats across all runs."),
      broadcast: EmailStatsSchema.describe("Aggregated broadcast email stats across all runs."),
    }).describe("Detailed email engagement stats aggregated across the upgrade chain."),
  })
  .openapi("WorkflowStats");

export const WorkflowMetadataSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    displayName: z.string().nullable(),
    createdForBrandId: z.string().nullable(),
    featureSlug: z.string().describe("Feature slug for grouping and naming."),
    signature: z.string(),
    signatureName: z.string(),
  })
  .openapi("WorkflowMetadata");

// --- Ranked Workflow schemas ---

export const RankedWorkflowObjectiveSchema = z
  .enum(["replies", "clicks"])
  .describe(
    'Optimization objective. "replies" sorts by lowest cost per reply; "clicks" sorts by lowest cost per click.'
  )
  .openapi("RankedWorkflowObjective");

export const RankedWorkflowGroupBySchema = z
  .enum(["feature", "brand"])
  .describe(
    'Group results by feature (featureSlug) or brand (brandId). ' +
    'Each group includes aggregated stats and its workflows ranked within. ' +
    'When groupBy=brand, workflows without a brandId are excluded.'
  )
  .openapi("RankedWorkflowGroupBy");

export const RankedWorkflowQuerySchema = z
  .object({
    orgId: z.string().optional().describe("Organization ID. When omitted, searches across all orgs."),
    brandId: z.string().optional().describe("Filter workflows by brand ID."),
    featureSlug: z.string().optional().describe("Filter workflows by feature slug."),
    objective: RankedWorkflowObjectiveSchema.default("replies").describe("Which metric to optimize for. Defaults to 'replies'."),
    limit: z.coerce.number().int().min(1).max(100).default(10).describe("Max workflows per group (when groupBy is set) or total (when flat). Defaults to 10."),
    groupBy: RankedWorkflowGroupBySchema.optional().describe("Group results by section or brand. When omitted, returns a flat ranked list."),
  })
  .openapi("RankedWorkflowQuery");

export const RankedWorkflowItemSchema = z
  .object({
    workflow: WorkflowMetadataSchema.describe("Workflow metadata."),
    dag: DAGSchema.describe("The DAG definition of the workflow."),
    stats: WorkflowStatsSchema.describe("Aggregated performance stats for this workflow."),
  })
  .openapi("RankedWorkflowItem");

export const RankedFeatureGroupSchema = z
  .object({
    featureSlug: z.string().describe("Feature slug used as the grouping key."),
    stats: WorkflowStatsSchema.describe("Aggregated stats across all workflows in this feature."),
    workflows: z.array(RankedWorkflowItemSchema).describe("Workflows in this feature, ranked by performance."),
  })
  .openapi("RankedFeatureGroup");

export const RankedWorkflowResponseSchema = z
  .object({
    results: z.array(RankedWorkflowItemSchema).describe("Workflows ranked by performance, best first."),
  })
  .openapi("RankedWorkflowResponse");

export const RankedBrandGroupSchema = z
  .object({
    brandId: z.string().describe("Brand ID."),
    stats: WorkflowStatsSchema.describe("Aggregated stats across all workflows for this brand."),
    workflows: z.array(RankedWorkflowItemSchema).describe("Workflows for this brand, ranked by performance."),
  })
  .openapi("RankedBrandGroup");

export const RankedWorkflowGroupedResponseSchema = z
  .object({
    features: z.array(RankedFeatureGroupSchema).optional().describe("Workflow groups by feature slug."),
    brands: z.array(RankedBrandGroupSchema).optional().describe("Workflow groups by brand ID."),
  })
  .openapi("RankedWorkflowGroupedResponse");

// --- Public (no-auth) variants — same structure but without DAG ---

export const PublicRankedWorkflowItemSchema = z
  .object({
    workflow: WorkflowMetadataSchema.describe("Workflow metadata."),
    stats: WorkflowStatsSchema.describe("Aggregated performance stats for this workflow."),
  })
  .openapi("PublicRankedWorkflowItem");

export const PublicRankedFeatureGroupSchema = z
  .object({
    featureSlug: z.string().describe("Feature slug used as the grouping key."),
    stats: WorkflowStatsSchema.describe("Aggregated stats across all workflows in this feature."),
    workflows: z.array(PublicRankedWorkflowItemSchema).describe("Workflows in this feature, ranked by performance."),
  })
  .openapi("PublicRankedFeatureGroup");

export const PublicRankedWorkflowResponseSchema = z
  .object({
    results: z.array(PublicRankedWorkflowItemSchema).describe("Workflows ranked by performance, best first."),
  })
  .openapi("PublicRankedWorkflowResponse");

export const PublicRankedBrandGroupSchema = z
  .object({
    brandId: z.string().describe("Brand ID."),
    stats: WorkflowStatsSchema.describe("Aggregated stats across all workflows for this brand."),
    workflows: z.array(PublicRankedWorkflowItemSchema).describe("Workflows for this brand, ranked by performance."),
  })
  .openapi("PublicRankedBrandGroup");

// --- Best Workflow schemas (hero records) ---

export const BestWorkflowBySchema = z
  .enum(["workflow", "brand"])
  .describe(
    'Granularity for best records. "workflow" (default) finds the best individual workflow. ' +
    '"brand" aggregates all workflows per brand and finds the best brand.'
  )
  .openapi("BestWorkflowBy");

export const BestWorkflowQuerySchema = z
  .object({
    orgId: z.string().optional().describe("Organization ID. When omitted, searches across all orgs."),
    brandId: z.string().optional().describe("Filter workflows by brand ID."),
    by: BestWorkflowBySchema.default("workflow").describe("Granularity: best workflow or best brand. Defaults to 'workflow'."),
  })
  .openapi("BestWorkflowQuery");

export const BestWorkflowRecordSchema = z
  .object({
    workflowId: z.string().uuid().describe("ID of the workflow holding the record."),
    workflowName: z.string().describe("Name of the workflow."),
    displayName: z.string().nullable().describe("Stable display name of the workflow family."),
    createdForBrandId: z.string().nullable().describe("Brand ID that created this workflow (creation context, not execution brand)."),
    value: z.number().describe("The record value in USD cents."),
  })
  .openapi("BestWorkflowRecord");

export const BestBrandRecordSchema = z
  .object({
    brandId: z.string().describe("Brand ID holding the record."),
    workflowCount: z.number().int().describe("Number of workflows aggregated for this brand."),
    value: z.number().describe("The record value in USD cents."),
  })
  .openapi("BestBrandRecord");

export const BestWorkflowResponseSchema = z
  .object({
    bestCostPerOpen: BestWorkflowRecordSchema.nullable().describe("Workflow with the lowest cost per email open. Null if no data."),
    bestCostPerReply: BestWorkflowRecordSchema.nullable().describe("Workflow with the lowest cost per reply. Null if no data."),
  })
  .openapi("BestWorkflowResponse");

export const BestBrandResponseSchema = z
  .object({
    bestCostPerOpen: BestBrandRecordSchema.nullable().describe("Brand with the lowest cost per email open. Null if no data."),
    bestCostPerReply: BestBrandRecordSchema.nullable().describe("Brand with the lowest cost per reply. Null if no data."),
  })
  .openapi("BestBrandResponse");

// --- Provider Requirements schemas ---

export const ServiceEndpointSchema = z
  .object({
    service: z.string().describe("Service name (e.g. 'apollo', 'stripe')."),
    method: z.string().describe("HTTP method (e.g. 'POST', 'GET')."),
    path: z.string().describe("Endpoint path (e.g. '/leads/search')."),
  })
  .openapi("ServiceEndpoint");

export const ProviderInfoSchema = z
  .object({
    name: z.string().describe("Provider name (e.g. 'anthropic', 'apollo')."),
    domain: z.string().nullable().describe(
      "Provider's primary domain for logo lookup (e.g. 'anthropic.com'). Null if unknown."
    ),
  })
  .openapi("ProviderInfo");

export const ProviderRequirementsResponseSchema = z
  .object({
    endpoints: z.array(ServiceEndpointSchema).describe(
      "The http.call endpoints extracted from the workflow DAG."
    ),
    requirements: z.array(z.unknown()).describe(
      "Provider requirements returned by key-service."
    ),
    providers: z.array(ProviderInfoSchema).describe(
      "Providers required by this workflow, with domain info for logo lookup."
    ),
  })
  .openapi("ProviderRequirementsResponse");

// --- Workflow conflict response (409 on PUT /workflows/:id) ---

export const WorkflowConflictResponseSchema = z
  .object({
    error: z.string(),
    existingWorkflowId: z.string().uuid().describe("ID of the existing workflow that already has this DAG signature."),
    existingWorkflowName: z.string().describe("Name of the existing workflow that already has this DAG signature."),
  })
  .openapi("WorkflowConflictResponse");

// --- Migrate feature slug (internal) ---

export const MigrateFeatureSlugSchema = z
  .object({
    oldSlug: z.string().min(1).describe("The deprecated feature slug to migrate away from."),
    newSlug: z.string().min(1).describe("The new active feature slug to migrate to."),
  })
  .openapi("MigrateFeatureSlugRequest");

export const MigrateFeatureSlugResponseSchema = z
  .object({
    migrated: z.number().describe("Number of active workflows whose featureSlug was updated."),
    workflows: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        oldFeatureSlug: z.string(),
        newFeatureSlug: z.string(),
      })
    ).describe("List of workflows that were migrated."),
  })
  .openapi("MigrateFeatureSlugResponse");

// --- Common ---

export const ErrorResponseSchema = z
  .object({
    error: z.string(),
    details: z.unknown().optional(),
  })
  .openapi("ErrorResponse");

export const HealthResponseSchema = z
  .object({
    status: z.string(),
    service: z.string(),
    windmill: z.string().optional(),
    db: z.string().optional(),
  })
  .openapi("HealthResponse");

// --- Identity header parameters (required on all endpoints except /health and /openapi.json) ---

const IdentityHeaders = z.object({
  "x-org-id": z.string().describe("Internal org UUID (from client-service). Required."),
  "x-user-id": z.string().describe("Internal user UUID (from client-service). Required."),
  "x-run-id": z.string().describe("Run ID for tracing across services. Required."),
  "x-campaign-id": z.string().optional().describe("Campaign ID for tracking. Optional — auto-injected by workflow-service on all downstream calls."),
  "x-brand-id": z.string().optional().describe("Brand ID for tracking. Optional — auto-injected by workflow-service on all downstream calls."),
  "x-workflow-name": z.string().optional().describe("Workflow name for tracking. Optional — auto-injected by workflow-service on all downstream calls."),
  "x-feature-slug": z.string().optional().describe("Feature slug from features-service. Optional — propagated by campaign-service for per-feature stats."),
});

// --- Register Paths ---

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  tags: ["Health"],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflows",
  summary: "Create a new workflow",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    body: {
      required: true,
      content: { "application/json": { schema: CreateWorkflowSchema } },
    },
  },
  responses: {
    201: {
      description: "Workflow created",
      content: { "application/json": { schema: WorkflowResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflows",
  summary: "List workflows",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    query: z.object({
      orgId: z.string().optional(),
      brandId: z.string().optional(),
      humanId: z.string().optional(),
      campaignId: z.string().optional(),
      featureSlug: z.string().optional().describe("Filter workflows by feature slug."),
      category: WorkflowCategorySchema.optional(),
      channel: WorkflowChannelSchema.optional(),
      audienceType: WorkflowAudienceTypeSchema.optional(),
      tag: z.string().optional().describe("Filter workflows that contain this tag."),
      status: z.string().optional().describe("Filter by status. Defaults to 'active'. Use 'all' to include deprecated workflows."),
    }),
  },
  responses: {
    200: {
      description: "List of workflows",
      content: {
        "application/json": {
          schema: z.object({ workflows: z.array(WorkflowResponseSchema) }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflows/{id}",
  summary: "Get a workflow",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Workflow found",
      content: { "application/json": { schema: WorkflowResponseSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflows/{id}/required-providers",
  summary: "Get required BYOK providers for a workflow",
  description:
    "Analyzes the workflow DAG to extract all http.call endpoints, " +
    "then queries key-service to determine which external providers " +
    "(and their API keys) are needed to execute the workflow.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Provider requirements",
      content: {
        "application/json": { schema: ProviderRequirementsResponseSchema },
      },
    },
    404: {
      description: "Workflow not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Key service unavailable or returned an error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/workflows/{id}",
  summary: "Fork a workflow with modifications",
  description:
    "Creates a new workflow based on an existing one with a modified DAG. " +
    "The original workflow remains active and unchanged. " +
    "If only metadata (name, description, tags) is changed without a new DAG, the update is applied in-place. " +
    "Returns the new forked workflow with a new name and signature.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: {
      required: true,
      content: { "application/json": { schema: UpdateWorkflowSchema } },
    },
  },
  responses: {
    201: {
      description: "Workflow forked (new workflow created with modified DAG)",
      content: { "application/json": { schema: WorkflowResponseSchema } },
    },
    200: {
      description: "Workflow updated in-place (metadata only, no DAG change)",
      content: { "application/json": { schema: WorkflowResponseSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "A workflow with this DAG signature already exists",
      content: { "application/json": { schema: WorkflowConflictResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/workflows/{id}",
  summary: "Delete a workflow",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Workflow deleted",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflows/{id}/validate",
  summary: "Validate a workflow DAG",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Validation result",
      content: { "application/json": { schema: ValidationResultSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflows/{id}/execute",
  summary: "Execute a workflow",
  tags: ["Workflow Runs"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: {
      required: false,
      content: { "application/json": { schema: ExecuteWorkflowSchema } },
    },
  },
  responses: {
    201: {
      description: "Execution started",
      content: {
        "application/json": { schema: WorkflowRunResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflow-runs/{id}",
  summary: "Get a workflow run",
  description: "Returns the current status and result of a workflow execution. If still running, polls the engine for the latest status before responding.",
  tags: ["Workflow Runs"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Workflow run",
      content: {
        "application/json": { schema: WorkflowRunResponseSchema },
      },
    },
  },
});

export const WorkflowRunDebugResponseSchema = z
  .object({
    runId: z.string().uuid(),
    windmillJobId: z.string(),
    status: z.string(),
    flowStatus: z.unknown().nullable().describe(
      "Windmill flow_status object. Contains per-module execution details including " +
      "resolved inputs, outputs, and timing for each step in the flow."
    ),
    result: z.unknown().nullable().describe("Final flow result."),
  })
  .openapi("WorkflowRunDebugResponse");

registry.registerPath({
  method: "get",
  path: "/workflow-runs/{id}/debug",
  summary: "Debug a workflow run",
  description:
    "Returns per-step execution details from the Windmill engine, including " +
    "resolved inputs and outputs for each module. Use this to diagnose " +
    "runtime issues that aren't visible in the final result.",
  tags: ["Workflow Runs"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Debug details",
      content: {
        "application/json": { schema: WorkflowRunDebugResponseSchema },
      },
    },
    404: {
      description: "Run not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflow-runs",
  summary: "List workflow runs",
  tags: ["Workflow Runs"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    query: z.object({
      workflowId: z.string().uuid().optional(),
      orgId: z.string().optional(),
      campaignId: z.string().optional(),
      featureSlug: z.string().optional().describe("Filter runs by feature slug."),
      status: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "List of runs",
      content: {
        "application/json": {
          schema: z.object({
            workflowRuns: z.array(WorkflowRunResponseSchema),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflow-runs/{id}/cancel",
  summary: "Cancel a workflow run",
  tags: ["Workflow Runs"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Run cancelled",
      content: {
        "application/json": { schema: WorkflowRunResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/workflows/upgrade",
  summary: "Upgrade (upsert) workflows by DAG signature",
  description:
    "Idempotent: creates new workflows or updates existing ones matched by (orgId + DAG signature). " +
    "The workflow name is auto-generated as {featureSlug}-{signatureName}. " +
    "signatureName is a human-readable word auto-assigned to each unique DAG. " +
    "After deploying, execute workflows via POST /workflows/by-name/{name}/execute.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    body: {
      required: true,
      content: { "application/json": { schema: DeployWorkflowsSchema } },
    },
  },
  responses: {
    200: {
      description: "Workflows deployed",
      content: {
        "application/json": { schema: DeployWorkflowsResponseSchema },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflows/generate",
  summary: "Generate a workflow from natural language",
  description:
    "Uses an LLM (Claude) to transform a natural language description into a valid DAG workflow. " +
    "Validates the generated DAG and deploys it automatically. " +
    "Returns the deployed workflow metadata along with the generated DAG.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    body: {
      required: true,
      content: { "application/json": { schema: GenerateWorkflowSchema } },
    },
  },
  responses: {
    200: {
      description: "Workflow generated and deployed",
      content: { "application/json": { schema: GenerateWorkflowResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    422: {
      description: "LLM generated an invalid DAG that could not be fixed after retries",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflows/ranked",
  summary: "Get workflows ranked by cost-per-outcome",
  description:
    "Returns workflows ranked by lowest cost-per-reply or cost-per-click for the given dimensions. " +
    "Stats are aggregated across the full upgrade chain (deprecated predecessors included). " +
    "Use `groupBy=section` to group by category-channel-audienceType, or `groupBy=brand` to group by brandId. " +
    "When groupBy=brand, workflows without a brandId are excluded. " +
    "Workflows with no completed runs are included with zeroed stats.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    query: RankedWorkflowQuerySchema,
  },
  responses: {
    200: {
      description: "Ranked workflows (flat list or grouped by section/brand)",
      content: {
        "application/json": { schema: RankedWorkflowResponseSchema },
      },
    },
    400: {
      description: "Missing or invalid query parameters",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "External service (runs-service or email-gateway-service) unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflows/best",
  summary: "Get hero records — best cost-per-open and best cost-per-reply",
  description:
    "Returns the single best workflow (or brand) for cost-per-open and cost-per-reply across all active workflows. " +
    "Stats are aggregated across the full upgrade chain. " +
    "Use `by=brand` to find the best brand instead of the best individual workflow. " +
    "Use this for leaderboard hero/headline stats.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    query: BestWorkflowQuerySchema,
  },
  responses: {
    200: {
      description: "Hero records found",
      content: {
        "application/json": { schema: BestWorkflowResponseSchema },
      },
    },
    502: {
      description: "External service unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Public endpoints (no auth, no identity headers) ---

registry.registerPath({
  method: "get",
  path: "/public/workflows/ranked",
  summary: "Public: Get workflows ranked by cost-per-outcome",
  description:
    "Public version of GET /workflows/ranked. No authentication required. " +
    "Returns workflows ranked by performance with stats, but without DAG details. " +
    "Stats are aggregated across the full upgrade chain. " +
    "Use `groupBy=section` to group by category-channel-audienceType, or `groupBy=brand` to group by brandId. " +
    "Use `brandId` to filter by a specific brand.",
  tags: ["Public"],
  request: {
    query: RankedWorkflowQuerySchema,
  },
  responses: {
    200: {
      description: "Ranked workflows (flat list or grouped by section)",
      content: {
        "application/json": { schema: PublicRankedWorkflowResponseSchema },
      },
    },
    400: {
      description: "Missing or invalid query parameters",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "External service unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/public/workflows/best",
  summary: "Public: Get hero records — best cost-per-open and best cost-per-reply",
  description:
    "Public version of GET /workflows/best. No authentication required. " +
    "Returns the single best workflow for cost-per-open and cost-per-reply across all active workflows. " +
    "Stats are aggregated across the full upgrade chain. " +
    "Use `by=brand` to find the best brand instead of the best workflow. " +
    "Use `brandId` to filter by a specific brand.",
  tags: ["Public"],
  request: {
    query: BestWorkflowQuerySchema,
  },
  responses: {
    200: {
      description: "Hero records found",
      content: {
        "application/json": { schema: BestWorkflowResponseSchema },
      },
    },
    502: {
      description: "External service unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflows/by-name/{name}/execute",
  summary: "Execute a workflow by name",
  description:
    "Starts an async execution of a previously deployed workflow. " +
    "Returns a run object with an ID — poll GET /workflow-runs/{id} for status (queued → running → completed/failed). " +
    "Pass runtime data via inputs (accessible in nodes as $ref:flow_input.fieldName).",
  tags: ["Workflow Runs"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ name: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: ExecuteByNameSchema } },
    },
  },
  responses: {
    201: {
      description: "Execution started",
      content: {
        "application/json": { schema: WorkflowRunResponseSchema },
      },
    },
    404: {
      description: "Workflow not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/migrate-feature-slug",
  summary: "Migrate workflows from one feature slug to another",
  description:
    "Called by features-service when a feature is upgraded (metadata-only change that deprecates the old slug). " +
    "Updates featureSlug on all active workflows matching oldSlug → newSlug. " +
    "Workflow names are unchanged (execution by name is unaffected). " +
    "Idempotent: re-calling with the same slugs is a no-op if already migrated.",
  tags: ["Internal"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    body: {
      required: true,
      content: { "application/json": { schema: MigrateFeatureSlugSchema } },
    },
  },
  responses: {
    200: {
      description: "Migration complete",
      content: {
        "application/json": { schema: MigrateFeatureSlugResponseSchema },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/openapi.json",
  summary: "OpenAPI specification",
  tags: ["Health"],
  responses: {
    200: {
      description: "OpenAPI spec",
      content: { "application/json": { schema: z.unknown() } },
    },
  },
});
