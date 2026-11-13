/**
 * SCRIPT-VALUE-RATING-1113-WF3 (owner 2026-11-13: « un pick = toujours un script », « le LLM et le template sont des
 * tactics du script »; about LLM calls coded inside services: « pourquoi ce ne sont pas des outcomes ? »).
 *
 * The drafts of a brand's fields and of an offer's fields (brand-service's `suggest` mode: the onboarding prefill, a new
 * offer) are made by these scripts, one Engine each: « Offer fields drafted » (`offer_fields_drafted`, a draft naming an
 * offer, and the cross-brand consolidation) and « Brand fields drafted » (`brand_fields_drafted`, a draft naming none).
 * brand-service asks the Engine for the Unit (`POST /internal/engines/{outcome}/make`): the Rating (features-service's
 * script pick) picks the dynasty, the script writes. The LLM it writes with is ITS tactic `llm` (or `llms.<place>`):
 * competing LLMs are competing dynasties of the Engine, never a run-time pick.
 *
 * Material `draft_request`: `{calls: [{place, systemPrompt, message, responseSchema?, responseFormat?, maxTokens?,
 * disableThinking?, temperature?}]}`, the chat requests brand-service builds today (its prompts, byte for byte: the
 * field batches of one draft, or the consolidation), minus the LLM. The script calls them in order, each with the LLM
 * its tactics state for that call's place, and answers `{content: {answers: [{place, json, content, model}]}}` in the
 * same order. No check, retry or refusal on the writer's answer (a writer is trusted); a call chat-service refuses
 * fails the run (nothing is drafted, brand-service answers its client an error as before).
 *
 * `recorded_by` brand: brand-service keeps every draft and declares the Unit itself, on THIS script's run.
 */
import { PORT_HEAD } from "./port-kit.js";

/** The material a draft hands the script: the chat requests of one draft. */
export const DRAFT_REQUEST = "draft_request";

/** The LLMs production ran each draft with before the port (features-service `engine_llm_picks`, 2026-11-12/13). */
export const FIELD_DRAFT_LLMS = {
  deepseekFlash: { provider: "deepseek", model: "deepseek-flash", name: "DeepSeek Flash" },
  geminiPro: { provider: "google", model: "gemini-pro", name: "Gemini Pro" },
  gptTerra: { provider: "openai", model: "gpt-terra", name: "GPT Terra" },
  glm: { provider: "zai", model: "glm", name: "GLM" },
  gptAstra: { provider: "openai", model: "gpt-astra", name: "GPT Astra" },
  kimiK3: { provider: "moonshot", model: "kimi-k3", name: "Kimi K3" },
} as const;

type Llm = (typeof FIELD_DRAFT_LLMS)[keyof typeof FIELD_DRAFT_LLMS];

export const FIELD_DRAFT_DYNASTY = "dy_fields_draft";

/** `<dynasty>__<llm>` (the SCRIPT-VALUE-RATING-1113-WF2 naming: the base dynasty carries the most-run LLM). */
export function forkDynasty(llm: Llm): string {
  return `${FIELD_DRAFT_DYNASTY}__${llm.model.replace(/-/g, "_")}`;
}

export interface FieldDraftEngine {
  outcome: "offer_fields_drafted" | "brand_fields_drafted";
  label: string;
  /** The base dynasty's LLM (the most-run one), then one fork per other LLM production ran. */
  base: Llm;
  forks: Llm[];
}

export const FIELD_DRAFT_ENGINES: FieldDraftEngine[] = [
  {
    outcome: "offer_fields_drafted",
    label: "an offer's fields",
    base: FIELD_DRAFT_LLMS.deepseekFlash,
    forks: [FIELD_DRAFT_LLMS.geminiPro, FIELD_DRAFT_LLMS.gptTerra, FIELD_DRAFT_LLMS.glm, FIELD_DRAFT_LLMS.gptAstra],
  },
  { outcome: "brand_fields_drafted", label: "a brand's fields", base: FIELD_DRAFT_LLMS.kimiK3, forks: [] },
];

/** The tactics of one dynasty: who records the Unit, and the LLM it writes with. */
export function fieldDraftTactics(llm: Llm): Record<string, unknown> {
  return { recorded_by: "brand", llm: { ...llm } };
}

export function fieldDraftDescription(engine: FieldDraftEngine, llm: Llm): string {
  return `Drafts ${engine.label} for the client to review, from the brand's site and what the client already told us, written with ${llm.name}.`;
}

/** The calls' fields passed to chat-service as stated (the LLM is the script's). */
export const DRAFT_CALL_FIELDS = ["responseSchema", "responseFormat", "maxTokens", "disableThinking", "temperature"] as const;

export function buildFieldDraftSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** A brand's or an offer's fields drafted: the draft's chat calls, written with the LLM this script states (SCRIPT-VALUE-RATING-1113-WF3). */`,
    PORT_HEAD,
    `
const CALL_FIELDS = ${JSON.stringify(DRAFT_CALL_FIELDS)};

export default function run(ctx: ScriptContext): ScriptResult {
  const request: any = ctx.get("${DRAFT_REQUEST}").content;
  const calls: any[] = Array.isArray(request.calls) ? request.calls : [];
  if (calls.length === 0) throw new Error("fields-draft: the draft request states no call");
  const answers: Array<Record<string, unknown>> = [];
  for (const call of calls) {
    const place = typeof call.place === "string" && call.place ? call.place : "draft";
    if (typeof call.message !== "string" || !call.message) throw new Error("fields-draft: a " + place + " call states no message");
    const llm = must(ctx, "llm.pick", { place });
    const args: Record<string, unknown> = { message: call.message, systemPrompt: typeof call.systemPrompt === "string" ? call.systemPrompt : "", provider: llm.provider, model: llm.model };
    for (const f of CALL_FIELDS) if (call[f] !== undefined) args[f] = call[f];
    const answer = must(ctx, "llm.complete", args);
    answers.push({ place, json: answer.json ?? null, content: answer.content ?? null, model: answer.model ?? null });
  }
  return { content: { answers } };
}
`,
  ].join("\n");
}
