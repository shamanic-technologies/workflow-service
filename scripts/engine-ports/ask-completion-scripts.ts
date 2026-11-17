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
  /**
   * A NEW dynasty for a way of writing that only a per-model copy carried (a different template = a different way):
   * built from that copy's stored code and tactics (`from`), created, and the copy merged into it.
   */
  from?: string;
  name?: string;
  /** Code appended after the rewrite (a helper the edits call). */
  append?: string;
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
  {
    outcome: "lead_interested",
    dynasty: "dy_reply_judge",
    edits: [],
    merged: ["dy_reply_judge__glm_flash"],
    description: "Lead interested, distribute.you reply judge: judges one reply with the request instantly-service sends (JSON, temperature 0, reasoning off), asked of the LLM completion Engine; it names no model.",
  },
  { outcome: "audience_built", dynasty: "dy_audience_split", edits: [] },
  {
    outcome: "audience_built",
    dynasty: "dy_split_proposal",
    merged: ["dy_split_proposal__glm_flash"],
    doors: [{ name: "human.split.complete", drop: ["proposal"] }],
    description: "Audience built, distribute.you split proposal: one writing call, asked of the LLM completion Engine, splits the client's target into at most six segments a people search can filter on, then human-service's door picks each card's icon. A model answer the parse refuses makes no proposal.",
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

/**
 * The post and WhatsApp writers: content-generation renders the template and stores what was written; the completion
 * in between is asked of the LLM completion Engine (content-generation v0.36.61: `/generate-thread/request` and `/generate-whatsapp/request` answer the
 * exact request minus the model, the generate door takes `completion: {request, answer, runId}`).
 */
export const ASKED_WRITER_HELPER = `
/** ONE-WRITER-N-MODELS-1116-OTHERS: the template's writer request, its completion asked (the Rating picks the model), the result stored by content-generation. */
function askedWriter(ctx: any, door: string, body: Record<string, unknown>, extra: Record<string, unknown>): any {
  const r: any = must(ctx, door + ".request", { body });
  const request: Record<string, unknown> = r.request;
  if (!request || typeof request !== "object") throw new Error(door + ".request answered no request");
  ctx.ask({ units: {}, request });
  const done: any = ctx.get("llm_completion");
  if (!done || !done.content) throw new Error("llm_completion: " + String((done && done.unmade) || "no completion") + ". Nothing is written: the run is retried later.");
  const llm: any = done.content.llm ?? {};
  const sent: Record<string, unknown> = {};
  for (const k of Object.keys(request)) if (k !== "strictResponseSchema") sent[k] = request[k];
  if (llm.provider === "anthropic" && request.strictResponseSchema) sent.responseSchema = request.strictResponseSchema;
  sent.provider = llm.provider;
  sent.model = llm.model;
  const runId = ctx.request && typeof ctx.request.runId === "string" ? ctx.request.runId : "";
  if (!runId) throw new Error(door + ": the run states no runId (the run that asked the completion)");
  return must(ctx, door + ".generate", { body: { ...body, ...extra, completion: { request: sent, answer: done.content.answer, runId } } });
}
`;

const SOCIAL_WRITER_EDITS: Edit[] = [
  {
    from: `  const draft = must(ctx, "content.thread.generate", {
    body: {
      variables: write.variables,
      context: write.context,
      brandIds: write.brandIds,
      campaignId,
      dryRun: false,
      type: head.template.type,
      model: pickLlm(ctx, "writer").model,
      ...(R.brief !== null && R.brief !== undefined ? { brief: R.brief } : {}),
    },
  });`,
    to: `  const draft = askedWriter(ctx, "content.thread", {
      variables: write.variables,
      context: write.context,
      brandIds: write.brandIds,
      campaignId,
      type: head.template.type,
      ...(R.brief !== null && R.brief !== undefined ? { brief: R.brief } : {}),
    }, { dryRun: false });`,
  },
];
export const MERGE_REASON = "The model is its own Engine: one script asks the LLM completion Engine (ONE-WRITER-N-MODELS-1116-OTHERS)";

/** `llm_completion/dy_<model>` for a model alias. */
export function completionDynastyOf(model: string): string {
  return `dy_${model.replace(/-/g, "_")}`;
}

const THREADS_WRITER_EDITS: Edit[] = [
  {
    from: `  const draft = must(ctx, "content.thread.generate", {
    body: {
      featureSlug: FEATURE,
      variables: write.variables,
      context: write.context,
      brandIds: write.brandIds,
      campaignId,
      dryRun: false,
      type: head.template.type,
      model: pickLlm(ctx, "writer").model,
      ...(R.brief !== null && R.brief !== undefined ? { brief: R.brief } : {}),
    },
  });`,
    to: `  const draft = askedWriter(ctx, "content.thread", {
      featureSlug: FEATURE,
      variables: write.variables,
      context: write.context,
      brandIds: write.brandIds,
      campaignId,
      type: head.template.type,
      ...(R.brief !== null && R.brief !== undefined ? { brief: R.brief } : {}),
    }, { dryRun: false });`,
  },
];

const FOUNDER_HELLO_EDITS: Edit[] = [
  {
    from: `    : must(ctx, "content.whatsapp.generate", {
        body: {
          featureSlug: FEATURE,
          context: composed.message,
          variables: composed.variables,
          campaignId,
          leadId: person.leadId,
          type: head.template.type,
          model: pickLlm(ctx, "writer").model,
          ...(R.brief !== null && R.brief !== undefined ? { brief: R.brief } : {}),
        },
      });`,
    to: `    : askedWriter(ctx, "content.whatsapp", {
          featureSlug: FEATURE,
          context: composed.message,
          variables: composed.variables,
          campaignId,
          leadId: person.leadId,
          type: head.template.type,
          ...(R.brief !== null && R.brief !== undefined ? { brief: R.brief } : {}),
        }, {});`,
  },
];

const X_COPIES = ["claude_sonnet", "deepseek_flash", "gemini_flash", "glm_flash", "gpt_sol", "kimi_k3"].map((m) => `dy_x_post__${m}__x_post_shape_rotation`);
const LINKEDIN_COPIES = ["claude_haiku", "gemini_argon", "gpt_astra", "kimi_k2", "kimi_k3"].map((m) => `dy_linkedin_post__${m}__linkedin_post_shape_rotation`);

ASKING_SCRIPTS.push(
  { outcome: "x_post_published", dynasty: "dy_x_post", edits: SOCIAL_WRITER_EDITS, append: ASKED_WRITER_HELPER, merged: X_COPIES },
  { outcome: "linkedin_post_published", dynasty: "dy_linkedin_post", edits: SOCIAL_WRITER_EDITS, append: ASKED_WRITER_HELPER, merged: LINKEDIN_COPIES },
  { outcome: "threads_post_published", dynasty: "dy_threads_thread", edits: THREADS_WRITER_EDITS, append: ASKED_WRITER_HELPER },
  {
    outcome: "threads_post_published",
    dynasty: "dy_threads_shape_rotation",
    from: "dy_threads_thread__deepseek_flash__threads_shape_rotation",
    name: "Shape rotation threads",
    description: "Publishes one Threads thread (a main post and two or three replies) on the brand's next Pro (AI) Threads account, at least an hour after its last one, during the day, written from the brand's own facts on the template threads-shape-rotation. It asks for the completion, it never names a model.",
    edits: THREADS_WRITER_EDITS,
    append: ASKED_WRITER_HELPER,
    merged: ["dy_threads_thread__deepseek_flash__threads_shape_rotation"],
  },
  {
    outcome: "threads_post_published",
    dynasty: "dy_threads_contrarian_take",
    from: "dy_threads_thread__gpt_sol__threads_contrarian_take",
    name: "Contrarian take threads",
    description: "Publishes one Threads thread (a main post and two or three replies) on the brand's next Pro (AI) Threads account, at least an hour after its last one, during the day, written from the brand's own facts on the template threads-contrarian-take. It asks for the completion, it never names a model.",
    edits: THREADS_WRITER_EDITS,
    append: ASKED_WRITER_HELPER,
    merged: ["dy_threads_thread__gpt_sol__threads_contrarian_take"],
  },
  { outcome: "whatsapp_message_sent", dynasty: "dy_founder_hello", edits: FOUNDER_HELLO_EDITS, append: ASKED_WRITER_HELPER },
);

/**
 * A DAG port (dag-port.ts): its writer step called the "llm.complete" door through `callStep` with the model a
 * features-service pick + plan step read; the step now asks the completion (door name `llm_completion`), the pick and
 * plan steps are gone.
 */
const DAG_PORT_EDITS: Edit[] = [
  { from: `  if (door === "llm.complete") args = sent(s.body ?? {});`, to: `  if (door === "llm_completion") args = sent(s.body ?? {});` },
  {
    from: `  for (let attempt = 0; ; attempt++) {
    const r: { ok: boolean; data: any } = ctx.vendor.call(door, args);`,
    to: `  // ONE-WRITER-N-MODELS-1116-OTHERS: the writer's completion is asked of the LLM completion Engine.
  if (door === "llm_completion") return askCompletionData(ctx, args);
  for (let attempt = 0; ; attempt++) {
    const r: { ok: boolean; data: any } = ctx.vendor.call(door, args);`,
  },
  {
    from: `  results.llm_pick = callStep(ctx, "llm.pick", { service: "features", method: "GET", path: "/internal/llm-pick", query: {"place":"writer"}, skip: (results.compose?.skip) }, 2);
  results.llm_plan = step_llm_plan((results.llm_pick), (results.compose?.skip));
`,
    to: ``,
  },
  { from: `  results.draft = callStep(ctx, "llm.complete", {`, to: `  results.draft = callStep(ctx, "llm_completion", {` },
  { from: `, provider: results.llm_plan?.provider, model: results.llm_plan?.model}`, to: `}` },
];

ASKING_SCRIPTS.push({ outcome: "lead_interested", dynasty: "dy_follow_up_due", edits: DAG_PORT_EDITS });
