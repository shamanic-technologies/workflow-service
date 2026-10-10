import { validateDAG, type DAG } from "./dag-validator.js";
import {
  buildSystemPrompt,
  buildRetryUserMessage,
  buildServicePickPrompt,
  buildEndpointPickPrompt,
  HIDDEN_SERVICES,
  type PipeContext,
} from "./prompt-templates.js";
import {
  discoverServices,
  discoverServiceEndpoints,
  discoverEndpoint,
  fetchSpecsForServices,
  type DiscoverServiceEndpointsResponse,
} from "./api-registry-client.js";
import {
  fetchPipe,
  fetchChannelPipes,
  fetchStep,
  PipeResolutionError,
  type CataloguePipe,
  type CataloguePipeSummary,
} from "./catalogue-client.js";
import { extractHttpEndpoints } from "./extract-http-endpoints.js";
import { validateWorkflowEndpoints } from "./validate-workflow-endpoints.js";
import type { DownstreamHeaders } from "./downstream-headers.js";
import {
  chatServiceComplete,
  type ChatServiceCompleteRequest,
  type ChatServiceCompleteResponse,
} from "./chat-service-client.js";

/**
 * Workflow generation runs on Anthropic (owner 2026-10-10: "si pas Anthropic alors il faut passer
 * à Anthropic"). `opus` is chat-service's version-free alias for its Opus-class model (Claude Opus
 * 5.5 today); chat-service resolves the version, this repo never names one.
 */
export const GENERATION_LLM = { provider: "anthropic", model: "opus" } as const;

/** Output budgets. Opus always reasons, and its reasoning is billed as output, so the caps leave room for it. */
const PICK_MAX_TOKENS = 8_000;
const DAG_MAX_TOKENS = 32_000;

export interface GenerateWorkflowInput {
  description: string;
  /** The workflow's channel slug (features-service). Its pipes are the candidates. */
  featureSlug: string;
  /** The pipe to generate for (`<channel slug>|<leg key>`). Omit when the channel has one pipe, or to let the model pick. */
  pipeId?: string;
  hints?: {
    services?: string[];
    nodeTypes?: string[];
    expectedInputs?: string[];
  };
}

export interface GeneratedPipe {
  id: string;
  channelSlug: string;
  legKey: string;
  mode: "proactive" | "reactive";
  triggerId: string | null;
  /** The step the pipe produces (its toStep), as the catalogue serves it. */
  toStep: string;
}

export interface GenerationUsage {
  calls: number;
  tokensInput: number;
  tokensOutput: number;
  /** Characters of every system prompt sent, summed: what the context window carried. */
  systemPromptChars: number;
}

export interface GenerateWorkflowResult {
  dag: DAG;
  description: string;
  pipe: GeneratedPipe;
  /** The features-service step this workflow produces: its pipe's toStep. */
  producesStep: string;
  usage: GenerationUsage;
}

const MAX_RETRIES = 2;

let overrideCompleteFn: ((req: ChatServiceCompleteRequest, h: DownstreamHeaders) => Promise<ChatServiceCompleteResponse>) | null = null;

/** Exported for testing — allows injecting a mock chat-service client */
export function setChatServiceClient(fn: typeof overrideCompleteFn): void {
  overrideCompleteFn = fn;
}

async function callComplete(
  request: ChatServiceCompleteRequest,
  downstreamHeaders: DownstreamHeaders,
): Promise<ChatServiceCompleteResponse> {
  if (overrideCompleteFn) return overrideCompleteFn(request, downstreamHeaders);
  return chatServiceComplete(request, downstreamHeaders);
}

type FieldError = { field: string; message: string };
type CheckResult<T> = { value: T } | { errors: FieldError[] };

// Anthropic enforces JSON output only through a strict schema (every object closed, every property
// required). A DAG's node `config` and `inputMapping` are open maps a strict schema cannot express,
// so the DAG travels as a JSON STRING and is parsed here.
const STRING_ARRAY = { type: "array", items: { type: "string" } };
function servicesSchema(withPipe: boolean): Record<string, unknown> {
  return withPipe
    ? { type: "object", additionalProperties: false, required: ["pipeId", "services"], properties: { pipeId: { type: "string" }, services: STRING_ARRAY } }
    : { type: "object", additionalProperties: false, required: ["services"], properties: { services: STRING_ARRAY } };
}
const ENDPOINTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["endpoints"],
  properties: {
    endpoints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["service", "method", "path"],
        properties: { service: { type: "string" }, method: { type: "string" }, path: { type: "string" } },
      },
    },
  },
};
const DAG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["description", "dag"],
  properties: { description: { type: "string" }, dag: { type: "string" } },
};

/**
 * One JSON call with up to MAX_RETRIES corrections. `check` returns the parsed value, or the
 * errors to send back to the model.
 */
async function askJson<T>(
  systemPrompt: string,
  message: string,
  responseSchema: Record<string, unknown>,
  maxTokens: number,
  check: (json: Record<string, unknown>) => CheckResult<T> | Promise<CheckResult<T>>,
  usage: GenerationUsage,
  downstreamHeaders: DownstreamHeaders,
  failure: string,
): Promise<T> {
  let userMessage = message;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await callComplete(
      { message: userMessage, systemPrompt, responseFormat: "json", responseSchema, maxTokens, ...GENERATION_LLM },
      downstreamHeaders,
    );
    usage.calls += 1;
    usage.tokensInput += response.tokensInput;
    usage.tokensOutput += response.tokensOutput;
    usage.systemPromptChars += systemPrompt.length;
    if (!response.json) throw new Error("LLM did not return valid JSON");
    const result = await check(response.json);
    if ("value" in result) return result.value;
    if (attempt >= MAX_RETRIES) throw new GenerationValidationError(failure, result.errors);
    userMessage = buildRetryUserMessage(message, result.errors);
  }
  throw new Error("Generation exceeded maximum retries");
}

async function pipeContextOf(pipe: CataloguePipe, downstreamHeaders: DownstreamHeaders): Promise<PipeContext> {
  if (pipe.operatedBy === "customer") {
    throw new PipeResolutionError(`Pipe "${pipe.id}" is worked by the customer's own team: no workflow runs on it`);
  }
  const [fromStep, toStep] = await Promise.all([
    fetchStep(pipe.fromStep, downstreamHeaders),
    fetchStep(pipe.toStep, downstreamHeaders),
  ]);
  return { pipe, fromStep, toStep };
}

export async function generateWorkflow(
  input: GenerateWorkflowInput,
  downstreamHeaders: DownstreamHeaders,
): Promise<GenerateWorkflowResult> {
  if (!process.env.API_REGISTRY_SERVICE_URL || !process.env.API_REGISTRY_SERVICE_API_KEY) {
    throw new Error(
      "API_REGISTRY_SERVICE_URL and API_REGISTRY_SERVICE_API_KEY must be set to generate workflows",
    );
  }
  const usage: GenerationUsage = { calls: 0, tokensInput: 0, tokensOutput: 0, systemPromptChars: 0 };

  // ── The pipe ────────────────────────────────────────────────────────────────────────────────
  let pipeContext: PipeContext | null = null;
  let candidates: CataloguePipeSummary[] = [];
  if (input.pipeId) {
    const pipe = await fetchPipe(input.pipeId, downstreamHeaders);
    if (pipe.channelSlug !== input.featureSlug) {
      throw new PipeResolutionError(
        `Pipe "${pipe.id}" belongs to channel "${pipe.channelSlug}", not to featureSlug "${input.featureSlug}"`,
      );
    }
    pipeContext = await pipeContextOf(pipe, downstreamHeaders);
  } else {
    candidates = await fetchChannelPipes(input.featureSlug, downstreamHeaders);
    if (candidates.length === 0) {
      throw new PipeResolutionError(
        `featureSlug "${input.featureSlug}" has no pipe in the features-service catalogue: a workflow runs on one pipe (pass pipeId)`,
      );
    }
    if (candidates.length === 1) {
      pipeContext = await pipeContextOf(await fetchPipe(candidates[0].id, downstreamHeaders), downstreamHeaders);
    }
  }

  // ── Call 1: services (level 1), and the pipe when the channel has several ───────────────────
  const level1 = await discoverServices(downstreamHeaders);
  const offered = new Set(level1.services.filter((s) => !HIDDEN_SERVICES.has(s.name) && !s.error).map((s) => s.name));
  let pickMessage = input.description;
  if (input.hints?.services?.length) pickMessage += `\n\nRelevant services: ${input.hints.services.join(", ")}`;

  const picked = await askJson(
    buildServicePickPrompt({ pipeContext, candidatePipes: candidates, services: level1.services.filter((s) => offered.has(s.name)) }),
    pickMessage,
    servicesSchema(!pipeContext),
    PICK_MAX_TOKENS,
    (json): CheckResult<{ services: string[]; pipeId: string | null }> => {
      const errors: FieldError[] = [];
      const services = Array.isArray(json.services) ? json.services.filter((s): s is string => typeof s === "string") : [];
      if (services.length === 0) errors.push({ field: "services", message: "Name at least one service." });
      for (const s of services) {
        if (!offered.has(s)) errors.push({ field: "services", message: `"${s}" is not one of the listed services.` });
      }
      let pipeId: string | null = null;
      if (!pipeContext) {
        pipeId = typeof json.pipeId === "string" ? json.pipeId : null;
        if (!pipeId || !candidates.some((c) => c.id === pipeId)) {
          errors.push({ field: "pipeId", message: `Pick one of: ${candidates.map((c) => c.id).join(", ")}.` });
        }
      }
      return errors.length ? { errors } : { value: { services: [...new Set(services)], pipeId } };
    },
    usage,
    downstreamHeaders,
    "Generator could not name the services the workflow needs",
  );
  if (!pipeContext) {
    pipeContext = await pipeContextOf(await fetchPipe(picked.pipeId!, downstreamHeaders), downstreamHeaders);
  }
  const ctx: PipeContext = pipeContext;

  // ── Call 2: endpoints (level 2: measured cost, success, ROI) ────────────────────────────────
  const level2: DiscoverServiceEndpointsResponse[] = await Promise.all(
    picked.services.map((s) => discoverServiceEndpoints(s, downstreamHeaders)),
  );
  const listed = new Set(level2.flatMap((svc) => svc.endpoints.map((e) => `${svc.service} ${e.method} ${e.path}`)));

  const chosen = await askJson(
    buildEndpointPickPrompt({ pipeContext: ctx, endpoints: level2 }),
    input.description,
    ENDPOINTS_SCHEMA,
    PICK_MAX_TOKENS,
    (json): CheckResult<Array<{ service: string; method: string; path: string }>> => {
      const raw = Array.isArray(json.endpoints) ? json.endpoints : [];
      const endpoints = raw.flatMap((e) => {
        const r = e as { service?: unknown; method?: unknown; path?: unknown };
        return typeof r.service === "string" && typeof r.method === "string" && typeof r.path === "string"
          ? [{ service: r.service, method: r.method.toUpperCase(), path: r.path }]
          : [];
      });
      const errors: FieldError[] = [];
      if (endpoints.length === 0) errors.push({ field: "endpoints", message: "Pick at least one endpoint." });
      for (const e of endpoints) {
        if (!listed.has(`${e.service} ${e.method} ${e.path}`)) {
          errors.push({ field: "endpoints", message: `${e.method} ${e.service}${e.path} is not in the listing.` });
        }
      }
      const unique = [...new Map(endpoints.map((e) => [`${e.service} ${e.method} ${e.path}`, e])).values()];
      return errors.length ? { errors } : { value: unique };
    },
    usage,
    downstreamHeaders,
    "Generator could not pick the endpoints the workflow calls",
  );

  // ── Call 3: the DAG, from the full doc (level 3) of the picked endpoints only ───────────────
  const docs = await Promise.all(
    chosen.map((e) => discoverEndpoint(e.service, e.method, e.path, downstreamHeaders)),
  );
  const systemPrompt = buildSystemPrompt({ pipeContext: ctx, endpointDocs: { docs } });

  let dagMessage = input.description;
  if (input.hints?.nodeTypes?.length) dagMessage += `\nPreferred node types: ${input.hints.nodeTypes.join(", ")}`;
  if (input.hints?.expectedInputs?.length) dagMessage += `\nExpected flow_input fields: ${input.hints.expectedInputs.join(", ")}`;

  // The endpoint check reads the full specs of the services the DAG calls; they are never sent to the model.
  const generated = await askJson(
    systemPrompt,
    dagMessage,
    DAG_SCHEMA,
    DAG_MAX_TOKENS,
    async (json): Promise<CheckResult<{ dag: DAG; description: string }>> => {
      let dag: DAG;
      try {
        if (typeof json.dag !== "string") throw new Error("not a string");
        dag = JSON.parse(json.dag) as DAG;
      } catch (err) {
        return { errors: [{ field: "dag", message: `dag must be ONE JSON string that JSON.parse reads as the DAG object (${(err as Error).message}).` }] };
      }
      const description = typeof json.description === "string" ? json.description : "";
      const validation = validateDAG(dag);
      if (!validation.valid) return { errors: validation.errors };
      const fieldErrors = await endpointFieldErrors(dag, downstreamHeaders);
      if (fieldErrors.length) return { errors: fieldErrors };
      if (!description) return { errors: [{ field: "description", message: "Describe what the workflow does on its pipe." }] };
      return { value: { dag, description } };
    },
    usage,
    downstreamHeaders,
    "Generated DAG is invalid after retries",
  );

  console.log(
    `[workflow-service] generate: pipe=${ctx.pipe.id} producesStep=${ctx.toStep.id} model=${GENERATION_LLM.provider}/${GENERATION_LLM.model} ` +
      `calls=${usage.calls} tokensIn=${usage.tokensInput} tokensOut=${usage.tokensOutput} systemPromptChars=${usage.systemPromptChars}`,
  );

  return {
    dag: generated.dag,
    description: generated.description,
    pipe: {
      id: ctx.pipe.id,
      channelSlug: ctx.pipe.channelSlug,
      legKey: ctx.pipe.legKey,
      mode: ctx.pipe.mode,
      triggerId: ctx.pipe.triggerId,
      toStep: ctx.pipe.toStep,
    },
    producesStep: ctx.toStep.id,
    usage,
  };
}

/** Endpoint + body-field check against the full specs of the services the DAG calls. */
async function endpointFieldErrors(dag: DAG, downstreamHeaders: DownstreamHeaders): Promise<FieldError[]> {
  const httpEndpoints = extractHttpEndpoints(dag);
  if (httpEndpoints.length === 0) return [];
  const serviceNames = [...new Set(httpEndpoints.map((e) => e.service))];
  const specs = await fetchSpecsForServices(serviceNames, downstreamHeaders);
  const endpointResult = validateWorkflowEndpoints(dag, specs);
  if (endpointResult.valid) return [];
  return [
    ...endpointResult.invalidEndpoints.map((e) => ({
      field: `${e.method} ${e.service}${e.path}`,
      message: e.reason,
    })),
    ...endpointResult.fieldIssues
      .filter((f) => f.severity === "error")
      .map((f) => ({
        field: `nodes[${f.nodeId}].${f.field}`,
        message: f.reason,
      })),
  ];
}

export class GenerationValidationError extends Error {
  public readonly validationErrors: Array<{ field: string; message: string }>;

  constructor(
    message: string,
    errors: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = "GenerationValidationError";
    this.validationErrors = errors;
  }
}
