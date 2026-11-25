/**
 * DISTRY-ENGINES-1119 (owner 2026-11-19: « assurons nous bien que chaque outcome est appelable par Distry »): every
 * Engine of the catalogue holds at least one runnable script, so Distry (and any campaign) can ask it for one Unit.
 * Same mechanism as every other script: each one is DATA stored through the script API (`distry-engines-store.ts` |
 * `post-catalogue-ops.mjs`), never a branch on an outcome in the runner.
 *
 * Four shapes, each ONE code whatever the outcome it is filed under (the outcome is never named in a script):
 *   1. PATH (`buildPathSource`): an outcome that is a PERSON's own act (they sign up, visit, buy, fill a form, reply
 *      with interest, give their WhatsApp number) or an AUDIENCE's (a post viewed, engaged, a search click). A script
 *      cannot make the act; it does its part by asking the Engine that acts (the answerer writes to the lead with the
 *      script's `goal`, a post Engine publishes, the backlink Engine earns a link) and the Unit lands when the owning
 *      service observes the act (`recorded_by`). Same shape as the Meeting booked path (SCRIPT-VALUE-RATING-1113-WF1).
 *   2. DRAFT (`buildDraftSource`): a draft of a piece (an X post, a LinkedIn post or comment, a newsletter), written by
 *      the LLM completion Engine the script asks (the model is never named here); the format is the tactic `format`.
 *   3. REPLY (`buildReplySource`): one reply under someone else's post on the brand's own X or LinkedIn account
 *      (social-service publishes it and declares the Unit), its text asked of the LLM completion Engine.
 *   4. PRODUCER (`buildEmailCheckSource`, `buildPhoneRevealSource`, `buildCompanyCheckSource`,
 *      `buildIndustryVideoSource`): one call of the owning service's own org route, which bills the run and declares
 *      its Unit (`recorded_by` that service).
 * Positive reply (`conversation`) holds two paths (TARGET-CONVERSATION-NO-SCRIPT-1121: two campaigns launched on that
 * Target alone were refused every tick, the Engine held no runnable script): a first email to a new lead (asks Email
 * sent) and an answer to a lead owed one (asks Message sent with the goal). Every live channel whose leg reaches a
 * positive reply names a finer Engine in the catalogue (cold email and pushed email = Email sent, follow-up = Lead
 * interested, founder hello = WhatsApp message sent), so these paths serve only campaigns that reach Positive reply
 * itself: a campaign launched on that Target, or a channel stating no finer outcome.
 * An outcome no script can make on demand (an ad with no ad account, a draft only a person of the team approves, a
 * newsletter released to a whole list) holds no script: its plain-words reason is stated as data
 * (`PUT /internal/engines/{outcome}/reason`, `ENGINE_REASONS` below), shown as-is on the Engine list.
 */
import { BRIEF_HEADER } from "../../src/lib/campaign-brief.js";
import { PORT_HEAD } from "./port-kit.js";

const HEAD = `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`;

/** Helpers every shape reads: plain strings, the run's brand, the brand's name and site, dashes rewritten. */
const COMMON = `
const BRIEF_HEADER = ${JSON.stringify(BRIEF_HEADER)};
function str(v: any): string {
  return typeof v === "string" ? v.trim() : "";
}
function brandIdOf(ctx: any, R: any): string {
  const ids = Array.isArray(R.brandIds) ? R.brandIds.filter((b: any) => typeof b === "string" && b.trim()) : [];
  return ids.length ? String(ids[0]).trim() : str(ctx.brand);
}
function brandOf(ctx: any, brandId: string): { name: string; domain: string } {
  if (!brandId) return { name: "", domain: "" };
  const p: any = tolerated(ctx, "brand.profile", { params: { id: brandId } });
  const b: any = p && p.brand && typeof p.brand === "object" ? p.brand : p || {};
  return { name: str(b.name), domain: str(b.domain) };
}
function undash(s: string): string {
  return s.replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-").replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ");
}
`;

/**
 * Only in the scripts that ask the LLM completion Engine (tactic `asks`): the catalogue reads a script's materials off
 * its code, so a helper reading `llm_completion` in a script that never asks it would make that script undrawable.
 */
const COMPLETION = `
function completion(ctx: any, request: Record<string, unknown>): any {
  ctx.ask({ units: {}, request });
  const done: any = ctx.get("llm_completion");
  if (!done || !done.content) throw new Error("llm_completion: " + String((done && done.unmade) || "no completion"));
  const json = done.content.answer && typeof done.content.answer.json === "object" ? done.content.answer.json : null;
  if (!json) throw new Error("llm_completion answered no JSON: " + JSON.stringify(done.content.answer).slice(0, 300));
  return { json, llm: done.content.llm ?? null };
}
`;

// ── 1. Paths ──────────────────────────────────────────────────────────────────────────────────────────────

export interface PathSpec {
  outcome: string;
  dynasty: string;
  name: string;
  /** The Engine the path asks (one). */
  asks: string;
  tactics: Record<string, unknown>;
  description: string;
  /** The asked Engine acts on no pushed person: the path refuses an occurrence (`buildPathSource`). */
  answersNobody?: boolean;
}

/**
 * The refusal a path that acts on NOBODY pushed (a first email to a newly found person, a post, a backlink) states on a
 * run answering an occurrence (PLAN-RECURSIVE-PER-ENGINE-1124-WF2): someone wrote or acted, and this script answers
 * nobody, so the occurrence goes to the next script of the draw (a refusal about WHO, LEAD-EVENT-ONE-CAMPAIGN-1121),
 * never a cold email to a stranger instead of an answer.
 */
export const ANSWERS_NOBODY_REFUSAL = "person_not_admitted: this script starts with someone new and answers nobody who wrote or acted";

/**
 * A path asks ONE Engine, named literally in its code (the catalogue reads a script's materials off its code).
 * `answersNobody`: the asked Engine acts on no pushed person (public paths): an occurrence run is refused, by WHO.
 */
export function buildPathSource(asked: string, opts: { answersNobody?: boolean } = {}): string {
  if (!/^[a-z_]+$/.test(asked)) throw new Error(`path: ${JSON.stringify(asked)} is not an outcome key`);
  return [
    HEAD,
    `/** A path toward its Engine's outcome: asks ${asked} with this script's goal; the outcome is observed by its owning service (DISTRY-ENGINES-1119). */`,
    `
export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};${opts.answersNobody ? `
  if (R.trigger && typeof R.trigger === "object") return { unmade: ${JSON.stringify(ANSWERS_NOBODY_REFUSAL)} };` : ""}
  const t: any = ctx.tactics ?? {};
  const goal = typeof t.goal === "string" ? t.goal.trim() : "";
  const by = typeof t.askRecordedBy === "string" ? t.askRecordedBy.trim() : "";
  const ask: any = { units: {}, request: goal ? Object.assign({}, R, { goal: goal }) : R };
  if (by) ask.recordedBy = by;
  ctx.ask(ask);
  const got: any = ctx.get(${JSON.stringify(asked)});
  if (got && typeof got.unmade === "string") return { unmade: got.unmade, ...(got.decided === "done" || got.decided === "idle" ? { decided: got.decided } : {}) };
  return { content: { asked: ${JSON.stringify(asked)}, unit: got.content } };
}
`,
  ].join("\n");
}

/** A path through the answerer: ONE AI converses with a lead (ONE-AI-CONVERSES-1029), the goal says what it works toward. */
const answererPath = (outcome: string, dynasty: string, name: string, recordedBy: string, goal: string, description: string): PathSpec => ({
  outcome,
  dynasty,
  name,
  asks: "message_sent",
  tactics: { asks: ["message_sent"], askRecordedBy: "sender", recorded_by: recordedBy, relationships: "pure_prospect", goal },
  description,
});

/** A path through another Engine that acts in public (a post, a backlink): no goal, the act itself is the path. */
const publicPath = (outcome: string, dynasty: string, name: string, asks: string, askRecordedBy: string, recordedBy: string, description: string): PathSpec => ({
  outcome,
  dynasty,
  name,
  asks,
  tactics: { asks: [asks], askRecordedBy, recorded_by: recordedBy },
  description,
  answersNobody: true,
});

export const PATHS: PathSpec[] = [
  answererPath(
    "form_submitted",
    "dy_form_path",
    "Answer toward a form filled",
    "crm",
    "This answer works toward the lead filling the brand's form. When they show interest, point them to the brand's form with its link, in one line, and say what happens right after they send it.",
    "Works toward a form filled: when a lead writes or acts, asks for the one answer that points them to the brand's form. Leads only.",
  ),
  answererPath(
    "signup",
    "dy_signup_path",
    "Answer toward a signup",
    "lead",
    "This answer works toward the lead creating an account on the brand's product. When they show interest, give them the signup link and the one thing they get right after signing up.",
    "Works toward a signup: when a lead writes or acts, asks for the one answer that gives them the signup link and what they get first. Leads only.",
  ),
  answererPath(
    "purchase",
    "dy_purchase_path",
    "Answer toward a purchase",
    "lead",
    "This answer works toward the lead buying. When they are ready, give them the way to buy now (the link or the next step), with the price only as the facts state it.",
    "Works toward a direct purchase: when a lead writes or acts, asks for the one answer that gives them the way to buy now. Leads only.",
  ),
  answererPath(
    "website_visit",
    "dy_site_visit_path",
    "Answer toward a website visit",
    "instantly",
    "This answer works toward the lead visiting the brand's website. Link the one page of the brand's site that answers what they care about, and say in a few words what they will find there.",
    "Works toward a website visit: when a lead writes or acts, asks for the one answer that links the page of the brand's site they care about. Leads only.",
  ),
  answererPath(
    "lead_visited",
    "dy_lead_visit_path",
    "Answer toward a lead visit",
    "lead",
    "This answer works toward the lead visiting the brand's website. Link the one page of the brand's site that answers what they care about, and say in a few words what they will find there.",
    "Works toward a lead visiting the brand's site: when a lead writes or acts, asks for the one answer that links the page they care about. Leads only.",
  ),
  answererPath(
    "whatsapp_number_given",
    "dy_whatsapp_number_path",
    "Answer toward a WhatsApp number",
    "crm",
    "This answer works toward the lead giving their WhatsApp number. When a chat would be easier for them, ask whether they want to go on over WhatsApp and for their number, in one line.",
    "Works toward a WhatsApp number given: when a lead writes or acts, asks for the one answer that offers to go on over WhatsApp. Leads only.",
  ),
  answererPath(
    "conversation",
    "dy_reply_answer_path",
    "Answer toward a positive reply",
    "instantly",
    "This answer works toward the lead replying with interest. Write the one message that makes a real conversation easy for them to start: about what they care about, one easy question, nothing to buy.",
    "Works toward a positive reply: asks for the one answer to a lead owed a message that opens a real conversation with one easy question. Leads only.",
  ),
  publicPath("conversation", "dy_reply_first_email_path", "First email toward a positive reply", "email_sent", "instantly", "instantly", "Works toward a positive reply: sends one first email to a new lead of the brand, whose reply the brand's mailbox reports."),
  publicPath("post_viewed", "dy_post_views_x", "X post toward views", "x_post_published", "social", "social", "Works toward post views: publishes one X post of the brand, whose views the brand's X account reports."),
  publicPath("post_viewed", "dy_post_views_linkedin", "LinkedIn post toward views", "linkedin_post_published", "social", "social", "Works toward post views: publishes one LinkedIn post of the brand, whose views the brand's LinkedIn account reports."),
  publicPath("post_engaged", "dy_post_engagement_x", "X post toward engagement", "x_post_published", "social", "social", "Works toward post engagement: publishes one X post of the brand, whose likes, replies and reposts the brand's X account reports."),
  publicPath("post_engaged", "dy_post_engagement_linkedin", "LinkedIn post toward engagement", "linkedin_post_published", "social", "social", "Works toward post engagement: publishes one LinkedIn post of the brand, whose reactions and comments the brand's LinkedIn account reports."),
  publicPath("google_search_click", "dy_search_clicks_backlinks", "Backlinks toward search clicks", "backlink_earned", "scraping", "google", "Works toward Google search clicks: earns or confirms a backlink to the brand's site, which lifts it in search; the clicks are what Google Search Console reports."),
];

/**
 * PLAN-RECURSIVE-PER-ENGINE-1124-WF2 (owner 2026-11-24: « À chaque Engine en partant de la fin (Target), on demande à
 * Jev de filtrer les scripts possibles et puis le Rating nous donne le meilleur »): every Engine a campaign reaches by
 * ANSWERING a lead (it holds a path asking Message sent alone) is also reached by STARTING with a new one: one first cold
 * email to a newly found person (it asks Email sent, whose senders take their person from Lead found). One code, one
 * dynasty under each such Engine, derived from the LIVE catalogue (never a list of outcomes here): `rows` = the active
 * scripts as `{outcome, tactics}`. The Unit's owner (`recorded_by`) is the one the Engine's own answering path states.
 * An Engine already holding a script that asks Email sent alone (Positive reply's first email path) gets none.
 * Which campaigns keep it is features-service's opt-in script tactic « Starts with a cold email to a new person »,
 * judged on the brief (a brief that does not ask for cold email never keeps it); it gates scripts stating
 * `askRecordedBy`, so that tactic must stay on these scripts.
 */
export const FIRST_EMAIL_DYNASTY = "dy_first_email_path";
export const FIRST_EMAIL_NAME = "Cold email to a new lead";

export function firstEmailPaths(rows: Array<{ outcome: string; tactics: Record<string, unknown> | null }>): PathSpec[] {
  const asksOf = (t: Record<string, unknown> | null): string[] => (Array.isArray(t?.asks) ? (t!.asks as unknown[]).map(String) : []);
  const byOutcome = new Map<string, Array<Record<string, unknown> | null>>();
  for (const r of rows) byOutcome.set(r.outcome, [...(byOutcome.get(r.outcome) ?? []), r.tactics]);
  const out: PathSpec[] = [];
  for (const [outcome, list] of [...byOutcome.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // An answering path asks Message sent ALONE (a script asking it among others, e.g. the intro path, is another way).
    const answering = list.filter((t) => asksOf(t).length === 1 && asksOf(t)[0] === "message_sent");
    if (answering.length === 0) continue;
    if (list.some((t) => asksOf(t).length === 1 && asksOf(t)[0] === "email_sent")) continue;
    const owners = [...new Set(answering.map((t) => (typeof t?.recorded_by === "string" ? t.recorded_by : "")).filter(Boolean))];
    if (owners.length !== 1) throw new Error(`first email path for ${outcome}: its answering scripts state ${owners.length === 0 ? "no" : "several"} owner (recorded_by: ${owners.join(", ")}): which service observes the outcome cannot be read`);
    out.push({
      outcome,
      dynasty: FIRST_EMAIL_DYNASTY,
      name: FIRST_EMAIL_NAME,
      asks: "email_sent",
      tactics: { asks: ["email_sent"], askRecordedBy: "instantly", recorded_by: owners[0]! },
      description: `Works toward ${outcome.replace(/_/g, " ")}: sends one first cold email to a newly found person of the brand's targets, the start of the conversation that leads there; answers nobody who wrote or acted.`,
      answersNobody: true,
    });
  }
  return out;
}

/**
 * PLAN-RECURSIVE-PER-ENGINE-1124-WF3 B1 (owner 2026-11-24: « À chaque Engine en partant de la fin (Target) … récursivement »):
 * a campaign aimed at a person's outcome (Signup, Paid client…) whose brief works through a PUBLIC act (an X post, a
 * LinkedIn post, a Threads post, a reply under someone's post) reaches that act's Engine from its Target, the way
 * `signup/dy_signup_threads_post` reached Threads. One code (`buildPathSource`, the act asked), one dynasty
 * `dy_through_<act>` under each Engine reached by answering a lead, derived from the LIVE catalogue (never a list of
 * outcomes here):
 *   - the Targets = Engines holding a path asking Message sent alone (`firstEmailPaths`' rule), the owner (`recorded_by`)
 *     = the one that path states;
 *   - the acts = catalogue steps about no person (`subjectKind: object`) that work toward a step of the person's ladder
 *     (`towardStep` whose `lifecycleRung` is a rung), whose Engine holds an active MAKER (a script that is not a path:
 *     not a single ask stating `askRecordedBy`, the first cold email / public path shape);
 *   - a Target already holding a script asking that act alone gets none (Threads under Signup).
 * Each refuses an occurrence run (a public act answers nobody who wrote). It states no `askRecordedBy`, so the opt-in
 * « Starts with a cold email to a new person » never gates it; which campaigns keep it is features-service's opt-in
 * script tactic per act (« Works through an X post »…), judged on the brief: the tactics field `asks` names the act.
 */
export const THROUGH_PREFIX = "dy_through_";
export interface CatalogueStep {
  key: string;
  name: string;
  subjectKind: string | null;
  lifecycleRung: string | null;
  towardStep: string | null;
}

export function publicActPaths(rows: Array<{ outcome: string; tactics: Record<string, unknown> | null }>, steps: CatalogueStep[]): PathSpec[] {
  const asksOf = (t: Record<string, unknown> | null): string[] => (Array.isArray(t?.asks) ? (t!.asks as unknown[]).map(String) : []);
  const isPath = (t: Record<string, unknown> | null): boolean => asksOf(t).length === 1 && typeof t?.askRecordedBy === "string";
  const byOutcome = new Map<string, Array<Record<string, unknown> | null>>();
  for (const r of rows) byOutcome.set(r.outcome, [...(byOutcome.get(r.outcome) ?? []), r.tactics]);
  const step = new Map(steps.map((x) => [x.key, x]));
  const onLadder = (key: string | null): boolean => {
    const rung = key ? step.get(key)?.lifecycleRung : null;
    return typeof rung === "string" && rung !== "" && rung !== "none";
  };
  const acts = steps
    .filter((x) => x.subjectKind === "object" && onLadder(x.towardStep) && (byOutcome.get(x.key) ?? []).some((t) => !isPath(t)))
    .sort((a, b) => a.key.localeCompare(b.key));
  const out: PathSpec[] = [];
  for (const [outcome, list] of [...byOutcome.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const answering = list.filter((t) => asksOf(t).length === 1 && asksOf(t)[0] === "message_sent");
    if (answering.length === 0) continue;
    const owners = [...new Set(answering.map((t) => (typeof t?.recorded_by === "string" ? t.recorded_by : "")).filter(Boolean))];
    if (owners.length !== 1) throw new Error(`public act path for ${outcome}: its answering scripts state ${owners.length === 0 ? "no" : "several"} owner (recorded_by: ${owners.join(", ")}): which service observes the outcome cannot be read`);
    const target = step.get(outcome)?.name ?? outcome.replace(/_/g, " ");
    for (const act of acts) {
      if (list.some((t) => asksOf(t).length === 1 && asksOf(t)[0] === act.key)) continue;
      out.push({
        outcome,
        dynasty: THROUGH_PREFIX + act.key,
        name: `Through ${act.name}`.slice(0, 40),
        asks: act.key,
        tactics: { asks: [act.key], recorded_by: owners[0]! },
        description: `Works toward ${target.toLowerCase()}: makes one ${act.name.toLowerCase()} of the brand in public, the act that brings people there; answers nobody who wrote or acted.`,
        answersNobody: true,
      });
    }
  }
  return out;
}

/**
 * PLAN-RECURSIVE-PER-ENGINE-1124-WF3 B2-B4: a campaign aimed at a person's outcome whose brief answers an OCCURRENCE
 * through another Engine (sends the email the client pushed, an AI proposal on a hot lead, a follow-up of a lead the
 * brand already wrote to) reaches that Engine from its Target. One code (`buildPathSource`, the occurrence passed as
 * stated, never refused), one dynasty `dy_answer_through_<engine>` under each Engine reached by answering a lead, derived
 * from the LIVE scripts' CODE (never a list of outcomes here):
 *   - the Targets and their owner = `firstEmailPaths`' rule;
 *   - the Engines = those holding a maker (not a single ask stating `askRecordedBy`) whose code reads the Request's
 *     `trigger` (`readRequestFields`): it answers an occurrence; never an Engine that is itself a Target (reached by
 *     answering a lead: it is reached directly);
 *   - a Target already holding a script asking that Engine alone that does not refuse an occurrence gets none (the
 *     answering path through Message sent).
 * On a proactive tick the asked Engine's own script decides (nobody named = its own serve, or idle). Which campaigns keep
 * one is features-service's opt-in script tactic per Engine, judged on the brief; stored RETIRED until it exists.
 */
export const ANSWER_THROUGH_PREFIX = "dy_answer_through_";

export function occurrenceActPaths(
  rows: Array<{ outcome: string; tactics: Record<string, unknown> | null; code: string }>,
  steps: CatalogueStep[],
  readsFields: (code: string) => string[],
): PathSpec[] {
  const asksOf = (t: Record<string, unknown> | null): string[] => (Array.isArray(t?.asks) ? (t!.asks as unknown[]).map(String) : []);
  const isPath = (t: Record<string, unknown> | null): boolean => asksOf(t).length === 1 && typeof t?.askRecordedBy === "string";
  const byOutcome = new Map<string, typeof rows>();
  for (const r of rows) byOutcome.set(r.outcome, [...(byOutcome.get(r.outcome) ?? []), r]);
  const step = new Map(steps.map((x) => [x.key, x]));
  const isTarget = (list: typeof rows) => list.some((r) => asksOf(r.tactics).length === 1 && asksOf(r.tactics)[0] === "message_sent");
  const engines = [...byOutcome.entries()]
    .filter(([, list]) => !isTarget(list) && list.some((r) => !isPath(r.tactics) && readsFields(r.code).includes("trigger")))
    .map(([outcome]) => outcome)
    .sort();
  const out: PathSpec[] = [];
  for (const [outcome, list] of [...byOutcome.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const answering = list.filter((r) => asksOf(r.tactics).length === 1 && asksOf(r.tactics)[0] === "message_sent");
    if (answering.length === 0) continue;
    const owners = [...new Set(answering.map((r) => (typeof r.tactics?.recorded_by === "string" ? r.tactics.recorded_by : "")).filter(Boolean))];
    if (owners.length !== 1) throw new Error(`answer-through path for ${outcome}: its answering scripts state ${owners.length === 0 ? "no" : "several"} owner (recorded_by: ${owners.join(", ")}): which service observes the outcome cannot be read`);
    const target = step.get(outcome)?.name ?? outcome.replace(/_/g, " ");
    for (const engine of engines) {
      if (engine === outcome) continue;
      if (list.some((r) => asksOf(r.tactics).length === 1 && asksOf(r.tactics)[0] === engine && !r.code.includes(ANSWERS_NOBODY_REFUSAL))) continue;
      const name = step.get(engine)?.name ?? engine.replace(/_/g, " ");
      out.push({
        outcome,
        dynasty: ANSWER_THROUGH_PREFIX + engine,
        name: `Answer through ${name}`.slice(0, 40),
        asks: engine,
        tactics: { asks: [engine], recorded_by: owners[0]! },
        description: `Works toward ${target.toLowerCase()}: hands the person a fact names (or the run itself) to ${name.toLowerCase()}, whose script answers them its own way.`,
      });
    }
  }
  return out;
}

// ── 2. Drafts ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ScriptSpec {
  outcome: string;
  dynasty: string;
  name: string;
  tactics: Record<string, unknown>;
  description: string;
}

const DRAFT_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, text: { type: "string" } },
  required: ["title", "text"],
  additionalProperties: false,
} as const;

export function buildDraftSource(): string {
  return [
    HEAD,
    `/** A draft of one piece, written by the LLM completion Engine; the piece is the tactic format (DISTRY-ENGINES-1119). */`,
    PORT_HEAD,
    COMMON,
    COMPLETION,
    `const DRAFT_SCHEMA = ${JSON.stringify(DRAFT_SCHEMA)};
export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const format = str((ctx.tactics as any).format);
  if (!format) throw new Error("draft: the script states no format (tactic format): nothing is written");
  const what = [str(R.topic), str(R.instructions), str(R.goal)].filter(Boolean).join("\\n");
  const brief = str(R.brief);
  const answered = str(R.postText);
  const brand = brandOf(ctx, brandIdOf(ctx, R));
  if (!what && !brief && !answered && !brand.name) return { unmade: "nothing_to_write_about: the request states no topic (request.topic), no brief, no post to answer and no brand" };
  const systemPrompt = [
    "You draft " + format + (brand.name ? " for " + brand.name : "") + ".",
    "State only what you are given: no figure, client, result or promise of your own.",
    "Write in the language of what you are given, English when unsure. Plain sentences, no em dash or en dash.",
    "Return JSON: title (a newsletter's subject line, else an empty string) and text (the draft itself, ready to read).",
  ].join("\\n");
  const message = [
    brand.name ? "THE BRAND: " + brand.name + (brand.domain ? " (" + brand.domain + ")" : "") : "",
    what ? "WHAT TO WRITE ABOUT:\\n" + what : "",
    answered ? "THE POST THIS ANSWERS:\\n" + answered.slice(0, 4000) : "",
    str(R.context) ? "CONTEXT:\\n" + str(R.context).slice(0, 8000) : "",
  ].filter(Boolean).join("\\n\\n");
  const out = completion(ctx, withBrief({ message, systemPrompt, maxTokens: 3000, responseFormat: "json", responseSchema: DRAFT_SCHEMA, strictResponseSchema: DRAFT_SCHEMA }, brief));
  const text = undash(str(out.json.text));
  if (!text) throw new Error("the writer returned no text");
  return { content: { title: undash(str(out.json.title)), text, format, writtenWith: out.llm } };
}
`,
  ].join("\n");
}

const draft = (outcome: string, name: string, format: string, description: string): ScriptSpec => ({
  outcome,
  dynasty: "dy_draft",
  name,
  tactics: { asks: ["llm_completion"], format },
  description,
});

export const DRAFTS: ScriptSpec[] = [
  draft("x_post_drafted", "X post draft", "one X post: one idea, at most 270 characters, no link, no hashtag, no @tag", "Drafts one X post of the brand on the topic it is given, ready for someone to approve."),
  draft("linkedin_post_drafted", "LinkedIn post draft", "one LinkedIn post: a first line that makes people stop, then short airy paragraphs, 120 to 220 words, no hashtag", "Drafts one LinkedIn post of the brand on the topic it is given, ready for someone to approve."),
  draft("linkedin_comment_drafted", "LinkedIn comment draft", "one comment under someone else's LinkedIn post: one to three sentences that add something useful to what the post says, no pitch, no link", "Drafts one comment of the brand under someone else's LinkedIn post, from what the post says."),
  draft("newsletter_drafted", "Newsletter draft", "one newsletter email: a subject line, then a body of 150 to 350 words telling one story or lesson, ending on one call to action", "Drafts one newsletter email of the brand (subject and body) on the topic it is given, ready for someone to approve."),
];

// ── 3. Replies under someone else's post ──────────────────────────────────────────────────────────────────

const REPLY_SCHEMA = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } as const;
export const PRO_AI = "pro_ai";

export function buildReplySource(): string {
  return [
    HEAD,
    `/** One reply of the brand under someone else's post, on its own X or LinkedIn account; social-service declares it (DISTRY-ENGINES-1119). */`,
    PORT_HEAD,
    COMMON,
    COMPLETION,
    `const REPLY_SCHEMA = ${JSON.stringify(REPLY_SCHEMA)};
export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const network = str((ctx.tactics as any).network);
  if (network !== "x" && network !== "linkedin") throw new Error("reply: tactic network must be x or linkedin, got " + JSON.stringify(network));
  const target = str(R.target);
  if (!target) return { unmade: "no_target: the request names no post to answer (request.target: the post's URL)" };
  const postText = str(R.postText);
  if (!postText) return { unmade: "no_post_text: the request does not say what the post says (request.postText): a reply to a post nobody read is never written" };
  const brandId = brandIdOf(ctx, R);
  if (!brandId) throw new Error("reply: the run names no brand");
  const listed: any = must(ctx, "social.accounts", { query: { brandId, network } });
  const all: any[] = Array.isArray(listed.accounts) ? listed.accounts : [];
  const account = all.find((a: any) => a.publishable === true && a.accountType === ${JSON.stringify(PRO_AI)} && a.health === "connected");
  if (!account) {
    const why = all.length ? all.map((a: any) => String(a.username) + " (" + String(a.notPublishableReason ?? a.accountTypeLabel ?? a.accountType) + ")").join("; ") : "no " + network + " account is connected to the brand";
    return { unmade: "no_publishable_account: no " + network + " account of the brand may reply by software: " + why };
  }
  const brand = brandOf(ctx, brandId);
  const brief = str(R.brief);
  const systemPrompt = [
    "You write one " + (network === "x" ? "reply on X (at most 250 characters)" : "comment on LinkedIn (one to three sentences)") + " from " + (brand.name || "the brand") + " under someone else's post.",
    "Add something useful to what the post says: an angle, an experience, a precise question. Never a pitch, a link, a hashtag or an @tag.",
    "State only what the post and the brand's own words say; no figure of your own. Write in the post's language. No em dash or en dash.",
    "Return JSON: text.",
  ].join("\\n");
  const message = [
    "THE BRAND: " + (brand.name || "unnamed") + (brand.domain ? " (" + brand.domain + ")" : ""),
    "THE POST YOU ANSWER (" + target + "):\\n" + postText.slice(0, 4000),
    str(R.topic) ? "WHAT THE BRAND WANTS TO SAY:\\n" + str(R.topic) : "",
  ].filter(Boolean).join("\\n\\n");
  const out = completion(ctx, withBrief({ message, systemPrompt, maxTokens: 800, responseFormat: "json", responseSchema: REPLY_SCHEMA, strictResponseSchema: REPLY_SCHEMA }, brief));
  const text = undash(str(out.json.text));
  if (!text) throw new Error("the writer returned no text");
  const key = network + "-reply:" + (str(R.campaignId) || "no-campaign") + ":" + target;
  const r: any = must(ctx, "social.reply", { params: { id: account.id }, body: { target, text, idempotencyKey: key } });
  return { content: { target, text, account: account.username ?? null, publication: r.publication ?? null } };
}
`,
  ].join("\n");
}

export const REPLIES: ScriptSpec[] = [
  { outcome: "x_reply_published", dynasty: "dy_reply_under_post", name: "Reply under an X post", tactics: { asks: ["llm_completion"], network: "x", recorded_by: "social" }, description: "Replies under someone else's X post from the brand's own X account, adding something useful to it. Never a pitch or a link." },
  { outcome: "linkedin_comment_published", dynasty: "dy_reply_under_post", name: "Comment under a LinkedIn post", tactics: { asks: ["llm_completion"], network: "linkedin", recorded_by: "social" }, description: "Comments under someone else's LinkedIn post from the brand's own LinkedIn account, adding something useful to it. Never a pitch or a link." },
];

// ── 4. Producer calls ─────────────────────────────────────────────────────────────────────────────────────

export function buildEmailCheckSource(): string {
  return [
    HEAD,
    `/** One address checked by apollo-service's verifiers; apollo declares the Unit (DISTRY-ENGINES-1119). */`,
    PORT_HEAD,
    COMMON,
    `export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const email = str(R.email).toLowerCase();
  if (!email || email.indexOf("@") < 1) return { unmade: "no_email: the request names no address to check (request.email)" };
  const r: any = must(ctx, "apollo.email.verifications", { body: { emails: [email], source: "engine" } });
  const res: any = Array.isArray(r.results) ? r.results[0] : null;
  if (!res) throw new Error("apollo-service answered no verdict for " + email + ": " + JSON.stringify(r).slice(0, 300));
  return { content: { email, verdict: res.verdict ?? null, reused: res.reused === true } };
}
`,
  ].join("\n");
}

export function buildPhoneRevealSource(): string {
  return [
    HEAD,
    `/** One person's phone, revealed by apollo-service (a paid reveal: asked only when no phone is known); apollo declares the Unit (DISTRY-ENGINES-1119). */`,
    PORT_HEAD,
    COMMON,
    `export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const known = str(R.phone);
  if (known) return { unmade: "phone_already_known: " + known + " is already known for this person: nothing is bought", decided: "done" };
  const id = str(R.apolloPersonId);
  if (!id) return { unmade: "no_person: the request names no Apollo person to find a phone for (request.apolloPersonId)" };
  const asked: any = must(ctx, "apollo.phone.reveal", { params: { apolloPersonId: id }, body: {} });
  const read: any = asked.status === "pending"
    ? must(ctx, "apollo.phone.read", { params: { apolloPersonId: id }, pollWhile: { field: "status", equals: "pending", intervalSeconds: 5, timeoutSeconds: 90 } })
    : asked;
  if (read.status === "found" && str(read.mobilePhone)) {
    return { content: { apolloPersonId: id, phone: str(read.mobilePhone), doNotCall: read.doNotCall === true, dncStatus: read.dncStatus ?? null, reused: read.reused === true } };
  }
  if (read.status === "pending") return { unmade: "still_looking: Apollo has not answered yet for " + id + "; the phone lands on the person once it does" };
  if (read.status === "failed") throw new Error("the phone reveal failed: " + String(read.failureReason ?? "no reason given"));
  return { unmade: "no_phone_found: Apollo holds no phone for " + id };
}
`,
  ].join("\n");
}

export function buildCompanyCheckSource(): string {
  return [
    HEAD,
    `/** One company researched against the offer's checks by lead-service, which declares the Unit (DISTRY-ENGINES-1119). */`,
    PORT_HEAD,
    COMMON,
    `export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const domain = str(R.domain).toLowerCase();
  if (!domain) return { unmade: "no_company: the request names no company domain (request.domain)" };
  const brandId = brandIdOf(ctx, R);
  const offerId = str(R.offerId);
  if (!brandId || !offerId) return { unmade: "no_offer: the request names no brand and offer (request.offerId) whose checks the company is researched on" };
  const name = str(R.companyName) || domain;
  const params = { brandId, offerId };
  const first: any = must(ctx, "lead.company.preview", { params, body: { companies: [{ domain, name }] } });
  let p: any = first.preview;
  if (!p) throw new Error("lead-service answered no preview: " + JSON.stringify(first).slice(0, 300));
  if (p.status === "running") {
    const read: any = must(ctx, "lead.company.preview.read", { params: { brandId, offerId, previewId: p.id }, pollWhile: { field: "preview.status", equals: "running", intervalSeconds: 10, timeoutSeconds: 240 } });
    p = read.preview;
  }
  if (!p.run) return { unmade: "no_checks: the offer states no checks to research a company on" };
  if (p.status === "running") return { unmade: "still_researching: preview " + String(p.id) + " is still running; its answer lands on the offer's previews" };
  if (p.status === "failed") throw new Error("the research failed: " + JSON.stringify(p.error ?? null).slice(0, 300));
  return { content: { domain, preview: p } };
}
`,
  ].join("\n");
}

const STORIES_SCHEMA = {
  type: "object",
  properties: {
    stories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          spotlight: { type: "string" },
          kicker: { type: "string" },
          headline: { type: "string" },
          relation: { type: "string", enum: ["official", "own", "third"] },
          role: { type: "string" },
          about: { type: "string" },
          why: { type: "string" },
          note: { type: "string" },
          take: { type: "string" },
        },
        required: ["index", "spotlight", "kicker", "headline", "relation", "role", "about", "why", "note", "take"],
        additionalProperties: false,
      },
    },
  },
  required: ["stories"],
  additionalProperties: false,
} as const;

export function buildIndustryVideoSource(): string {
  return [
    HEAD,
    `/** The day's industry update video: the industry watch's best posts, written up by the LLM completion Engine, rendered by content-generation, which declares the Unit (DISTRY-ENGINES-1119). */`,
    PORT_HEAD,
    COMMON,
    COMPLETION,
    `const STORIES_SCHEMA = ${JSON.stringify(STORIES_SCHEMA)};
function clip(s: string, n: number): string {
  const t = undash(str(s));
  return t.length <= n ? t : t.slice(0, n - 3).replace(/\\s+\\S*$/, "") + "...";
}
/** A post the video can show: an X status or a LinkedIn activity, with its words. */
function showable(i: any): any {
  const url = str(i && i.url);
  const text = str(i && (i.text || i.title));
  if (!url || !text) return null;
  const x = /(?:x|twitter)[.]com[/][^/]+[/]status[/]([0-9]{5,25})/i.exec(url);
  if (x) return { post: { platform: "x", tweetId: x[1] }, url, text, author: i.author ?? null, score: typeof i.score === "number" ? i.score : -1 };
  const li = /(?:activity[-:]|urn:li:activity:)([0-9]{10,25})/i.exec(url);
  if (li) return { post: { platform: "linkedin", activityId: li[1] }, url, text, author: i.author ?? null, score: typeof i.score === "number" ? i.score : -1 };
  return null;
}
export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const now = str(R.now);
  const day = now.slice(0, 10);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)) throw new Error("industry video: the run states no clock (request.now)");
  const windowHours = (ctx.tactics as any).windowHours;
  if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 168) throw new Error("industry video: tactic windowHours must be 1 to 168 hours, got " + JSON.stringify(windowHours));
  ctx.ask({ units: {}, recordedBy: "social", request: { now, brandIds: R.brandIds ?? null, offerId: R.offerId ?? null, brief: R.brief ?? null } });
  const news: any = ctx.get("industry_news_found");
  if (!news.content) return { unmade: "no_industry_news: " + String(news.unmade ?? "the watch answered nothing") };
  const items: any[] = Array.isArray(news.content.items) ? news.content.items : [];
  const posts = items.map(showable).filter(Boolean).sort((a: any, b: any) => b.score - a.score).slice(0, 6);
  if (posts.length < 2) return { unmade: "not_enough_stories: the day's watch kept " + posts.length + " X or LinkedIn post the video can show, 2 are needed" };
  const brand = brandOf(ctx, brandIdOf(ctx, R));
  const systemPrompt = [
    "You pick 2 to 4 of the posts below for " + (brand.name || "the brand") + "'s daily industry update video and write each one up.",
    "spotlight: ONE sentence copied word for word from the post. kicker: the company in the news, at most 40 characters. headline: the news in one line, at most 140.",
    "relation: official (the poster speaks for that company), own (the news is the poster's own test), third (comments on someone else's news). role: the poster's short role. about: what the poster's company does, one line.",
    "why: why it matters, one market observation, at most 15 words. note: attribution or sample size, one line. take: what we think, optimistic, at most 14 words, no figures.",
    "State only what the posts say. No em dash or en dash. Return JSON: stories, each with the index of its post.",
  ].join("\\n");
  const message = posts.map((p: any, i: number) => "[" + i + "] " + p.url + (p.author ? " by " + JSON.stringify(p.author) : "") + "\\n" + p.text.slice(0, 2000)).join("\\n\\n");
  const out = completion(ctx, withBrief({ message, systemPrompt, maxTokens: 3000, responseFormat: "json", responseSchema: STORIES_SCHEMA, strictResponseSchema: STORIES_SCHEMA }, str(R.brief)));
  const written: any[] = Array.isArray(out.json.stories) ? out.json.stories : [];
  const stories: any[] = [];
  for (const s of written) {
    const p = Number.isInteger(s.index) ? posts[s.index] : null;
    if (!p || stories.some((x: any) => x.post === p.post) || stories.length >= 4) continue;
    stories.push({
      post: p.post,
      spotlight: [str(s.spotlight)],
      kicker: clip(s.kicker, 40),
      headline: clip(s.headline, 140),
      poster: { relation: s.relation, role: clip(s.role, 60), about: clip(s.about, 120) },
      why: clip(s.why, 140),
      note: clip(s.note, 160),
      take: clip(s.take, 140),
    });
  }
  if (stories.length < 2) throw new Error("the writer wrote " + stories.length + " usable story, 2 are needed");
  const key = "industry-video:" + day + ":" + (str(R.campaignId) || "no-campaign");
  const render: any = must(ctx, "content.debrief.render", { body: { date: day, scan: { postsRead: items.length, windowHours }, stories, idempotencyKey: key } });
  let v: any = render;
  for (let i = 0; i < 2 && (v.status === "queued" || v.status === "rendering"); i++) v = must(ctx, "content.debrief.read", { params: { id: render.id }, query: { waitSeconds: "240" } });
  if (v.status === "failed") throw new Error("the render failed: " + String(v.errorCode ?? "") + " " + String(v.error ?? ""));
  if (v.status !== "done") return { unmade: "still_rendering: video " + String(render.id) + " is still rendering; it lands on the brand once done" };
  return { content: { videoId: v.id, videoUrl: v.videoUrl ?? null, durationSeconds: v.durationSeconds ?? null, stories: stories.length } };
}
`,
  ].join("\n");
}

export const PRODUCERS: Array<ScriptSpec & { build: () => string }> = [
  { outcome: "email_checked", dynasty: "dy_email_check", name: "Email address check", tactics: { recorded_by: "apollo" }, description: "Checks one email address with our verifiers and says whether it can receive email (a verdict under 30 days old is reused, nothing paid twice).", build: buildEmailCheckSource },
  { outcome: "phone_found", dynasty: "dy_phone_reveal", name: "Phone reveal", tactics: { recorded_by: "apollo" }, description: "Finds one person's phone number through Apollo, only when no phone is known for them yet (a paid reveal).", build: buildPhoneRevealSource },
  { outcome: "company_researched", dynasty: "dy_company_check", name: "Company check against an offer", tactics: { recorded_by: "lead" }, description: "Researches one company against the checks the offer states (who it serves, what it needs) and answers each check.", build: buildCompanyCheckSource },
  { outcome: "industry_update_video", dynasty: "dy_industry_video", name: "Daily industry update video", tactics: { asks: ["industry_news_found", "llm_completion"], recorded_by: "content", windowHours: 36 }, description: "Makes the day's industry update video: picks the best posts the industry watch kept, writes each one up and renders the video.", build: buildIndustryVideoSource },
];

// ── 5. Engines no script makes on demand: the reason, in plain words (data, stated through the route) ────────

export const ENGINE_REASONS: Record<string, string> = {
  ad_shown: "We run no ads yet: no ad account (Google, Meta, LinkedIn) is connected, so nothing can show an ad.",
  x_post_validated: "A person of the brand approves an X post draft; a script never approves its own drafts. Ask X post drafted for a draft.",
  linkedin_post_validated: "A person of the brand approves a LinkedIn post draft; a script never approves its own drafts. Ask LinkedIn post drafted for a draft.",
  newsletter_validated: "A person of the brand approves a newsletter draft; a script never approves its own drafts. Ask Newsletter drafted for a draft.",
  newsletter_email_sent: "A newsletter goes to the brand's whole mailing list at once, released by a person of the team after reading it; a script never releases one on its own.",
};
