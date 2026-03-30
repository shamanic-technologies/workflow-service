import type { HttpEndpoint } from "./extract-http-endpoints.js";
import type { DownstreamHeaders } from "./downstream-headers.js";

export interface IdentityHeaders {
  orgId: string;
  userId: string;
  runId: string;
}

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
  endpoints: HttpEndpoint[],
  downstreamHeaders: DownstreamHeaders,
): Promise<ProviderRequirementsResponse> {
  const { baseUrl, apiKey } = getKeyServiceConfig();

  const url = `${baseUrl}/provider-requirements`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      ...downstreamHeaders,
    },
    body: JSON.stringify({ endpoints }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `key-service error: POST /provider-requirements -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<ProviderRequirementsResponse>;
}

