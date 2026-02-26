import Anthropic from "@anthropic-ai/sdk";
import { validateDAG, type DAG } from "./dag-validator.js";
import {
  buildSystemPrompt,
  buildRetryUserMessage,
  DAG_GENERATION_TOOL,
} from "./prompt-templates.js";

export interface GenerateWorkflowInput {
  description: string;
  anthropicApiKey?: string;
  hints?: {
    services?: string[];
    nodeTypes?: string[];
    expectedInputs?: string[];
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
const MODEL = "claude-sonnet-4-20250514";

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(apiKey?: string): Anthropic {
  if (apiKey) {
    return new Anthropic({ apiKey });
  }
  if (!anthropicClient) {
    const envKey = process.env.ANTHROPIC_API_KEY;
    if (!envKey) throw new Error("ANTHROPIC_API_KEY is not set");
    anthropicClient = new Anthropic({ apiKey: envKey });
  }
  return anthropicClient;
}

/** Exported for testing — allows injecting a mock client */
export function setAnthropicClient(client: Anthropic | null): void {
  anthropicClient = client;
}

export async function generateWorkflow(
  input: GenerateWorkflowInput,
): Promise<GenerateWorkflowResult> {
  const client = input.anthropicApiKey
    ? getAnthropicClient(input.anthropicApiKey)
    : getAnthropicClient();
  const systemPrompt = buildSystemPrompt(input.hints?.services);

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

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools: [DAG_GENERATION_TOOL],
      tool_choice: { type: "tool", name: "create_workflow" },
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.Messages.ToolUseBlock =>
        block.type === "tool_use" && block.name === "create_workflow",
    );

    if (!toolUse) {
      throw new Error("LLM did not return a tool use response");
    }

    const result = toolUse.input as {
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

    if (attempt < MAX_RETRIES) {
      messages.push({
        role: "assistant",
        content: response.content,
      });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: buildRetryUserMessage(input.description, validation.errors),
          },
        ],
      });
    } else {
      throw new GenerationValidationError(
        "Generated DAG is invalid after retries",
        validation.errors,
      );
    }
  }

  throw new Error("Unexpected: generation loop exited without result");
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
