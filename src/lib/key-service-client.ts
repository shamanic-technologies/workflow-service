import type { HttpEndpoint } from "./extract-http-endpoints.js";

export interface ProviderRequirementsResponse {
  requirements: unknown[];
  providers: string[];
}

export async function fetchProviderRequirements(
  endpoints: HttpEndpoint[]
): Promise<ProviderRequirementsResponse> {
  const baseUrl = process.env.KEY_SERVICE_URL;
  const apiKey = process.env.KEY_SERVICE_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "KEY_SERVICE_URL and KEY_SERVICE_API_KEY must be set to fetch provider requirements"
    );
  }

  const url = `${baseUrl.replace(/\/$/, "")}/internal/provider-requirements`;
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
