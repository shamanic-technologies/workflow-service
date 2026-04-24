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
  .openapi("DAGNode", {
    example: {
      id: "fetch-lead",
      type: "http.call",
      config: {
        service: "lead",
        method: "POST",
        path: "/buffer/next",
        body: { sourceType: "journalist" },
      },
      inputMapping: {
        "body.brandId": "$ref:start-run.output.brandId",
        "body.campaignId": "$ref:flow_input.campaignId",
      },
      retries: 0,
    },
  });

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
  .openapi("DAGEdge", {
    example: {
      from: "check-lead",
      to: "brand-profile",
      condition: "results['fetch-lead'].found == true",
    },
  });

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
  .openapi("DAG", {
    example: {
      nodes: [
        { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/buffer/next" }, inputMapping: { "body.campaignId": "$ref:flow_input.campaignId" } },
        { id: "check-lead", type: "condition" },
        { id: "send-email", type: "http.call", config: { service: "email-gateway", method: "POST", path: "/send" }, inputMapping: { "body.to": "$ref:fetch-lead.output.lead.email" }, retries: 0 },
        { id: "end-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: false } } },
        { id: "end-run-no-lead", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: true } } },
        { id: "end-run-error", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: false, stopCampaign: false } } },
      ],
      edges: [
        { from: "fetch-lead", to: "check-lead" },
        { from: "check-lead", to: "send-email", condition: "results['fetch-lead'].found == true" },
        { from: "check-lead", to: "end-run-no-lead", condition: "results['fetch-lead'].found == false" },
        { from: "send-email", to: "end-run" },
      ],
      onError: "end-run-error",
    },
  });

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
    description: z.string().optional().describe("Human-readable description of what this workflow does."),
    featureSlug: z.string().min(1).describe("Feature slug from features-service. Required — used to build the workflow slug/name and for feature-level grouping."),
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
    description: z.string().optional().describe("Updated description."),
    tags: z.array(z.string()).optional().describe("Updated tags for filtering/grouping."),
    dag: DAGSchema.optional().describe(
      "Optional new DAG. When omitted, only metadata (description, tags) is updated in-place. " +
      "When provided with the same structural signature, the DAG is updated in-place. " +
      "When provided with a different structural signature, a new workflow is created (fork) " +
      "and the original is kept active (unless its dynasty has zero campaign runs, in which case it is deprecated)."
    ),
  })
  .openapi("UpdateWorkflowRequest", {
    example: {
      description: "Updated workflow description",
      tags: ["email", "outreach"],
      dag: {
        nodes: [
          { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/buffer/next" }, inputMapping: { "body.campaignId": "$ref:flow_input.campaignId" } },
          { id: "send-email", type: "http.call", config: { service: "email-gateway", method: "POST", path: "/send" }, inputMapping: { "body.to": "$ref:fetch-lead.output.lead.email" }, retries: 0 },
        ],
        edges: [
          { from: "fetch-lead", to: "send-email" },
        ],
      },
    },
  });

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
    slug: z.string().describe("Unique technical identifier. Use this to execute via /workflows/by-slug/{slug}/execute."),
    name: z.string().describe("Human-readable display name. Globally unique."),
    dynastyName: z.string().describe("Stable name for the lineage. Constant across all versions of a dynasty."),
    dynastySlug: z.string().describe("Stable slug for the lineage. Constant across all versions of a dynasty. Use this as key for dynasty-level lookups."),
    description: z.string().nullable(),
    category: WorkflowCategorySchema.nullable().describe("Optional workflow category tag."),
    channel: WorkflowChannelSchema.nullable().describe("Optional workflow channel tag."),
    audienceType: WorkflowAudienceTypeSchema.nullable().describe("Optional workflow audience type tag."),
    tags: z.array(z.string()).describe("Free-form tags for filtering/grouping (e.g. [\"email\", \"linkedin\"])."),
    signature: z.string().describe("Deterministic SHA-256 hash of the canonical DAG JSON. Changes when any node, edge, or config changes."),
    signatureName: z.string().describe("Poetic word for this dynasty (e.g. 'sequoia'). Set once at dynasty creation."),
    version: z.number().int().describe("Version number within the dynasty. Starts at 1."),
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

export const WorkflowMutationResponseSchema = WorkflowResponseSchema.extend({
  _action: z.enum(["updated", "forked"]).describe(
    "What happened: 'updated' means the existing workflow was modified in-place (metadata or same-signature DAG). " +
    "'forked' means a new workflow was created with a new dynasty because the DAG signature changed."
  ),
  _forkedFromName: z.string().optional().describe(
    "Present only when _action='forked'. The display name of the original workflow that was forked."
  ),
  _forkedFromId: z.string().uuid().optional().describe(
    "Present only when _action='forked'. The ID of the original workflow that was forked."
  ),
  _sourceDynastyDeprecated: z.boolean().optional().describe(
    "Present only when _action='forked'. True if the source dynasty was deprecated (had zero campaign runs). " +
    "False if the source dynasty was kept active."
  ),
}).openapi("WorkflowMutationResponse", {
  example: {
    id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    orgId: "b645207b-d8e9-40b0-9391-072b777cd9a9",
    createdForBrandId: null,
    humanId: null,
    campaignId: null,
    subrequestId: null,
    styleName: null,
    slug: "pr-cold-email-outreach-sequoia",
    name: "Pr Cold Email Outreach Sequoia",
    dynastyName: "Pr Cold Email Outreach Sequoia",
    dynastySlug: "pr-cold-email-outreach-sequoia",
    description: "Cold outreach sequence for PR campaigns",
    featureSlug: "pr-cold-email-outreach",
    category: "pr",
    channel: "email",
    audienceType: "cold-outreach",
    tags: ["email"],
    signature: "4c4239e8d9bec64c85a178cb12b6669d3a69b6e68bafc0cb45c1797377ce9a8a",
    signatureName: "sequoia",
    version: 1,
    dag: {
      nodes: [
        { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/buffer/next" }, inputMapping: { "body.campaignId": "$ref:flow_input.campaignId" } },
        { id: "check-lead", type: "condition" },
        { id: "send-email", type: "http.call", config: { service: "email-gateway", method: "POST", path: "/send" }, inputMapping: { "body.to": "$ref:fetch-lead.output.lead.email" }, retries: 0 },
      ],
      edges: [
        { from: "fetch-lead", to: "check-lead" },
        { from: "check-lead", to: "send-email", condition: "results['fetch-lead'].found == true" },
      ],
    },
    status: "active",
    upgradedTo: null,
    forkedFrom: "3f8db0d4-ec80-4d06-805d-13b7df8703f9",
    createdByUserId: "cfe148ed-e3d8-40a2-8920-f8c040a81934",
    createdByRunId: "48f459aa-3352-4a61-9bd7-72f0a4401f62",
    windmillFlowPath: "f/workflows/b645207b/pr_cold_email_outreach_sequoia",
    windmillWorkspace: "prod",
    createdAt: "2026-03-26T03:39:24.262Z",
    updatedAt: "2026-03-26T06:23:27.287Z",
    _action: "updated",
  } as z.infer<typeof WorkflowResponseSchema> & { _action: "updated" },
});

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
  .openapi("ExecuteWorkflowRequest", {
    example: {
      inputs: {
        orgId: "b645207b-d8e9-40b0-9391-072b777cd9a9",
        campaignId: "camp-123",
        prAngle: "AI-powered PR automation",
        newsHook: "Company raises Series A",
        currentDate: "2026-03-26",
      },
    },
  });

export const WorkflowRunResponseSchema = z
  .object({
    id: z.string().uuid().describe("Run UUID. Use this to poll status via GET /workflow-runs/{id}."),
    workflowId: z.string().uuid().nullable(),
    orgId: z.string(),
    campaignId: z.string().nullable(),
    brandIds: z.array(z.string()).nullable().describe("Brand IDs associated with this run. Multi-brand campaigns produce multiple IDs."),
    featureSlug: z.string().nullable().describe("Feature slug from features-service. Used for per-feature analytics."),
    workflowSlug: z.string().nullable().describe("Slug of the workflow that was executed. Use this to re-execute via /workflows/by-slug/{slug}/execute."),
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
  .openapi("DeployWorkflowsRequest", {
    example: {
      workflows: [
        {
          featureSlug: "pr-cold-email-outreach",
          description: "Cold outreach sequence for PR campaigns",
          category: "pr",
          channel: "email",
          audienceType: "cold-outreach",
          tags: ["email"],
          dag: {
            nodes: [
              { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/buffer/next", body: { sourceType: "journalist" } }, inputMapping: { "body.campaignId": "$ref:flow_input.campaignId" } },
              { id: "check-lead", type: "condition" },
              { id: "send-email", type: "http.call", config: { service: "email-gateway", method: "POST", path: "/send" }, inputMapping: { "body.to": "$ref:fetch-lead.output.lead.email" }, retries: 0 },
              { id: "end-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: false } } },
              { id: "end-run-no-lead", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: true } } },
              { id: "end-run-error", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: false, stopCampaign: false } } },
            ],
            edges: [
              { from: "fetch-lead", to: "check-lead" },
              { from: "check-lead", to: "send-email", condition: "results['fetch-lead'].found == true" },
              { from: "check-lead", to: "end-run-no-lead", condition: "results['fetch-lead'].found == false" },
              { from: "send-email", to: "end-run" },
            ],
          },
        },
      ],
    },
  });

export const DeployWorkflowResultSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string().describe("Unique technical identifier: {featureDynastySlug}-{signatureName}[-v{N}]."),
    name: z.string().describe("Human-readable name: {dynastyName}[ v{N}]."),
    dynastySlug: z.string().describe("Stable dynasty slug (constant across versions)."),
    featureSlug: z.string().describe("Feature slug used to build the name."),
    tags: z.array(z.string()).describe("Tags assigned to this workflow."),
    signature: z.string().describe("SHA-256 hash of the canonical DAG JSON."),
    signatureName: z.string().describe("Poetic word for this dynasty (auto-generated by workflow-service)."),
    version: z.number().int().describe("Version number within the dynasty."),
    action: z.enum(["created", "updated", "deprecated-to-existing"]),
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
    upgradedToSlug: z.string().nullable().optional().describe(
      "Slug of the replacement workflow (for by-slug lookups)."
    ),
  })
  .openapi("WorkflowDeprecatedResponse");

// --- Execute by slug schema ---

export const ExecuteByNameSchema = z
  .object({
    inputs: z.record(z.unknown()).optional().describe(
      "Runtime inputs for the workflow. Accessible in nodes via $ref:flow_input.fieldName."
    ),
  })
  .openapi("ExecuteBySlugRequest", {
    example: {
      inputs: {
        orgId: "b645207b-d8e9-40b0-9391-072b777cd9a9",
        campaignId: "camp-123",
        prAngle: "AI-powered PR automation",
        newsHook: "Company raises Series A",
        spokesperson: "Jane Doe, CEO",
        currentDate: "2026-03-26",
      },
    },
  });

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
    totalCostInUsdCents: z.number().describe("Total cost in USD cents across all completed runs of this workflow."),
    totalOutcomes: z.number().describe("Total outcome count for the requested objective metric (e.g. emailsReplied, leadsServed, outletsDiscovered)."),
    costPerOutcome: z.number().nullable().describe("Cost per outcome in USD cents (totalCostInUsdCents / totalOutcomes). Null if no outcomes yet."),
    completedRuns: z.number().describe("Number of completed runs used in the calculation."),
    email: z.object({
      transactional: EmailStatsSchema.describe("Aggregated transactional email stats across all runs."),
      broadcast: EmailStatsSchema.describe("Aggregated broadcast email stats across all runs."),
    }).describe("Detailed email engagement stats aggregated across the upgrade chain."),
  })
  .openapi("WorkflowStats", {
    example: {
      totalCostInUsdCents: 4250,
      totalOutcomes: 17,
      costPerOutcome: 250,
      completedRuns: 12,
      email: {
        transactional: { sent: 120, delivered: 115, opened: 48, clicked: 12, replied: 7, bounced: 3, unsubscribed: 0, recipients: 120 },
        broadcast: { sent: 80, delivered: 76, opened: 30, clicked: 8, replied: 3, bounced: 2, unsubscribed: 1, recipients: 80 },
      },
    },
  });

export const WorkflowMetadataSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string().describe("Unique technical identifier."),
    name: z.string().describe("Human-readable display name."),
    dynastyName: z.string().describe("Stable lineage name (constant across versions)."),
    dynastySlug: z.string().describe("Stable dynasty slug (constant across versions)."),
    version: z.number().int().describe("Version number within the dynasty."),
    createdForBrandId: z.string().nullable(),
    featureSlug: z.string().describe("Feature slug for grouping and naming."),
    signature: z.string(),
    signatureName: z.string(),
  })
  .openapi("WorkflowMetadata");

// --- Ranked Workflow schemas ---

export const RankedWorkflowObjectiveSchema = z
  .string()
  .describe(
    'Stats key to optimize for. Any key from the stats registry is valid ' +
    '(e.g. "emailsReplied", "emailsClicked", "leadsServed", "outletsDiscovered", "journalistsFound"). ' +
    'Legacy values "replies" and "clicks" are still supported as aliases. ' +
    'When featureSlug is provided and objective is omitted, the feature\'s declared output metrics are used automatically.'
  )
  .openapi("RankedWorkflowObjective", { example: "emailsReplied" });

// --- Public workflow metadata (service-to-service, x-api-key only) ---

export const PublicWorkflowsQuerySchema = z
  .object({
    featureSlugs: z.string().min(1).describe("Comma-separated list of versioned feature slugs."),
    status: z.enum(["active", "deprecated", "all"]).optional().describe("Filter by workflow status. Defaults to 'active'."),
  })
  .openapi("PublicWorkflowsQuery");

export const PublicWorkflowItemSchema = z
  .object({
    id: z.string().uuid().describe("Workflow ID."),
    slug: z.string().describe("Unique technical identifier."),
    name: z.string().describe("Human-readable display name."),
    dynastyName: z.string().describe("Stable dynasty name across versions."),
    dynastySlug: z.string().describe("Stable dynasty slug across versions."),
    version: z.number().int().describe("Version number within the dynasty."),
    status: z.string().describe("Workflow status: active or deprecated."),
    featureSlug: z.string().describe("Versioned feature slug."),
    createdForBrandId: z.string().nullable().describe("Brand ID this workflow was created for, or null."),
    upgradedTo: z.string().uuid().nullable().describe("ID of the workflow this was upgraded to, or null if still active."),
  })
  .openapi("PublicWorkflowItem");

export const PublicWorkflowsResponseSchema = z
  .object({
    workflows: z.array(PublicWorkflowItemSchema).describe("Workflow metadata matching the query."),
  })
  .openapi("PublicWorkflowsResponse");

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
    existingWorkflowSlug: z.string().describe("Slug of the existing workflow that already has this DAG signature."),
  })
  .openapi("WorkflowConflictResponse");

// --- Dynasty lookup schemas ---

export const DynastySlugsResponseSchema = z
  .object({
    dynastySlug: z.string().describe("The dynasty slug used for lookup."),
    dynastyName: z.string().describe("Human-readable dynasty name."),
    slugs: z.array(z.string()).describe("All workflow slugs in this dynasty (all versions, all statuses)."),
  })
  .openapi("DynastySlugsResponse");

export const DynastyEntrySchema = z
  .object({
    dynastySlug: z.string().describe("Stable dynasty slug."),
    dynastyName: z.string().describe("Human-readable dynasty name."),
    slugs: z.array(z.string()).describe("All versioned workflow slugs in this dynasty."),
  })
  .openapi("DynastyEntry");

export const DynastiesResponseSchema = z
  .object({
    dynasties: z.array(DynastyEntrySchema).describe("All dynasties with their versioned slugs."),
  })
  .openapi("DynastiesResponse");

export const DynastyStatsResponseSchema = z
  .object({
    dynastySlug: z.string().describe("The dynasty slug."),
    dynastyName: z.string().describe("Human-readable dynasty name."),
    stats: WorkflowStatsSchema.describe("Aggregated stats across all versions of this dynasty."),
  })
  .openapi("DynastyStatsResponse");

// --- Internal: Transfer Brand ---

export const TransferBrandRequestSchema = z
  .object({
    brandId: z.string().min(1).describe("The brand ID to transfer."),
    sourceOrgId: z.string().min(1).describe("The org that currently owns the brand."),
    targetOrgId: z.string().min(1).describe("The org to transfer the brand to."),
  })
  .openapi("TransferBrandRequest");

export const TransferBrandResponseSchema = z
  .object({
    updatedTables: z.array(
      z.object({
        tableName: z.string().describe("Name of the database table."),
        count: z.number().int().describe("Number of rows updated."),
      })
    ).describe("Tables and counts of rows updated."),
  })
  .openapi("TransferBrandResponse");

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
  "x-campaign-id": z.string().optional().describe("Campaign ID for tracking. Optional on non-execute endpoints."),
  "x-brand-id": z.string().optional().describe("Brand ID(s) as CSV (e.g. 'uuid1,uuid2'). Optional on non-execute endpoints."),
  "x-workflow-slug": z.string().optional().describe("Workflow slug for tracking. Optional on non-execute endpoints."),
  "x-feature-slug": z.string().optional().describe("Feature slug from features-service. Optional on non-execute endpoints."),
});

/** All 7 headers are required on execute endpoints — no fallbacks, no defaults. */
const ExecutionHeaders = z.object({
  "x-org-id": z.string().describe("Internal org UUID (from client-service). Required."),
  "x-user-id": z.string().describe("Internal user UUID (from client-service). Required."),
  "x-run-id": z.string().describe("Run ID for tracing across services. Required."),
  "x-campaign-id": z.string().describe("Campaign ID. Required on execute endpoints — propagated to all downstream http.call nodes."),
  "x-brand-id": z.string().describe("Brand ID(s) as CSV (e.g. 'uuid1,uuid2'). Required on execute endpoints — propagated to all downstream http.call nodes."),
  "x-workflow-slug": z.string().describe("Workflow slug. Required on execute endpoints — propagated to all downstream http.call nodes."),
  "x-feature-slug": z.string().describe("Feature slug. Required on execute endpoints — propagated to all downstream http.call nodes."),
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
      featureSlug: z.string().optional().describe("Exact match on the versioned feature slug stored in the workflow."),
      featureDynastySlug: z.string().optional().describe("Filter by feature dynasty slug — resolves to all versioned feature slugs in the lineage via features-service."),
      workflowSlug: z.string().optional().describe("Exact match on the versioned workflow slug."),
      workflowDynastySlug: z.string().optional().describe("Filter by workflow dynasty slug — matches all workflows in the dynasty (all versions)."),
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
  summary: "Update a workflow (metadata or DAG)",
  description:
    "The single endpoint for modifying a workflow. Behavior depends on what you send:\n\n" +
    "**Metadata only** (no `dag` in body): updates description/tags in-place. Returns `_action: 'updated'`.\n\n" +
    "**DAG with same signature**: the DAG structure hasn't changed (e.g. only config tweaks that don't affect the hash). " +
    "Updates in-place. Returns `_action: 'updated'`.\n\n" +
    "**DAG with new signature**: creates a new workflow in a new dynasty (fork). The original workflow is kept active " +
    "unless its entire dynasty has zero campaign runs, in which case it is deprecated. " +
    "Returns `_action: 'forked'` with the new workflow data, plus `_forkedFromName`, `_forkedFromId`, " +
    "and `_sourceDynastyDeprecated` to indicate what happened.\n\n" +
    "The new workflow's ID is in the response — use it going forward. " +
    "Returns 201 for forks, 200 for in-place updates.",
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
    200: {
      description: "Workflow updated in-place (metadata or same-signature DAG). _action='updated'.",
      content: { "application/json": { schema: WorkflowMutationResponseSchema } },
    },
    201: {
      description: "New workflow created via fork (DAG signature changed). _action='forked'.",
      content: { "application/json": { schema: WorkflowMutationResponseSchema } },
    },
    400: {
      description: "Invalid DAG structure",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Workflow not found",
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
    headers: ExecutionHeaders,
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
      featureSlug: z.string().optional().describe("Exact match on the versioned feature slug stored in the run."),
      featureDynastySlug: z.string().optional().describe("Filter by feature dynasty slug — resolves to all versioned feature slugs in the lineage via features-service."),
      workflowSlug: z.string().optional().describe("Exact match on the versioned workflow slug stored in the run."),
      workflowDynastySlug: z.string().optional().describe("Filter by workflow dynasty slug — finds all workflows in the dynasty, then matches runs by workflow ID."),
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

// NOTE: PUT /workflows/upgrade is an internal-only endpoint (used by apps at startup).
// It is NOT registered in OpenAPI to avoid exposing it to external clients.
// External clients should use PUT /workflows/{id} for all workflow modifications.

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

// --- Dynasty endpoints ---

registry.registerPath({
  method: "get",
  path: "/workflows/dynasties",
  summary: "List all dynasties with their versioned slugs",
  description:
    "Returns all dynasties with the list of versioned workflow slugs for each. " +
    "Useful for building a reverse map (slug → dynastySlug) to aggregate stats by dynasty.",
  tags: ["Dynasty"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
  },
  responses: {
    200: {
      description: "All dynasties",
      content: {
        "application/json": { schema: DynastiesResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflows/dynasty/slugs",
  summary: "Resolve a dynasty slug to all versioned workflow slugs",
  description:
    "Returns all workflow slugs (across all versions and statuses) that belong to the given dynasty. " +
    "Use this to aggregate stats across all versions of a workflow in external services.",
  tags: ["Dynasty"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    query: z.object({
      dynastySlug: z.string().describe("The dynasty slug to resolve."),
    }),
  },
  responses: {
    200: {
      description: "Dynasty slugs resolved",
      content: {
        "application/json": { schema: DynastySlugsResponseSchema },
      },
    },
    400: {
      description: "Missing dynastySlug query parameter",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "No workflows found for this dynasty slug",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflows/dynasty/stats",
  summary: "Get aggregated stats for a dynasty",
  description:
    "Returns performance stats aggregated across all versions of the given dynasty. " +
    "This includes costs, email metrics, and completed runs from the entire upgrade chain.",
  tags: ["Dynasty"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    query: z.object({
      dynastySlug: z.string().describe("The dynasty slug to get stats for."),
      objective: RankedWorkflowObjectiveSchema.describe("Stats key to optimize for (e.g. 'emailsReplied', 'emailsClicked'). Required."),
    }),
  },
  responses: {
    200: {
      description: "Dynasty stats",
      content: {
        "application/json": { schema: DynastyStatsResponseSchema },
      },
    },
    400: {
      description: "Missing dynastySlug query parameter",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "No workflows found for this dynasty slug",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "External service unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Public endpoints ---

registry.registerPath({
  method: "get",
  path: "/public/workflows",
  summary: "Public: Get workflow metadata by feature slugs",
  description:
    "Service-to-service endpoint. Returns workflow metadata (no DAG) filtered by feature slugs. " +
    "Requires x-api-key. No identity headers needed.",
  tags: ["Public"],
  security: [{ apiKey: [] }],
  request: {
    query: PublicWorkflowsQuerySchema,
  },
  responses: {
    200: {
      description: "Workflow metadata",
      content: {
        "application/json": { schema: PublicWorkflowsResponseSchema },
      },
    },
    400: {
      description: "Missing or invalid query parameters",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflows/by-slug/{slug}/execute",
  summary: "Execute a workflow by slug",
  description:
    "Starts an async execution of a previously deployed workflow. " +
    "Returns a run object with an ID — poll GET /workflow-runs/{id} for status (queued → running → completed/failed). " +
    "Pass runtime data via inputs (accessible in nodes as $ref:flow_input.fieldName).",
  tags: ["Workflow Runs"],
  security: [{ apiKey: [] }],
  request: {
    headers: ExecutionHeaders,
    params: z.object({ slug: z.string() }),
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

// --- Internal endpoints ---

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  summary: "Transfer a brand from one org to another",
  description:
    "Re-assigns all solo-brand rows from sourceOrgId to targetOrgId. " +
    "Skips co-branding rows (multiple brand IDs). Idempotent.",
  tags: ["Internal"],
  security: [{ apiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: TransferBrandRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Transfer complete",
      content: { "application/json": { schema: TransferBrandResponseSchema } },
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
