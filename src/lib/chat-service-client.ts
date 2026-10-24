export type ChatProvider = "anthropic" | "google";
export type ChatModel = "haiku" | "sonnet" | "opus" | "flash-lite" | "flash" | "pro";

export interface ChatServiceCompleteRequest {
  message: string;
  systemPrompt: string;
  responseFormat?: "json";
  /** JSON Schema the provider enforces server-side. Anthropic requires it for JSON output, strict (additionalProperties: false). */
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  provider: ChatProvider;
  model: ChatModel;
  /** Opt-in native web search (Anthropic `web_search` tool / Google grounding). Text mode answers carry the source URLs. */
  webSearch?: boolean;
}

export interface ChatServiceCompleteResponse {
  content: string;
  json?: Record<string, unknown>;
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

import type { DownstreamHeaders } from "./downstream-headers.js";

function getChatServiceConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.CHAT_SERVICE_URL;
  const apiKey = process.env.CHAT_SERVICE_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "CHAT_SERVICE_URL and CHAT_SERVICE_API_KEY must be set for LLM calls"
    );
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

export async function chatServiceComplete(
  request: ChatServiceCompleteRequest,
  downstreamHeaders: DownstreamHeaders,
): Promise<ChatServiceCompleteResponse> {
  const { baseUrl, apiKey } = getChatServiceConfig();

  const res = await fetch(`${baseUrl}/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      ...downstreamHeaders,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(600_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `chat-service error: POST /complete -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<ChatServiceCompleteResponse>;
}

/** The support functions chat-service accepts (its `SUPPORT_FUNCTIONS`, byte-equal): spend reported apart, never on an outcome. */
export type PlatformSupportKind =
  | "payment_fees"
  | "brand_setup"
  | "copilot"
  | "platform_llm"
  | "staff_experiment"
  | "product_feature"
  | "retired_product";

/**
 * Whose work a platform call is (PLATFORM-CALLER-RUN-1024): THIS service's run doing the work (its spend rides the
 * outcome that run declares), or, only when no run stands behind the call by design, the support function it serves.
 * Exactly one, required: chat-service refuses both (400) and will refuse neither.
 */
export type PlatformCaller =
  | { runId: string }
  | { support: { kind: PlatformSupportKind; reason: string } };

/**
 * Platform-level LLM call: no org/user context, no org billing.
 * Uses POST /internal/platform-complete (x-api-key auth only), stating whose work it is (`caller`).
 */
export async function chatServicePlatformComplete(
  request: ChatServiceCompleteRequest,
  caller: PlatformCaller,
): Promise<ChatServiceCompleteResponse> {
  const { baseUrl, apiKey } = getChatServiceConfig();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
  let body: Record<string, unknown> = { ...request };
  if ("runId" in caller) headers["x-run-id"] = caller.runId;
  else body = { ...body, support: caller.support };

  const res = await fetch(`${baseUrl}/internal/platform-complete`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `chat-service error: POST /internal/platform-complete -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<ChatServiceCompleteResponse>;
}
