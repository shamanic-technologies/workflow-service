export interface ChatServiceCompleteRequest {
  message: string;
  systemPrompt: string;
  responseFormat?: "json";
  temperature?: number;
  maxTokens?: number;
  model?: "claude-sonnet-4-6" | "claude-haiku-4-5";
}

export interface ChatServiceCompleteResponse {
  content: string;
  json?: Record<string, unknown>;
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

export interface ChatServiceIdentity {
  orgId: string;
  userId: string;
  runId: string;
}

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
  identity: ChatServiceIdentity,
): Promise<ChatServiceCompleteResponse> {
  const { baseUrl, apiKey } = getChatServiceConfig();

  const res = await fetch(`${baseUrl}/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      "x-run-id": identity.runId,
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
