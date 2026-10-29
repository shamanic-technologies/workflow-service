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
}

export interface VendorCallContext {
  /** Downstream headers of the script's run (x-run-id = the script's own run). */
  headers: Record<string, string>;
  /** The script's tactics (its own, then the run's on top). */
  tactics: Record<string, unknown>;
}

/** An LLM completion, answered with chat-service's whole answer `{content, json, model, tokensInput, tokensOutput}`. */
export const LLM_COMPLETE = "llm.complete";
/** The same completion, answered with the model's parsed JSON object itself. */
export const CHAT_COMPLETE = "chat.complete";
/** Jev yes/no judgments: `{state, questions: {<key>: {instructions, whenTrue?, whenFalse?}}}` -> `{probabilities: {<key>: P(yes)}, model}`. */
export const JEV_NOUL = "jev.noul";
/** Our one voice (chat-service skill `client-comms`), for a writer that builds its own system prompt: `{content, version}`. */
export const VOICE_READ = "voice.read";
export const SCRIPT_VENDORS = [LLM_COMPLETE, CHAT_COMPLETE, JEV_NOUL, VOICE_READ] as const;

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
    answer = await deps.complete(built.body, ctx.headers);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
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
    out = await deps.judge({ ...(args.state !== undefined ? { state: args.state } : {}), questions: wire }, ctx.headers);
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

/** Call one vendor for a script. */
export async function callVendor(name: string, args: Record<string, unknown> | null, ctx: VendorCallContext, deps: VendorDeps): Promise<VendorAnswer> {
  if (name === LLM_COMPLETE || name === CHAT_COMPLETE) return complete(name, args ?? {}, ctx, deps);
  if (name === JEV_NOUL) return jevNoul(args ?? {}, ctx, deps);
  if (name === VOICE_READ) return voiceRead(deps);
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
    async readSkill(slug) {
      need();
      const res = await fetch(`${base}/internal/skills/${encodeURIComponent(slug)}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(600_000) });
      if (!res.ok) return null;
      return (await res.json()) as { content?: unknown; version?: unknown };
    },
  };
}
