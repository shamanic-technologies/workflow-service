/**
 * ONE-WRITER-N-MODELS-1116-OTHERS: the scripts that named their model, and each one's OWN edits (anything the
 * mechanical rewrite of `ask-completion.ts` cannot do: removing its own model read, replacing a service door that
 * made the completion for it). Keyed `<outcome>/<dynasty>` of the survivor; `merged` = the per-model copies of it
 * (same code, another model) merged into it. Every edit's anchor must be found exactly once in the stored code.
 */
import type { Edit } from "./cold-email-one-writer.js";
import type { DoorAsCompletion } from "./ask-completion.js";

export interface AskingScript {
  outcome: string;
  dynasty: string;
  edits: Edit[];
  /** Service doors whose completion moves to the LLM completion Engine (restated in the cases). */
  doors?: DoorAsCompletion[];
  /** The per-model copies of this dynasty (same code), merged into it. */
  merged?: string[];
  description?: string;
  /** Tactics added (e.g. `personFields`: what a person reads of its Unit, judged by the writer proof). */
  addTactics?: Record<string, unknown>;
}

const FIELDS_DRAFT_EDITS: Edit[] = [
  { from: `    const llm = must(ctx, "llm.pick", { place });\n`, to: `` },
  { from: `, provider: llm.provider, model: llm.model };`, to: ` };` },
];

export const ASKING_SCRIPTS: AskingScript[] = [
  {
    outcome: "offer_fields_drafted",
    dynasty: "dy_fields_draft",
    edits: FIELDS_DRAFT_EDITS,
    merged: ["dy_fields_draft__gemini_pro", "dy_fields_draft__glm", "dy_fields_draft__gpt_astra", "dy_fields_draft__gpt_terra"],
    description: "Writes the draft's chat calls brand-service hands it, in order. It asks for each completion, it never names a model.",
  },
  {
    outcome: "brand_fields_drafted",
    dynasty: "dy_fields_draft",
    edits: FIELDS_DRAFT_EDITS,
    description: "Writes the draft's chat calls brand-service hands it, in order. It asks for each completion, it never names a model.",
  },
  { outcome: "lead_interested", dynasty: "dy_reply_judge", edits: [], merged: ["dy_reply_judge__glm_flash"] },
  { outcome: "audience_built", dynasty: "dy_audience_split", edits: [] },
  {
    outcome: "audience_built",
    dynasty: "dy_split_proposal",
    merged: ["dy_split_proposal__glm_flash"],
    doors: [{ name: "human.split.complete", drop: ["proposal"] }],
    edits: [
      {
        from: `    const written = door(ctx, "human.split.complete", {
      proposal,
      message: targetAudience,
      systemPrompt: buildSplitSystemPrompt(),
      ...pickLlm(ctx, "split"),
      responseSchema: SPLIT_RESPONSE_SCHEMA,
      disableThinking: true,
    });`,
        to: `    // ONE-WRITER-N-MODELS-1116-OTHERS: the split is a completion this script asks for (the Rating picks its model).
    const asked = askChatCompletion(ctx, {
      message: targetAudience,
      systemPrompt: buildSplitSystemPrompt(),
      responseSchema: SPLIT_RESPONSE_SCHEMA,
      disableThinking: true,
    });
    if (!asked.ok) throw new Unmade(\`human.split.complete: \${String(asked.data.error ?? "refused")}\`);
    const written = asked.data;`,
      },
    ],
  },
];

/** The intro scripts' one completion helper read its model per place (`llmFor`): the call now asks. */
const INTRO_EDITS: Edit[] = [
  {
    from: `  const llm = llmFor(ctx, place);
  const a = must(ctx, "llm.complete", { provider: llm.provider, model: llm.model, systemPrompt,`,
    to: `  const a = must(ctx, "llm.complete", { systemPrompt,`,
  },
];

ASKING_SCRIPTS.push(
  { outcome: "email_sent", dynasty: "dy_intro_lead_to_lead", edits: INTRO_EDITS, addTactics: { personFields: ["subject", "body"] } },
  { outcome: "email_sent", dynasty: "dy_intro_open", edits: INTRO_EDITS, addTactics: { personFields: ["subject", "body"] } },
  { outcome: "email_sent", dynasty: "dy_intro_client_to_lead", edits: INTRO_EDITS, addTactics: { personFields: ["subject", "body"] } },
  { outcome: "message_sent", dynasty: "dy_intro_answer", edits: INTRO_EDITS },
  { outcome: "paid_client", dynasty: "dy_intro_path", edits: INTRO_EDITS },
  { outcome: "backlink_earned", dynasty: "dy_listicle_outreach", edits: [], addTactics: { personFields: ["pitched.subject", "pitched.body"] } },
);

export const MERGE_REASON = "The model is its own Engine: one script asks the LLM completion Engine (ONE-WRITER-N-MODELS-1116-OTHERS)";

/** `llm_completion/dy_<model>` for a model alias. */
export function completionDynastyOf(model: string): string {
  return `dy_${model.replace(/-/g, "_")}`;
}
