/**
 * ONE-WRITER-N-MODELS-1116 (owner 2026-11-16: « Je pensais qu'on avait qu'un script, et que le choix du model est
 * orthogonal / indépendant du script ??? »; GTM Factory framework v10 §2 "Request", §4).
 *
 * The LLM completion Engine (`llm_completion`): ONE script per model, the model its tactic `llm`. A writer never names
 * a model: it builds its prompt and ASKS for a completion,
 *
 *   ctx.ask({ units: {}, subject, request: { message, systemPrompt, responseSchema?, strictResponseSchema?, ... } });
 *   const done = ctx.get("llm_completion"); // done.content.answer = chat-service's whole answer
 *
 * and the Rating (features-service's script pick, told who asks: `askedBy`) picks which model answers THAT writer,
 * falling back to its Engine, then to the model alone. The completion runs as a child run of the writer's run, named
 * `script:llm_completion/<dynasty>`, so the model that wrote is the one credited and shown (SERVED-MODEL-1116).
 *
 * The Request is `llm.complete`'s call minus the LLM: `message`, `systemPrompt`, `responseSchema` (a schema or a named
 * one), and every other field chat-service takes (temperature, maxTokens, webSearch, brandTools...), passed as stated.
 * `strictResponseSchema`: the strict variant a provider that enforces JSON only through a strict schema needs
 * (Anthropic): a provider fact, so it is decided here, by the script that knows its provider, never by the writer.
 * The answer is never checked, retried or refused (a writer is trusted); a call chat-service refuses fails the run.
 */
import { PORT_HEAD } from "./port-kit.js";

export const LLM_COMPLETION = "llm_completion";

export interface CompletionLlm {
  provider: string;
  model: string;
  name: string;
}

/**
 * The models production's writers wrote with on 2026-11-16 (the per-model copies' tactics: cold email ways of
 * writing, the lead answerer, the reply judge), one script each. Never Haiku 4.5 (chat-service's `claude-haiku` is
 * Haiku 5.5). A new model = one more script (`llm_completion/dy_<model>`), stored through the catalogue.
 */
export const COMPLETION_LLMS: CompletionLlm[] = [
  { provider: "anthropic", model: "claude-haiku", name: "Claude Haiku" },
  { provider: "anthropic", model: "claude-sonnet", name: "Claude Sonnet" },
  { provider: "deepseek", model: "deepseek-flash", name: "DeepSeek Flash" },
  { provider: "google", model: "gemini-argon", name: "Gemini Argon" },
  { provider: "google", model: "gemini-flash", name: "Gemini Flash" },
  { provider: "google", model: "gemini-flash-lite", name: "Gemini Flash-Lite" },
  { provider: "google", model: "gemini-pro", name: "Gemini Pro" },
  { provider: "zai", model: "glm", name: "GLM" },
  { provider: "zai", model: "glm-flash", name: "GLM Flash" },
  { provider: "openai", model: "gpt-astra", name: "GPT Astra" },
  { provider: "openai", model: "gpt-sol", name: "GPT Sol" },
  { provider: "openai", model: "gpt-terra", name: "GPT Terra" },
  { provider: "moonshot", model: "kimi-k2", name: "Kimi K2" },
  { provider: "moonshot", model: "kimi-k3", name: "Kimi K3" },
];

/** `dy_<model>`: the model names its script. */
export function completionDynasty(llm: CompletionLlm): string {
  return `dy_${llm.model.replace(/-/g, "_")}`;
}

export function completionTactics(llm: CompletionLlm): Record<string, unknown> {
  return { llm: { provider: llm.provider, model: llm.model, name: llm.name } };
}

export function completionDescription(llm: CompletionLlm): string {
  return `Writes the completion a script asks for with ${llm.name}. The asking script states the prompt; this script states the model.`;
}

/** The one code every completion script runs: the model is its tactic. */
export function buildCompletionSource(): string {
  return `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";
${PORT_HEAD}
/** LLM completion (ONE-WRITER-N-MODELS-1116): the completion the asking script states, written with this script's model (tactic llm). */
export default function run(ctx: ScriptContext): ScriptResult {
  const r: any = ctx.request ?? {};
  const llm: any = (ctx.tactics ?? {}).llm ?? {};
  if (typeof llm.provider !== "string" || !llm.provider || typeof llm.model !== "string" || !llm.model) throw new Error("this completion script states no LLM (tactic llm: {provider, model})");
  if (typeof r.message !== "string" || !r.message) throw new Error("the asking script states no message (ctx.ask request.message)");
  const call: any = {};
  for (const k of Object.keys(r)) if (k !== "strictResponseSchema" && k !== "provider" && k !== "model") call[k] = r[k];
  // A provider that enforces JSON only through a strict schema gets the strict variant, when the asker states one.
  if (llm.provider === "anthropic" && r.strictResponseSchema && typeof r.strictResponseSchema === "object") call.responseSchema = r.strictResponseSchema;
  call.provider = llm.provider;
  call.model = llm.model;
  const answer: any = ctx.vendor.call("llm.complete", call);
  if (!answer.ok) throw new Error("llm.complete (" + llm.model + "): " + String(answer.data && answer.data.error ? answer.data.error : "no answer"));
  return { content: { answer: answer.data, llm: { provider: llm.provider, model: llm.model, name: typeof llm.name === "string" ? llm.name : llm.model } } };
}
`;
}
