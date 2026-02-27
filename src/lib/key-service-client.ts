import type { HttpEndpoint } from "./extract-http-endpoints.js";

export interface ProviderRequirementsResponse {
  requirements: unknown[];
  providers: string[];
}

function getKeyServiceConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.KEY_SERVICE_URL;
  const apiKey = process.env.KEY_SERVICE_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "KEY_SERVICE_URL and KEY_SERVICE_API_KEY must be set to fetch provider requirements"
    );
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

export async function fetchProviderRequirements(
  endpoints: HttpEndpoint[]
): Promise<ProviderRequirementsResponse> {
  const { baseUrl, apiKey } = getKeyServiceConfig();

  const url = `${baseUrl}/internal/provider-requirements`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ endpoints }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `key-service error: POST /internal/provider-requirements -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<ProviderRequirementsResponse>;
}

export async function fetchAnthropicKey(
  keySource: "app" | "byok" | "platform",
  opts: { appId: string; orgId: string },
): Promise<string> {
  const { baseUrl, apiKey } = getKeyServiceConfig();

  const callerHeaders = {
    "x-caller-service": "workflow",
    "x-caller-method": "POST",
    "x-caller-path": "/workflows/generate",
  };

  const path =
    keySource === "platform"
      ? `/internal/platform-keys/anthropic/decrypt`
      : keySource === "app"
        ? `/internal/app-keys/anthropic/decrypt?appId=${encodeURIComponent(opts.appId)}`
        : `/internal/keys/anthropic/decrypt?orgId=${encodeURIComponent(opts.orgId)}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      ...callerHeaders,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `key-service error: GET ${path.split("?")[0]} -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  const body = (await res.json()) as { provider: string; key: string };
  return body.key;
}
