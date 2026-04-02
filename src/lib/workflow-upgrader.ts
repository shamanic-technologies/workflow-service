import { validateDAG, type DAG } from "./dag-validator.js";
import {
  buildUpgradeSystemPrompt,
  buildRetryUserMessage,
  type ServiceContext,
} from "./prompt-templates.js";
import {
  fetchLlmContext,
  fetchSpecsForServices,
} from "./api-registry-client.js";
import type { DownstreamHeaders } from "./downstream-headers.js";
import type { InvalidEndpoint, FieldValidationIssue } from "./validate-workflow-endpoints.js";
import {
  chatServiceComplete,
  chatServicePlatformComplete,
  type ChatServiceCompleteRequest,
  type ChatServiceCompleteResponse,
} from "./chat-service-client.js";

const MAX_RETRIES = 2;

let overrideCompleteFn: ((req: ChatServiceCompleteRequest, h?: DownstreamHeaders) => Promise<ChatServiceCompleteResponse>) | null = null;

/** Exported for testing — allows injecting a mock chat-service client */
export function setUpgradeChatServiceClient(fn: typeof overrideCompleteFn): void {
  overrideCompleteFn = fn;
}

async function callComplete(
  request: ChatServiceCompleteRequest,
  downstreamHeaders?: DownstreamHeaders,
): Promise<ChatServiceCompleteResponse> {
  if (overrideCompleteFn) return overrideCompleteFn(request, downstreamHeaders);
  if (downstreamHeaders) return chatServiceComplete(request, downstreamHeaders);
  return chatServicePlatformComplete(request);
}

async function fetchServiceContext(
  invalidEndpoints: InvalidEndpoint[],
  fieldErrors: FieldValidationIssue[],
  downstreamHeaders?: DownstreamHeaders,
): Promise<ServiceContext> {
  // Fetch specs for all services referenced in broken endpoints and field errors
  const serviceNames = new Set<string>();
  for (const ep of invalidEndpoints) serviceNames.add(ep.service);
  for (const fe of fieldErrors) serviceNames.add(fe.service);

  let services: Array<{ name: string; description: string; endpointCount: number }> = [];
  try {
    const context = await fetchLlmContext(downstreamHeaders);
    services = context.services.map((s: { service: string; description?: string; endpointCount: number }) => ({
      name: s.service,
      description: s.description ?? "",
      endpointCount: s.endpointCount,
    }));
    // Also add all service names from the context so the LLM can find replacements
    for (const s of context.services) serviceNames.add(s.service);
  } catch {
    // Non-blocking — proceed with just the broken service specs
  }

  const specsMap = await fetchSpecsForServices([...serviceNames], downstreamHeaders);
  const specs: Record<string, unknown> = {};
  for (const [name, spec] of specsMap) specs[name] = spec;

  return { services, specs };
}

export interface UpgradeWorkflowResult {
  dag: DAG;
  category: string;
  channel: string;
  audienceType: string;
  description: string;
}

export async function upgradeWorkflow(
  currentDag: DAG,
  invalidEndpoints: InvalidEndpoint[],
  fieldErrors: FieldValidationIssue[],
  downstreamHeaders: DownstreamHeaders | undefined,
  metadata: { category: string; channel: string; audienceType: string; description: string },
): Promise<UpgradeWorkflowResult> {
  // Pre-fetch service context
  const serviceContext = await fetchServiceContext(invalidEndpoints, fieldErrors, downstreamHeaders);

  const systemPrompt = buildUpgradeSystemPrompt({
    currentDag: currentDag as unknown as Record<string, unknown>,
    invalidEndpoints,
    fieldErrors,
    serviceContext,
  });

  let userMessage = `Fix this workflow. The category is "${metadata.category}", channel is "${metadata.channel}", audienceType is "${metadata.audienceType}". Description: "${metadata.description}". Fix the broken endpoints and field errors listed above.`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await callComplete(
      {
        message: userMessage,
        systemPrompt,
        responseFormat: "json",
        maxTokens: 16384,
        provider: "google",
        model: "pro",
      },
      downstreamHeaders,
    );

    if (!response.json) {
      throw new Error("LLM did not return valid JSON during upgrade");
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
      return {
        dag: result.dag,
        category: result.category,
        channel: result.channel,
        audienceType: result.audienceType,
        description: result.description,
      };
    }

    if (attempt >= MAX_RETRIES) {
      throw new UpgradeValidationError(
        "Upgraded DAG is invalid after retries",
        validation.errors,
      );
    }

    userMessage = buildRetryUserMessage(userMessage, validation.errors);
  }

  throw new Error("Upgrade exceeded maximum retries without producing a corrected workflow");
}

export class UpgradeValidationError extends Error {
  public readonly validationErrors: Array<{ field: string; message: string }>;

  constructor(
    message: string,
    errors: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = "UpgradeValidationError";
    this.validationErrors = errors;
  }
}
