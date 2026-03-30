import { validateDAG, type DAG } from "./dag-validator.js";
import {
  buildSystemPrompt,
  buildRetryUserMessage,
  type ServiceContext,
} from "./prompt-templates.js";
import {
  fetchLlmContext,
  fetchSpecsForServices,
} from "./api-registry-client.js";
import { extractHttpEndpoints } from "./extract-http-endpoints.js";
import { validateWorkflowEndpoints } from "./validate-workflow-endpoints.js";
import type { IdentityHeaders } from "./key-service-client.js";
import {
  chatServiceComplete,
  type ChatServiceCompleteRequest,
  type ChatServiceCompleteResponse,
  type ChatServiceIdentity,
} from "./chat-service-client.js";

export interface GenerateWorkflowInput {
  description: string;
  hints?: {
    services?: string[];
    nodeTypes?: string[];
    expectedInputs?: string[];
  };
  style?: {
    type: "human" | "brand";
    name: string;
    humanId?: string;
    brandId?: string;
  };
}

export interface GenerateWorkflowResult {
  dag: DAG;
  category: string;
  channel: string;
  audienceType: string;
  description: string;
}

const MAX_RETRIES = 2;

let overrideCompleteFn: ((req: ChatServiceCompleteRequest, id: ChatServiceIdentity) => Promise<ChatServiceCompleteResponse>) | null = null;

/** Exported for testing — allows injecting a mock chat-service client */
export function setChatServiceClient(fn: typeof overrideCompleteFn): void {
  overrideCompleteFn = fn;
}

async function callComplete(
  request: ChatServiceCompleteRequest,
  identity: ChatServiceIdentity,
): Promise<ChatServiceCompleteResponse> {
  if (overrideCompleteFn) return overrideCompleteFn(request, identity);
  return chatServiceComplete(request, identity);
}

async function fetchServiceContext(identity: IdentityHeaders): Promise<ServiceContext> {
  const context = await fetchLlmContext(identity);
  const serviceNames = context.services.map((s: { service: string }) => s.service);
  const specsMap = await fetchSpecsForServices(serviceNames, identity);

  const specs: Record<string, unknown> = {};
  for (const [name, spec] of specsMap) specs[name] = spec;

  return {
    services: context.services.map((s: { service: string; description?: string; endpointCount: number }) => ({
      name: s.service,
      description: s.description ?? "",
      endpointCount: s.endpointCount,
    })),
    specs,
  };
}

export async function generateWorkflow(
  input: GenerateWorkflowInput,
  identity: IdentityHeaders,
): Promise<GenerateWorkflowResult> {
  if (!process.env.API_REGISTRY_SERVICE_URL || !process.env.API_REGISTRY_SERVICE_API_KEY) {
    throw new Error(
      "API_REGISTRY_SERVICE_URL and API_REGISTRY_SERVICE_API_KEY must be set to generate workflows",
    );
  }

  // Pre-fetch all service context upfront
  const serviceContext = await fetchServiceContext(identity);

  const styleDirective = input.style
    ? `This workflow MUST be created in the style of ${input.style.name}. Adopt their methodology, tone, and strategic patterns.`
    : undefined;

  const systemPrompt = buildSystemPrompt({ styleDirective, serviceContext });

  let userMessage = input.description;
  if (input.hints?.services?.length) {
    userMessage += `\n\nRelevant services: ${input.hints.services.join(", ")}`;
  }
  if (input.hints?.nodeTypes?.length) {
    userMessage += `\nPreferred node types: ${input.hints.nodeTypes.join(", ")}`;
  }
  if (input.hints?.expectedInputs?.length) {
    userMessage += `\nExpected flow_input fields: ${input.hints.expectedInputs.join(", ")}`;
  }
  if (input.style) {
    userMessage += `\n\nStyle: Generate this workflow in the style of "${input.style.name}".`;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await callComplete(
      {
        message: userMessage,
        systemPrompt,
        responseFormat: "json",
        maxTokens: 16384,
        model: "claude-sonnet-4-6",
      },
      identity,
    );

    if (!response.json) {
      throw new Error("LLM did not return valid JSON");
    }

    const result = response.json as {
      category: string;
      channel: string;
      audienceType: string;
      description: string;
      dag: DAG;
    };

    const validation = validateDAG(result.dag);

    if (validation.valid) {
      // Also validate endpoint fields against API registry
      const httpEndpoints = extractHttpEndpoints(result.dag);
      if (httpEndpoints.length > 0) {
        try {
          const serviceNames = [...new Set(httpEndpoints.map((e) => e.service))];
          const specs = await fetchSpecsForServices(serviceNames, identity);
          const endpointResult = validateWorkflowEndpoints(result.dag, specs);

          if (!endpointResult.valid) {
            const fieldErrors = [
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

            if (attempt >= MAX_RETRIES) {
              throw new GenerationValidationError(
                "Generated DAG has invalid endpoint fields after retries",
                fieldErrors,
              );
            }

            userMessage = buildRetryUserMessage(input.description, fieldErrors);
            continue;
          }
        } catch (err) {
          if (err instanceof GenerationValidationError) throw err;
          console.warn("[workflow-service] generate: field validation skipped:", err);
        }
      }

      return {
        dag: result.dag,
        category: result.category,
        channel: result.channel,
        audienceType: result.audienceType,
        description: result.description,
      };
    }

    if (attempt >= MAX_RETRIES) {
      throw new GenerationValidationError(
        "Generated DAG is invalid after retries",
        validation.errors,
      );
    }

    userMessage = buildRetryUserMessage(input.description, validation.errors);
  }

  throw new Error("Generation exceeded maximum retries without producing a workflow");
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
