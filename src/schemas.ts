import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { NODE_TYPE_REGISTRY } from "./lib/node-type-registry.js";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

const REGISTERED_NODE_TYPES = Object.keys(NODE_TYPE_REGISTRY) as [string, ...string[]];

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
    type: z.enum(REGISTERED_NODE_TYPES).describe(
      "Node type. Must be one of the registered types — unknown strings are rejected (no silent fallback). " +
      "Preferred: \"http.call\" — call any microservice. config requires { service, method, path }. " +
      "Inline JS: \"script\" — runs node.config.code (string) inline as a Windmill rawscript. " +
      "config = { code: string, language?: \"bun\" | \"deno\" }. Inputs via inputMapping, outputs via `return { … }`. " +
      "Native flow control: " +
      "\"condition\" — if/then/else branching (uses Windmill branchone). " +
      "Outgoing edges with 'condition' define branches; nodes downstream of a conditional edge are nested inside that branch. " +
      "Outgoing edges without 'condition' define after-branch steps that always execute. " +
      "\"wait\" — sleep/delay. \"for-each\" — loop over items (body nodes are nested inside the loop). " +
      "Legacy named types: stripe.createProduct, client.createUser, transactional-email.send."
    ),
    config: z.record(z.unknown()).optional().describe(
      "Static parameters passed to the node. For http.call: { service, method, path, body?, query?, headers? }. " +
      "For script: { code (string, required, inline JS), language? (\"bun\" | \"deno\", default \"bun\") }. " +
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
    forkedForPipe: z.string().min(1).optional().describe(
      "The pipe (`<channel>|<leg>`) a one-leg copy was forked for (`POST /workflows/{id}/fork` with `pipeId`). " +
      "Inert at run time: it only makes two copies of the same steps two workflows, one per pipe (a workflow sits " +
      "on ONE leg, owner 2026-10-19). Which pipe a workflow serves is features-service's, never read from here. " +
      "An upgrade that states none keeps its predecessor's."
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
  .enum(["sales", "pr", "outlets", "journalists", "advertising"])
  .describe(
    "Workflow category — the acquisition domain the workflow works in. " +
      "\"advertising\" covers paid-reach channels (Google Ads, Meta Ads, and the rest of the paid family)."
  )
  .openapi("WorkflowCategory");

export const WorkflowChannelSchema = z
  .enum(["email", "database", "ads"])
  .describe(
    "Workflow distribution channel — how the work reaches people. " +
      "\"ads\" means the workflow buys placements on an ad platform rather than sending or storing anything."
  )
  .openapi("WorkflowChannel");

export const WorkflowAudienceTypeSchema = z
  .enum(["cold-outreach", "discovery", "audience-targeting", "conversation-follow-up"])
  .describe(
    "Workflow audience type — how the workflow relates to the people it reaches. " +
      "\"audience-targeting\" means the audience is described to an ad platform as targeting criteria, " +
      "not contacted one by one (\"cold-outreach\") and not collected into a database (\"discovery\"). " +
      "\"conversation-follow-up\" means the people are already in a conversation with us and answered: " +
      "the workflow continues that thread rather than opening one."
  )
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
    pipeId: z.string().min(1).optional().describe(
      "The features-service pipe the workflow runs on, `<channel slug>|<leg key>`. Read from the catalogue: " +
      "it must exist, its channel must equal featureSlug and it must be platform-worked (else 422). " +
      "The workflow is then registered on that pipe in features-service (POST /internal/workflow-leg-assignments/register, active at once), " +
      "which owns the link; this service stores no pipe."
    ),
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
      "and the original is kept active (unless its lineage has zero campaign runs, in which case it is deprecated)."
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

// DEPRECATION-REASON-1020: why a workflow stopped, who decided it, when.
export const DeprecationSchema = z
  .object({
    reason: z.string().describe(
      "Why this workflow was deprecated, in plain words. 'Not specified' for workflows deprecated before 2026-10-20 " +
      "(the reason was never recorded)."
    ),
    decidedBy: z.string().nullable().describe(
      "Who decided it: a staff email, 'workflow-service' for an automatic deprecation (an upgrade replacing this version), " +
      "or 'user:<id>' when only the caller's user id is known. Null when unknown (every pre-2026-10-20 'Not specified' row)."
    ),
    decidedAt: z.string().nullable().describe("ISO instant the deprecation was decided. Null when unknown (pre-2026-10-20 'Not specified' rows)."),
  })
  .openapi("WorkflowDeprecation");

const deprecationField = DeprecationSchema.nullable().describe(
  "Why, by whom and when this workflow was deprecated. Null while it is executable (status AND workflowDynastyStatus 'active'). " +
  "A retired dynasty carries its retirement decision on every version; a version replaced by an upgrade says so."
);

const DeprecationRequestFields = {
  reason: z.string().trim().min(1).max(2000).optional().describe(
    "REQUIRED when deprecating (DEPRECATION-REASON-1020): why, in plain words a staff member reads months later. " +
    "A deprecation without one is refused with 400 `deprecation_reason_required`. Ignored when activating."
  ),
  decidedBy: z.string().trim().min(1).max(320).optional().describe(
    "Who decided (staff email). Absent = the caller's x-email header, else 'user:<x-user-id>'."
  ),
};

export const WorkflowResponseSchema = z
  .object({
    id: z.string().uuid().describe("Workflow UUID."),
    orgId: z.string().describe("Organization ID."),
    featureSlug: z.string().describe("Feature slug from features-service. Used for naming and feature-level grouping."),
    createdForBrandId: z.string().nullable(),
    humanId: z.string().nullable().describe("Human ID if this workflow was generated in a human expert's style."),
    campaignId: z.string().nullable(),
    subrequestId: z.string().nullable(),
    workflowSlug: z.string().describe("Unique technical identifier. Use this to execute via /workflows/by-slug/{workflowSlug}/execute."),
    workflowName: z.string().describe("Human-readable display name. Globally unique."),
    workflowDynastySlug: z.string().describe("Stable lineage slug (constant across all versions of a dynasty). Use for dynasty-level grouping."),
    workflowDynastyName: z.string().describe("Stable lineage display name (constant across all versions of a dynasty)."),
    description: z.string().nullable(),
    category: WorkflowCategorySchema.nullable().describe("Legacy provenance tag (pre-2026-10-10). The generator no longer sets it: the pipe link lives in features-service (/internal/workflow-leg-assignments)."),
    channel: WorkflowChannelSchema.nullable().describe("Legacy provenance tag (pre-2026-10-10). The generator no longer sets it: the pipe link lives in features-service (/internal/workflow-leg-assignments)."),
    audienceType: WorkflowAudienceTypeSchema.nullable().describe("Legacy provenance tag (pre-2026-10-10). The generator no longer sets it: the pipe link lives in features-service (/internal/workflow-leg-assignments)."),
    tags: z.array(z.string()).describe("Free-form tags for filtering/grouping (e.g. [\"email\", \"linkedin\"])."),
    signature: z.string().describe("Deterministic SHA-256 hash of the canonical DAG JSON. Changes when any node, edge, or config changes."),
    workflowDynastySignatureName: z.string().describe("Star name of this lineage, lowercase (e.g. 'vega'; 'bright-vega' once a feature has burned every single IAU star name). Lineages created before 2026-10-10 keep their older word (e.g. 'sequoia'). Set once at lineage creation. Unique among all workflows (any status, any org) within the same featureSlug."),
    version: z.number().int().describe("Version number within the lineage. Starts at 1."),
    dag: z.unknown().describe("The DAG definition as submitted."),
    contentModel: z.string().nullable().describe(
      "The chat-service model alias this workflow writes its content with (e.g. 'flash', 'deepseek-pro', 'fable'), " +
      "read from the `model` field of the DAG's content-generation POST /generate request body. " +
      "Derived at read from the DAG, so a consumer can label a workflow row without downloading and parsing the DAG. " +
      "Null when the workflow makes no content-generation call, when the call does not state a model " +
      "(content-generation then applies its own default), when the value is produced at run time by another node, " +
      "or when several content-generation calls state different models — never a guess."
    ),
    contentPromptType: z.string().nullable().describe(
      "The content-generation prompt template this workflow renders (e.g. 'cold-email'), read from the `type` field " +
      "of the DAG's content-generation POST /generate request body. Same derivation and same null cases as `contentModel`."
    ),
    contentTemplateDynasty: z.string().nullable().describe(
      "TPL-DYNASTY-1021-WF: the content-generation template DYNASTY this workflow writes with. Every run reads the dynasty's " +
      "CURRENT head (GET /internal/template-dynasties/{slug}/head), so a new head version reaches it with no new workflow version; " +
      "`contentPromptType` is then the head the DAG was last written against. Null when the workflow pins a template version."
    ),
    writesWithLegBest: z.boolean().describe(
      "BEST-TPL-LLM-1022: true when the workflow states no template and no LLM: every run writes with the template dynasty and the LLM " +
      "features-service ranks best on the workflow's leg (lowest $/outcome, narrowed by the campaign strategy's tactics). " +
      "`contentModel`, `contentPromptType` and `contentTemplateDynasty` are then null: what wrote each email is recorded per generation by content-generation."
    ),
    deprecation: deprecationField,
    status: z.enum(["active", "deprecated"]).describe("Per-version lifecycle status. Only active workflows can be executed. Within a dynasty the latest version is 'active' and predecessors are 'deprecated'. Set on demand via PUT /workflows/{id}/status. Distinct from `workflowDynastyStatus`."),
    workflowDynastyStatus: z.enum(["active", "deprecated"]).describe("Dynasty-level status. 'deprecated' means the entire lineage is retired: no version of it can be executed (execute returns 410) and it is not listed as an active candidate. Constant across all versions of a dynasty. Set via PUT /workflows/dynasty/{workflowDynastySlug}/status."),
    creationType: z.enum(["scratch", "upgrade", "fork"]).describe(
      "How this workflow was created: 'scratch' = brand-new dynasty, 'upgrade' = new version of an existing dynasty, 'fork' = forked from another workflow."
    ),
    createdFromWorkflow: z.string().uuid().nullable().describe(
      "ID of the workflow this one was derived from (predecessor for 'upgrade', source for 'fork'). Null for 'scratch'."
    ),
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
    "'forked' means a new workflow was created with a new lineage because the DAG signature changed."
  ),
  _forkedFromWorkflowName: z.string().optional().describe(
    "Present only when _action='forked'. The display name of the original workflow that was forked."
  ),
  _forkedFromId: z.string().uuid().optional().describe(
    "Present only when _action='forked'. The ID of the original workflow that was forked."
  ),
}).openapi("WorkflowMutationResponse", {
  example: {
    id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    orgId: "b645207b-d8e9-40b0-9391-072b777cd9a9",
    createdForBrandId: null,
    humanId: null,
    campaignId: null,
    subrequestId: null,
    workflowSlug: "pr-cold-email-outreach-sequoia",
    workflowName: "Pr Cold Email Outreach Sequoia",
    workflowDynastySlug: "pr-cold-email-outreach-sequoia",
    workflowDynastyName: "Pr Cold Email Outreach Sequoia",
    description: "Cold outreach sequence for PR campaigns",
    featureSlug: "pr-cold-email-outreach",
    category: "pr",
    channel: "email",
    audienceType: "cold-outreach",
    tags: ["email"],
    signature: "4c4239e8d9bec64c85a178cb12b6669d3a69b6e68bafc0cb45c1797377ce9a8a",
    workflowDynastySignatureName: "sequoia",
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
    workflowDynastyStatus: "active",
    creationType: "fork",
    createdFromWorkflow: "3f8db0d4-ec80-4d06-805d-13b7df8703f9",
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

export const InvalidEndpointSchema = z
  .object({
    service: z.string(),
    method: z.string(),
    path: z.string(),
    reason: z.string(),
  })
  .openapi("InvalidEndpoint");

export const FieldValidationIssueSchema = z
  .object({
    nodeId: z.string(),
    service: z.string(),
    method: z.string(),
    path: z.string(),
    field: z.string(),
    severity: z.enum(["error", "warning"]),
    reason: z.string(),
  })
  .openapi("FieldValidationIssue");

export const ValidationResultSchema = z
  .object({
    valid: z.boolean(),
    errors: z
      .array(z.object({ field: z.string(), message: z.string() }))
      .optional(),
    invalidEndpoints: z
      .array(InvalidEndpointSchema)
      .describe("http.call endpoints that do not exist in the corresponding service's current OpenAPI spec."),
    fieldIssues: z
      .array(FieldValidationIssueSchema)
      .describe("Body/output field mismatches between http.call nodes and the current OpenAPI specs."),
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

export const CampaignAttributionContextSchema = z
  .object({
    brandId: z.string().optional().describe("Single brand ID for this attributed execution when the campaign is single-brand."),
    brandIds: z.array(z.string()).optional().describe("Brand IDs for this attributed execution. Copied from the execution brand header when attribution is present."),
    campaignId: z.string().optional().describe("Campaign ID copied from the execution header when attribution is present."),
    featureSlug: z.string().optional().describe("Feature slug copied from the execution header when attribution is present."),
    goal: z.string().optional().describe("Canonical active optimization goal supplied by the caller. Workflow-service never infers this value."),
    brandProfileId: z.string().optional().describe("Canonical brand-profile version ID supplied by the caller. Workflow-service never infers this value."),
    profileId: z.string().optional().describe("Brand/profile version ID supplied by the caller. Workflow-service never infers this value."),
    personaId: z.string().optional().describe("Customer persona ID supplied by the caller. Workflow-service never infers this value."),
    goalId: z.string().optional().describe("Goal ID supplied by the caller. Workflow-service never infers this value."),
    goalSlug: z.string().optional().describe("Goal slug supplied by the caller. Workflow-service never infers this value."),
    optimizationGoal: z.string().optional().describe("Active optimization goal supplied by the caller, e.g. signups or sales_meetings."),
  })
  .catchall(z.unknown())
  .describe("Optional literal attribution context for campaign executions. Present only when supplied by the caller; absent executions remain null.")
  .openapi("CampaignAttributionContext");

const NullableCampaignAttributionContextSchema = CampaignAttributionContextSchema
  .nullable()
  .describe("Literal attribution context preserved from execution, or null when the execution was untagged.")
  .openapi("NullableCampaignAttributionContext");

export const ExecuteWorkflowSchema = z
  .object({
    conflictPolicy: z.enum(["use_existing", "reject"]).optional().describe(
      "How to handle an already-active campaign-scoped execution for the same org + campaign. " +
      "When omitted, workflow-service returns the existing active execution."
    ),
    attributionContext: CampaignAttributionContextSchema.optional().describe(
      "Optional real campaign attribution context to preserve on the workflow run and expose to nodes via flow_input.attributionContext. " +
      "Workflow-service copies this literally and never derives persona/profile/goal IDs from names or totals."
    ),
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
    workflowSlug: z.string().nullable().describe("Slug of the workflow that was executed. Use this to re-execute via /workflows/by-slug/{workflowSlug}/execute."),
    subrequestId: z.string().nullable(),
    userId: z.string().nullable().describe("User ID from the execution context."),
    runId: z.string().nullable().describe("Runs-service run ID for this execution (auto-created)."),
    windmillJobId: z.string().nullable().describe("Internal Windmill job ID (managed automatically)."),
    windmillWorkspace: z.string(),
    status: z.string().describe("Run status: dispatching, queued, running, completed, failed, or cancelled."),
    executionScope: z.string().nullable().describe("Business execution scope, e.g. campaign."),
    executionKey: z.string().nullable().describe("Deterministic key used to prevent duplicate active executions."),
    conflictPolicy: z.string().nullable().describe("Conflict policy used when this run was reserved."),
    attributionContext: NullableCampaignAttributionContextSchema,
    inputs: z.unknown().nullable().describe("The inputs that were passed at execution time."),
    result: z.unknown().nullable().describe("Workflow result (available when status is completed). Contains the output of the last node."),
    error: z.string().nullable().describe("Error message (available when status is failed). Raw Windmill error — use errorSummary for a clean version."),
    errorSummary: z.object({
      failedStep: z.string().nullable().describe("Which workflow step failed (e.g. 'fetch_lead', 'send_email')."),
      message: z.string().describe("Clean error message with stack traces stripped."),
      rootCause: z.string().describe("Innermost root cause extracted from nested service error chains."),
    }).optional().describe("Parsed error summary (present only when status is 'failed'). Use rootCause for user-facing messages."),
    reservedAt: z.string().nullable(),
    dispatchStartedAt: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("WorkflowRunResponse");

export const ExecutionConflictResponseSchema = z
  .object({
    error: z.string(),
    workflowRun: WorkflowRunResponseSchema.describe("The active workflow execution that already owns this execution key."),
  })
  .openapi("ExecutionConflictResponse");

// --- Deprecated workflow response ---

export const WorkflowDeprecatedResponseSchema = z
  .object({
    error: z.literal("Workflow has been deprecated"),
    upgradedTo: z.string().uuid().nullable().describe(
      "ID of the replacement workflow. Null if no replacement was set."
    ),
    upgradedToWorkflowSlug: z.string().nullable().optional().describe(
      "Slug of the replacement workflow (for by-slug lookups)."
    ),
  })
  .openapi("WorkflowDeprecatedResponse");

// --- Execute by slug schema ---

export const ExecuteByNameSchema = z
  .object({
    conflictPolicy: z.enum(["use_existing", "reject"]).optional().describe(
      "How to handle an already-active campaign-scoped execution for the same org + campaign. " +
      "When omitted, workflow-service returns the existing active execution."
    ),
    attributionContext: CampaignAttributionContextSchema.optional().describe(
      "Optional real campaign attribution context to preserve on the workflow run and expose to nodes via flow_input.attributionContext. " +
      "Workflow-service copies this literally and never derives persona/profile/goal IDs from names or totals."
    ),
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

// --- Description-driven create/upgrade schemas ---

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

export const CreateWorkflowFromDescriptionSchema = z
  .object({
    description: z.string().min(10).describe(
      "Natural-language description of the desired workflow."
    ),
    featureSlug: z.string().min(1).describe(
      "The workflow's channel slug in features-service (e.g. 'sales-cold-email-outreach'). Required: it names " +
      "the workflow and its pipes are the ones the workflow can run on."
    ),
    pipeId: z.string().min(1).optional().describe(
      "The features-service pipe the workflow runs on, `<channel slug>|<leg key>` " +
      "(GET /internal/catalogue/pipes). Its channel slug must equal featureSlug. Omit it when the channel has " +
      "one pipe, or to let the generator pick the pipe the description is about."
    ),
    hints: GenerateWorkflowHintsSchema.optional().describe(
      "Optional hints to guide generation."
    ),
  })
  .openapi("CreateWorkflowFromDescriptionRequest");

export const UpgradeWorkflowFromDescriptionSchema = z
  .object({
    workflowDynastySlug: z.string().min(1).describe(
      "Stable dynasty slug (constant across all versions of the dynasty). The route resolves it to the currently-active row, so callers do not need to track which version is active after prior upgrades."
    ),
    description: z.string().min(10).optional().describe(
      "Natural-language description of the desired upgraded workflow. " +
      "Required when `dag` is not provided (LLM regenerates the DAG from this description). " +
      "Optional when `dag` is provided; if present, replaces the stored description on the resulting row."
    ),
    dag: DAGSchema.optional().describe(
      "Optional client-supplied DAG. When provided, the LLM is not invoked: the DAG is validated, " +
      "its signature computed, and the upgrade applies the same in-place / new-version branching as " +
      "the LLM path. category/channel/audienceType are inherited from the existing row. " +
      "Use this to apply surgical fixes to a workflow (e.g. patch a single script node) without re-running " +
      "generation. Either `dag` or `description` MUST be provided."
    ),
    pipeId: z.string().min(1).optional().describe(
      "The features-service pipe to regenerate for, `<channel slug>|<leg key>`. Defaults to the pipe features-service " +
      "assigns the dynasty to when it is exactly one; otherwise the generator resolves it from featureSlug. " +
      "Ignored when `dag` is provided."
    ),
    hints: GenerateWorkflowHintsSchema.optional().describe(
      "Optional hints to guide generation. Ignored when `dag` is provided."
    ),
  })
  .refine((data) => data.dag !== undefined || data.description !== undefined, {
    message: "Either 'dag' or 'description' is required",
    path: ["dag"],
  })
  .openapi("UpgradeWorkflowFromDescriptionRequest");

export const WorkflowFromDescriptionResultSchema = z
  .object({
    id: z.string().uuid(),
    workflowSlug: z.string().describe("Unique technical identifier."),
    workflowName: z.string().describe("Human-readable name."),
    workflowDynastySlug: z.string().describe("Stable dynasty slug (constant across versions)."),
    featureSlug: z.string().describe("Feature slug used to build the name."),
    tags: z.array(z.string()).describe("Tags assigned to this workflow."),
    signature: z.string().describe("SHA-256 hash of the canonical DAG JSON."),
    workflowDynastySignatureName: z.string().describe("Star name of this lineage (older lineages keep their pre-2026-10-10 word)."),
    version: z.number().int().describe("Version number within the lineage."),
    pipe: z.object({
      id: z.string().describe("Pipe id, `<channel slug>|<leg key>`."),
      channelSlug: z.string(),
      legKey: z.string(),
      mode: z.enum(["proactive", "reactive"]).describe("proactive: the workflow finds its own people. reactive: a trigger hands them over."),
      triggerId: z.string().nullable().describe("The trigger of a reactive pipe (features-service); null on a proactive one."),
      toStep: z.string().describe("The step the pipe produces: the workflow's ROI is that step's value over what a run costs."),
    }).nullable().describe(
      "The pipe as the generator read it from the features-service catalogue on THIS call, and the one the dynasty is now assigned to there " +
      "(features-service owns the link). Null when the call ran no generation (client-supplied DAG)."
    ),
    action: z.enum(["created", "updated", "upgraded", "existing"]).describe(
      "What happened: 'created' = new dynasty inserted (creation_type='scratch'), " +
      "'existing' = matching active workflow already exists with same signature, " +
      "'updated' = upgrade with same signature applied in-place, " +
      "'upgraded' = new version inserted in same dynasty (creation_type='upgrade')."
    ),
  })
  .openapi("WorkflowFromDescriptionResult");

export const WorkflowFromDescriptionResponseSchema = z
  .object({
    workflow: WorkflowFromDescriptionResultSchema,
    dag: DAGSchema,
    generatedDescription: z.string(),
  })
  .openapi("WorkflowFromDescriptionResponse");

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
    workflowSlug: z.string().describe("Unique technical identifier."),
    workflowName: z.string().describe("Human-readable display name."),
    workflowDynastySlug: z.string().describe("Stable dynasty slug (constant across versions)."),
    workflowDynastyName: z.string().describe("Stable dynasty name (constant across versions)."),
    version: z.number().int().describe("Version number within the lineage."),
    createdForBrandId: z.string().nullable(),
    featureSlug: z.string().describe("Feature slug for grouping and naming."),
    signature: z.string(),
    workflowDynastySignatureName: z.string(),
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
    status: z.enum(["active", "deprecated", "all"]).optional().describe(
      "Filter by workflow status. Defaults to 'active', which means EXECUTABLE: the version " +
      "is active AND its dynasty is not retired. 'deprecated' returns every non-executable " +
      "row (version deprecated, or dynasty retired). 'all' returns everything."
    ),
  })
  .openapi("PublicWorkflowsQuery");

export const PublicWorkflowItemSchema = z
  .object({
    id: z.string().uuid().describe("Workflow ID."),
    workflowSlug: z.string().describe("Unique technical identifier."),
    workflowName: z.string().describe("Human-readable display name."),
    workflowDynastySlug: z.string().describe("Stable dynasty slug across versions."),
    workflowDynastyName: z.string().describe("Stable dynasty name across versions."),
    version: z.number().int().describe("Version number within the lineage."),
    status: z.string().describe("Per-version lifecycle status: active or deprecated."),
    workflowDynastyStatus: z.enum(["active", "deprecated"]).describe(
      "Dynasty-level status. 'deprecated' means the whole lineage is retired and cannot execute, " +
      "whatever this row's per-version `status` says. A row is executable only when both are 'active'."
    ),
    featureSlug: z.string().describe("Feature slug."),
    createdForBrandId: z.string().nullable().describe("Brand ID this workflow was created for, or null."),
    upgradedTo: z.string().uuid().nullable().describe("ID of the active workflow this one was upgraded to, computed from successor lineage. Null when this is the active row or no successor was found in the result set."),
    createdAt: z.string().nullable().describe(
      "ISO instant this version row was created. Reliable: set once at insert, never moved by a later edit. " +
      "A version is executable from this instant unless it was born under a retired dynasty (then `executableUntil` equals it)."
    ),
    executableUntil: z.string().nullable().describe(
      "ISO instant this version STOPPED being executable (its version status became 'deprecated' or its dynasty was retired), " +
      "the earliest such transition. Null while the version is executable (status AND workflowDynastyStatus 'active'); " +
      "cleared again if the version is re-activated, so it reports only the LAST stretch (an older stop/restart gap is not kept). " +
      "To know whether a dynasty could run at instant T: one of its versions has createdAt <= T and (executableUntil null or > T). " +
      "How reliable it is: see `executableUntilSource`."
    ),
    executableUntilSource: z.enum(["recorded", "successor_created", "last_update"]).nullable().describe(
      "Where `executableUntil` comes from. 'recorded': written by this service at the transition (every stop since 2026-10-19), exact. " +
      "'successor_created': backfilled for older rows from the creation of the upgrade that replaced this version (an upgrade deprecates its predecessor in the same transaction), exact to the second. " +
      "'last_update': backfilled for older rows with no upgrade successor (a dynasty's last version, a per-version or stale retirement) from the row's updated_at, " +
      "which a later edit of the already-deprecated row (bulk description/DAG repairs) could have moved LATER than the real stop: an upper bound. Null when `executableUntil` is null."
    ),
    deprecation: deprecationField,
    mergedIntoDynastySlug: z.string().nullable().describe(
      "TPL-DYNASTY-1021-WF: the FINAL survivor dynasty slug this row's dynasty is currently merged into " +
      "(chains A into B into C resolved here: C), null when it is not merged or was un-merged. Same value on every version of the dynasty. " +
      "A merged dynasty is a duplicate of its survivor on the same pipe (same template dynasty, same writer model): pool its stats into the survivor's. " +
      "The merge record: GET /public/workflows/dynasty-merges."
    ),
  })
  .openapi("PublicWorkflowItem");

export const PublicWorkflowsResponseSchema = z
  .object({
    workflows: z.array(PublicWorkflowItemSchema).describe("Workflow metadata matching the query."),
  })
  .openapi("PublicWorkflowsResponse");

export const PublicWorkflowDefinitionsQuerySchema = z
  .object({
    featureSlug: z.string().min(1).describe("One feature slug. Every version of every workflow of that feature is returned, any status."),
  })
  .openapi("PublicWorkflowDefinitionsQuery");

export const PublicWorkflowDefinitionItemSchema = z
  .object({
    id: z.string().uuid().describe("Workflow (version) ID."),
    workflowSlug: z.string().describe("Version slug, the same value the identity-gated GET /workflows serves."),
    workflowName: z.string().describe("Human-readable version name."),
    workflowDynastySlug: z.string().describe("Stable dynasty slug across versions."),
    workflowDynastyName: z.string().describe("Stable dynasty name across versions."),
    version: z.number().int().describe("Version number within the dynasty."),
    status: z.enum(["active", "deprecated"]).describe("Per-version lifecycle status."),
    workflowDynastyStatus: z.enum(["active", "deprecated"]).describe("Dynasty-level status (the whole lineage retired or not)."),
    executable: z.boolean().describe("True only when both `status` and `workflowDynastyStatus` are 'active': this is the version that runs."),
    featureSlug: z.string().describe("Feature slug."),
    description: z.string().nullable().describe("Stored workflow description, or null."),
    dag: DAGSchema.describe("Full stored DAG of this version (what the workflow does)."),
    createdAt: z.string().nullable().describe("ISO timestamp the version was created."),
    executableUntil: z.string().nullable().describe("ISO instant this version stopped being executable, null while it is. Same field and reliability as on GET /public/workflows (see `executableUntilSource`)."),
    executableUntilSource: z.enum(["recorded", "successor_created", "last_update"]).nullable().describe("Reliability of `executableUntil`: 'recorded' exact, 'successor_created' exact (backfill), 'last_update' upper bound (backfill from updated_at). Null when `executableUntil` is null."),
    deprecation: deprecationField,
  })
  .openapi("PublicWorkflowDefinitionItem");

export const PublicWorkflowDefinitionsResponseSchema = z
  .object({
    featureSlug: z.string().describe("The feature slug queried."),
    workflows: z.array(PublicWorkflowDefinitionItemSchema).describe("Every version of every workflow of the feature, ordered by dynasty slug then version."),
  })
  .openapi("PublicWorkflowDefinitionsResponse");

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

export const WorkflowListItemSchema = WorkflowResponseSchema.extend({
  status: z.enum(["active", "deprecated"]).describe(
    "Dynasty status ('active' | 'deprecated'). On the list surface this field " +
    "reflects the item's DYNASTY status (mirrors `workflowDynastyStatus`) so the " +
    "dashboard can render one active/deprecated flag per dynasty row. (On the " +
    "single-workflow GET /workflows/{id} surface, `status` is the per-version " +
    "lifecycle status instead.)"
  ),
  requiredProviders: z.array(ProviderInfoSchema).describe(
    "Providers required by this workflow (with domain info for logo lookup). " +
    "Empty array if the workflow has no http.call nodes. Computed via a single " +
    "deduped key-service POST per list request, so callers no longer need to " +
    "fan out N follow-up requests to /workflows/{id}/required-providers."
  ),
}).openapi("WorkflowListItem");

// --- Dynasty status write (PUT /workflows/dynasty/{workflowDynastySlug}/status) ---

export const DynastyStatusUpdateSchema = z
  .object({
    status: z.enum(["active", "deprecated"]).describe(
      "New dynasty-level status. 'deprecated' retires the entire lineage: no version of it " +
      "can be executed any more (every execute returns 410) and it stops being listed as an " +
      "active candidate. 'active' un-retires it. Idempotent — re-applying the same status is a no-op success " +
      "(re-deprecating with a new `reason` records the new reason)."
    ),
    ...DeprecationRequestFields,
  })
  .openapi("DynastyStatusUpdate");

export const DynastyStatusResponseSchema = z
  .object({
    workflowDynastySlug: z.string().describe("The dynasty slug whose status was set."),
    status: z.enum(["active", "deprecated"]).describe("The dynasty's status after the write."),
    updatedWorkflows: z.number().int().describe("How many version rows in the lineage carry the new status."),
    activeWorkflowSlug: z.string().nullable().describe(
      "The workflow slug left executable. Null when the dynasty was retired — a retired dynasty " +
      "has no executable version, and nothing is substituted for it."
    ),
  })
  .openapi("DynastyStatusResponse");

// --- Dynasty merge (TPL-DYNASTY-1021-WF) ---

export const DynastyMergeRequestSchema = z
  .object({
    intoWorkflowDynastySlug: z.string().min(1).describe("The SURVIVOR dynasty: same channel and same pipe (features-service leg assignments), executable."),
    reason: z.string().trim().min(1).max(2000).describe("Why (required), e.g. 'Same template dynasty and same model on the same pipe'."),
    decidedBy: DeprecationRequestFields.decidedBy,
  })
  .openapi("DynastyMergeRequest");

export const DynastyUnmergeRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000).describe("Why the merge is undone (required)."),
    decidedBy: DeprecationRequestFields.decidedBy,
  })
  .openapi("DynastyUnmergeRequest");

export const DynastyMergeSchema = z
  .object({
    id: z.string().uuid(),
    absorbedDynastySlug: z.string().describe("The dynasty merged away (deprecated on both axes while the merge is open)."),
    survivorDynastySlug: z.string().describe("The dynasty it was merged into."),
    finalSurvivorDynastySlug: z.string().nullable().describe("The survivor through every open merge (A into B into C = C); null once un-merged."),
    featureSlug: z.string(),
    legKeys: z.array(z.string()).describe("The pipe (leg keys on featureSlug) both dynasties served when merged."),
    reason: z.string(),
    decidedBy: z.string().nullable(),
    mergedAt: z.string(),
    unmergedAt: z.string().nullable().describe("Null while the merge is open."),
    unmergedBy: z.string().nullable(),
    unmergeReason: z.string().nullable(),
  })
  .openapi("DynastyMerge");

export const DynastyMergeResponseSchema = z
  .object({
    merge: DynastyMergeSchema,
    deprecatedVersions: z.number().int().optional().describe("Merge: how many absorbed versions were deprecated."),
    restoredVersions: z.number().int().optional().describe("Un-merge: how many versions were restored to their exact prior state."),
  })
  .openapi("DynastyMergeResponse");

export const DynastyMergesQuerySchema = z
  .object({
    featureSlug: z.string().optional().describe("Narrow to one channel."),
    state: z.enum(["open", "all"]).optional().describe("'open' (default) = merges in force; 'all' includes un-merged ones."),
  })
  .openapi("DynastyMergesQuery");

export const DynastyMergesResponseSchema = z
  .object({ merges: z.array(DynastyMergeSchema) })
  .openapi("DynastyMergesResponse");

// --- Retire every workflow running a template or a model (POST /workflows/retire-by-content) ---

export const RetireByContentRequestSchema = z
  .object({
    promptType: z.string().min(1).optional().describe("content-generation template type: retire every runnable workflow whose content call PINS it. A workflow writing with a template dynasty's live head is never retired by one of that dynasty's versions (TPL-DYNASTY-1021-WF3)."),
    model: z.string().min(1).optional().describe("Writer model alias: retire every runnable workflow whose content call writes with it."),
    featureSlug: z.string().min(1).optional().describe("Narrow to one channel. Absent = every channel."),
    legKey: z.string().min(1).optional().describe(
      "Narrow to ONE pipe (`featureSlug` x `legKey`, e.g. lead_found_to_website_visit; requires `featureSlug`): only dynasties features-service has ACTIVE on that leg are listed/retired, each with its `legKeys`. " +
      "A matching dynasty also active on another leg of the channel is never retired (it would stop that pipe too): it is listed under `keptOnOtherLegs`. Absent = every leg, answered as before (RETIRE-BY-CONTENT-PER-LEG-1023)."
    ),
    dryRun: z.boolean().optional().describe("true = list what would be retired, write nothing (the confirmation a staff member reads first)."),
    reason: z.string().trim().min(1).max(2000).optional().describe(
      "Why these workflows are retired (DEPRECATION-REASON-1020). Absent = 'Uses deprecated template <promptType>' / 'Uses deprecated model <model>'."
    ),
    decidedBy: DeprecationRequestFields.decidedBy,
  })
  .refine((b) => (b.promptType === undefined) !== (b.model === undefined), { message: "Exactly one of promptType or model is required" })
  .refine((b) => b.legKey === undefined || b.featureSlug !== undefined, { message: "legKey requires featureSlug (a pipe is a channel x leg)" })
  .openapi("RetireByContentRequest");

export const RetireByContentResponseSchema = z
  .object({
    dryRun: z.boolean(),
    workflows: z
      .array(
        z.object({
          workflowDynastySlug: z.string(),
          workflowDynastyName: z.string(),
          featureSlug: z.string(),
          workflowSlug: z.string().describe("The version that was running (the dynasty's active version)."),
          version: z.number().int(),
          legKeys: z.array(z.string()).optional().describe("Only when `legKey` was sent: the legs features-service has this dynasty ACTIVE on (exactly [legKey])."),
        }),
      )
      .describe("Every workflow (dynasty) running the template or model (on the pipe, when `legKey` was sent): retired, or that would be on a dry run."),
    retired: z.number().int().describe("Dynasties retired by this call (0 on a dry run)."),
    keptOnOtherLegs: z
      .array(
        z.object({
          workflowDynastySlug: z.string(),
          workflowDynastyName: z.string(),
          featureSlug: z.string(),
          workflowSlug: z.string(),
          version: z.number().int(),
          legKeys: z.array(z.string()).describe("Every leg it is ACTIVE on: `legKey` and at least one other."),
        }),
      )
      .optional()
      .describe("Only when `legKey` was sent: dynasties running the template or model on that leg AND another one, never retired by a per-pipe call."),
  })
  .openapi("RetireByContentResponse");

// --- Per-version status write (PUT /workflows/{id}/status) ---

export const WorkflowStatusUpdateSchema = z
  .object({
    status: z.enum(["active", "deprecated"]).describe(
      "New per-version lifecycle status. 'deprecated' retires THIS version only: it can no " +
      "longer be executed by id, and it stops being the dynasty's execution target when " +
      "resolving by slug. 'active' restores it — rejected with 409 when another version of " +
      "the same dynasty is already active. Idempotent (re-deprecating with a new `reason` records the new reason)."
    ),
    ...DeprecationRequestFields,
  })
  .openapi("WorkflowStatusUpdate");

// --- Workflow conflict response (409 on PUT /workflows/:id) ---

export const WorkflowConflictResponseSchema = z
  .object({
    error: z.string(),
    existingWorkflowId: z.string().uuid().describe("ID of the existing workflow that already has this DAG signature."),
    existingWorkflowSlug: z.string().describe("Workflow slug of the existing workflow that already has this DAG signature."),
  })
  .openapi("WorkflowConflictResponse");

// --- Prompt edit (POST /workflows/{id}/prompt-edit + dynasty twin) ---

export const PromptEditRequestSchema = z
  .object({
    action: z.enum(["upgrade", "fork"]).describe(
      "'upgrade' adds a new version to the SAME dynasty that writes with the edited prompt " +
      "(the current active version is superseded, exactly like any upgrade — every campaign on the " +
      "dynasty sends the new text from its next run). 'fork' creates a NEW dynasty identical to the " +
      "source except that it writes with the edited prompt; the source is left untouched."
    ),
    prompt: z.string().min(1).describe(
      "The full edited template text. It must state exactly the same {{variables}} as the template " +
      "the workflow renders today (read it via content-generation's platform-prompts by the workflow's " +
      "`contentPromptType`); anything else is refused with 422. It is stored as a NEW template type — " +
      "the existing template, which other workflows may share, is never modified."
    ),
  })
  .openapi("PromptEditRequest");

export const PromptEditResponseSchema = z
  .object({
    action: z.enum(["upgraded", "forked"]).describe("What was created."),
    workflow: WorkflowResponseSchema.describe(
      "The NEW workflow row: the dynasty's new active version on upgrade, version 1 of the new dynasty on fork. " +
      "Navigate with `workflowDynastySlug` (new on fork, unchanged on upgrade) or `id`. " +
      "Its `contentPromptType` is the new template type."
    ),
    sourceWorkflow: z.object({
      id: z.string().uuid(),
      workflowSlug: z.string(),
      workflowDynastySlug: z.string(),
      version: z.number().int(),
    }).describe("The version the edit was applied to. Deprecated after an upgrade; untouched after a fork."),
    promptTemplate: z.object({
      previousType: z.string().describe("The template type the source renders. Unchanged."),
      type: z.string().describe("The new template type holding the edited text, rendered only by `workflow`."),
    }),
  })
  .openapi("PromptEditResponse");

export const PromptEditVariableErrorSchema = z
  .object({
    error: z.string().describe("Readable sentence naming what the edit broke. Safe to show as-is."),
    droppedVariables: z.array(z.string()).describe("{{variables}} the current template states that the edit removed."),
    addedVariables: z.array(z.string()).describe("{{variables}} the edit introduced that the workflow does not provide."),
    requiredVariables: z.array(z.string()).describe("The exact set an edited prompt must state."),
  })
  .openapi("PromptEditVariableError");

// --- Fork with a stated change (POST /workflows/{id}/fork + dynasty twin) ---

const changePath = z.string().describe(
  "JSON Pointer into the workflow's DAG (`{nodes, edges}`), e.g. `/nodes/fetch-lead/config/body/acceptedEmails`. " +
  "Under `/nodes` a non-numeric segment names a node by its `id`; a numeric one is the array index."
);

export const WorkflowChangeSchema = z
  .object({
    op: z.enum(["add", "replace", "remove", "test"]).describe(
      "JSON Patch (RFC 6902) operation. `add` sets a key (creating it) or inserts into an array; `replace` " +
      "requires the path to exist; `remove` deletes it; `test` refuses the whole fork unless the path holds `value` " +
      "(use it to assert the source is what you think before changing it)."
    ),
    path: changePath,
    value: z.unknown().optional().describe("The value to add, replace with, or test against. Required except for `remove`."),
  })
  .refine((c) => c.op === "remove" || c.value !== undefined, { message: "value is required for add, replace and test" })
  .openapi("WorkflowChange");

export const ForkWorkflowRequestSchema = z
  .object({
    changes: z.array(WorkflowChangeSchema).default([]).describe(
      "The stated change, applied in order to a copy of the source DAG. Everything it does not name is copied " +
      "byte-identical. A change that leaves the DAG identical is refused (400). May be empty only with `pipeId`."
    ),
    pipeId: z.string().regex(/^[^|]+\|[^|]+$/).optional().describe(
      "Fork the copy for ONE pipe (`<channel>|<leg>`) of the source's own channel: the copy is registered on that " +
      "pipe only (never on the source's pipes) and its DAG states `forkedForPipe`, so a copy with the same steps " +
      "is its own workflow (a workflow sits on ONE leg, owner 2026-10-19). Unknown pipe or another channel = 400."
    ),
    description: z.string().min(1).optional().describe(
      "The copy's description. Defaults to the source's. Say what the copy does differently in plain words: " +
      "features-service judges a workflow's tactics on its DAG and description."
    ),
    tags: z.array(z.string()).optional().describe("The copy's tags. Defaults to the source's."),
  })
  .strict()
  .refine((b) => b.changes.length > 0 || b.pipeId !== undefined, {
    message: "State at least one change, or the pipeId the copy is forked for",
    path: ["changes"],
  })
  .openapi("ForkWorkflowRequest");

export const ForkWorkflowResponseSchema = z
  .object({
    workflow: WorkflowResponseSchema.describe(
      "The NEW workflow: version 1 of a new dynasty, deployed, and serving every pipe its source serves (active at once)."
    ),
    sourceWorkflow: z.object({
      id: z.string().uuid(),
      workflowSlug: z.string(),
      workflowDynastySlug: z.string(),
      version: z.number().int(),
    }).describe("The version the change was applied to. Never modified."),
    changesApplied: z.number().int().describe("Number of change operations applied."),
  })
  .openapi("ForkWorkflowResponse");

export const ForkWorkflowChangeErrorSchema = z
  .object({
    error: z.string().describe("Readable sentence naming the change that cannot apply and why."),
    changeIndex: z.number().int().describe("Zero-based index in `changes` of the operation that failed."),
  })
  .openapi("ForkWorkflowChangeError");

// --- Figures (POST /orgs/figures/read) ---

export const ReadFiguresRequestSchema = z
  .object({
    question: z.string().trim().min(1).max(8000).describe(
      "What the message must say, in words (e.g. the campaign's instruction). The reader works out which " +
      "figures that needs and reads them."
    ),
    recipientEmail: z.string().trim().email().optional().describe(
      "The person the message goes to. Their OWN account (the organizations they belong to, per the identity " +
      "provider) is the only account that can be read. Omitted, or a person who belongs to no organization: " +
      "public figures only."
    ),
  })
  .strict()
  .openapi("ReadFiguresRequest");

export const ReadFiguresResponseSchema = z
  .object({
    figures: z.array(z.object({
      label: z.string().describe("What the figure is, in words."),
      value: z.string().describe("The value as the read served it (unit and currency kept), or a ratio of two served values."),
      source: z.string().describe("The read it came from: a customer-API path, or a web question."),
    })).describe("Every figure found. Each cites a read that succeeded; nothing estimated."),
    missing: z.string().nullable().describe(
      "Null when everything the question needs was found; else one sentence naming what could not be read and why " +
      "(e.g. it belongs to another organization than the recipient's)."
    ),
    recipient: z.object({
      email: z.string().nullable(),
      isMember: z.boolean().describe("True when the recipient belongs to at least one organization."),
      organizations: z.array(z.object({ orgId: z.string(), name: z.string().nullable() })),
    }),
    reads: z.array(z.object({
      kind: z.enum(["account", "public", "web"]),
      orgId: z.string().nullable(),
      target: z.string(),
      status: z.number().int().nullable(),
      refused: z.string().nullable().describe("Why the read was refused before any request left (never made). Null when made."),
    })).describe("Every read planned, made or refused, in order."),
  })
  .openapi("ReadFiguresResponse");

// --- Internal: Transfer Brand ---

export const TransferBrandRequestSchema = z
  .object({
    sourceBrandId: z.string().min(1).describe("The brand ID to transfer (in the source org)."),
    sourceOrgId: z.string().min(1).describe("The org that currently owns the brand."),
    targetOrgId: z.string().min(1).describe("The org to transfer the brand to."),
    targetBrandId: z.string().min(1).optional().describe("The existing brand ID in the target org to rewrite to. When present, brand references are rewritten from sourceBrandId to targetBrandId."),
  })
  .openapi("TransferBrandRequest");

export const TransferBrandResponseSchema = z
  .object({
    updatedTables: z.array(
      z.object({
        tableName: z.string().describe("Name of the database table."),
        count: z.number().int().describe("Number of distinct rows changed in this table by this call (0 on a re-run)."),
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
  "x-goal": z.string().optional().describe("Canonical active optimization goal for attribution. Propagated to downstream runs and http.call nodes only when supplied."),
  "x-brand-profile-id": z.string().optional().describe("Canonical brand-profile ID for attribution. Propagated to downstream runs and http.call nodes only when supplied."),
  "x-profile-id": z.string().optional().describe("Optional profile ID for attribution. Propagated to downstream http.call nodes only when supplied."),
  "x-persona-id": z.string().optional().describe("Optional persona ID for attribution. Propagated to downstream http.call nodes only when supplied."),
  "x-goal-id": z.string().optional().describe("Optional goal ID for attribution. Propagated to downstream http.call nodes only when supplied."),
  "x-goal-slug": z.string().optional().describe("Optional goal slug for attribution. Propagated to downstream http.call nodes only when supplied."),
  "x-optimization-goal": z.string().optional().describe("Optional active optimization goal for attribution. Propagated to downstream http.call nodes only when supplied."),
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

const DynastyItemSchema = z.object({
  workflowDynastySlug: z.string().describe("Stable dynasty slug (constant across versions)."),
  workflowDynastyName: z.string().describe("Stable dynasty display name."),
  featureSlug: z.string().describe("The feature this dynasty belongs to."),
  workflowSlugs: z.array(z.string()).describe(
    "EVERY versioned workflow slug of this lineage, active and deprecated alike — " +
    "so a consumer holding a superseded slug can resolve it back to its dynasty."
  ),
});

const DynastyStatsSchema = z.object({
  workflowDynastySlug: z.string(),
  workflowDynastyName: z.string(),
  stats: z.record(z.unknown()).describe("Aggregated stats for the dynasty (costs, email metrics, completed runs)."),
});

const WorkflowSummarySchema = z.object({
  id: z.string().uuid(),
  workflowSlug: z.string().describe("Versioned slug of this version."),
  workflowName: z.string(),
  workflowDynastySlug: z.string().describe("Stable lineage slug (constant across versions)."),
  workflowDynastyName: z.string(),
  featureSlug: z.string(),
  description: z.string().nullable().describe("What this workflow does, in plain words."),
  siblingLine: z.string().nullable().describe(
    "WF-SHORT-LINE-1023, display only: a fragment of at most 10 words saying ONLY what sets this workflow's dynasty apart from the other workflows on the same pipe (never the pipe, leg or channel, a template, an LLM, a version or a date). " +
      "Null when the dynasty is the only workflow on its pipe, when its pipe's lines are not written yet (at most ~10 min after a change), or when it sits on several pipes with different lines (read `siblingLines`).",
  ),
  siblingLines: z.array(z.object({ legKey: z.string(), line: z.string() })).describe(
    "The dynasty's line per pipe it sits on (features-service leg assignments, any state), one entry per leg; empty when none is written.",
  ),
  status: z.string().describe("Per-version lifecycle: active (latest of its dynasty) or deprecated."),
  workflowDynastyStatus: z.string().describe("Whole-lineage status: deprecated = retired, never runs."),
  version: z.number().int(),
  tags: z.array(z.string()),
  contentModel: z.string().nullable().describe("Model of the content-generation call, derived from the DAG; null when it states none."),
  contentPromptType: z.string().nullable().describe("Prompt template of the content-generation call, derived from the DAG; null when it states none."),
  contentTemplateDynasty: z.string().nullable().describe("Template dynasty the workflow writes with (its live head each run); null when it pins a template version."),
  writesWithLegBest: z.boolean().describe("True when the workflow states no template and no LLM: each run writes with its leg's best (features-service)."),
  deprecation: deprecationField,
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
}).openapi("WorkflowSummary");

registry.registerPath({
  method: "get",
  path: "/workflows/summaries",
  summary: "List what each workflow of a feature does, without its DAG",
  description:
    "A light listing for readers that need to know which workflow does what (an agent choosing a workflow, a " +
    "catalogue page): slug, names, description, status, version, tags and the content model/template, never the " +
    "DAG (GET /workflows returns every DAG, hundreds of KB per feature). Read one DAG on demand with " +
    "GET /workflows/{id}. `status` has the GET /workflows semantics: default active = EXECUTABLE (version active " +
    "AND dynasty not retired), deprecated = either axis retired, all = both. Sorted by dynasty, newest version first.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    query: z.object({
      featureSlug: z.string().optional().describe("Exact match on the feature slug (e.g. ai-meeting-booking)."),
      workflowDynastySlug: z.string().optional().describe("One lineage, every version (the unversioned slug)."),
      status: z.string().optional().describe("active (default, executable) | deprecated | all."),
    }),
  },
  responses: {
    200: {
      description: "The workflows, without DAGs",
      content: { "application/json": { schema: z.object({ workflows: z.array(WorkflowSummarySchema) }) } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflows/dynasties",
  summary: "List dynasties with every one of their versioned workflow slugs",
  description:
    "Lists each dynasty with ALL of its versioned workflow slugs, deprecated versions included — " +
    "the only read that names a superseded version, so a consumer holding the versioned slug a " +
    "campaign was pinned to can resolve which dynasty it belongs to. Pass featureSlug to scope the " +
    "answer to one channel; a customer-facing consumer should always pass it, since the unscoped " +
    "listing is the whole internal codename catalogue.",
  tags: ["Dynasties"],
  security: [{ apiKey: [] }],
  request: {
    query: z.object({
      featureSlug: z.string().optional().describe(
        "Restrict to the dynasties of this feature. Omitted, the listing is fleet-wide."
      ),
      workflowSlug: z.string().optional().describe(
        "Restrict to the single dynasty this versioned workflow slug belongs to — including when " +
        "the slug names a superseded or deprecated version. An unknown slug answers an empty list."
      ),
    }),
  },
  responses: {
    200: {
      description: "List of dynasties",
      content: {
        "application/json": {
          schema: z.object({ dynasties: z.array(DynastyItemSchema) }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflows/dynasty/slugs",
  summary: "Resolve a dynasty slug to all versioned workflow slugs",
  tags: ["Dynasties"],
  security: [{ apiKey: [] }],
  request: {
    query: z.object({
      workflowDynastySlug: z.string().describe("The dynasty slug to resolve."),
    }),
  },
  responses: {
    200: {
      description: "Dynasty resolved",
      content: { "application/json": { schema: DynastyItemSchema } },
    },
    400: {
      description: "Missing query parameter",
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
  summary: "Aggregated stats for a dynasty (full upgrade chain)",
  tags: ["Dynasties"],
  security: [{ apiKey: [] }],
  request: {
    query: z.object({
      workflowDynastySlug: z.string().describe("The dynasty slug to get stats for."),
      objective: z.string().describe("Stats key to optimize for (e.g. 'emailsReplied')."),
    }),
  },
  responses: {
    200: {
      description: "Dynasty stats",
      content: { "application/json": { schema: DynastyStatsSchema } },
    },
    400: {
      description: "Missing query parameter",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "No workflows found for this dynasty slug",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/workflows/dynasty/{workflowDynastySlug}/status",
  summary: "Retire or un-retire a whole workflow dynasty",
  description:
    "Marks an entire workflow dynasty (lineage) active or deprecated. Applies to " +
    "every version in the dynasty. Idempotent — re-applying the same status is a " +
    "no-op success. A deprecated dynasty is RETIRED: every execute against any of its " +
    "versions returns 410, and it is excluded from the default (active) workflow " +
    "listings, so rankers and pickers stop offering it. It does not change the " +
    "per-version lifecycle `status`, so un-retiring restores the same active version.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ workflowDynastySlug: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: DynastyStatusUpdateSchema } },
    },
  },
  responses: {
    200: {
      description: "Dynasty status set",
      content: { "application/json": { schema: DynastyStatusResponseSchema } },
    },
    400: {
      description: "Invalid body",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "No workflows found for this dynasty slug",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflows/dynasty/{workflowDynastySlug}/merge",
  summary: "Merge a duplicate dynasty into its survivor on the same pipe",
  description:
    "TPL-DYNASTY-1021-WF. Two active dynasties on the same pipe writing with the same template dynasty and model are one workflow: " +
    "this absorbs `workflowDynastySlug` into `intoWorkflowDynastySlug`. Never across two pipes: both must be on the same channel AND " +
    "actively assigned to the same leg(s) in features-service (409 `merge_across_pipes`). Non-destructive: no history is rewritten " +
    "(runs, emails, leads keep the absorbed slug); every absorbed version is deprecated on both axes with the reason " +
    "'Merged into <survivor>: <reason>', its prior status fields are kept on the merge record, and execute-by-slug forwards the absorbed " +
    "slug to the survivor's active version, so a campaign holding it keeps running. Reversible: POST .../unmerge. " +
    "409 `already_merged`, `survivor_merged`, `survivor_not_executable`, `absorbed_not_executable`; 400 `merge_into_itself`.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ workflowDynastySlug: z.string() }),
    body: { required: true, content: { "application/json": { schema: DynastyMergeRequestSchema } } },
  },
  responses: {
    201: { description: "Merged", content: { "application/json": { schema: DynastyMergeResponseSchema } } },
    400: { description: "Invalid body", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Unknown dynasty", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "Refused (code names why)", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflows/dynasty/{workflowDynastySlug}/unmerge",
  summary: "Undo a dynasty merge, restoring the exact prior state",
  description:
    "TPL-DYNASTY-1021-WF. Restores every version of the absorbed dynasty exactly as the merge recorded it (status, dynasty status, " +
    "executableUntil, deprecation) and closes the merge record (kept, with who/when/why). The Windmill flow of every version that runs " +
    "again is restored first (502 if it cannot be). 404 `not_merged` when no merge is open.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ workflowDynastySlug: z.string() }),
    body: { required: true, content: { "application/json": { schema: DynastyUnmergeRequestSchema } } },
  },
  responses: {
    200: { description: "Un-merged", content: { "application/json": { schema: DynastyMergeResponseSchema } } },
    404: { description: "Not merged", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "A recorded version no longer exists", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "Windmill flow restore failed", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/public/workflows/dynasty-merges",
  summary: "Public: every dynasty merge record",
  description:
    "Service-to-service (x-api-key, no identity). TPL-DYNASTY-1021-WF: who was merged into whom, on which pipe, why, by whom, when, " +
    "and whether it was undone. Stats readers pool an absorbed dynasty into `finalSurvivorDynastySlug` (also served per row on " +
    "GET /public/workflows as `mergedIntoDynastySlug`).",
  tags: ["Public"],
  security: [{ apiKey: [] }],
  request: { query: DynastyMergesQuerySchema },
  responses: {
    200: { description: "Merge records", content: { "application/json": { schema: DynastyMergesResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflows/retire-by-content",
  summary: "Retire every workflow running a template or a model",
  description:
    "Staff action behind deprecating a content-generation template or a writer model (TEMPLATE-MODEL-STATUS-1019). " +
    "Finds every RUNNABLE workflow (version active, dynasty active) whose content call renders `promptType` or writes " +
    "with `model`, and retires each whole dynasty exactly like PUT /workflows/dynasty/{workflowDynastySlug}/status " +
    "with 'deprecated'. `featureSlug` + `legKey` narrow it to ONE pipe (features-service's active leg assignments): a dynasty also on another leg is listed in `keptOnOtherLegs`, never retired. `dryRun: true` lists them and writes nothing. There is no reverse: re-activating a template or " +
    "a model brings no workflow back, each is re-activated by hand. Idempotent (a second call finds nothing left).",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    body: { required: true, content: { "application/json": { schema: RetireByContentRequestSchema } } },
  },
  responses: {
    200: { description: "Listed (dryRun) or retired", content: { "application/json": { schema: RetireByContentResponseSchema } } },
    400: { description: "Invalid body", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "`legKey` sent and features-service's leg assignments unreadable (`leg_assignments_unreadable`): nothing listed or retired", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/workflows/{id}/status",
  summary: "Retire or un-retire a single workflow version",
  description:
    "Sets the per-version lifecycle `status` of one workflow. 'deprecated' retires that " +
    "version: executing it by id returns 410, and it stops being the version a dynasty-slug " +
    "execute resolves forward to — so retiring the only active version of a dynasty stops " +
    "the dynasty running, with no substitution. 'active' restores it, re-pushing its Windmill " +
    "flow first; it is rejected with 409 when another version of the same dynasty is already " +
    "active, because at most one version per dynasty may be active. Idempotent.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: {
      required: true,
      content: { "application/json": { schema: WorkflowStatusUpdateSchema } },
    },
  },
  responses: {
    200: {
      description: "Workflow status set",
      content: { "application/json": { schema: WorkflowResponseSchema } },
    },
    400: {
      description: "Invalid body or workflow ID",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Workflow not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Another version of this dynasty is already active",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Windmill flow could not be re-pushed while re-activating",
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
      featureSlug: z.string().optional().describe("Exact match on the feature slug stored in the workflow."),
      workflowSlug: z.string().optional().describe("Exact match on the versioned workflow slug."),
      workflowDynastySlug: z.string().optional().describe("Filter by workflow dynasty slug — matches all workflows in the dynasty (all versions)."),
      category: WorkflowCategorySchema.optional(),
      channel: WorkflowChannelSchema.optional(),
      audienceType: WorkflowAudienceTypeSchema.optional(),
      tag: z.string().optional().describe("Filter workflows that contain this tag."),
      status: z.string().optional().describe(
        "Filter by status. Defaults to 'active', which means EXECUTABLE: the version is active " +
        "AND its dynasty is not retired — so a retired dynasty stops being offered as a candidate. " +
        "Use 'all' to include deprecated workflows."
      ),
    }),
  },
  responses: {
    200: {
      description: "List of workflows, each enriched with requiredProviders",
      content: {
        "application/json": {
          schema: z.object({ workflows: z.array(WorkflowListItemSchema) }),
        },
      },
    },
    502: {
      description: "Key service unavailable or returned an error while computing requiredProviders",
      content: { "application/json": { schema: ErrorResponseSchema } },
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
    "**DAG with new signature**: creates a new workflow in a new lineage (fork). The original workflow is kept active " +
    "unless its entire lineage has zero campaign runs, in which case it is deprecated. " +
    "Returns `_action: 'forked'` with the new workflow data, plus `_forkedFromName`, `_forkedFromId`, " +
    "and `_sourceDynastyDeprecated` to indicate what happened to the source lineage.\n\n" +
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
    200: {
      description: "Existing active campaign-scoped execution returned because conflictPolicy is use_existing",
      content: {
        "application/json": { schema: WorkflowRunResponseSchema },
      },
    },
    201: {
      description: "Execution started",
      content: {
        "application/json": { schema: WorkflowRunResponseSchema },
      },
    },
    409: {
      description: "Active campaign-scoped execution already exists and conflictPolicy is reject",
      content: {
        "application/json": { schema: ExecutionConflictResponseSchema },
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
      featureSlug: z.string().optional().describe("Exact match on the feature slug stored in the run."),
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

registry.registerPath({
  method: "post",
  path: "/workflows/create",
  summary: "Create a workflow from a natural-language description",
  description:
    "Uses an LLM to transform a natural-language description into a valid DAG workflow and deploy it. " +
    "If an active workflow already exists for (orgId, featureSlug) with the same DAG signature, " +
    "returns 200 with the existing row unchanged. Otherwise creates a brand-new dynasty " +
    "(creation_type='scratch'). This endpoint never upgrades existing dynasties — use POST /workflows/upgrade.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    body: {
      required: true,
      content: { "application/json": { schema: CreateWorkflowFromDescriptionSchema } },
    },
  },
  responses: {
    200: {
      description: "Existing matching workflow returned (idempotent match)",
      content: { "application/json": { schema: WorkflowFromDescriptionResponseSchema } },
    },
    201: {
      description: "New workflow created in a new dynasty",
      content: { "application/json": { schema: WorkflowFromDescriptionResponseSchema } },
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
  method: "post",
  path: "/workflows/upgrade",
  summary: "Upgrade an existing active workflow via natural-language description",
  description:
    "Regenerates the DAG of an existing active workflow using an LLM. " +
    "If the new DAG signature matches the existing one, the workflow is updated in-place " +
    "(returns 200). If the signature changes, a new version is inserted in the same dynasty " +
    "with creation_type='upgrade' and the predecessor is deprecated (returns 201). " +
    "A dynasty that is not retired but has no active version (orphaned: its head deprecated with no successor) " +
    "is upgraded on its latest version, which is left deprecated and unchanged; the new version is always inserted (201).",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    body: {
      required: true,
      content: { "application/json": { schema: UpgradeWorkflowFromDescriptionSchema } },
    },
  },
  responses: {
    200: {
      description: "Workflow upgraded in-place (signature unchanged)",
      content: { "application/json": { schema: WorkflowFromDescriptionResponseSchema } },
    },
    201: {
      description: "New version of the workflow created in the same dynasty",
      content: { "application/json": { schema: WorkflowFromDescriptionResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "No version of the dynasty is active and it is retired, or the dynasty does not exist",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    422: {
      description: "LLM generated an invalid DAG that could not be fixed after retries",
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
  method: "get",
  path: "/public/workflows/definitions",
  summary: "Public: every version of a feature's workflows, with DAG and description",
  description:
    "Service-to-service endpoint for org-less readers (e.g. a background judging sweep). Returns EVERY version " +
    "of every workflow of one feature (active and deprecated, both status axes), each with its full stored DAG " +
    "and description. Requires x-api-key. No identity headers needed.",
  tags: ["Public"],
  security: [{ apiKey: [] }],
  request: {
    query: PublicWorkflowDefinitionsQuerySchema,
  },
  responses: {
    200: {
      description: "Workflow definitions",
      content: {
        "application/json": { schema: PublicWorkflowDefinitionsResponseSchema },
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
  path: "/workflows/by-slug/{workflowSlug}/execute",
  summary: "Execute a workflow by slug",
  description:
    "Starts an async execution of a previously deployed workflow. " +
    "Returns a run object with an ID — poll GET /workflow-runs/{id} for status (queued → running → completed/failed). " +
    "Pass runtime data via inputs (accessible in nodes as $ref:flow_input.fieldName).",
  tags: ["Workflow Runs"],
  security: [{ apiKey: [] }],
  request: {
    headers: ExecutionHeaders,
    params: z.object({ workflowSlug: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: ExecuteByNameSchema } },
    },
  },
  responses: {
    200: {
      description: "Existing active campaign-scoped execution returned because conflictPolicy is use_existing",
      content: {
        "application/json": { schema: WorkflowRunResponseSchema },
      },
    },
    201: {
      description: "Execution started",
      content: {
        "application/json": { schema: WorkflowRunResponseSchema },
      },
    },
    409: {
      description: "Active campaign-scoped execution already exists and conflictPolicy is reject",
      content: {
        "application/json": { schema: ExecutionConflictResponseSchema },
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
    "Moves every row this service holds for the brand from sourceOrgId to targetOrgId, in one transaction: " +
    "workflow_runs whose brand_ids is exactly [brand] or that carry no brand_ids but belong to one of the brand's campaigns, " +
    "workflows created for the brand or for one of its campaigns, and the orgId/brandId recorded in each moved run's inputs. " +
    "Co-branded runs (several brand IDs) stay in the source org; when targetBrandId is given the brand id is rewritten everywhere, co-branded arrays included. " +
    "Catalog workflows (no brand, no campaign) never move. Idempotent: a second call reports zero rows.",
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

const promptEditResponses = {
  201: {
    description: "Created: the new version (upgrade) or the new dynasty (fork), with the new template",
    content: { "application/json": { schema: PromptEditResponseSchema } },
  },
  400: {
    description: "Invalid body, invalid id, the prompt is unchanged, or the rewritten DAG fails validation",
    content: { "application/json": { schema: ErrorResponseSchema } },
  },
  404: {
    description: "Workflow not found (by id), or the dynasty has no active version (by dynasty slug)",
    content: { "application/json": { schema: ErrorResponseSchema } },
  },
  409: {
    description:
      "Upgrade requested on a version that is not the dynasty's active one; the workflow does not write " +
      "with a single literal prompt template; or the resulting DAG already exists as an active workflow",
    content: { "application/json": { schema: ErrorResponseSchema } },
  },
  422: {
    description: "The edited prompt adds or removes a {{variable}}",
    content: { "application/json": { schema: PromptEditVariableErrorSchema } },
  },
  502: {
    description: "content-generation could not read or store the template",
    content: { "application/json": { schema: ErrorResponseSchema } },
  },
};

const promptEditDescription =
  "Takes the prompt template the workflow's content-generation call renders, stores the edited text " +
  "as a NEW template type (content-generation `PUT /prompts`, which never mutates the source), and " +
  "repoints a copy of the DAG at it. `upgrade` inserts that DAG as the dynasty's next version and " +
  "deprecates the current one; `fork` inserts it as version 1 of a new dynasty and leaves the source " +
  "untouched. The edit must keep exactly the template's {{variables}} (422 otherwise). Staff-only at the " +
  "gateway: an upgrade changes what every campaign on the dynasty sends.";

registry.registerPath({
  method: "post",
  path: "/workflows/{id}/prompt-edit",
  summary: "Upgrade or fork a workflow with an edited prompt",
  description:
    promptEditDescription +
    " `id` may be any version: `fork` branches from exactly that version; `upgrade` requires it to be " +
    "the dynasty's active version (409 otherwise, naming the active one).",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: {
      required: true,
      content: { "application/json": { schema: PromptEditRequestSchema } },
    },
  },
  responses: promptEditResponses,
});

registry.registerPath({
  method: "post",
  path: "/workflows/dynasty/{workflowDynastySlug}/prompt-edit",
  summary: "Upgrade or fork a workflow dynasty with an edited prompt",
  description:
    promptEditDescription +
    " The dynasty slug resolves to its currently-active version, which is what both actions build on.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ workflowDynastySlug: z.string().min(1) }),
    body: {
      required: true,
      content: { "application/json": { schema: PromptEditRequestSchema } },
    },
  },
  responses: promptEditResponses,
});

const forkResponses = {
  201: {
    description: "Created: the copy, a new dynasty, deployed and assigned to every pipe its source serves",
    content: { "application/json": { schema: ForkWorkflowResponseSchema } },
  },
  400: {
    description: "Invalid body or id, the change leaves the DAG identical, or the changed DAG fails validation",
    content: { "application/json": { schema: ErrorResponseSchema } },
  },
  404: {
    description: "Workflow not found (by id), or the dynasty has no active version (by dynasty slug)",
    content: { "application/json": { schema: ErrorResponseSchema } },
  },
  409: {
    description: "The changed DAG already exists as an active workflow (`existingWorkflowId` names it)",
    content: { "application/json": { schema: WorkflowConflictResponseSchema } },
  },
  422: {
    description: "A change cannot apply (missing path, unknown node id, failed `test`)",
    content: { "application/json": { schema: ForkWorkflowChangeErrorSchema } },
  },
  502: {
    description: "The copy was written but its pipe assignment in features-service failed (`reason: leg_assignment_failed`)",
    content: { "application/json": { schema: ErrorResponseSchema } },
  },
};

const forkDescription =
  "Copies a workflow with a stated change into a NEW dynasty: the change (JSON Patch on the DAG) is applied to a " +
  "copy of the source DAG, the result is validated like any stored DAG, deployed, and registered on every pipe the " +
  "source serves (active at once). The source is never modified. The copy belongs to the source's owner org.";

registry.registerPath({
  method: "post",
  path: "/workflows/{id}/fork",
  summary: "Fork a workflow version with a stated change",
  description: forkDescription + " `id` may be any version; the copy branches from exactly that version.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: { required: true, content: { "application/json": { schema: ForkWorkflowRequestSchema } } },
  },
  responses: forkResponses,
});

registry.registerPath({
  method: "post",
  path: "/workflows/dynasty/{workflowDynastySlug}/fork",
  summary: "Fork a workflow dynasty with a stated change",
  description: forkDescription + " The dynasty slug resolves to its currently-active version, which the copy branches from.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    params: z.object({ workflowDynastySlug: z.string().min(1) }),
    body: { required: true, content: { "application/json": { schema: ForkWorkflowRequestSchema } } },
  },
  responses: forkResponses,
});

registry.registerPath({
  method: "post",
  path: "/orgs/figures/read",
  summary: "Read the figures a message needs: public ones and the recipient's own account figures",
  description:
    "General capability for any workflow (an `http.call` node). Works out which figures `question` needs and " +
    "reads them at run time: PUBLIC figures (our public catalogue routes, the live web) and the figures of the " +
    "organization(s) the RECIPIENT belongs to, read through the customer API gateway as that recipient, with no " +
    "staff access. NEVER another organization's: the org a read acts in comes from the recipient's membership at " +
    "the identity provider (never from the question), and every id a read names must come from an earlier read of " +
    "the recipient's own account. A figure that cannot be read is named in `missing`; the caller decides what to " +
    "do (the AI Follow-up Email workflow sends nothing). The model spend is declared by chat-service on the " +
    "calling run.",
  tags: ["Figures"],
  security: [{ apiKey: [] }],
  request: {
    headers: IdentityHeaders,
    body: { required: true, content: { "application/json": { schema: ReadFiguresRequestSchema } } },
  },
  responses: {
    200: { description: "What was found and read", content: { "application/json": { schema: ReadFiguresResponseSchema } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "A dependency failed (identity provider, gateway 5xx, chat-service)", content: { "application/json": { schema: ErrorResponseSchema } } },
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
