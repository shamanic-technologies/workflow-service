import type { DownstreamHeaders } from "./downstream-headers.js";

/**
 * A declared template variable. content-generation-service migrated variables
 * from bare `string[]` to self-describing `{ name, description }` objects
 * (DIS-52) — each variable documents the JSON shape the caller should provide.
 */
export interface PromptVariable {
  name: string;
  description: string;
}

export interface PromptTemplate {
  id: string;
  type: string;
  prompt: string;
  /** Tokens the stored template body declares — a caller MUST provide each one. */
  variables: PromptVariable[];
  /**
   * Optional lead + organization facts every template accepts, rendered into a
   * "Recipient context" block ahead of the body. A separate list from
   * `variables` on purpose: these are never declared by a template, so a
   * workflow that provides one is complete, not over-providing. Absent on a
   * content-generation deploy that predates the catalog.
   */
  contextVariables?: PromptVariable[];
  createdAt: string;
  updatedAt: string;
}

function getConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.CONTENT_GENERATION_SERVICE_URL;
  const apiKey = process.env.CONTENT_GENERATION_SERVICE_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "CONTENT_GENERATION_SERVICE_URL and CONTENT_GENERATION_SERVICE_API_KEY must be set",
    );
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

/**
 * Fetches a platform prompt template by type from content-generation service.
 * Returns null if the template is not found (404).
 */
export async function fetchPromptTemplate(
  type: string,
  downstreamHeaders?: DownstreamHeaders,
): Promise<PromptTemplate | null> {
  const { baseUrl, apiKey } = getConfig();

  const res = await fetch(
    `${baseUrl}/platform-prompts?type=${encodeURIComponent(type)}`,
    {
      method: "GET",
      headers: { "x-api-key": apiKey, ...downstreamHeaders },
      signal: AbortSignal.timeout(600_000),
    },
  );

  if (res.status === 404) return null;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `content-generation error: GET /platform-prompts?type=${type} -> ${res.status}: ${text}`,
    );
  }

  return res.json() as Promise<PromptTemplate>;
}

/**
 * Fetches multiple prompt templates by type (deduplicated, resilient).
 */
export async function fetchPromptTemplates(
  types: string[],
  downstreamHeaders?: DownstreamHeaders,
): Promise<Map<string, PromptTemplate>> {
  const unique = [...new Set(types)];
  const templates = new Map<string, PromptTemplate>();

  const results = await Promise.allSettled(
    unique.map(async (type) => {
      const template = await fetchPromptTemplate(type, downstreamHeaders);
      return { type, template };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value.template) {
      templates.set(result.value.type, result.value.template);
    } else if (result.status === "fulfilled" && !result.value.template) {
      console.warn(
        `[content-generation] Prompt "${result.value.type}" returned 404 from content-generation service`,
      );
    } else if (result.status === "rejected") {
      console.warn(
        `[content-generation] Failed to fetch prompt: ${result.reason}`,
      );
    }
  }

  return templates;
}

export interface PromptVersionResult {
  template: PromptTemplate;
  /** false when content-generation found the text identical and returned the source untouched. */
  created: boolean;
}

/**
 * Stores `prompt` as a NEW template derived from `sourceType`, via
 * content-generation `PUT /prompts`, which never mutates the source: it inserts
 * `<base>-vN` (the next free version of the type's base name) and answers 201,
 * or answers 200 with the source row when the text and variables are identical.
 *
 * That route is identity-scoped, so the caller's `x-org-id` / `x-user-id` /
 * `x-run-id` must be in `downstreamHeaders`.
 */
export async function createPromptVersion(
  sourceType: string,
  prompt: string,
  variables: PromptVariable[],
  downstreamHeaders: DownstreamHeaders,
): Promise<PromptVersionResult> {
  const { baseUrl, apiKey } = getConfig();

  const res = await fetch(`${baseUrl}/prompts`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      ...downstreamHeaders,
    },
    body: JSON.stringify({ sourceType, prompt, variables }),
    signal: AbortSignal.timeout(600_000),
  });

  if (res.status !== 200 && res.status !== 201) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `content-generation error: PUT /prompts (sourceType=${sourceType}) -> ${res.status}: ${text}`,
    );
  }

  return { template: (await res.json()) as PromptTemplate, created: res.status === 201 };
}
