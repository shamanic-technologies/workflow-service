/**
 * ONE-WRITER-N-MODELS-1116 (owner 2026-11-16: « 63 scripts actifs pour 5 façons d'écrire », « Je pensais qu'on avait
 * qu'un script, et que le choix du model est orthogonal / indépendant du script ??? »).
 *
 * The cold email, as framework v10 §2 says it: the SENDER (Email sent) serves a person, reads who they are and the
 * brand, decides who signs, asks Message written for the email, then sends it; the WRITER (Message written) is one
 * script per WAY OF WRITING (its tactic `template`), which asks content-generation for that template's materials and
 * asks the LLM completion Engine for the completion. Nobody names a model: the Rating picks the way of writing for the
 * sender and the model for the writer (features-service, told who asks).
 *
 * Built from the STORED code (the source of truth), by anchored edits only, so nothing else in either script moves:
 *   - the writers from `message_written/dy_template_writer_full` (its prompt, voice, signature, language, give lists,
 *     brief, relationship blocks, schemas, parser: byte for byte);
 *   - the senders from `email_sent/dy_cold_email_signed_sender_client_brand` (the newest sender code: who signs is
 *     decided BEFORE the email is written, SENDER-NAME-BODY-1111; any 409 of the sender is a normal run).
 * Every edit must find its anchor exactly once, else the generator throws (the stored code moved: re-read it).
 */

/** One way of writing: a template dynasty (content-generation), its writer dynasty and its client-readable name. */
export interface WayOfWriting {
  template: string;
  /** The suffix the per-model copies carry (`..__<llm>__<code>`). */
  code: string;
  dynasty: string;
  name: string;
}

export const WAYS_OF_WRITING: WayOfWriting[] = [
  { template: "cold-reply-eight-second-named", code: "cresn", dynasty: "dy_eight_second_pitch", name: "Eight-second pitch" },
  { template: "cold-reply-three-line-reply-named", code: "crtlrn", dynasty: "dy_three_line_reply", name: "Three-line reply" },
  { template: "cold-reply-free-offer-named", code: "crfon", dynasty: "dy_free_offer", name: "Free offer" },
  { template: "cold-reply-intro-offer-named", code: "crion", dynasty: "dy_named_intro_offer", name: "Named intro offer" },
  { template: "cold-reply-intro-offer-blind", code: "criob", dynasty: "dy_blind_intro_offer", name: "Blind intro offer" },
];

export const GENERATION_REQUEST = "generation_request";
export const WRITER_OUTCOME = "message_written";
export const SENDER_OUTCOME = "email_sent";
export const COMPLETION_OUTCOME = "llm_completion";

/** The four cold email senders (one code; who signs and the extra variables are their tactics). */
export const SENDERS = ["dy_cold_email", "dy_cold_email_site", "dy_cold_email_signed_client_person", "dy_cold_email_signed_sender_client_brand"];

export interface Edit {
  from: string;
  to: string;
}

export function applyEdits(code: string, edits: Edit[], what: string): string {
  let out = code;
  for (const [i, e] of edits.entries()) {
    const n = out.split(e.from).length - 1;
    if (n !== 1) throw new Error(`${what}: edit ${i} found its anchor ${n} times (the stored code moved: re-read it)`);
    out = out.replace(e.from, () => e.to);
  }
  return out;
}

/** Removes one top-level function (and the doc comment right above it) by its exact head line. */
export function withoutFunction(code: string, head: string, what: string): string {
  const at = code.indexOf(head);
  if (at < 0 || code.indexOf(head, at + 1) >= 0) throw new Error(`${what}: function ${head} not found exactly once`);
  // Its closing brace: the first "\n}\n" after the head.
  const end = code.indexOf("\n}\n", at);
  if (end < 0) throw new Error(`${what}: function ${head} has no closing brace`);
  let start = at;
  const before = code.slice(0, at);
  const doc = before.lastIndexOf("/**");
  if (doc >= 0 && before.slice(doc).trimEnd().endsWith("*/") && !before.slice(doc).includes("\n\n")) start = doc;
  return code.slice(0, start) + code.slice(end + 3);
}

// ─── The writer ────────────────────────────────────────────────────────────

export const WRITER_EDITS: Edit[] = [
  {
    from: `export default function run(ctx: ScriptContext): ScriptResult {
  const lead = ctx.get("lead_identified");
  const brand = ctx.get("brand_context");
  const template = ctx.get("template_written");`,
    to: `/**
 * ONE-WRITER-N-MODELS-1116: one writer per WAY OF WRITING (its tactic \`template\`). The sender hands what it knows of
 * the person and the brand (\`${GENERATION_REQUEST}\`: content-generation's request minus the template and the model);
 * this writer asks content-generation for THIS template's materials, writes the prompt, and asks the LLM completion
 * Engine for the completion: the Rating picks the model for this writer. It names no model and sends nothing.
 */
export default function run(ctx: ScriptContext): ScriptResult {
  const asked: any = ctx.get("${GENERATION_REQUEST}");
  const genBody: Record<string, unknown> = { ...((asked.content && asked.content.body) || {}) };
  delete genBody.model;
  const pickAns: any = ctx.vendor.call("template.pick", { place: "writer" });
  if (!pickAns.ok) throw new Error("template.pick: " + String(pickAns.data.error));
  const templateDynastySlug = pickAns.data && pickAns.data.template ? pickAns.data.template.templateDynastySlug : null;
  if (typeof templateDynastySlug !== "string" || !templateDynastySlug) throw new Error("this writer states no template (tactic template): nothing is written");
  const head: any = ctx.vendor.call("content.template_head", { params: { slug: templateDynastySlug } });
  if (!head.ok) throw new Error("content.template_head: " + String(head.data.error));
  genBody.type = head.data.template && head.data.template.type;
  const materials: any = ctx.vendor.call("content.materials", { body: genBody });
  if (!materials.ok) throw new Error("content.materials: " + String(materials.data.error));
  const m: any = materials.data;
  // Already written for this person (content-generation's idempotency): nothing is written again, the sender has
  // content-generation answer the stored email.
  if (m.existing != null) return { content: { existing: true, generation: { body: genBody, materials: m } } };
  const lead: any = m.units.lead_identified;
  const brand: any = m.units.brand_context;
  const template: any = m.units.template_written;`,
  },
  {
    from: `  const llm = (ctx.tactics.llm ?? {}) as { provider?: string; model?: string };
  if (!llm.provider || !llm.model) throw new Error("the run states no LLM (tactic llm: {provider, model})");
  const responseSchema = llm.provider === "anthropic" ? GENERATE_RESPONSE_SCHEMA_STRICT : GENERATE_RESPONSE_SCHEMA;
  const answer = ctx.vendor.call("llm.complete", { message: prompt, systemPrompt, responseSchema, provider: llm.provider, model: llm.model });
  if (!answer.ok) throw new Error(\`llm.complete failed: \${String(answer.data.error ?? "no answer")}\`);
  const parsed = parseSequenceFromJson(answer.data.json as { subject: string; emails: Array<{ body: string; daysSinceLastStep?: unknown }> });
  return { content: { subject: parsed.subject, sequence: parsed.sequence } };`,
    to: `  // The completion: the model is the LLM completion Engine's pick for this writer (the strict schema is for a provider
  // that needs one, chosen by the completion script).
  ctx.ask({ units: {}, ...(m.subject ? { subject: m.subject } : {}), request: { message: prompt, systemPrompt, responseSchema: GENERATE_RESPONSE_SCHEMA, strictResponseSchema: GENERATE_RESPONSE_SCHEMA_STRICT } });
  const done: any = ctx.get("${COMPLETION_OUTCOME}");
  if (!done.content) throw new Error("llm_completion: " + String(done.unmade ?? "no completion"));
  const answer: any = done.content.answer;
  const parsed = parseSequenceFromJson(answer.json as { subject: string; emails: Array<{ body: string; daysSinceLastStep?: unknown }> });
  return { content: { subject: parsed.subject, sequence: parsed.sequence, generation: { body: genBody, units: m.units } } };`,
  },
];

export function buildWriterSource(storedWriter: string): string {
  return applyEdits(storedWriter, WRITER_EDITS, "message_written writer");
}

export function writerTactics(way: WayOfWriting): Record<string, unknown> {
  // personFields: what a person reads of this writer's Unit (the writer proof judges exactly these, montpellier-v1).
  return { template: way.template, asks: [COMPLETION_OUTCOME], personFields: ["subject", "sequence.*.bodyHtml"] };
}

export function writerDescription(way: WayOfWriting): string {
  return `Writes a first cold email in the ${way.name.toLowerCase()} way. It asks for the completion, it never names a model or sends.`;
}

// ─── The sender ────────────────────────────────────────────────────────────

export const SENDER_EDITS: Edit[] = [
  {
    from: `  const pickAns = ctx.vendor.call("template.pick", { place: "writer" });
  if (!pickAns.ok) throw new Error("template.pick: " + String(pickAns.data.error));
  const plan = writerPlan(pickAns.data as Record<string, any>);
  const head = ctx.vendor.call("content.template_head", { params: { slug: plan.templateDynastySlug } });
  if (!head.ok) throw new Error("content.template_head: " + String(head.data.error));
`,
    to: ``,
  },
  {
    from: `    type: (head.data as any).template?.type,
    model: pickLlm(ctx, "writer").model,
    leadId: lead.leadId,`,
    to: `    leadId: lead.leadId,`,
  },
  {
    from: `    const llm = pickLlm(ctx, "signature");
    const sig = ctx.vendor.call("llm.complete", {
      provider: llm.provider,
      model: llm.model,
      systemPrompt: SIGNER_SYSTEM_PROMPT,`,
    to: `    // The signature is a completion this sender asks for: the Rating picks its model (it names none).
    ctx.ask({ units: {}, subject: { service: "lead-service", id: lead.leadId }, request: {
      systemPrompt: SIGNER_SYSTEM_PROMPT,`,
  },
  {
    from: `    });
    if (!sig.ok) throw new Error("llm.complete (signature): " + String(sig.data.error));
    const text = String(((sig.data as any).json ?? {}).signature ?? "").trim();`,
    to: `    } });
    const sig: any = ctx.get("${COMPLETION_OUTCOME}");
    if (!sig.content) throw new Error("llm_completion (signature): " + String(sig.unmade ?? "no completion"));
    const text = String(((sig.content.answer as any).json ?? {}).signature ?? "").trim();`,
  },
  {
    from: `  const materials = ctx.vendor.call("content.materials", { body: genBody });
  if (!materials.ok) throw new Error("content.materials: " + String(materials.data.error));
  const m = materials.data as Record<string, any>;
  // Already written for this person (content-generation's idempotency): nothing is asked, content-generation answers
  // the stored email (the old run handed it the materials answer as \`written\`, kept as is).
  let written: unknown = m;
  if (m.existing == null) {
    ctx.ask({ units: m.units, subject: m.subject, tactics: m.tactics, recordedBy: "content-generation", trace: true, ...(statedSignature ? { request: { signature: statedSignature } } : {}) });
    // Live: the child run's whole answer rides \`run\`; in a replay of an old run the Unit IS that recorded answer.
    const got = ctx.get("message_written") as any;
    written = got.run ?? got.content;
  }
  const gen = ctx.vendor.call("content.generate", { body: { ...genBody, units: m.units, written } });`,
    to: `  // ONE-WRITER-N-MODELS-1116: the Rating picks the way of writing for this sender (a Message written script); that
  // writer asks its template's materials and a completion. This sender names no template and no model.
  ctx.ask({ units: { ${GENERATION_REQUEST}: { content: { body: genBody } } }, subject: { service: "lead-service", id: lead.leadId }, recordedBy: "content-generation", trace: true, ...(statedSignature ? { request: { signature: statedSignature } } : {}) });
  const got = ctx.get("${WRITER_OUTCOME}") as any;
  if (!got.content) throw new Error("message_written: " + String(got.unmade ?? "nothing written"));
  const generation = got.content.generation ?? {};
  // Already written for this person (content-generation's idempotency): content-generation answers the stored email
  // (handed the materials answer as \`written\`, as before); else the writer's whole run (its trace holds the completion).
  const existing = got.content.existing === true;
  const written: unknown = existing ? generation.materials : got.run;
  const gen = ctx.vendor.call("content.generate", { body: { ...generation.body, units: existing ? generation.materials.units : generation.units, written } });`,
  },
];

export function buildSenderSource(storedSender: string): string {
  let code = applyEdits(storedSender, SENDER_EDITS, "email_sent sender");
  code = withoutFunction(code, "function writerPlan(pick: Record<string, any>) {", "email_sent sender");
  code = withoutFunction(code, "function pickLlm(ctx: any, place: string, outcome?: string): { provider: string; model: string } {", "email_sent sender");
  if (/llm\.pick|template\.pick|"llm\.complete"/.test(code)) throw new Error("email_sent sender: still names a model call");
  return code;
}

/** The sender's tactics: its own, minus the writer's (template) and the model's (llm), plus what it asks. */
export function senderTactics(current: Record<string, unknown>): Record<string, unknown> {
  const { llm: _llm, llms: _llms, template: _t, templates: _ts, ...rest } = current;
  return { ...rest, asks: [WRITER_OUTCOME, COMPLETION_OUTCOME] };
}

// ─── The merges ────────────────────────────────────────────────────────────

/** A per-model copy of a cold email sender, as production stores it today. */
export interface ColdCopy {
  dynasty: string;
  template: string;
  model: string;
}

/** The sender a copy belongs to: the dynasty before its `__<llm>__<way>` suffix. */
export function senderOf(copy: ColdCopy): string {
  const base = copy.dynasty.split("__")[0]!;
  if (!SENDERS.includes(base)) throw new Error(`${copy.dynasty}: no known sender ${base}`);
  return base;
}

/**
 * Each copy counts at three places from now on: its sender (a campaign's own pick), the way of writing it wrote in
 * (asked by that sender), and its model (asked by that writer).
 */
export function mergePlaces(copy: ColdCopy): Array<{ survivor: string; askedBy: string | null }> {
  const way = WAYS_OF_WRITING.find((w) => w.template === copy.template);
  if (!way) throw new Error(`${copy.dynasty}: template ${copy.template} is no known way of writing`);
  const sender = `${SENDER_OUTCOME}/${senderOf(copy)}`;
  const writer = `${WRITER_OUTCOME}/${way.dynasty}`;
  return [
    { survivor: sender, askedBy: null },
    { survivor: writer, askedBy: sender },
    { survivor: `${COMPLETION_OUTCOME}/dy_${copy.model.replace(/-/g, "_")}`, askedBy: writer },
  ];
}

export const MERGE_REASON = "One writer per way of writing, the model is its own Engine (ONE-WRITER-N-MODELS-1116)";
