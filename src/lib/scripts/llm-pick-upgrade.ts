/**
 * LLM-PICK-SCRIPTS-1112 (owner 2026-11-12: « Ce n'est pas normal qu'on ait des scripts qui tournent sur du Fable ou du
 * Opus », « est-ce que tu peux juste upgrade ces scripts pour qu'ils arrêtent de forcer un LLM ? »): every LLM call a
 * live script makes uses the LLM the GTM Factory Rating picks for its Engine and that call (`llm.pick`, vendors.ts).
 *
 * The UPGRADE of each stored script that named a model (a constant, a tactic) or read the LLM of the legacy per-pipe
 * writer pick: anchored edits on the STORED code (the stored version is the source of truth), each edit asserted to
 * land exactly where expected, so a drifted version is reported and never half-edited. A port with recorded cases is
 * upgraded with its cases RESTATED under the owner's rule: one recorded `llm.pick` call is inserted right before each
 * LLM call (or the call handed the writer LLM), answering the provider and model that call recorded, so every recorded
 * request stays byte for byte and the replay proves nothing else moved.
 *
 * Pure: `scripts/upgrade-llm-pick-1112.mjs` reads the active rows and cases and stores the upgrades.
 */
import type { RecordedCall, ReplayCase } from "./replay.js";

/** The helper every upgraded script calls: one pick per LLM call, a refusal fails the run (nothing written, retried). */
export const PICK_LLM_FN = `

/** The LLM of one call: the Rating's pick for this Engine and this call (LLM-PICK-SCRIPTS-1112). No LLM in the Engine's universe = nothing is written: the run fails and is retried later, never a fallback model. */
function pickLlm(ctx: any, place: string, outcome?: string): { provider: string; model: string } {
  const p = ctx.vendor.call("llm.pick", outcome ? { place, outcome } : { place });
  if (!p.ok) throw new Error("llm.pick " + place + ": " + String(p.data && p.data.error) + ". Nothing is written: the run is retried later.");
  return { provider: p.data.provider, model: p.data.model };
}
`;

export class UpgradeEditError extends Error {}

/** Replace `from` by `to` exactly `times` times (default once), else throw naming the edit. */
function edit(code: string, label: string, from: string | RegExp, to: string, times = 1): string {
  const re = typeof from === "string" ? new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : new RegExp(from.source, from.flags.includes("g") ? from.flags : from.flags + "g");
  const n = (code.match(re) ?? []).length;
  if (n !== times) throw new UpgradeEditError(`${label}: expected ${times} match(es), found ${n}`);
  return code.replace(re, () => to);
}

/** The text of `function <name>(` ... its closing brace, by brace matching. */
function functionSpan(code: string, name: string): { start: number; end: number } {
  const start = code.indexOf(`function ${name}(`);
  if (start < 0 || code.indexOf(`function ${name}(`, start + 1) >= 0) throw new UpgradeEditError(`function ${name}: expected exactly one`);
  let depth = 0;
  let i = code.indexOf("{", code.indexOf(")", start));
  for (; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return { start, end: i + 1 };
  }
  throw new UpgradeEditError(`function ${name}: no closing brace`);
}

/** writerPlan keeps the TEMPLATE half of the legacy pick only: its LLM half is gone (read by no script). */
function templateOnlyWriterPlan(code: string): string {
  const { start, end } = functionSpan(code, "writerPlan");
  let fn = code.slice(start, end);
  fn = edit(fn, "writerPlan model read", /\n\s*const model = pick && pick\.llm \? pick\.llm\.model : null;/, "");
  fn = edit(fn, "writerPlan LLM check", /\n\s*if \(typeof model !== "string" \|\| model\.length === 0\) \{\n\s*throw new Error\("\[writer-plan\] no LLM[^\n]*\n\s*\}/, "");
  fn = fn.replace(/ \+ ", LLM " \+ model\)/, ")");
  fn = fn.replace("{ skipped: true, templateDynastySlug: null, model: null }", "{ skipped: true, templateDynastySlug: null }");
  fn = fn.replace("templateDynastySlug, model, provider: pick.llm.provider ?? null, ", "templateDynastySlug, ");
  fn = fn.replace("return { templateDynastySlug, model };", "return { templateDynastySlug };");
  if (/\bmodel\b|\bllm\b/i.test(fn)) throw new UpgradeEditError(`writerPlan still reads an LLM: ${fn.slice(0, 200)}`);
  return code.slice(0, start) + fn + code.slice(end);
}

const withHelper = (code: string) => {
  if (code.includes("function pickLlm(")) throw new UpgradeEditError("the code already carries pickLlm");
  return code.replace(/\s*$/, "\n") + PICK_LLM_FN;
};

/** A rule of the case restatement: insert a pick right before each recorded call it matches. */
export interface PickInsertion {
  /** The recorded call the new code makes right after its pick. */
  before: string;
  /** Which of those calls (default every one). */
  when?: (call: RecordedCall) => boolean;
  /** The call's name (place), possibly read off the recorded call. */
  place: string | ((call: RecordedCall) => string);
  /** The Engine the pick is for when not the script's own (tactic asks). */
  outcome?: string;
  /** The provider + model the recorded call used (what the pick must answer for the request to stay byte for byte). */
  llmOf: (call: RecordedCall, previous: RecordedCall[]) => { provider: string; model: string } | null;
}

export interface LlmPickUpgrade {
  outcome: string;
  dynasty: string;
  /** The new code from the stored one. */
  code: (stored: string) => string;
  /** The new tactics, when they named a model. */
  tactics?: (stored: Record<string, unknown>) => Record<string, unknown>;
  /** How a recorded case is restated (absent = cases unchanged, the dynasty carries none). */
  insertions?: PickInsertion[];
  /**
   * Which stored cases are this dynasty's own (default all): `dy_audience_split` holds 9 records of
   * `dy_split_proposal`'s door (`human.split.complete`), a call its code never makes (its v1 replays 101/110).
   */
  keepCase?: (c: ReplayCase) => boolean;
  /** What an upgraded version already carries (skipped when present): default `"llm.pick"`. */
  marker?: string;
  /** Upgraded only while the stored code still carries this (default: always); `marker` then unused. */
  needs?: string;
  /** A recorded call REPLACED by the pick (the follow-up port's writer pick step). */
  replaceCall?: { name: string; args: Record<string, unknown> };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const bodyOf = (c: RecordedCall) => ((c.args as Record<string, unknown> | undefined)?.body ?? {}) as Record<string, unknown>;
/** The legacy writer pick's LLM, as the recorded answer served it (what the old code wrote with). */
const writerPickLlm = (previous: RecordedCall[]) => {
  const wp = [...previous].reverse().find((c) => c.name === "features.writer_pick");
  const llm = (wp?.answer?.data as Record<string, unknown> | undefined)?.llm as Record<string, unknown> | undefined;
  return llm && str(llm.model) ? { provider: str(llm.provider) ?? "", model: str(llm.model)! } : null;
};
const argsLlm = (c: RecordedCall) => {
  const a = (c.args ?? {}) as Record<string, unknown>;
  return str(a.provider) && str(a.model) ? { provider: str(a.provider)!, model: str(a.model)! } : null;
};

/** The pick answer a restated case records. */
function pickAnswer(place: string, outcome: string, llm: { provider: string; model: string } | null): RecordedCall["answer"] {
  if (!llm) return { ok: false, data: { error: `llm.pick ${outcome}|${place}: no LLM recorded for this call` } };
  const picked = { provider: llm.provider, model: llm.model, llmDynastySlug: llm.model, name: null };
  return { ok: true, data: { ...picked, place, outcome, llm: picked } };
}

/** Restate one recorded case under the upgrade (pure; the case's own fields are kept). */
export function restateCase(u: LlmPickUpgrade, c: ReplayCase): ReplayCase {
  const calls: RecordedCall[] = [];
  for (const call of c.calls) {
    if (u.replaceCall && call.name === "features.writer_pick") {
      const llm = (call.answer?.data as Record<string, unknown> | undefined)?.llm as Record<string, unknown> | undefined;
      const answer: RecordedCall["answer"] =
        call.answer?.ok && llm && str(llm.model)
          ? pickAnswer(String(u.replaceCall.args.place ?? (u.replaceCall.args.query as Record<string, unknown>)?.place), u.outcome, { provider: str(llm.provider) ?? "", model: str(llm.model)! })
          : call.answer;
      calls.push({ name: u.replaceCall.name, ...(call.args !== undefined ? { args: u.replaceCall.args } : {}), answer });
      continue;
    }
    for (const ins of u.insertions ?? []) {
      if (call.name !== ins.before || (ins.when && !ins.when(call))) continue;
      const place = typeof ins.place === "function" ? ins.place(call) : ins.place;
      const outcome = ins.outcome ?? u.outcome;
      calls.push({ name: "llm.pick", ...(call.args !== undefined ? { args: ins.outcome ? { place, outcome: ins.outcome } : { place } } : {}), answer: pickAnswer(place, outcome, ins.llmOf(call, calls)) });
    }
    calls.push(call);
  }
  return { ...c, calls };
}

// ─── The scripts ───────────────────────────────────────────────────────────────────────────────────────────────

/** X, LinkedIn and Threads posts: three research calls and the writer, each its own place. */
function postCode(stored: string): string {
  let code = edit(stored, "LLM constant", /\nconst LLM = \{"provider":"[^"]+","model":"[^"]+"\};/, "");
  code = edit(code, "angles call", 'withBrief({ provider: LLM.provider, model: LLM.model, webSearch: true,', 'withBrief({ ...pickLlm(ctx, "angles"), webSearch: true,');
  code = edit(code, "own pages call", 'withBrief({ provider: LLM.provider, model: LLM.model, responseFormat: "json",', 'withBrief({ ...pickLlm(ctx, "own_pages"), responseFormat: "json",');
  code = edit(code, "own figures call", "withBrief({ provider: LLM.provider, model: LLM.model, maxTokens: 4000, message: own.message,", 'withBrief({ ...pickLlm(ctx, "own_figures"), maxTokens: 4000, message: own.message,');
  code = edit(code, "writer model", "      model: writer.model,\n", '      model: pickLlm(ctx, "writer").model,\n');
  code = templateOnlyWriterPlan(code);
  return withHelper(code);
}
const POST_PLACES = (c: RecordedCall) => {
  const a = (c.args ?? {}) as Record<string, unknown>;
  return a.webSearch ? "angles" : a.responseSchema ? "own_pages" : "own_figures";
};
const postInsertions = (writerCall: string): PickInsertion[] => [
  { before: "llm.complete", place: POST_PLACES, llmOf: (c) => argsLlm(c) },
  { before: writerCall, place: "writer", llmOf: (c, prev) => (str(bodyOf(c).model) ? { provider: writerPickLlm(prev)?.provider ?? "", model: str(bodyOf(c).model)! } : writerPickLlm(prev)) },
];

/** The cold emails: the writer LLM handed to message_written (the Engine whose script makes the call), the signer its own. */
function coldEmailCode(stored: string): string {
  let code = edit(stored, "writer model", "    model: plan.model,\n", '    model: pickLlm(ctx, "writer", "message_written").model,\n');
  if (code.includes("const llm = (pickAns.data as any).llm ?? {};")) {
    code = edit(code, "signer LLM", "const llm = (pickAns.data as any).llm ?? {};", 'const llm = pickLlm(ctx, "signature");');
    code = edit(code, "signer provider", "      provider: llm.provider ?? undefined,\n", "      provider: llm.provider,\n");
  }
  code = templateOnlyWriterPlan(code);
  return withHelper(code);
}
const coldEmailInsertions: PickInsertion[] = [
  {
    before: "content.materials",
    place: "writer",
    outcome: "message_written",
    llmOf: (c, prev) => (str(bodyOf(c).model) ? { provider: writerPickLlm(prev)?.provider ?? "", model: str(bodyOf(c).model)! } : writerPickLlm(prev)),
  },
];

/** The answering script: its one decision call. */
function answerLeadCode(stored: string): string {
  let code = edit(
    stored,
    "writer pick",
    /  const writer = must\("features\.writer_pick", \{ query: \{ campaignId: campaignId \} \}\);\n  const llm = writer\.llm \|\| \{\};\n  if \(!s\(llm\.provider\) \|\| !s\(llm\.model\)\) throw new Error\("no writer LLM picked for this campaign: " \+ String\(writer\.llmUnavailableReason \|\| "none"\)\);/,
    '  const llm = must("llm.pick", { place: "writer" });\n  if (!s(llm.provider) || !s(llm.model)) throw new Error("llm.pick answered no LLM for the writer: nothing is written");',
  );
  code = edit(code, "writer pick comment", /  \/\/ The writer's LLM is features-service's pick for this campaign[^\n]*\n  \/\/ never one the script states[^\n]*\n/, "  // The writer's LLM is the Rating's pick for this Engine and this call (LLM-PICK-SCRIPTS-1112): never one the script\n  // states, never a default; none = the run fails, nothing written.\n");
  return code;
}

/** The founder hello: its template writer's LLM. */
function founderHelloCode(stored: string): string {
  let code = edit(stored, "writer model", "          model: writer.model,\n", '          model: pickLlm(ctx, "writer").model,\n');
  code = templateOnlyWriterPlan(code);
  return withHelper(code);
}

/** The follow-up port: the writer pick step becomes the Rating's pick for the writer. */
const FOLLOW_UP_PICK_ARGS = { query: { place: "writer" } };
function followUpCode(stored: string): string {
  return edit(
    stored,
    "writer pick step",
    /results\.llm_pick = callStep\(ctx, "features\.writer_pick", \{ service: "features", method: "GET", path: "\/internal\/writer-pick", query: \(\(\{workflowSlug: flow_input\.workflowSlug, campaignId: flow_input\.campaignId\}\)\), skip: \(results\.compose\?\.skip\) \}, 2\);/,
    'results.llm_pick = callStep(ctx, "llm.pick", { service: "features", method: "GET", path: "/internal/llm-pick", query: {"place":"writer"}, skip: (results.compose?.skip) }, 2);',
  );
}

/** The reply judge (instantly's lead_interested): its one judgment call. */
function replyJudgeCode(stored: string): string {
  let code = edit(stored, "judge model", 'provider: "deepseek", model: "deepseek-flash", ', '...pickLlm(ctx, "judge"), ');
  code = edit(code, "judge comment", /\(provider deepseek, deepseek-flash, JSON, temperature 0, reasoning off\)/, "(JSON, temperature 0, reasoning off; the LLM is the Rating's pick since LLM-PICK-SCRIPTS-1112)");
  return withHelper(code);
}

/** The audience split proposals: one completion each. */
function splitCode(stored: string, call: string): string {
  let code = edit(stored, "split constants", /\nconst SPLIT_LLM_PROVIDER = "[^"]+";\nconst SPLIT_LLM_MODEL = "[^"]+";/, "");
  code =
    call === "inline"
      ? edit(code, "split call", "provider: SPLIT_LLM_PROVIDER, model: SPLIT_LLM_MODEL, ", '...pickLlm(ctx, "split"), ')
      : edit(code, "split call", "      provider: SPLIT_LLM_PROVIDER,\n      model: SPLIT_LLM_MODEL,\n", '      ...pickLlm(ctx, "split"),\n');
  return withHelper(code);
}

/** The backlink listicle outreach: its reader (two calls) and its writer. */
function listicleCode(stored: string): string {
  let code = edit(stored, "tactic LLMs", /  const reader = t\.readerLlm \?\? null;\n  const writer = t\.llm \?\? null;\n  if \(!reader\?\.provider[^\n]*\n/, "");
  code = edit(code, "page pick", "      provider: reader.provider, model: reader.model, systemPrompt: PAGE_PICK_PROMPT,", '      ...pickLlm(ctx, "page_pick"), systemPrompt: PAGE_PICK_PROMPT,');
  code = edit(code, "page read", "      provider: reader.provider, model: reader.model, systemPrompt: PAGE_READ_PROMPT,", '      ...pickLlm(ctx, "page_read"), systemPrompt: PAGE_READ_PROMPT,');
  code = edit(code, "pitch", "      provider: writer.provider, model: writer.model, responseFormat: \"json\", responseSchema: PITCH_SCHEMA,", '      ...pickLlm(ctx, "pitch"), responseFormat: "json", responseSchema: PITCH_SCHEMA,');
  return withHelper(code);
}
const dropLlmTactics = (t: Record<string, unknown>) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== "llm" && k !== "readerLlm"));

/**
 * A recorded call whose REQUEST was not recorded (`args` absent: the replay compares no request for it) used the model the
 * old code stated, the only one it could call: the restated pick answers that one, so the replay proves the rest.
 */
const JUDGE_STATED = { provider: "deepseek", model: "deepseek-flash" };
const SPLIT_STATED = { provider: "anthropic", model: "sonnet" };
const UNRECORDED = (c: RecordedCall, stated: { provider: string; model: string }) => (c.args === undefined ? stated : null);

export const LLM_PICK_UPGRADES: LlmPickUpgrade[] = [
  { outcome: "x_post_published", dynasty: "dy_x_post", code: postCode, insertions: postInsertions("content.thread.generate") },
  { outcome: "linkedin_post_published", dynasty: "dy_linkedin_post", code: postCode, insertions: postInsertions("content.thread.generate") },
  { outcome: "threads_post_published", dynasty: "dy_threads_thread", code: postCode, insertions: postInsertions("content.thread.generate") },
  { outcome: "backlink_earned", dynasty: "dy_listicle_outreach", code: listicleCode, tactics: dropLlmTactics },
  { outcome: "email_sent", dynasty: "dy_cold_email", code: coldEmailCode, insertions: coldEmailInsertions },
  { outcome: "email_sent", dynasty: "dy_cold_email_site", code: coldEmailCode, insertions: coldEmailInsertions },
  { outcome: "email_sent", dynasty: "dy_cold_email_signed_client_person", code: coldEmailCode, insertions: coldEmailInsertions },
  { outcome: "email_sent", dynasty: "dy_cold_email_signed_sender_client_brand", code: coldEmailCode, insertions: coldEmailInsertions },
  { outcome: "message_sent", dynasty: "dy_answer_lead", code: answerLeadCode },
  { outcome: "whatsapp_message_sent", dynasty: "dy_founder_hello", code: founderHelloCode, insertions: [{ before: "content.whatsapp.generate", place: "writer", llmOf: (c, prev) => (str(bodyOf(c).model) ? { provider: writerPickLlm(prev)?.provider ?? "", model: str(bodyOf(c).model)! } : writerPickLlm(prev)) }] },
  { outcome: "conversation", dynasty: "dy_follow_up_due", code: followUpCode, replaceCall: { name: "llm.pick", args: FOLLOW_UP_PICK_ARGS } },
  { outcome: "lead_interested", dynasty: "dy_reply_judge", code: replyJudgeCode, insertions: [{ before: "llm.complete", place: "judge", llmOf: (c) => argsLlm(c) ?? UNRECORDED(c, JUDGE_STATED) }] },
  { outcome: "audience_built", dynasty: "dy_audience_split", code: (s) => splitCode(s, "inline"), keepCase: (c) => !c.calls.some((x) => x.name === "human.split.complete"), insertions: [{ before: "chat.complete", place: "split", llmOf: (c) => argsLlm(c) ?? UNRECORDED(c, SPLIT_STATED) }] },
  { outcome: "audience_built", dynasty: "dy_split_proposal", code: (s) => splitCode(s, "door"), insertions: [{ before: "human.split.complete", place: "split", llmOf: (c) => argsLlm(c) }] },
];

/** Model names no active script may state (the AC grep). */
export const NAMED_MODEL = /["'`](opus|sonnet|fable|haiku|claude-[a-z0-9.-]+|deepseek-[a-z0-9.-]+|gemini[a-z0-9.-]*|gpt-[a-z0-9.-]+|glm-[a-z0-9.-]+|kimi[a-z0-9.-]*|flash|pro|flash-pro|flash-lite)["'`]/i;

// ─── Phase 2: the TEMPLATE (LLM-RATING-PER-ENGINE-1112 phase 2) ─────────────────────────────────────────────────

/** The legacy writer pick call becomes the Rating's template pick for the script's own Engine, its writing call. */
function templatePickCode(stored: string): string {
  let code = edit(stored, "writer pick call", /"features\.writer_pick", \{ query: \{ campaignId(?:: req\.campaignId)? \} \}/, '"template.pick", { place: "writer" }');
  code = code.replace(/"features\.writer_pick: "/g, '"template.pick: "');
  if (code.includes("features.writer_pick")) throw new UpgradeEditError("the code still calls features.writer_pick");
  return code;
}

/** A recorded legacy writer pick restated as the template pick answering the template it served (the head is read live). */
export function restateTemplateCase(u: LlmPickUpgrade, c: ReplayCase): ReplayCase {
  return {
    ...c,
    calls: c.calls.map((call) => {
      if (call.name !== "features.writer_pick") return call;
      const tpl = (call.answer?.data as Record<string, unknown> | undefined)?.template as Record<string, unknown> | undefined;
      const slug = tpl ? str(tpl.templateDynastySlug) : null;
      const answer: RecordedCall["answer"] = call.answer?.ok
        ? (() => {
            const picked = { templateDynastySlug: slug, name: tpl ? str(tpl.name) : null, head: null };
            return { ok: true, data: { ...picked, place: "writer", outcome: u.outcome, template: picked } };
          })()
        : call.answer;
      return { name: "template.pick", ...(call.args !== undefined ? { args: { place: "writer" } } : {}), answer };
    }),
  };
}

export const TEMPLATE_PICK_UPGRADES: LlmPickUpgrade[] = [
  "x_post_published/dy_x_post",
  "linkedin_post_published/dy_linkedin_post",
  "threads_post_published/dy_threads_thread",
  "email_sent/dy_cold_email",
  "email_sent/dy_cold_email_site",
  "email_sent/dy_cold_email_signed_client_person",
  "email_sent/dy_cold_email_signed_sender_client_brand",
  "whatsapp_message_sent/dy_founder_hello",
].map((key) => {
  const [outcome, dynasty] = key.split("/") as [string, string];
  return { outcome, dynasty, code: templatePickCode, marker: '"template.pick"' };
});

// ─── Phase 3: the cold email's writer LLM is picked on its OWN Engine ───────────────────────────────────────────
// The Rating files the writing calls under the OUTERMOST script (`email_sent/dy_cold_email`), and the templates sit on
// `email_sent` too: a `message_written` pick saw no history (features montgomery-v3, 2026-11-12).

const OWN_ENGINE_FROM = 'pickLlm(ctx, "writer", "message_written")';
function writerOwnEngineCode(stored: string): string {
  return edit(stored, "writer pick on message_written", OWN_ENGINE_FROM, 'pickLlm(ctx, "writer")');
}

/** A recorded writer pick for `message_written` restated as the same pick on the script's own Engine. */
export function restateOwnEngineCase(u: LlmPickUpgrade, c: ReplayCase): ReplayCase {
  return {
    ...c,
    calls: c.calls.map((call) => {
      const a = call.args as Record<string, unknown> | undefined;
      if (call.name !== "llm.pick" || a?.outcome !== "message_written") return call;
      const data = { ...((call.answer?.data as Record<string, unknown>) ?? {}), outcome: u.outcome };
      return { ...call, args: { place: a.place }, answer: { ...call.answer, data } };
    }),
  };
}

export const WRITER_OWN_ENGINE_UPGRADES: LlmPickUpgrade[] = ["dy_cold_email", "dy_cold_email_site", "dy_cold_email_signed_client_person", "dy_cold_email_signed_sender_client_brand"].map(
  (dynasty) => ({ outcome: "email_sent", dynasty, code: writerOwnEngineCode, needs: OWN_ENGINE_FROM }),
);
