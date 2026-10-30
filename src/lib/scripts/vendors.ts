/**
 * FACTORY-P2-ENGINES: the vendors a stored script may call, each one of OUR metered doors, called with the RUN's
 * identity (the script's own runs-service run as `x-run-id`, the caller's org, user, brand and campaign), so every
 * dollar a script spends lands on its run and is declared by the service that spent it (chat-service declares an
 * LLM call's cost itself). A closed list: a name not here answers `{ok: false}` naming it, and a new vendor is one
 * more entry (treg next), never a raw `fetch` handed to a script.
 *
 * A vendor answers `{ok, data}` like the GTM Factory vendor client: a refusal is an answer the script reads, never a
 * thrown error (the script decides; `throw` in its own code fails the run loudly).
 */
import type { VendorAnswer } from "./replay.js";

export interface VendorDeps {
  /** chat-service `POST /complete` on the run (its own key + the given headers). */
  complete(body: Record<string, unknown>, headers: Record<string, string>): Promise<Record<string, unknown>>;
  /** chat-service `POST /orgs/judgments` (Jev) on the run. */
  judge(body: Record<string, unknown>, headers: Record<string, string>): Promise<Record<string, unknown>>;
  /** chat-service `GET /internal/skills/{slug}` (our voice, read live). */
  readSkill(slug: string): Promise<{ content?: unknown; version?: unknown } | null>;
  /**
   * chat-service `POST /internal/platform-complete`: the same completion, PLATFORM-billed, its platform run a child of
   * the script's run (`x-run-id`). Only for a run whose caller has no org request behind it (a service's own sweep,
   * `POST /internal/scripts/run`), exactly as that service's own code called it.
   */
  platformComplete(body: Record<string, unknown>, headers: Record<string, string>): Promise<Record<string, unknown>>;
  /** chat-service `POST /internal/platform-judgments` (Jev, platform-billed) on the script's run. */
  platformJudge(body: Record<string, unknown>, headers: Record<string, string>): Promise<Record<string, unknown>>;
  /**
   * A SERVICE DOOR (FACTORY-P3 service switches): one call of the owning service's own code for the work it has in
   * flight for the caller's run (`x-caller-run-id`), on the script's run (`x-run-id`), with its own billing, rows and
   * declarations. `service` names `<SERVICE>_SERVICE_URL` / `_API_KEY`. Answers `{status, body}`: 200 = its answer.
   */
  serviceDoor(service: string, method: "GET" | "POST", path: string, body: Record<string, unknown> | null, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }>;
}

export interface VendorCallContext {
  /** Downstream headers of the script's run (x-run-id = the script's own run). */
  headers: Record<string, string>;
  /** The script's tactics (its own, then the run's on top). */
  tactics: Record<string, unknown>;
  /**
   * A completion's exact request and chat-service's WHOLE answer, handed to the run's trace (a step run with
   * `trace: true`): the service that records the Unit stores them (the fleet writer: content-generation's row).
   */
  onCompletion?: (exchange: { sent: Record<string, unknown>; raw: Record<string, unknown> }) => void;
  /**
   * Who pays the vendor (the caller's choice, never the script's): `org` (default, the run's org through `/complete`)
   * or `platform` (a service's own sweep with no org request: chat-service's platform doors, x-run-id = the run).
   */
  billing?: "org" | "platform";
  /** The run that asked for the script (its parent): a service's door serves only the work it has in flight for it. */
  callerRunId?: string;
}

/** The headers of a platform call: only whose work it is (the script's run), as chat-service's platform doors read. */
function platformHeaders(headers: Record<string, string>): Record<string, string> {
  const runId = headers["x-run-id"];
  // PLATFORM-CALLER-RUN-1024: a platform call always states whose work it is; here, always the script's own run.
  if (!runId) throw new Error("a platform-billed vendor call needs the script's run (x-run-id)");
  return { "x-run-id": runId };
}

/** An LLM completion, answered with chat-service's whole answer `{content, json, model, tokensInput, tokensOutput}`. */
export const LLM_COMPLETE = "llm.complete";
/** The same completion, answered with the model's parsed JSON object itself. */
export const CHAT_COMPLETE = "chat.complete";
/** Jev yes/no judgments: `{state, questions: {<key>: {instructions, whenTrue?, whenFalse?}}}` -> `{probabilities: {<key>: P(yes)}, model}`. */
export const JEV_NOUL = "jev.noul";
/** Our one voice (chat-service skill `client-comms`), for a writer that builds its own system prompt: `{content, version}`. */
export const VOICE_READ = "voice.read";
/**
 * The service doors a stored script may call (FACTORY-P3 service switches), each the owning service's own code for
 * the work it has in flight: `args` = the call's fields (all required, sent as the body, or the query on a GET);
 * `okFrom` = a GET whose answer is a yes/no (`ok` = that field is true, nothing else answered).
 */
export const SERVICE_DOOR_VENDORS: Record<string, { service: string; method: "GET" | "POST"; path: string; args: string[]; optional?: string[]; okFrom?: string }> = {
  // email_found (apollo-service): one verifier call -> {verificationId, verifier, verdict, error}; BounceVerify asked now.
  "apollo.email.verify": { service: "apollo", method: "POST", path: "/internal/email-verifier-calls", args: ["verifier", "email"] },
  "apollo.apify.available": { service: "apollo", method: "GET", path: "/internal/email-verifier-calls/apify", args: ["email"], okFrom: "available" },
  // lead_identified (lead-service): one candidate's screen, must-pass checks, reveal, decline.
  "lead.candidate.screen": { service: "lead", method: "POST", path: "/internal/candidate-decisions/screen", args: ["candidateId"] },
  "lead.candidate.must_pass": { service: "lead", method: "POST", path: "/internal/candidate-decisions/must-pass", args: ["candidateId"] },
  "lead.candidate.reveal": { service: "lead", method: "POST", path: "/internal/candidate-decisions/reveal", args: ["candidateId"] },
  "lead.candidate.decline": { service: "lead", method: "POST", path: "/internal/candidate-decisions/decline", args: ["candidateId", "reason"] },
  // lead_found (human-service): a PAGE of teasers with the facts each free rule reads, then the page's verdicts
  // (one run per walk, never per person: a walk stays far under the 500 host calls).
  "human.walk.page": { service: "human", method: "POST", path: "/internal/candidate-walks/page", args: ["walk", "limit"] },
  "human.walk.decide": { service: "human", method: "POST", path: "/internal/candidate-walks/decide", args: ["walk", "verdicts"] },
};
export const APOLLO_EMAIL_VERIFY = "apollo.email.verify";
export const APOLLO_APIFY_AVAILABLE = "apollo.apify.available";
export const SCRIPT_VENDORS = [LLM_COMPLETE, CHAT_COMPLETE, JEV_NOUL, VOICE_READ, ...Object.keys(SERVICE_DOOR_VENDORS)] as const;

/** Response schemas a script may name instead of spelling one (Anthropic needs a strict schema). */
export const NAMED_RESPONSE_SCHEMAS: Record<string, Record<string, unknown>> = {
  email_sequence: {
    type: "object",
    additionalProperties: false,
    required: ["subject", "emails"],
    properties: {
      subject: { type: "string" },
      emails: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["body", "daysSinceLastStep"],
          properties: { body: { type: "string" }, daysSinceLastStep: { type: "integer" } },
        },
      },
    },
  },
};

export const VOICE_SKILL_SLUG = "client-comms";

/** The owner's ban (2026-10-09): nothing goes to Haiku 4.5. */
export function isBannedModel(model: string): boolean {
  return /haiku[-_. ]?4/i.test(model);
}

const refuse = (error: string): VendorAnswer => ({ ok: false, data: { error } });

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** chat-service `/complete` fields a script may state, passed through verbatim (the door owns their meaning). */
const PASSTHROUGH_FIELDS = ["responseFormat", "temperature", "maxTokens", "webSearch", "disableThinking", "thinkingLevel", "effort"] as const;

/**
 * The completion body, VERBATIM: nothing is added to the script's prompt (a classifier and a writer differ; a writer
 * that wants our voice reads it with `voice.read`). The system prompt, provider and model are the call's, else the
 * script's tactics (`systemPrompt`, `llm: {provider, model}`); missing = refused, never a default.
 */
function completionBody(args: Record<string, unknown>, ctx: VendorCallContext): { body: Record<string, unknown> } | { error: string } {
  const message = str(args.message);
  if (!message) return { error: "needs a message" };
  const tacticLlm = (ctx.tactics.llm ?? null) as { provider?: unknown; model?: unknown } | null;
  const provider = str(args.provider) ?? str(tacticLlm?.provider);
  const model = str(args.model) ?? str(tacticLlm?.model);
  if (!provider || !model) return { error: "needs an LLM: state provider and model in the call or in the script's tactic `llm`" };
  if (isBannedModel(model)) return { error: `refuses ${model}: nothing goes to Haiku 4.5` };
  const systemPrompt = typeof args.systemPrompt === "string" ? args.systemPrompt : str(ctx.tactics.systemPrompt);
  if (systemPrompt === null || systemPrompt === undefined) return { error: "needs a systemPrompt: state it in the call or in the script's tactic `systemPrompt`" };
  const body: Record<string, unknown> = { message, systemPrompt, provider, model };
  if (typeof args.responseSchema === "string") {
    const named = NAMED_RESPONSE_SCHEMAS[args.responseSchema];
    if (!named) return { error: `no response schema named ${args.responseSchema} (known: ${Object.keys(NAMED_RESPONSE_SCHEMAS).join(", ")})` };
    body.responseFormat = "json";
    body.responseSchema = named;
  } else if (args.responseSchema && typeof args.responseSchema === "object") {
    // A spelled schema is passed as stated (chat-service enforces JSON from the schema alone), byte for byte the
    // request the service path sends.
    body.responseSchema = args.responseSchema;
  }
  for (const f of PASSTHROUGH_FIELDS) if (args[f] !== undefined) body[f] = args[f];
  return { body };
}

async function complete(name: string, args: Record<string, unknown>, ctx: VendorCallContext, deps: VendorDeps): Promise<VendorAnswer> {
  const built = completionBody(args, ctx);
  if ("error" in built) return refuse(`${name} ${built.error}`);
  let answer: Record<string, unknown>;
  try {
    answer = ctx.billing === "platform" ? await deps.platformComplete(built.body, platformHeaders(ctx.headers)) : await deps.complete(built.body, ctx.headers);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
  ctx.onCompletion?.({ sent: built.body, raw: answer });
  if (name === CHAT_COMPLETE) {
    const json = answer.json;
    if (!json || typeof json !== "object" || Array.isArray(json)) return refuse("chat.complete: the model answered no JSON object");
    return { ok: true, data: json as Record<string, unknown> };
  }
  return { ok: true, data: { content: answer.content ?? null, json: answer.json ?? null, model: answer.model ?? null, tokensInput: answer.tokensInput ?? null, tokensOutput: answer.tokensOutput ?? null } };
}

async function jevNoul(args: Record<string, unknown>, ctx: VendorCallContext, deps: VendorDeps): Promise<VendorAnswer> {
  const questions = args.questions as Record<string, { instructions?: unknown; whenTrue?: unknown; whenFalse?: unknown }> | undefined;
  if (!questions || typeof questions !== "object" || Object.keys(questions).length === 0) return refuse("jev.noul needs questions");
  const wire: Record<string, Record<string, unknown>> = {};
  for (const [k, q] of Object.entries(questions)) {
    const instructions = str(q?.instructions);
    if (!instructions) return refuse(`jev.noul question ${k} needs instructions`);
    wire[k] = { type: "noul", instructions, ...(str(q.whenTrue) && str(q.whenFalse) ? { criteria: { true: q.whenTrue, false: q.whenFalse } } : {}) };
  }
  let out: Record<string, unknown>;
  try {
    const body = { ...(args.state !== undefined ? { state: args.state } : {}), questions: wire };
    out = ctx.billing === "platform" ? await deps.platformJudge(body, platformHeaders(ctx.headers)) : await deps.judge(body, ctx.headers);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
  const answers = (out.answers ?? {}) as Record<string, Record<string, unknown>>;
  const probabilities: Record<string, number> = {};
  for (const k of Object.keys(wire)) {
    const p = answers[k]?.noul;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return refuse(`jev.noul: judgment ${k} answered without a readable probability`);
    probabilities[k] = p;
  }
  return { ok: true, data: { probabilities, model: out.model ?? null } };
}

async function voiceRead(deps: VendorDeps): Promise<VendorAnswer> {
  const skill = await deps.readSkill(VOICE_SKILL_SLUG).catch(() => null);
  const content = typeof skill?.content === "string" ? skill.content.trim() : "";
  if (!content) return refuse(`voice.read: our voice (${VOICE_SKILL_SLUG}) could not be read`);
  return { ok: true, data: { content, version: typeof skill?.version === "number" ? skill.version : null } };
}

/** One service door call: the run's identity + tracking, and whose in-flight work it is (the caller's run). */
async function serviceDoor(name: string, args: Record<string, unknown>, ctx: VendorCallContext, deps: VendorDeps): Promise<VendorAnswer> {
  const door = SERVICE_DOOR_VENDORS[name]!;
  // Every field is required: a string (non-blank), a number, or a list/object, passed as stated (a GET sends text).
  const fields: Record<string, unknown> = {};
  for (const f of door.args) {
    const v = args[f];
    const present = typeof v === "string" ? v.trim() !== "" : typeof v === "number" ? Number.isFinite(v) : v !== null && typeof v === "object";
    if (!present) return refuse(`${name} needs ${door.args.join(", ")}`);
    fields[f] = typeof v === "string" ? v.trim() : v;
  }
  if (!ctx.callerRunId || !ctx.headers["x-run-id"]) return refuse(`${name} serves only a run a service asked for`);
  const headers = { ...ctx.headers, "x-caller-run-id": ctx.callerRunId };
  try {
    const path = door.method === "GET" ? `${door.path}?${new URLSearchParams(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])))}` : door.path;
    const out = await deps.serviceDoor(door.service, door.method, path, door.method === "GET" ? null : fields, headers);
    if (out.status !== 200) return refuse(String(out.body.error ?? `${door.service}-service answered ${out.status}`));
    if (door.okFrom) return { ok: out.body[door.okFrom] === true, data: {} };
    return { ok: true, data: out.body };
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
}

/** Call one vendor for a script. */
export async function callVendor(name: string, args: Record<string, unknown> | null, ctx: VendorCallContext, deps: VendorDeps): Promise<VendorAnswer> {
  if (name === LLM_COMPLETE || name === CHAT_COMPLETE) return complete(name, args ?? {}, ctx, deps);
  if (name === JEV_NOUL) return jevNoul(args ?? {}, ctx, deps);
  if (name === VOICE_READ) return voiceRead(deps);
  if (name in SERVICE_DOOR_VENDORS) return serviceDoor(name, args ?? {}, ctx, deps);
  return refuse(`no vendor named ${name} (scripts may call: ${SCRIPT_VENDORS.join(", ")})`);
}

/** The production doors (chat-service with its own key). */
export function productionVendorDeps(): VendorDeps {
  const base = (process.env.CHAT_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.CHAT_SERVICE_API_KEY ?? "";
  const need = () => {
    if (!base || !key) throw new Error("CHAT_SERVICE_URL and CHAT_SERVICE_API_KEY must be set for script vendors");
  };
  return {
    async complete(body, headers) {
      need();
      const res = await fetch(`${base}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`chat-service POST /complete -> ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
    async judge(body, headers) {
      need();
      const res = await fetch(`${base}/orgs/judgments`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`chat-service POST /orgs/judgments -> ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
    async platformComplete(body, headers) {
      need();
      const res = await fetch(`${base}/internal/platform-complete`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`chat-service POST /internal/platform-complete -> ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
    async platformJudge(body, headers) {
      need();
      const res = await fetch(`${base}/internal/platform-judgments`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`chat-service POST /internal/platform-judgments -> ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
    async serviceDoor(service, method, path, body, headers) {
      const prefix = service.toUpperCase().replace(/-/g, "_");
      const base = (process.env[`${prefix}_SERVICE_URL`] ?? "").replace(/\/$/, "");
      const key = process.env[`${prefix}_SERVICE_API_KEY`] ?? "";
      if (!base || !key) throw new Error(`${prefix}_SERVICE_URL and ${prefix}_SERVICE_API_KEY must be set for its script doors`);
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), "x-api-key": key, ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { error: text.slice(0, 300) };
      }
      return { status: res.status, body: parsed };
    },
    async readSkill(slug) {
      need();
      const res = await fetch(`${base}/internal/skills/${encodeURIComponent(slug)}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(600_000) });
      if (!res.ok) return null;
      return (await res.json()) as { content?: unknown; version?: unknown };
    },
  };
}
