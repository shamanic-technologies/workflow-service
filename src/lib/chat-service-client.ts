export type ChatProvider = "anthropic" | "google";
export type ChatModel = "haiku" | "sonnet" | "opus" | "flash-lite" | "flash" | "pro";

export interface ChatServiceCompleteRequest {
  message: string;
  systemPrompt: string;
  responseFormat?: "json";
  temperature?: number;
  maxTokens?: number;
  provider: ChatProvider;
  model: ChatModel;
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
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `chat-service error: POST /complete -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<ChatServiceCompleteResponse>;
}
