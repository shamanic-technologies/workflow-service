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
  /** Catalogue status (TEMPLATE-MODEL-STATUS-1019): a deprecated template may not be named by a NEW workflow. */
  status?: "active" | "deprecated";
  createdAt: string;
  updatedAt: string;
}

/**
 * Status of every writer model alias content-generation accepts (`GET /internal/models`). A deprecated alias may
 * not be named by a NEW workflow; stored ones keep generating.
 */
export async function fetchModelStatuses(): Promise<Map<string, "active" | "deprecated">> {
  const { baseUrl, apiKey } = getConfig();
  const res = await fetch(`${baseUrl}/internal/models`, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(600_000) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`content-generation error: GET /internal/models -> ${res.status}: ${text}`);
  }
  const body = (await res.json()) as { models: Array<{ model: string; status: "active" | "deprecated" }> };
  return new Map(body.models.map((m) => [m.model, m.status]));
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

// --- Template dynasties (TPL-DYNASTY-1021): content-generation owns the catalogue ----------------------------

export interface TemplateDynasty {
  slug: string;
  name: string;
  description: string;
  signature: string;
  identity: "blind" | "named";
  featureSlug: string;
  legKey: string;
  head: string | null;
  versions: Array<{ type: string; position: number; status?: string; addedAt?: string }>;
}

/** Every template dynasty of one pipe (feature x leg). Throws on any failure: never a guess. */
export async function fetchTemplateDynasties(featureSlug: string, legKey: string): Promise<TemplateDynasty[]> {
  const { baseUrl, apiKey } = getConfig();
  const res = await fetch(
    `${baseUrl}/internal/template-dynasties?featureSlug=${encodeURIComponent(featureSlug)}&legKey=${encodeURIComponent(legKey)}`,
    { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(600_000) },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`content-generation error: GET /internal/template-dynasties -> ${res.status}: ${text}`);
  }
  return ((await res.json()) as { dynasties: TemplateDynasty[] }).dynasties;
}

/** The dynasty's head template (the one every workflow on it writes with). Throws on any failure. */
export async function fetchTemplateDynastyHead(slug: string): Promise<{ dynasty: TemplateDynasty; template: PromptTemplate }> {
  const { baseUrl, apiKey } = getConfig();
  const res = await fetch(`${baseUrl}/internal/template-dynasties/${encodeURIComponent(slug)}/head`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`content-generation error: GET /internal/template-dynasties/${slug}/head -> ${res.status}: ${text}`);
  }
  return (await res.json()) as { dynasty: TemplateDynasty; template: PromptTemplate };
}

/**
 * A new head version of a dynasty (content-generation names its type). The refusal (twin text, a variable the head
 * does not declare, a non-neutral or revealing text) is returned as-is so the caller can relay it.
 */
export async function addTemplateDynastyVersion(
  slug: string,
  prompt: string,
  variables: PromptVariable[],
): Promise<{ ok: true; template: PromptTemplate } | { ok: false; status: number; body: unknown }> {
  const { baseUrl, apiKey } = getConfig();
  const res = await fetch(`${baseUrl}/internal/template-dynasties/${encodeURIComponent(slug)}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ prompt, variables }),
    signal: AbortSignal.timeout(600_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON refusal: relayed as text
  }
  if (res.status === 201 || res.status === 200) return { ok: true, template: (body as { template: PromptTemplate }).template };
  if (res.status >= 500) throw new Error(`content-generation error: POST /internal/template-dynasties/${slug}/versions -> ${res.status}: ${text}`);
  return { ok: false, status: res.status, body };
}
