export interface PromptTemplate {
  id: string;
  type: string;
  prompt: string;
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

function getConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl =
    process.env.CONTENT_GENERATION_SERVICE_URL ??
    process.env.CONTENT_GENERATION_URL;
  const apiKey =
    process.env.CONTENT_GENERATION_SERVICE_API_KEY ??
    process.env.CONTENT_GENERATION_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "CONTENT_GENERATION_SERVICE_URL / CONTENT_GENERATION_SERVICE_API_KEY (or legacy CONTENT_GENERATION_URL / CONTENT_GENERATION_API_KEY) must be set",
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
): Promise<PromptTemplate | null> {
  const { baseUrl, apiKey } = getConfig();

  const res = await fetch(
    `${baseUrl}/platform-prompts?type=${encodeURIComponent(type)}`,
    {
      method: "GET",
      headers: { "x-api-key": apiKey },
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
): Promise<Map<string, PromptTemplate>> {
  const unique = [...new Set(types)];
  const templates = new Map<string, PromptTemplate>();

  const results = await Promise.allSettled(
    unique.map(async (type) => {
      const template = await fetchPromptTemplate(type);
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
