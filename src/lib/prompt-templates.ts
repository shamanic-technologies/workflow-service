import { NODE_TYPE_REGISTRY } from "./node-type-registry.js";
import { LEAD_CONTEXT_PATHS } from "./lead-context-variables.js";
import type { CataloguePipe, CatalogueStep, CataloguePipeSummary } from "./catalogue-client.js";
import type { DiscoveredService, DiscoverServiceEndpointsResponse } from "./api-registry-client.js";

/**
 * The recipient-context variables a generated workflow should map. The
 * authoritative list is `contextVariables` on content-generation's prompt reads;
 * this is the subset this repo knows a lead-service path for, which is also
 * exactly what `scripts/backfill-lead-context-variables.mjs` writes onto the
 * workflows already stored.
 */
const LEAD_CONTEXT_VARIABLE_NAMES = Object.keys(LEAD_CONTEXT_PATHS).join(", ");

/** The pipe a workflow is generated for, and the step it produces (both from features-service). */
export interface PipeContext {
  pipe: CataloguePipe;
  fromStep: CatalogueStep;
  toStep: CatalogueStep;
}

/** Level-3 docs (api-registry `/discover/services/{service}/endpoint`) of the endpoints the model picked. */
export interface EndpointDocs {
  docs: Array<Record<string, unknown>>;
}

export interface BuildSystemPromptOptions {
  pipeContext?: PipeContext;
  endpointDocs?: EndpointDocs;
}

/**
 * The owner's vocabulary (2026-10-10), shared by the three generation prompts. Kept as ONE text so
 * the three calls can never describe the model differently.
 */
export const DISTRIBUTE_MODEL_VOCABULARY = `## The Model You Are Building For

distribute.you is a cold email specialist. Every name below is a real object in the platform:

- **Step**: a stage a person reaches (Lead found, Website visit, Positive reply, Meeting booked, Paid client...).
- **Sales Path**: a chain of steps that ends at Paid client.
- **Channel**: how we work a person (e.g. "sales-cold-email-outreach", "ai-meeting-booking").
- **Pipe**: one leg of a sales path (fromStep -> toStep) worked by ONE channel. Its id is \`<channel slug>|<leg key>\`.
- **Sales Funnel**: a sales path with one pipe on each leg.
- **Workflow**: what you are writing. It runs on ONE pipe and moves people from the pipe's fromStep to its toStep, which is the step it PRODUCES (its ROI is the value of that step over what a run costs). It is either:
  - **proactive**: it goes and finds its own people (e.g. pulls the next lead), or
  - **reactive**: someone who reached the pipe's fromStep (its trigger, e.g. a positive reply) is handed to it.
- **Campaign**: a sales funnel capped by a max budget and a max volume (proactive) or by an "Up to" cap (reactive). Every pipe of the funnel stops when the funnel's cap is reached.`;

function pipeSection(ctx: PipeContext): string {
  const { pipe, fromStep, toStep } = ctx;
  const mode =
    pipe.mode === "proactive"
      ? "PROACTIVE: each run finds its own next person to work (the gate-check says whether the campaign's caps leave room)."
      : `REACTIVE on trigger "${pipe.triggerId ?? fromStep.id}": each run works one person who reached "${fromStep.name}" and is owed the next move. It does not source new people.`;
  return `## The Pipe This Workflow Runs On

- Pipe: \`${pipe.id}\` (${pipe.line})
- Channel: \`${pipe.channelSlug}\` (${pipe.channelName})
- Leg: \`${pipe.legKey}\`: from step \`${fromStep.id}\` (${fromStep.name}: ${fromStep.line}) to step \`${toStep.id}\` (${toStep.name}: ${toStep.line})
- Mode: ${mode}
- Produces step: \`${toStep.id}\` (${toStep.name}). Write the workflow so a run's work is what moves a person toward "${toStep.name}" and nothing else; do not add work that belongs to another pipe (another leg or another channel).`;
}

export function buildSystemPrompt(options?: BuildSystemPromptOptions): string {
  const { pipeContext, endpointDocs } = options ?? {};

  const nodeTypes = Object.entries(NODE_TYPE_REGISTRY)
    .map(([type, path]) => {
      if (path === null) return `- "${type}" (native flow control)`;
      return `- "${type}"`;
    })
    .join("\n");

  let serviceSection: string;
  if (endpointDocs) {
    serviceSection = `## Endpoint Docs

Below is the full doc of every endpoint you picked (request body, responses, measured cost and ROI). Use these to determine the correct paths, request body fields and response schemas. Do NOT guess: only use endpoints and fields documented here.

\`\`\`json
${JSON.stringify(endpointDocs.docs)}
\`\`\`

Do NOT invent endpoints or fields that are not in the docs above. If an endpoint you need is not here, adjust the workflow to use only documented endpoints.`;
  } else {
    serviceSection = `## Endpoint Docs

No endpoint docs are available. Use only well-known endpoint paths.`;
  }

  const pipeBlock = pipeContext ? `\n\n${pipeSection(pipeContext)}` : "";

  return `You are a workflow architect that generates valid DAG (Directed Acyclic Graph) workflows.

${DISTRIBUTE_MODEL_VOCABULARY}${pipeBlock}

## DAG Format

A workflow DAG has:
- **nodes**: Array of steps. Each node: { id (string, kebab-case), type (string), config? (object), inputMapping? (object), retries? (number) }
- **edges**: Array of { from, to, condition? } defining execution order.
- **onError**: Optional node ID that runs when any step fails.

## Recommended Node Type: http.call

Use "http.call" for all service calls. Config:
- service (string): service name, maps to {SERVICE}_SERVICE_URL env var. NEVER use "api" — api-service is a proxy. Call the underlying service directly (e.g. "brand", "lead", "client").
- method (string): HTTP verb (GET, POST, PUT, DELETE)
- path (string): endpoint path
- body (object, optional): static request body parts
- query (object, optional): query params
- params (object, optional): path parameters — keys match \`\{placeholder\}\` in the path

Example:
{
  "id": "fetch-lead",
  "type": "http.call",
  "config": { "service": "lead", "method": "POST", "path": "<endpoint to pull next lead from buffer>" },
  "inputMapping": { "body.campaignId": "$ref:flow_input.campaignId" },
  "retries": 0
}

## Flow Control Node Types

- "condition": if/then/else branching. Outgoing edges WITH a condition expression define branches (target nodes are nested inside that branch). Outgoing edges WITHOUT condition are after-branch steps that always execute after the branchone completes.
- "wait": delay. config: { seconds: number }
- "for-each": loop over items. config: { iterator: string (JS expression), parallel?: boolean, skipFailures?: boolean }

## Inline Script Node

Use "script" for small inline transforms (date stamping, normalisation, simple shape changes) when no microservice fits. Avoid for anything non-trivial — push real logic into a service instead.

- config.code (REQUIRED, string): a Windmill rawscript. MUST export an \`async function main(...)\` whose return value becomes the node's \`output\`, addressable via \`$ref:node-id.output.field\`.
- config.language (optional, default "bun"): "bun" | "deno". Windmill compiles to rawscript.
- inputMapping: declares the args of \`main\`. Each key in inputMapping becomes a positional argument of \`main\` in declaration order. Example: \`{ "first": "$ref:flow_input.firstName", "last": "$ref:flow_input.lastName" }\` → signature \`export async function main(first: string, last: string)\`.

Example — normalise a value before passing it on:

\`\`\`json
{
  "id": "normalise-domain",
  "type": "script",
  "config": {
    "code": "export async function main(url) { return { domain: new URL(url).hostname.replace(/^www\\\\./, '') }; }"
  },
  "inputMapping": { "url": "$ref:fetch-lead.output.lead.data.organization.websiteUrl" }
}
\`\`\`

Do NOT write a script node for the current date. \`currentDate\` (ISO \`YYYY-MM-DD\`) is supplied automatically on every execution — map it straight from \`"body.variables.currentDate": "$ref:flow_input.currentDate"\`. A node for it costs a Windmill step on every single run for a value the dispatcher already has.

## Input Mapping ($ref syntax)

Use inputMapping to pass dynamic data between nodes:
- "$ref:flow_input.fieldName" — from workflow execution inputs
- "$ref:node-id.output.fieldName" — from a previous node's output
- "$ref:node-id.output" — entire output of a previous node

Dot-notation keys create nested objects:
- "body.campaignId": "$ref:flow_input.campaignId" → body: { campaignId: ... }
- "body.metadata.source": "$ref:flow_input.source" → body: { metadata: { source: ... } }

Static body fields go in config.body, dynamic overrides go in inputMapping with dot-notation.

### Placeholders in examples

Examples below use natural-language placeholders like \`<path to X>\` for any value that lives in another service's OpenAPI spec (endpoint paths and response field paths). These are NOT literal strings — you MUST resolve every \`<...>\` against the endpoint docs injected later in this prompt and emit the actual JSON path. Emitting a literal \`<...>\` token in the final DAG is a hard failure.

For path parameters (e.g. \`/internal/brands/{brandId}\`), use \`params.*\` in inputMapping:
- "params.brandId": "$ref:start-run.output.<path to brandId in start-run response>" → replaces {brandId} in the path

### \`$ref\` resolution rule (HARD)

Every \`$ref\` path you emit MUST resolve against the endpoint docs injected below. Two distinct cases:

1. **Fixed-schema objects** (declared via \`properties\`): use the property names verbatim from the spec. NEVER invent a key. If the upstream node response declares \`data.organization.name\`, you MUST emit \`$ref:node.output.data.organization.name\` — not \`data.organizationName\`, not \`data.org.name\`, not \`data.organization_name\`. Resolution failure = validation error.

2. **Dynamic-key maps** (declared via \`additionalProperties\`): the keys are caller-chosen. Match the key you sent in the request body. Example: \`brand-extract-fields\` body sends \`fields: [{key: "companyOverview"}, ...]\` and the response is \`{fields: {<caller-key>: MultiBrandFieldValue}}\` — so \`$ref:brand-extract-fields.output.fields.companyOverview.value\` is valid (the key \`companyOverview\` was supplied in the body).

If a needed field is absent from a fixed-schema response, do NOT invent a path. Either pick a different upstream node that legitimately exposes the value, or omit the field. Inventing paths against fixed schemas is a hard failure.

The flattening in case 1 is not hypothetical — it is the mistake that has actually been made, on lead-service, seven times. lead-service \`POST /orgs/buffer/next\` serves the canonical lead under \`lead.data\` and the lead's employer under \`lead.data.organization\`, a NESTED object. So the person's job title is \`lead.data.currentTitle\` (there is no \`lead.data.title\`), and every company field hangs off the organization: \`lead.data.organization.name\`, \`.industry\`, \`.keywords\`, \`.technologyNames\`, \`.shortDescription\`, \`.latestFundingStage\`, \`.websiteUrl\`, and the head count is \`.estimatedNumEmployees\` (there is no \`.size\`). Never write \`lead.data.organizationName\` or any other flattened \`organization<Field>\` form: it renders as an empty string with no error and no log line, so the prompt silently reads \`Company: \` on every run. Read the doc below for the full set rather than working from this list.

## Special Config Keys (stripped before passing to script)

- retries (number): retry attempts on failure. Default 3. Set 0 for non-idempotent ops (email sends, SMS, queue consumes).
- stopAfterIf (string): JS expression using "result" variable. Stops the entire flow gracefully when true. No onError triggered. Example: "result.allowed == false"
- skipIf (string): JS expression using "results.<module_id>". Skips only this step when true. Example: "results.fetch_lead.found == false"
- validateResponse ({ field, equals }): throws error if response[field] !== equals, triggers onError handler.

${serviceSection}

## All Registered Node Types

${nodeTypes}

Prefer "http.call" over legacy named types for new workflows.

## Content Generation + Email Send Pattern

When using content-generation service (\`POST /generate\`):
- \`body.type\` MUST be "cold-email" (matches the registered prompt type) — do NOT use "email", "cold_outreach", or other variants
- **CRITICAL: \`body.variables\` MUST contain FLAT keys only.** Each variable must be a separate scalar mapping. NEVER pass an entire object like \`"body.variables.lead": "$ref:fetch-lead.output.lead"\`. Instead, map each field individually:
  - \`"body.variables.leadFirstName": "$ref:fetch-lead.output.<path to lead's first name>"\`
  - \`"body.variables.leadLastName": "$ref:fetch-lead.output.<path to lead's last name>"\`
  - \`"body.variables.leadTitle": "$ref:fetch-lead.output.<path to lead's job title or headline>"\`
  - \`"body.variables.leadEmail": "$ref:fetch-lead.output.<path to lead's email>"\`
  - \`"body.variables.leadCompanyName": "$ref:fetch-lead.output.<path to lead's company name>"\`
  - \`"body.variables.leadCompanyDomain": "$ref:fetch-lead.output.<path to lead's company domain>"\`
  - \`"body.variables.clientCompanyOverview": "$ref:brand-extract.output.fields.companyOverview.value"\`
  - \`"body.variables.clientValueProposition": "$ref:brand-extract.output.fields.valueProposition.value"\`
  - \`"body.variables.clientTargetAudience": "$ref:brand-extract.output.fields.targetAudience.value"\`
- **Map EVERY recipient-context variable the fetch node can satisfy, not only the ones the template body names.** content-generation publishes two separate lists on \`GET /platform-prompts\`: \`variables\` (tokens the stored body declares — each is required) and \`contextVariables\` (optional lead + organization facts every template accepts and renders into a "Recipient context" block ahead of the body). Providing a context variable is never over-providing. The full accepted set is: ${LEAD_CONTEXT_VARIABLE_NAMES}
  Map each one to the path the lead fetch node's response actually serves — the person's fields sit on the canonical lead, the employer's under its nested organization object. Omit any name that node's response declares no field for; never invent a path, and never substitute a default.
- Include tracking fields: \`body.brandId\`, \`body.campaignId\`, \`body.leadId\`, \`body.workflowSlug\`, \`body.apolloEnrichmentId\`
- Response contains \`subject\` (string) and \`sequence\` (array of { step, bodyHtml, bodyText, daysSinceLastStep })

When sending via email-gateway (\`POST /send\` with \`type: "broadcast"\`):
- Pass the ENTIRE \`sequence\` array from content-generation output: \`"body.sequence": "$ref:email-generate.output.<path to generated email sequence array>"\`
- Required fields: \`type\`, \`to\`, \`subject\`, \`sequence\`
- Optional personalization: \`recipientFirstName\`, \`recipientLastName\`, \`recipientCompany\`. Map each one when the fetch node's response declares that field for the recipient; omit any it does not serve. Never invent a path and never substitute a placeholder value.
- Also map \`body.timezone\` to the recipient's IANA timezone from the same node the recipient's email comes from: \`"body.timezone": "$ref:fetch-lead.output.<path to the recipient's timezone>"\`. It schedules the sequence in the prospect's local business hours. Omit it only when the fetch node's response declares no timezone field — never invent a path for it, and never substitute a default.
- The sequence is variable-length (LLM determines how many follow-up steps) — always pass it as-is

## Campaign Execution Model

A campaign is a sales funnel capped by a max budget and a max volume (proactive pipes) or an "Up to" cap (reactive pipes); every pipe of the funnel stops when the funnel's cap is reached. Campaign service dispatches the workflow of each pipe. Key concepts:
- Campaign service triggers the workflow (DAG) repeatedly, roughly every minute, until the cap is reached
- Each workflow run processes ONE unit of work (e.g. one lead, one email send, one reply)
- The gate-check step validates that the cap leaves room before each run — if not, it returns allowed=false and the flow stops gracefully via stopAfterIf
- The end-run step reports success/failure AND whether to stop the campaign:
  - stopCampaign: false → campaign-service automatically re-triggers the workflow
  - stopCampaign: true → this run's audience had nobody to serve (fetch-lead found == false). It stops NOTHING: campaign-service marks that one audience exhausted for a while and picks another on the next run
- Both "success" and "stopCampaign" are required fields in the /end-run body
- campaign-service reads orgId and campaignId from headers (x-org-id, x-campaign-id) — do NOT pass them in the body
- This is why campaign workflows MUST use the chassis pattern: gate-check → start-run → [business logic] → end-run, with onError → end-run-error

## Rules

1. Node IDs: unique, kebab-case, descriptive (e.g. "fetch-lead", "send-email", "check-status")
2. No cycles — edges must form a DAG
3. Every $ref must reference an existing node ID or flow_input
4. Set retries: 0 for non-idempotent operations (email sends, SMS, queue consumes)
5. Use onError for workflows that need cleanup on failure (e.g. mark run as failed via end-run)
6. Use "condition" nodes for branching, not skipIf (skipIf only skips one step)
7. The http.call node auto-injects orgId, userId, and serviceEnvs from flow_input — no need to map them
8. Campaign workflows MUST have THREE end-run nodes:
   - end-run (after successful business logic): { "success": true, "stopCampaign": false }
   - end-run-no-lead (when fetch-lead finds nothing): { "success": true, "stopCampaign": true }
   - end-run-error (onError handler): { "success": false, "stopCampaign": false }
   The success path and the no-lead path MUST end on DIFFERENT end-run nodes — one node shared by both can only say one thing, and an empty serve reported as stopCampaign: false keeps asking the same empty audience forever
   Do NOT pass orgId or campaignId in end-run body — campaign-service reads them from headers
9. NEVER include cost-tracking nodes in workflows. Cost tracking (run costs, usage metering) is handled internally by each downstream service — do NOT add steps that POST to runs-service /costs or any similar cost endpoint

## Example: Cold Email Outreach with Branching

\`\`\`json
{
  "nodes": [
    {
      "id": "gate-check",
      "type": "http.call",
      "config": { "service": "campaign", "method": "POST", "path": "<endpoint to gate-check campaign budget>", "stopAfterIf": "result.allowed == false" },
      "inputMapping": { "body.campaignId": "$ref:flow_input.campaignId", "body.orgId": "$ref:flow_input.orgId" }
    },
    {
      "id": "start-run",
      "type": "http.call",
      "config": { "service": "campaign", "method": "POST", "path": "<endpoint to start a campaign run>" },
      "inputMapping": { "body.campaignId": "$ref:flow_input.campaignId", "body.orgId": "$ref:flow_input.orgId" }
    },
    {
      "id": "fetch-lead",
      "type": "http.call",
      "config": { "service": "lead", "method": "POST", "path": "<endpoint to pull next lead from buffer>" },
      "inputMapping": { "body.campaignId": "$ref:flow_input.campaignId", "body.orgId": "$ref:start-run.output.<path to orgId in start-run response>" },
      "retries": 0
    },
    { "id": "check-lead", "type": "condition" },
    {
      "id": "brand-extract",
      "type": "http.call",
      "config": {
        "service": "brand",
        "method": "POST",
        "path": "<endpoint to extract fields from one or more brands via AI>",
        "body": {
          "fields": [
            { "key": "companyOverview", "description": "A 2-3 sentence neutral summary of what the company does, who it serves, and its main product or service. Written in third person. No marketing language." },
            { "key": "valueProposition", "description": "The single sharpest reason a customer would pick this company over alternatives. One sentence. Outcome-focused (what the customer gets), not feature-focused." },
            { "key": "targetAudience", "description": "The ideal customer profile as an array of strings. Each string is one distinct ICP segment (job title, company size, industry, or use case). Return 1-5 segments." }
          ]
        }
      },
      "inputMapping": { "brandId": "$ref:start-run.output.<path to brandId in start-run response>" }
    },
    {
      "id": "email-generate",
      "type": "http.call",
      "config": { "service": "content-generation", "method": "POST", "path": "<endpoint to generate content>", "body": { "type": "cold-email", "includeAiDisclaimer": true } },
      "inputMapping": {
        "body.brandId": "$ref:start-run.output.<path to brandId in start-run response>",
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.leadId": "$ref:fetch-lead.output.<path to leadId in fetch-lead response>",
        "body.workflowSlug": "$ref:start-run.output.<path to workflowSlug in start-run response>",
        "body.apolloEnrichmentId": "$ref:fetch-lead.output.<path to apollo person/enrichment id in fetch-lead response>",
        "body.variables.leadEmail": "$ref:fetch-lead.output.<path to lead's email>",
        "body.variables.leadFirstName": "$ref:fetch-lead.output.<path to lead's first name>",
        "body.variables.leadLastName": "$ref:fetch-lead.output.<path to lead's last name>",
        "body.variables.leadTitle": "$ref:fetch-lead.output.<path to lead's job title or headline>",
        "body.variables.leadCompanyName": "$ref:fetch-lead.output.<path to lead's company name>",
        "body.variables.leadCompanyDomain": "$ref:fetch-lead.output.<path to lead's company domain>",
        "body.variables.clientBrandUrl": "$ref:start-run.output.<path to brand url in start-run response>",
        "body.variables.clientCompanyOverview": "$ref:brand-extract.output.fields.companyOverview.value",
        "body.variables.clientValueProposition": "$ref:brand-extract.output.fields.valueProposition.value",
        "body.variables.clientTargetAudience": "$ref:brand-extract.output.fields.targetAudience.value"
      },
      "retries": 0
    },
    {
      "id": "email-send",
      "type": "http.call",
      "config": { "service": "email-gateway", "method": "POST", "path": "<endpoint to send a broadcast email>", "body": { "type": "broadcast", "tag": "cold-email" }, "validateResponse": { "field": "success", "equals": true } },
      "inputMapping": {
        "body.to": "$ref:fetch-lead.output.<path to lead's email>",
        "body.subject": "$ref:email-generate.output.<path to generated subject>",
        "body.sequence": "$ref:email-generate.output.<path to generated email sequence array>",
        "body.leadId": "$ref:fetch-lead.output.<path to leadId in fetch-lead response>",
        "body.brandId": "$ref:start-run.output.<path to brandId in start-run response>",
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.workflowSlug": "$ref:start-run.output.<path to workflowSlug in start-run response>",
        "body.recipientFirstName": "$ref:fetch-lead.output.<path to lead's first name>",
        "body.recipientLastName": "$ref:fetch-lead.output.<path to lead's last name>",
        "body.recipientCompany": "$ref:fetch-lead.output.<path to lead's company name>",
        "body.timezone": "$ref:fetch-lead.output.<path to lead's IANA timezone>"
      },
      "retries": 0
    },
    {
      "id": "end-run",
      "type": "http.call",
      "config": { "service": "campaign", "method": "POST", "path": "<endpoint to end a campaign run>", "body": { "success": true, "stopCampaign": false } }
    },
    {
      "id": "end-run-no-lead",
      "type": "http.call",
      "config": { "service": "campaign", "method": "POST", "path": "<endpoint to end a campaign run>", "body": { "success": true, "stopCampaign": true } }
    },
    {
      "id": "end-run-error",
      "type": "http.call",
      "config": { "service": "campaign", "method": "POST", "path": "<endpoint to end a campaign run>", "body": { "success": false, "stopCampaign": false } }
    }
  ],
  "edges": [
    { "from": "gate-check", "to": "start-run" },
    { "from": "start-run", "to": "fetch-lead" },
    { "from": "fetch-lead", "to": "check-lead" },
    { "from": "check-lead", "to": "brand-extract", "condition": "results.fetch_lead.found == true" },
    { "from": "brand-extract", "to": "email-generate" },
    { "from": "email-generate", "to": "email-send" },
    { "from": "email-send", "to": "end-run" },
    { "from": "check-lead", "to": "end-run-no-lead" }
  ],
  "onError": "end-run-error"
}
\`\`\`

## Example: Simple For-Each Loop

\`\`\`json
{
  "nodes": [
    { "id": "fetch-contacts", "type": "http.call", "config": { "service": "client", "method": "GET", "path": "<endpoint to list contacts/users>" } },
    { "id": "loop-contacts", "type": "for-each", "config": { "iterator": "results.fetch_contacts.<path to array of contacts in fetch-contacts response>", "parallel": false } },
    { "id": "send-email", "type": "http.call", "config": { "service": "transactional-email", "method": "POST", "path": "<endpoint to send a transactional email>" }, "inputMapping": { "body.recipientEmail": "$ref:loop-contacts.output.<path to email field on the iterated contact>" }, "retries": 0 }
  ],
  "edges": [
    { "from": "fetch-contacts", "to": "loop-contacts" },
    { "from": "loop-contacts", "to": "send-email" }
  ]
}
\`\`\`

## Output Format

You MUST respond with a JSON object matching this exact shape:

\`\`\`json
{
  "description": "Human-readable description of what this workflow does on its pipe (1-2 sentences)",
  "dag": "the DAG serialized as ONE JSON string"
}
\`\`\`

\`dag\` is a STRING holding the JSON of the DAG object, \`{ "nodes": [{ "id", "type", "config", "inputMapping", "retries" }], "edges": [{ "from", "to", "condition" }], "onError" }\`, escaped as any JSON string is. It is parsed with JSON.parse, so it must be exactly one valid JSON object and nothing else.

Generate a single workflow DAG for the pipe above that fulfills the user's description. Return ONLY the JSON object, no explanation.`;
}

export function buildRetryUserMessage(
  originalDescription: string,
  validationErrors: Array<{ field: string; message: string }>,
): string {
  const errorList = validationErrors
    .map((e) => `- ${e.field}: ${e.message}`)
    .join("\n");

  return `The DAG you generated was invalid. Fix these errors and try again:

${errorList}

Original request: ${originalDescription}`;
}

// --- Discovery calls (levels 1 and 2), made before the DAG is written -----------------------

/** Services the generator never offers: api-service is a proxy, the DAG calls the service behind it. */
export const HIDDEN_SERVICES: ReadonlySet<string> = new Set(["api", "api-registry"]);

export interface ServicePickPromptOptions {
  /** The resolved pipe, or null while the model still has to choose among `candidatePipes`. */
  pipeContext: PipeContext | null;
  candidatePipes: CataloguePipeSummary[];
  services: DiscoveredService[];
}

/**
 * Call 1 of 3: the model reads level 1 (one line per service) and names the services the workflow
 * needs. When the channel has several pipes and the caller named none, it also picks the pipe.
 */
export function buildServicePickPrompt(options: ServicePickPromptOptions): string {
  const { pipeContext, candidatePipes, services } = options;
  const serviceList = services
    .filter((s) => !HIDDEN_SERVICES.has(s.name))
    .map((s) => `- **${s.name}**: ${s.description}`)
    .join("\n");
  const pipeBlock = pipeContext
    ? pipeSection(pipeContext)
    : `## Pick The Pipe

The workflow runs on exactly ONE of these pipes of its channel. Pick the one the user's description is about:

${candidatePipes.map((p) => `- \`${p.id}\` (${p.mode}): ${p.line}`).join("\n")}`;
  const pipeField = pipeContext ? "" : `\n  "pipeId": "one pipe id from the list above",`;

  return `You are a workflow architect planning a workflow before you write it.

${DISTRIBUTE_MODEL_VOCABULARY}

${pipeBlock}

## Services

${serviceList}

## Your Task

Name every service the workflow will call. A campaign workflow always needs "campaign" (gate-check, start-run, end-run). Pick only services you will actually call; you will see their endpoints next.

## Output Format

Return ONLY this JSON object:

\`\`\`json
{${pipeField}
  "services": ["service name", "..."]
}
\`\`\``;
}

export interface EndpointPickPromptOptions {
  pipeContext: PipeContext;
  endpoints: DiscoverServiceEndpointsResponse[];
}

/** Call 2 of 3: the model reads level 2 (endpoints with measured cost, success, ROI) and picks the ones it will call. */
export function buildEndpointPickPrompt(options: EndpointPickPromptOptions): string {
  const listing = options.endpoints
    .map((svc) => {
      const rows = svc.endpoints
        .map((e) => `  - ${e.method} ${e.path}: ${e.summary}${e.stats || e.roi ? ` ${JSON.stringify({ stats: e.stats, roi: e.roi })}` : ""}`)
        .join("\n");
      return `### ${svc.service}: ${svc.description}\n${rows}`;
    })
    .join("\n\n");

  return `You are a workflow architect planning a workflow before you write it.

${DISTRIBUTE_MODEL_VOCABULARY}

${pipeSection(options.pipeContext)}

## Endpoints

Each endpoint shows its measured stats (success rate, average cost and duration per run) and, when it produces a step, its ROI. Prefer the endpoints that do the job at the best measured cost.

${listing}

## Your Task

Pick every endpoint the workflow will call, including the campaign chassis (gate-check, start-run, end-run). You will receive the full doc of exactly these endpoints next, and nothing else.

## Output Format

Return ONLY this JSON object:

\`\`\`json
{
  "endpoints": [{ "service": "service name", "method": "POST", "path": "/path/exactly/as/listed" }]
}
\`\`\``;
}
