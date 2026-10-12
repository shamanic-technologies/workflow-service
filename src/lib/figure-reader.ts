/**
 * Reads, at run time, the figures a message needs: any PUBLIC figure, and any figure of the organization(s) the
 * RECIPIENT belongs to. Never another customer's.
 *
 * Served as `POST /orgs/figures/read` so ANY workflow can call it as an ordinary `http.call` node (first caller:
 * `ai-follow-up-email`, whose instruction may ask for "her exact cost per booked meeting" without the number).
 *
 * The no-leak property rests on three things, none of which the model can move:
 *
 *  1. WHICH ORG. The organizations a read may act in are the recipient's own memberships, read from the identity
 *     provider through client-service (`/internal/users?email=` then `/internal/users/{id}/orgs`). The recipient is
 *     the person the email is sent to, so whatever is read is read FOR the one person entitled to see it. Nothing
 *     the model writes (instruction, plan) can add an org: a read naming any other org id is refused before any
 *     request leaves. A recipient who belongs to no organization (a prospect) gets public reads only.
 *  2. AS WHOM. An org read goes through api-service, the customer API gateway, under the recipient's own identity
 *     (`x-org-id` = one of her orgs, `x-user-id` = her user) and WITHOUT `x-email`, so no staff route can open:
 *     it is exactly what her own dashboard or API key reads. Only GET routes of api-service's SERVED catalogue
 *     (which omits staff routes) are reachable, minus `DENIED_READS` (credentials, writes, streams, spend, caches
 *     shared across orgs). Never a service key on a producer, never an internal/admin/platform route.
 *  3. WHICH IDS. Every identifier a read names (a uuid, an email, a vendor id) must have come out of an earlier
 *     read of HER account in this same session (or be her own org/user id). An id typed in the instruction, read
 *     off a public page or a cross-org catalogue, or invented, is refused. So even a gateway route that forgot its
 *     ownership check cannot be pointed at another customer's brand.
 *
 * Public reads (the catalogue routes api-service serves without auth) carry no identity at all, and web questions
 * go to chat-service `/complete` with native web search. Every model call goes through chat-service, which
 * declares its cost on the calling run like any other spend; the reads themselves are free GETs.
 */
import type { DownstreamHeaders } from "./downstream-headers.js";

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface CatalogueParam {
  name: string;
  in: "path" | "query";
  required: boolean;
  description: string;
}

export interface CatalogueEntry {
  template: string;
  pattern: RegExp;
  /** Served without auth by api-service: read with no identity. */
  isPublic: boolean;
  /** An org route whose answer spans orgs (a shared catalogue): readable, but no identifier is learnt from it. */
  learnsNoIds: boolean;
  summary: string;
  params: CatalogueParam[];
}

/** Routes never read, whatever the instruction asks. Each says why. */
export const DENIED_READS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /^\/$|^\/health$|^\/openapi\.json$/, why: "not a figure" },
  { pattern: /^\/v1\/(api-)?keys(\/|$)/, why: "credentials" },
  { pattern: /\/(conversion|share)-token$/, why: "credentials" },
  { pattern: /\/auth\/callback$/, why: "an OAuth exchange writes" },
  { pattern: /\/stream$/, why: "a stream never ends" },
  { pattern: /^\/v1\/chat\//, why: "a chat session is private to the user who opened it" },
  { pattern: /^\/v1\/orgs\/audiences\/[^/]+\/preview(\/|$)/, why: "a preview may spend" },
  { pattern: /^\/v1\/platform\//, why: "API documentation, not a figure" },
  { pattern: /^\/v1\/scraping\//, why: "the scrape cache is shared across orgs" },
  { pattern: /^\/v1\/waitlist\//, why: "a lookup by someone else's email" },
  { pattern: /^\/v1\/(prompts|content\/)/, why: "prompt templates, not a figure" },
];

/** Org routes whose answer is a cross-org catalogue: they may be read, but no identifier is learnt from them. */
export const CATALOGUE_READS: ReadonlyArray<RegExp> = [
  /^\/v1\/workflows(\/|$)/,
  /^\/v1\/workflow-examples$/,
  /^\/v1\/features$/,
  /^\/v1\/features\/(entities|stats)\/registry$/,
  /^\/v1\/features\/stats$/,
  /^\/v1\/features\/[^/]+(\/(stats|revenue|workflow-projection|pipeline-activity|audience-stats))?$/,
  /^\/v1\/qualification\/catalog$/,
];

function templateToPattern(template: string): RegExp {
  const escaped = template
    .split(/(\{[^}]+\})/)
    .map((part) => (part.startsWith("{") ? "([^/]+)" : part.replace(/[.*+?^$()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${escaped}$`);
}

interface OpenApiParam { name?: string; in?: string; required?: boolean; description?: string; schema?: { description?: string } }
interface OpenApiOperation { summary?: string; security?: unknown[] | null; parameters?: OpenApiParam[] }

/** The readable routes: GET operations of api-service's served spec, under `/v1/` or `/public/`, minus the denied. */
export function buildCatalogue(spec: { paths?: Record<string, Record<string, OpenApiOperation>> }): CatalogueEntry[] {
  const out: CatalogueEntry[] = [];
  for (const [template, ops] of Object.entries(spec.paths ?? {})) {
    const op = ops?.get;
    if (!op) continue;
    if (!template.startsWith("/v1/") && !template.startsWith("/public/")) continue;
    if (DENIED_READS.some((d) => d.pattern.test(template))) continue;
    const isPublic = !Array.isArray(op.security) || op.security.length === 0;
    const params: CatalogueParam[] = [];
    for (const p of op.parameters ?? []) {
      if (!p.name || (p.in !== "path" && p.in !== "query")) continue;
      params.push({
        name: p.name,
        in: p.in,
        required: p.required === true,
        description: String(p.description ?? p.schema?.description ?? "").replace(/\s+/g, " ").slice(0, 90),
      });
    }
    out.push({
      template,
      pattern: templateToPattern(template),
      isPublic,
      learnsNoIds: CATALOGUE_READS.some((re) => re.test(template)),
      summary: String(op.summary ?? "").replace(/\s+/g, " ").slice(0, 110),
      params,
    });
  }
  return out;
}

/** One line per route, the way the model reads the catalogue. */
export function renderCatalogue(catalogue: CatalogueEntry[]): string {
  return catalogue
    .map((e) => {
      const q = e.params
        .filter((p) => p.in === "query")
        .map((p) => `${p.name}${p.required ? "*" : ""}${p.description ? ` (${p.description})` : ""}`)
        .join("; ");
      return `${e.isPublic ? "PUBLIC " : ""}GET ${e.template} | ${e.summary}${q ? ` | query: ${q}` : ""}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Vendor-style ids (`org_2ab…`, `cus_…`) and opaque tokens: 16+ word chars mixing letters and digits. */
const TOKEN_G = /\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{16,}\b/g;

/** Every identifier a value carries, lower-cased. A value with none (a number, a date, a word, a slug) is free. */
export function identifiersIn(value: string): string[] {
  const found = new Set<string>();
  for (const re of [UUID_G, EMAIL_G, TOKEN_G]) {
    for (const m of value.matchAll(re)) found.add(m[0].toLowerCase());
  }
  return [...found];
}

/** Adds every identifier found in a read's answer to `owned`. */
export function learnIdentifiers(value: unknown, owned: Set<string>, depth = 0): void {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.length <= 2000) for (const id of identifiersIn(value)) owned.add(id);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) learnIdentifiers(v, owned, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) learnIdentifiers(v, owned, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface RecipientOrg { orgId: string; name: string | null }

/** One organization the recipient belongs to, and the user row of theirs that is its member (read as that user). */
export interface RecipientMembership extends RecipientOrg { userId: string }

export interface RecipientScope {
  email: string | null;
  /** Every user row carrying exactly this email (one mailbox, so one person). */
  userIds: string[];
  organizations: RecipientMembership[];
}

export interface PlannedRead {
  /** The recipient org the read acts in; "" for a public read. */
  orgId: string;
  path: string;
  query: Array<{ name: string; value: string }>;
}

export type GatedRead =
  | { ok: true; url: string; template: string; isPublic: boolean; learnsNoIds: boolean; orgId: string | null; userId: string | null }
  | { ok: false; reason: string };

/**
 * Decides whether ONE planned read may be made, before any request leaves. Pure: the property the whole module
 * exists for is decided here and tested here.
 */
export function gateRead(read: PlannedRead, catalogue: CatalogueEntry[], scope: RecipientScope, owned: Set<string>): GatedRead {
  const path = String(read.path ?? "").trim();
  if (!path.startsWith("/") || /[?#\\]|\/\.\.?(\/|$)|%2f|%5c/i.test(path)) {
    return { ok: false, reason: `path_not_plain: "${path}" (no query string, no dot segments; query goes in query)` };
  }
  const denied = DENIED_READS.find((d) => d.pattern.test(path));
  if (denied) return { ok: false, reason: `denied_route: ${path} (${denied.why})` };
  const entry = catalogue.find((e) => e.pattern.test(path));
  if (!entry) return { ok: false, reason: `unknown_route: GET ${path} is not in the readable catalogue` };

  const declaredQuery = new Map(entry.params.filter((p) => p.in === "query").map((p) => [p.name, p]));
  const query = Array.isArray(read.query) ? read.query : [];
  for (const q of query) {
    if (!declaredQuery.has(q.name)) return { ok: false, reason: `unknown_query_param: "${q.name}" on GET ${entry.template}` };
  }
  for (const p of declaredQuery.values()) {
    if (p.required && !query.some((q) => q.name === p.name && String(q.value ?? "") !== "")) {
      return { ok: false, reason: `missing_query_param: "${p.name}" is required on GET ${entry.template}` };
    }
  }

  let orgId: string | null = null;
  let userId: string | null = null;
  if (!entry.isPublic) {
    const named = String(read.orgId ?? "").trim().toLowerCase();
    const org = scope.organizations.find((o) => o.orgId.toLowerCase() === named);
    if (!org) {
      return {
        ok: false,
        reason: scope.organizations.length === 0
          ? `not_a_member: the recipient belongs to no organization, so GET ${entry.template} (an account read) cannot be made; only public reads can`
          : `org_not_recipients: "${read.orgId}" is not an organization the recipient belongs to`,
      };
    }
    orgId = org.orgId;
    userId = org.userId;
    // Identifiers must come from HER account. A public read names none that matter: it carries no identity.
    let pathValues: string[];
    try {
      pathValues = (path.match(entry.pattern)?.slice(1) ?? []).map((v) => decodeURIComponent(v));
    } catch {
      return { ok: false, reason: `path_not_plain: "${path}" carries a malformed escape` };
    }
    const values = [...pathValues, ...query.map((q) => String(q.value ?? ""))];
    for (const v of values) {
      for (const id of identifiersIn(v)) {
        if (!owned.has(id)) {
          return { ok: false, reason: `identifier_not_from_recipient: "${id}" was not read from the recipient's own account in this session` };
        }
      }
    }
  }

  const qs = new URLSearchParams(query.map((q) => [q.name, String(q.value ?? "")])).toString();
  return { ok: true, url: qs ? `${path}?${qs}` : path, template: entry.template, isPublic: entry.isPublic, learnsNoIds: entry.learnsNoIds, orgId, userId };
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface ReadRecord {
  kind: "account" | "public" | "web";
  orgId: string | null;
  /** The URL read (account/public), or the question asked (web). */
  target: string;
  status: number | null;
  refused: string | null;
}

export interface Figure { label: string; value: string; source: string }

export interface FigureReadResult {
  figures: Figure[];
  missing: string | null;
  recipient: { email: string | null; isMember: boolean; organizations: RecipientOrg[] };
  reads: ReadRecord[];
}

export interface FigureReaderDeps {
  /** api-service's served OpenAPI document. */
  loadSpec(): Promise<{ paths?: Record<string, Record<string, OpenApiOperation>> }>;
  /** The recipient's user id and memberships (identity provider truth). */
  resolveRecipient(email: string): Promise<RecipientScope>;
  /** One GET on api-service: as the recipient (orgId + userId) or with no identity (public). */
  apiGet(url: string, identity: { orgId: string; userId: string } | null): Promise<{ status: number; body: unknown }>;
  /** chat-service `/complete`, on the calling run's identity (it declares the cost). */
  complete(request: Record<string, unknown>): Promise<{ content: string; json?: Record<string, unknown> }>;
}

export const FIGURE_READER_LLM = { provider: "anthropic", model: "opus" } as const;
export const FIGURE_WEB_LLM = { provider: "anthropic", model: "sonnet" } as const;
export const MAX_ROUNDS = 4;
export const MAX_READS_PER_ROUND = 6;
/** How much of one read's answer the model sees. */
export const MAX_READ_CHARS = 24_000;

export const PLAN_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["read", "done"] },
    reads: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          orgId: { type: "string" },
          path: { type: "string" },
          query: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { name: { type: "string" }, value: { type: "string" } },
              required: ["name", "value"],
            },
          },
        },
        required: ["orgId", "path", "query"],
      },
    },
    webQuestions: { type: "array", items: { type: "string" } },
    figures: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { label: { type: "string" }, value: { type: "string" }, source: { type: "string" } },
        required: ["label", "value", "source"],
      },
    },
    missing: { type: "string" },
  },
  required: ["status", "reads", "webQuestions", "figures", "missing"],
} as const;

const SYSTEM_PROMPT = [
  "You find the figures a message needs, by reading them. You never write the message.",
  "You read three kinds of source: the RECIPIENT's own account (GET routes of our customer API, acting in one of the organizations the recipient belongs to), PUBLIC routes (marked PUBLIC, no organization), and the public web (webQuestions).",
  "An account read names its organization in orgId, one of the RECIPIENT ORGANIZATIONS listed. A public read sets orgId to an empty string.",
  "You can only read the recipient's own organizations and public data. If the request asks for another person's or another company's account figure, it cannot be read: do not try to work around it, say so in missing.",
  "An id you put in a path or a query must be one you READ from the recipient's account in an earlier read (start from the account listing you are given). Never use an id written in the request: it is refused.",
  "path is the route with its {params} filled in, no query string. query lists the query parameters, name and value.",
  "A web question must never contain anything read from the account.",
  "Each round: either status read with the reads you need next (at most " + MAX_READS_PER_ROUND + " plus web questions), or status done with the figures. Read only what the request needs.",
  "figures: each one is a value exactly as a read served it (keep its unit and currency), or a plain ratio of two served values, and then the label says what was divided by what. Never invent, estimate or round a figure the reads do not hold. source is the exact path or web question it came from.",
  "missing: empty when every figure the request needs was found; else one sentence naming what could not be read and why.",
].join("\n");

function compactJson(body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > MAX_READ_CHARS ? text.slice(0, MAX_READ_CHARS) + " …[truncated]" : text;
}

/**
 * Plans and makes the reads a question needs, a few rounds at most, and returns the figures found. Every read
 * passes `gateRead` first; a refused read is reported back to the model and in the result, never made.
 */
export async function readFigures(
  input: { question: string; recipientEmail: string | null },
  deps: FigureReaderDeps,
): Promise<FigureReadResult> {
  const question = input.question.trim();
  if (!question) throw new Error("figure-reader: the question is empty");
  const email = input.recipientEmail?.trim().toLowerCase() || null;

  const scope: RecipientScope = email ? await deps.resolveRecipient(email) : { email: null, userIds: [], organizations: [] };
  const catalogue = buildCatalogue(await deps.loadSpec());
  if (catalogue.length === 0) throw new Error("figure-reader: api-service served no readable route");

  const owned = new Set<string>();
  for (const o of scope.organizations) owned.add(o.orgId.toLowerCase());
  for (const u of scope.userIds) owned.add(u.toLowerCase());
  if (email) owned.add(email);

  const reads: ReadRecord[] = [];
  const transcript: string[] = [];
  const succeeded = new Set<string>();

  const runRead = async (planned: PlannedRead): Promise<void> => {
    const gated = gateRead(planned, catalogue, scope, owned);
    if (!gated.ok) {
      console.error(`[figure-reader] refused ${planned.path}: ${gated.reason}`);
      reads.push({ kind: "account", orgId: planned.orgId || null, target: planned.path, status: null, refused: gated.reason });
      transcript.push(`REFUSED GET ${planned.path} (org ${planned.orgId || "none"}): ${gated.reason}`);
      return;
    }
    const identity = gated.isPublic ? null : { orgId: gated.orgId as string, userId: gated.userId as string };
    const res = await deps.apiGet(gated.url, identity);
    reads.push({ kind: gated.isPublic ? "public" : "account", orgId: gated.orgId, target: gated.url, status: res.status, refused: null });
    if (res.status >= 200 && res.status < 300) {
      succeeded.add(planned.path);
      succeeded.add(gated.url);
      if (!gated.isPublic && !gated.learnsNoIds) learnIdentifiers(res.body, owned);
    }
    transcript.push(`GET ${gated.url} (${gated.isPublic ? "public" : `org ${gated.orgId}`}) -> ${res.status}\n${compactJson(res.body)}`);
  };

  // Every account starts from its brands: the first ids a read may name.
  for (const org of scope.organizations) await runRead({ orgId: org.orgId, path: "/v1/brands", query: [] });

  const orgLines = scope.organizations.length
    ? scope.organizations.map((o) => `- orgId ${o.orgId}: ${o.name ?? "(unnamed)"}`)
    : ["(none: the recipient belongs to no organization, so only PUBLIC routes and the web can be read)"];

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const last = round === MAX_ROUNDS;
    const message = [
      "REQUEST (what the message must say):",
      question,
      "",
      "RECIPIENT: " + (email ?? "(no email)"),
      "RECIPIENT ORGANIZATIONS:",
      ...orgLines,
      "",
      "READABLE ROUTES (* = required query parameter):",
      renderCatalogue(catalogue),
      "",
      "READS SO FAR:",
      ...(transcript.length ? transcript : ["(none)"]),
      "",
      last ? "This is the LAST round: answer now with status done." : `Round ${round} of ${MAX_ROUNDS}.`,
    ].join("\n");

    const res = await deps.complete({
      provider: FIGURE_READER_LLM.provider,
      model: FIGURE_READER_LLM.model,
      systemPrompt: SYSTEM_PROMPT,
      message,
      responseFormat: "json",
      responseSchema: PLAN_RESPONSE_SCHEMA,
      maxTokens: 16_000,
    });
    const plan = res.json as {
      status?: string; reads?: PlannedRead[]; webQuestions?: string[]; figures?: Figure[]; missing?: string;
    } | undefined;
    if (!plan || (plan.status !== "read" && plan.status !== "done")) {
      throw new Error(`figure-reader: the model answered no plan (round ${round}): ${res.content?.slice(0, 300)}`);
    }

    if (plan.status === "done" || last) {
      const figures: Figure[] = [];
      for (const f of plan.figures ?? []) {
        if (succeeded.has(String(f.source ?? "").trim())) {
          figures.push({ label: String(f.label), value: String(f.value), source: String(f.source).trim() });
        } else {
          console.error(`[figure-reader] dropped a figure citing no successful read: ${JSON.stringify(f)}`);
        }
      }
      const stated = String(plan.missing ?? "").trim() || null;
      // A last round that still wanted to read did not finish: say so rather than report it complete.
      const missing = stated ?? (plan.status === "done" ? null : "the reads ran out of rounds before every figure was found");
      return {
        figures,
        missing,
        recipient: {
          email,
          isMember: scope.organizations.length > 0,
          organizations: scope.organizations.map((o) => ({ orgId: o.orgId, name: o.name })),
        },
        reads,
      };
    }

    for (const r of (plan.reads ?? []).slice(0, MAX_READS_PER_ROUND)) await runRead(r);
    for (const q of (plan.webQuestions ?? []).slice(0, 2)) {
      const asked = String(q).trim();
      if (!asked) continue;
      const web = await deps.complete({
        provider: FIGURE_WEB_LLM.provider,
        model: FIGURE_WEB_LLM.model,
        systemPrompt: "Answer from the live web with the exact figure and its source URL. If the web does not hold it, say so.",
        message: asked,
        webSearch: true,
        maxTokens: 4_000,
      });
      reads.push({ kind: "web", orgId: null, target: asked, status: 200, refused: null });
      succeeded.add(asked);
      transcript.push(`WEB "${asked}" ->\n${compactJson(web.content)}`);
    }
  }
  throw new Error("figure-reader: unreachable");
}

// ---------------------------------------------------------------------------
// Production dependencies
// ---------------------------------------------------------------------------

const SPEC_TTL_MS = 60 * 60 * 1000;
let specCache: { at: number; spec: { paths?: Record<string, Record<string, OpenApiOperation>> } } | null = null;

function apiServiceConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.API_SERVICE_URL;
  const apiKey = process.env.ADMIN_DISTRIBUTE_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("API_SERVICE_URL and ADMIN_DISTRIBUTE_API_KEY must be set to read figures");
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

function clientServiceConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.CLIENT_SERVICE_URL;
  const apiKey = process.env.CLIENT_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("CLIENT_SERVICE_URL and CLIENT_SERVICE_API_KEY must be set to read figures");
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

/** fetch, with a transport failure named by the dependency it was meant to reach (undici says only "fetch failed"). */
async function fetchNamed(what: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(`figure-reader: ${what} did not answer: ${cause?.code ?? cause?.message ?? (err as Error).message}`);
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function productionDeps(
  downstreamHeaders: DownstreamHeaders,
  complete: (request: Record<string, unknown>, headers: DownstreamHeaders) => Promise<{ content: string; json?: Record<string, unknown> }>,
): FigureReaderDeps {
  return {
    async loadSpec() {
      if (specCache && Date.now() - specCache.at < SPEC_TTL_MS) return specCache.spec;
      const { baseUrl } = apiServiceConfig();
      const res = await fetchNamed("api-service /openapi.json", `${baseUrl}/openapi.json`, { signal: AbortSignal.timeout(600_000) });
      if (!res.ok) throw new Error(`figure-reader: api-service /openapi.json -> ${res.status}`);
      const spec = (await res.json()) as { paths?: Record<string, Record<string, OpenApiOperation>> };
      specCache = { at: Date.now(), spec };
      return spec;
    },

    async resolveRecipient(email) {
      const { baseUrl, apiKey } = clientServiceConfig();
      const headers = { "x-api-key": apiKey, ...downstreamHeaders };
      const usersRes = await fetchNamed("client-service users by email", `${baseUrl}/internal/users?${new URLSearchParams({ email, limit: "5" })}`, {
        headers,
        signal: AbortSignal.timeout(600_000),
      });
      if (!usersRes.ok) throw new Error(`figure-reader: client-service users by email -> ${usersRes.status} ${await usersRes.text()}`);
      const users = ((await usersRes.json()) as { users?: Array<{ id: string; email: string | null }> }).users ?? [];
      // Exactly this email: the filter is the producer's, the equality is ours. Several user rows can carry one
      // address (one per identity it signed up with); they are one mailbox, so one person: their memberships
      // are unioned, each org read as the row that is its member.
      const matches = users.filter((u) => (u.email ?? "").trim().toLowerCase() === email);
      const organizations: RecipientMembership[] = [];
      for (const user of matches) {
        const orgsRes = await fetchNamed("client-service memberships", `${baseUrl}/internal/users/${encodeURIComponent(user.id)}/orgs`, {
          headers,
          signal: AbortSignal.timeout(600_000),
        });
        const text = await orgsRes.text();
        // A row the identity provider no longer knows belongs to no organization: a real answer, not a failure.
        if (orgsRes.status === 404 && text.includes("identity_not_found")) continue;
        if (!orgsRes.ok) throw new Error(`figure-reader: client-service memberships -> ${orgsRes.status} ${text}`);
        const orgs = (JSON.parse(text) as { organizations?: Array<{ orgId: string; name: string | null }> }).organizations ?? [];
        for (const o of orgs) {
          if (!organizations.some((m) => m.orgId === o.orgId)) organizations.push({ orgId: o.orgId, name: o.name ?? null, userId: user.id });
        }
      }
      return { email, userIds: matches.map((u) => u.id), organizations };
    },

    async apiGet(url, identity) {
      const { baseUrl, apiKey } = apiServiceConfig();
      // Never x-email: without it no staff route opens. The run id rides along for tracing only.
      const headers: Record<string, string> = identity
        ? {
            "X-API-Key": apiKey,
            "x-org-id": identity.orgId,
            "x-user-id": identity.userId,
            ...(downstreamHeaders["x-run-id"] ? { "x-run-id": downstreamHeaders["x-run-id"] } : {}),
          }
        : {};
      const res = await fetchNamed(`api-service GET ${url}`, `${baseUrl}${url}`, { headers, signal: AbortSignal.timeout(600_000) });
      const body = await readJson(res);
      if (res.status >= 500) throw new Error(`figure-reader: api-service GET ${url} -> ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
      return { status: res.status, body };
    },

    complete: (request) => complete(request, downstreamHeaders),
  };
}
