/**
 * THE WORKFLOW OF THE THREADS POSTS PIPE (`threads-post|start_to_post_published`, THREADS-CAMPAIGN-1028, owner
 * 2026-10-28: « une campagne qui va automatiser ces 5 envois tous les jours », fully automatic, no daily approval).
 * Any brand: every run writes ONE Threads thread (a main post + 2 or 3 replies chained under it) and publishes it on
 * one of the brand's connected Threads accounts typed Pro (AI), rotating across them. A proactive Start pipe run by
 * campaign-service like every other; how many threads a day is the campaign's MAX VOLUME (billing counts the
 * `post_published` outcome meta-service declares per thread), never a count in this DAG.
 *
 * Each run, in order:
 *  - The campaign chassis (`/gate-check`, `/start-run`, an `/end-run` on every exit). A staff DRY RUN
 *    (`inputs.dryRun: true`) skips the chassis, the window and the spacing, writes the thread and publishes nothing
 *    (`dry-summary`).
 *  - meta-service: the brand's connected Threads accounts and what the brand published on Threads over the last
 *    HISTORY_DAYS days. `check-turn` decides: only accounts typed Pro (AI) whose login Threads still accepts are
 *    candidates (Personal (human) and Pro (human) never; a `needs_reconnect` account is skipped, meta-service already
 *    flags it for a human); outside PUBLISH_WINDOW_UTC, or less than MIN_GAP_MINUTES after the brand's last thread,
 *    the run ends IDLE (`noWorkAvailable`: campaign-service rechecks in about 10 minutes, a cheap read), which is what
 *    spaces the day's threads about an hour apart. The account is the candidate whose last thread is the oldest (never
 *    used first), so a newly connected Pro (AI) account joins the rotation with no change.
 *  - The brand's own facts (offer answers + the fields the client CONFIRMED, `GATHER_CLIENT_FACTS_CODE`: never the
 *    site's prefill), its profile, and the campaign's instruction (`/start-run`).
 *  - chat-service with live web search finds this week's fresh angles in the brand's industry (angles only, never a
 *    figure: tolerated, a run without angles still writes from the facts).
 *  - The leg's best LLM (features-service, `withLegBestLlm`, Opus when the leg ranks none) writes the thread under
 *    THREADS_WRITING_RULES, a different subject from every main post of the last HISTORY_DAYS days and a different
 *    shape from today's. `check-thread` holds it to the rules a rule can check (counts, length, a number only when
 *    the facts state it, banned words, the last line); a refused draft is rewritten ONCE with the reasons, and a
 *    second refusal fails the run (nothing published).
 *  - meta-service publishes the main post, then each reply under the previous one, each with an idempotency key
 *    (a retried node never publishes twice). A main post refused because the account needs reconnecting ends the
 *    run IDLE (the next run picks another account); every other refusal fails the run loud.
 *
 * Spend: the model calls by chat-service on this run, the features pick by features-service. The outcome
 * (`post_published`, one per thread) is meta-service's, the publisher's (cost-accounting doctrine).
 *
 * Shape: three decisions (`decide-turn`, `check-ship`, `check-main`) are SIBLING top-level branchones, each pinned by
 * a convergence edge from `check-turn` (`nodeToModule` builds a condition nested in a branch as an ordinary module,
 * which silently does nothing); every arm reads positive evidence with `?.`.
 */
import type { DAG } from "./dag-validator.js";
import { CHAT_STEP_MAX_TOKENS } from "./ai-meeting-booking-dag.js";
import { GATHER_CLIENT_FACTS_CODE } from "./cold-whatsapp-outreach-dag.js";
import { LEG_BEST_LLM_MODEL_REF, LEG_BEST_LLM_PROVIDER_REF, withLegBestLlm } from "./leg-best-writer.js";

export const THREADS_POST_FEATURE_SLUG = "threads-post";

/** The step a thread produces: the catalogue's existing `post_published` (object), shared with social-service. */
export const THREADS_POST_STEP_KEY = "post_published";

export const THREADS_POST_LEG_KEY = "start_to_post_published";

export const THREADS_POST_PIPE_ID = `${THREADS_POST_FEATURE_SLUG}|${THREADS_POST_LEG_KEY}`;

export const THREADS_POST_DESCRIPTION =
  "Publishes one Threads thread per run, a main post and two or three replies, on the brand's Threads accounts typed Pro (AI), rotating across them and never on a personal account. Threads go out at least an hour apart during the day, each on a new subject, written only from the brand's own facts.";

/** The LLM a thread is written with while features-service ranks none on the leg. */
export const THREADS_WRITER_LLM = { provider: "anthropic", model: "opus" } as const;

/** The LLM that reads the live web for fresh industry angles. */
export const THREADS_ANGLES_LLM = { provider: "anthropic", model: "sonnet" } as const;

/** UTC hours [from, to) in which a live run may publish: 09:00 to 17:00 in New York, 14:00 to 22:00 in Paris. */
export const PUBLISH_WINDOW_UTC = [13, 21] as const;

/** The least time between two threads of one brand. */
export const MIN_GAP_MINUTES = 60;

/** How far back the subjects are read (never twice). */
export const HISTORY_DAYS = 30;

/** Threads' own limit is 500; our rule is 400 per post or reply. */
export const MAX_POST_CHARS = 400;

/** meta-service's account types (`src/lib/account-types.ts` there): only this one is posted on by software. */
export const PRO_AI_ACCOUNT_TYPE = "pro_ai";

/** meta-service: the brand's Threads publications over a window (THREADS-CAMPAIGN-1028, meta-service ledger). */
export const META_PUBLICATIONS = { service: "meta", method: "GET", path: "/orgs/threads/publications" } as const;

/** The five shapes a day's threads take, each once while one is free. */
export const THREAD_SHAPES = ["insight", "question to the reader", "short story from our facts", "myth vs fact", "practical tip"] as const;

/** The rules every thread is written under. The campaign's instruction adds the brand's own. */
export const THREADS_WRITING_RULES = [
  "You write ONE Threads thread for the brand below, published on the brand's own Threads account.",
  "A thread is a main post plus 2 or 3 replies posted right under it. The main post stands alone and hooks. Each reply adds one new idea: the example, the how, the takeaway.",
  `Each post and each reply is at most ${MAX_POST_CHARS} characters.`,
  "English. Short plain words. One idea per sentence. Readable in one pass.",
  "Most important first: the main insight or value opens, a qualifier closes.",
  "Never open a sentence on a pronoun (It, They, This) whose noun is not in that same sentence.",
  'Never a list like "No X, no Y" or "without X, without Y".',
  'Tone: reward, value, growth, joy. Congratulate what the reader already does well and encourage them. Never the words effort, cost or risk. Never a label like "Proof:".',
  "No em dash or en dash. No hashtags. At most one emoji in the whole thread.",
  "A number only if it is written in OUR FACTS below, exactly as written there. Never a number from the web angles, never an invented one.",
  "The web angles are inspiration for a timely subject only: never copy them, never name their authors.",
  "A subject different from every main post listed under ALREADY POSTED, and the shape named under TODAY'S SHAPE.",
  "The last line of the LAST reply is exactly the GET STARTED line given below, and it appears nowhere else.",
].join("\n");

export const THREAD_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    post: { type: "string" },
    replies: { type: "array", items: { type: "string" } },
  },
  required: ["subject", "post", "replies"],
  additionalProperties: false,
} as const;

/** The run's plan: dry run or live, the window, the history window, the brand and offer. */
export const PLAN_RUN_CODE = `
export async function main(dryRun, campaignId, brandId, offerId, startRun) {
  const dry = dryRun === true || dryRun === "true";
  const campaign = typeof campaignId === "string" && campaignId ? campaignId : null;
  if (!dry && !campaign) throw new Error("plan-run: a live run needs its campaign (a staff run without one must say dryRun: true)");
  const brand = typeof brandId === "string" && brandId ? brandId : null;
  if (!brand) throw new Error("plan-run: no brand on this run (x-brand-id)");
  const offer = startRun?.offerId ?? (typeof offerId === "string" && offerId ? offerId : null);
  if (!offer) throw new Error("plan-run: no offer (the campaign's /start-run states it; a dry run passes inputs.offerId)");
  const now = new Date();
  const hour = now.getUTCHours();
  return {
    dryRun: dry,
    campaignId: campaign,
    brandId: brand,
    offerId: offer,
    instruction: typeof startRun?.instruction === "string" && startRun.instruction.trim() ? startRun.instruction.trim() : null,
    now: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    inWindow: hour >= ${PUBLISH_WINDOW_UTC[0]} && hour < ${PUBLISH_WINDOW_UTC[1]},
    accountsQuery: { brandId: brand },
    postsQuery: { brandId: brand, since: new Date(now.getTime() - ${HISTORY_DAYS} * 24 * 3600 * 1000).toISOString(), limit: "1000" },
  };
}
`.trim();

/**
 * Whose turn, and is a thread owed now. Reads meta-service's two answers: accounts `{accounts: [...]}`, publications
 * `{publications: [...]}` (newest first, `kind` `post` = a thread's main post, `reply` under it). Returns the account, the subjects already posted and
 * today's shapes; `proceed: false` names why (idle).
 */
export const CHECK_TURN_CODE = `
export async function main(plan, accounts, posts) {
  const all = Array.isArray(accounts?.accounts) ? accounts.accounts : null;
  if (all === null) throw new Error("check-turn: meta-service served no accounts list: " + JSON.stringify(accounts).slice(0, 300));
  const list = Array.isArray(posts?.publications) ? posts.publications : null;
  if (list === null) throw new Error("check-turn: meta-service served no publications list: " + JSON.stringify(posts).slice(0, 300));
  const at = (p) => Date.parse(p.publishedAt ?? "");
  const mains = list.filter((p) => p.kind === "post" && Number.isFinite(at(p))).sort((a, b) => at(b) - at(a));
  const skipped = [];
  const candidates = [];
  for (const a of all) {
    if (a.accountType !== "${PRO_AI_ACCOUNT_TYPE}") { skipped.push("@" + a.username + " (" + (a.accountTypeLabel ?? a.accountType) + ")"); continue; }
    if (a.health !== "connected") { skipped.push("@" + a.username + " (needs reconnect)"); continue; }
    candidates.push(a);
  }
  if (skipped.length) console.log("[threads-post] not posted on: " + skipped.join(", "));
  const lastOn = (a) => { const m = mains.find((p) => p.accountId === a.id); return m ? at(m) : -Infinity; };
  candidates.sort((a, b) => lastOn(a) - lastOn(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const account = candidates[0] ?? null;
  const now = Date.parse(plan.now);
  const today = mains.filter((p) => new Date(at(p)).toISOString().slice(0, 10) === plan.date);
  const history = mains.map((p) => new Date(at(p)).toISOString().slice(0, 10) + ": " + String(p.text ?? "").slice(0, 400));
  const shapes = ${JSON.stringify(THREAD_SHAPES)};
  const usedShapes = today.length;
  const shape = shapes[usedShapes % shapes.length];
  const base = { account, history, shape, todayCount: today.length, candidates: candidates.map((a) => "@" + a.username) };
  if (!account) {
    console.error("[threads-post] the brand has no connected Threads account typed Pro (AI): nothing to post on");
    return { ...base, proceed: false, reason: "no_pro_ai_account" };
  }
  if (plan.dryRun) return { ...base, proceed: true, reason: "dry_run" };
  if (!plan.inWindow) return { ...base, proceed: false, reason: "outside_publish_window" };
  const last = mains[0] ? at(mains[0]) : null;
  if (last !== null && now - last < ${MIN_GAP_MINUTES} * 60 * 1000) {
    return { ...base, proceed: false, reason: "last_thread_under_" + ${MIN_GAP_MINUTES} + "_minutes_ago" };
  }
  console.log("[threads-post] owed: thread " + (today.length + 1) + " today, on @" + account.username + ", shape " + shape);
  return { ...base, proceed: true, reason: "owed" };
}
`.trim();

/** The live-web read of this week's angles in the brand's industry (no figure taken from it). */
export const COMPOSE_ANGLES_CODE = `
export async function main(brand, facts, plan) {
  const b = brand?.brand ?? brand ?? {};
  const lines = (facts?.exact ?? []).slice(0, 20).map((f) => "- " + f.label + ": " + String(f.value).slice(0, 300));
  return {
    systemPrompt: "You read the live web for a social media writer. Answer in plain text, at most 8 short lines, each a fresh development of the last 7 days in the brand's industry (what happened, who, the source URL). Never an opinion.",
    message: ["BRAND: " + (b.name ?? "?") + " (" + (b.domain ?? b.url ?? "?") + ")", "TODAY: " + plan.date, "WHAT THE BRAND SELLS:", ...(lines.length ? lines : ["(no stated facts)"]), "", "Find what is new this week in this brand's industry that its buyers care about."].join("\\n"),
  };
}
`.trim();

/** The writer's input: the rules, the brand, its facts, the instruction, the angles, the history, today's shape. */
export const COMPOSE_WRITE_CODE = `
export async function main(plan, turn, brand, facts, angles) {
  const b = brand?.brand ?? brand ?? {};
  const domain = String(b.domain ?? b.url ?? "").replace(/^https?:\\/\\//, "").replace(/^www\\./, "").replace(/\\/.*$/, "");
  if (!domain) throw new Error("compose-write: the brand has no domain to close the thread on");
  const getStarted = "Get started: " + domain;
  const exact = (facts?.exact ?? []).map((f) => "- [" + f.id + "] " + f.label + ": " + f.value);
  const never = (facts?.neverGive ?? []).map((t) => "- " + t);
  const web = angles && angles.ok !== false && typeof angles.content === "string" ? angles.content.slice(0, 3000) : null;
  if (!web) console.error("[threads-post] no web angles this run (" + JSON.stringify(angles?.error ?? angles?.status ?? null) + "): writing from the facts alone");
  const message = [
    "BRAND: " + (b.name ?? domain) + " (" + domain + ")",
    "PUBLISHED ON: @" + turn.account.username,
    "TODAY: " + plan.date,
    "TODAY'S SHAPE: " + turn.shape,
    "GET STARTED line: " + getStarted,
    "",
    "OUR FACTS (the only source of numbers):",
    ...(exact.length ? exact : ["(none: write without any number)"]),
    ...(never.length ? ["", "NEVER STATE OR OFFER:", ...never] : []),
    ...(plan.instruction ? ["", "THE BRAND'S INSTRUCTION FOR THESE THREADS:", plan.instruction] : []),
    "",
    "THIS WEEK IN THE INDUSTRY (angles only):",
    web ?? "(none)",
    "",
    "ALREADY POSTED (never repeat a subject):",
    ...(turn.history.length ? turn.history : ["(none yet)"]),
  ].join("\\n");
  const factText = [...(facts?.exact ?? []).map((f) => String(f.value)), plan.instruction ?? "", b.name ?? "", domain].join("\\n");
  return { systemPrompt: ${JSON.stringify(THREADS_WRITING_RULES)}, message, getStarted, factText };
}
`.trim();

/**
 * Holds a draft to the rules a rule can check, then cleans it: dashes rewritten, the GET STARTED line closing the
 * last reply only. `ok: false` names every problem (rewritten once by `rewrite-thread`).
 */
const CHECK_THREAD_FN = `
function checkThread(draft, compose) {
  const j = draft?.json ?? draft ?? {};
  const problems = [];
  const undash = (s) => String(s ?? "").replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-").replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ").trim();
  const strip = (s) => undash(s).split("\\n").filter((l) => l.trim() !== compose.getStarted).join("\\n").trim();
  const post = strip(j.post);
  const replies = Array.isArray(j.replies) ? j.replies.map(strip).filter(Boolean) : [];
  if (!post) problems.push("the main post is empty");
  if (replies.length < 2 || replies.length > 3) problems.push("write 2 or 3 replies, not " + replies.length);
  if (replies.length) replies[replies.length - 1] = replies[replies.length - 1] + "\\n\\n" + compose.getStarted;
  const parts = [post, ...replies];
  parts.forEach((t, i) => {
    const name = i === 0 ? "the main post" : "reply " + i;
    if ([...t].length > ${MAX_POST_CHARS}) problems.push(name + " is " + [...t].length + " characters, at most ${MAX_POST_CHARS}");
    if (/\\b(effort|cost|risk)s?\\b/i.test(t)) problems.push(name + " uses a banned word (effort, cost, risk)");
    if (/\\b(no|without) \\w+[^.!?\\n]{0,40}, (no|without) \\w+/i.test(t)) problems.push(name + ' has a "No X, no Y" list');
    if (/(^|\\s)#\\w/.test(t)) problems.push(name + " has a hashtag");
    // A counting word ("2 tips", "step 3") is not a figure; a money amount, a rate or any larger number is.
    const numbers = (t.replace(compose.getStarted, "").match(/[$\\u20ac\\u00a3]?\\d[\\d,.]*[%x]?/g) ?? []).map((n) => n.replace(/[.,]$/, ""));
    for (const n of numbers) {
      if (/^([0-9]|10)$/.test(n)) continue;
      if (!compose.factText.includes(n.replace(/^[$\\u20ac\\u00a3]/, "").replace(/[%x]$/, ""))) problems.push(name + " states " + n + ", a number OUR FACTS do not hold");
    }
  });
  const emoji = parts.join(" ").match(/\\p{Extended_Pictographic}/gu) ?? [];
  if (emoji.length > 1) problems.push("the thread has " + emoji.length + " emojis, at most 1");
  return { ok: problems.length === 0, problems, thread: { subject: String(j.subject ?? "").trim(), post, replies } };
}
`.trim();

export const CHECK_THREAD_CODE = `
${CHECK_THREAD_FN}

export async function main(draft, compose) {
  const r = checkThread(draft, compose);
  if (!r.ok) console.error("[threads-post] draft refused, rewriting once: " + r.problems.join("; "));
  return {
    ...r,
    rewriteMessage: compose.message + "\\n\\nYOUR PREVIOUS DRAFT:\\n" + JSON.stringify(draft?.json ?? null) + "\\n\\nIT BROKE THESE RULES, fix every one:\\n- " + r.problems.join("\\n- "),
  };
}
`.trim();

/** The thread to publish: the first draft when it passed, else the rewrite, which must pass. */
export const FINAL_THREAD_CODE = `
${CHECK_THREAD_FN}

export async function main(first, rewrite, compose, plan, turn) {
  let thread = first.thread;
  if (!first.ok) {
    const r = checkThread(rewrite, compose);
    if (!r.ok) throw new Error("final-thread: the rewrite still breaks the rules, nothing published: " + r.problems.join("; "));
    thread = r.thread;
  }
  const scope = (plan.campaignId ?? "dry-run") + ":" + plan.now;
  return {
    ...thread,
    accountId: turn.account.id,
    username: turn.account.username,
    replyCount: thread.replies.length,
    reply1: thread.replies[0],
    reply2: thread.replies[1],
    reply3: thread.replies[2] ?? null,
    keys: { main: "threads-post:" + scope + ":main", reply1: "threads-post:" + scope + ":reply-1", reply2: "threads-post:" + scope + ":reply-2", reply3: "threads-post:" + scope + ":reply-3" },
  };
}
`.trim();

/** A main post Threads refused because the account's login is dead ends the run idle; anything else fails loud. */
export const CLASSIFY_MAIN_CODE = `
export async function main(published, thread) {
  if (published && published.ok !== false && published.postId) {
    console.log("[threads-post] published on @" + thread.username + ": " + (published.permalink ?? published.postId));
    return { outcome: "published", postId: published.postId, permalink: published.permalink ?? null };
  }
  const body = typeof published?.error === "string" ? published.error : JSON.stringify(published?.error ?? published ?? null);
  if (published?.status === 409 && /needs_reconnect/.test(body)) {
    console.error("[threads-post] @" + thread.username + " needs reconnecting (Threads refused its login): skipped, the next run posts on another account");
    return { outcome: "account_dead", postId: null, permalink: null };
  }
  throw new Error("publish-main: Threads publish failed (" + String(published?.status) + "): " + body.slice(0, 500));
}
`.trim();

export const DRY_SUMMARY_CODE = `
export async function main(thread, turn) {
  return { dryRun: true, published: false, account: "@" + thread.username, candidates: turn.candidates, shape: turn.shape, subject: thread.subject, post: thread.post, replies: thread.replies };
}
`.trim();

const END_RUN_SKIP_ON_DRY = "flow_input.dryRun === true || flow_input.dryRun === 'true'";

const endRun = (id: string, body: Record<string, unknown>) => ({
  id,
  type: "http.call" as const,
  config: { service: "campaign", method: "POST", path: "/end-run", body, skipIf: END_RUN_SKIP_ON_DRY },
  retries: 0,
});

const publishReply = (n: 1 | 2 | 3, parentRef: string) => ({
  id: `publish-reply-${n}`,
  type: "http.call" as const,
  config: {
    service: "meta",
    method: "POST",
    path: "/orgs/threads/accounts/{id}/posts",
    ...(n === 3 ? { skipIf: "results.final_thread.replyCount < 3" } : {}),
  },
  retries: 2,
  inputMapping: {
    "params.id": "$ref:final-thread.output.accountId",
    "body.text": `$ref:final-thread.output.reply${n}`,
    "body.replyToPostId": parentRef,
    "body.idempotencyKey": `$ref:final-thread.output.keys.reply${n}`,
  },
});

const TURN = "results['check-turn']";
const MAIN = "results['classify-main']";
const DRY = "results['plan-run']?.dryRun";

export function buildThreadsPostDag(): DAG {
  const dag: DAG = {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false", skipIf: END_RUN_SKIP_ON_DRY },
      },
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run", skipIf: END_RUN_SKIP_ON_DRY } },
      {
        id: "plan-run",
        type: "script",
        config: { code: PLAN_RUN_CODE },
        retries: 0,
        inputMapping: {
          dryRun: "$ref:flow_input.dryRun",
          campaignId: "$ref:flow_input.campaignId",
          brandId: "$ref:flow_input.brandId",
          offerId: "$ref:flow_input.offerId",
          startRun: "$ref:start-run.output",
        },
      },
      {
        id: "threads-accounts",
        type: "http.call",
        config: { service: "meta", method: "GET", path: "/orgs/threads/accounts" },
        inputMapping: { query: "$ref:plan-run.output.accountsQuery" },
      },
      {
        id: "threads-posts",
        type: "http.call",
        config: { ...META_PUBLICATIONS },
        inputMapping: { query: "$ref:plan-run.output.postsQuery" },
      },
      {
        id: "check-turn",
        type: "script",
        config: { code: CHECK_TURN_CODE },
        retries: 0,
        inputMapping: { plan: "$ref:plan-run.output", accounts: "$ref:threads-accounts.output", posts: "$ref:threads-posts.output" },
      },
      { id: "decide-turn", type: "condition" },
      endRun("end-run-idle", { success: true, stopCampaign: false, noWorkAvailable: true }),
      {
        id: "brand-profile",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/internal/brands/{id}" },
        inputMapping: { "params.id": "$ref:plan-run.output.brandId" },
      },
      {
        id: "offer-answers",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/answers" },
        inputMapping: { "params.brandId": "$ref:plan-run.output.brandId", "params.offerId": "$ref:plan-run.output.offerId" },
      },
      {
        id: "offer-user-fields",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/user-fields" },
        inputMapping: { "params.brandId": "$ref:plan-run.output.brandId", "params.offerId": "$ref:plan-run.output.offerId" },
      },
      {
        id: "brand-user-fields",
        type: "http.call",
        // 409 SEVERAL_OFFERS for a brand selling several offers: gather-facts reads that refusal as "no brand-level
        // fields" and re-throws every other failure.
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/user-fields", tolerateFailure: true },
        inputMapping: { "params.brandId": "$ref:plan-run.output.brandId" },
      },
      {
        id: "gather-facts",
        type: "script",
        config: { code: GATHER_CLIENT_FACTS_CODE },
        retries: 0,
        inputMapping: {
          offerAnswers: "$ref:offer-answers.output",
          offerFields: "$ref:offer-user-fields.output",
          brandFields: "$ref:brand-user-fields.output",
        },
      },
      {
        id: "compose-angles",
        type: "script",
        config: { code: COMPOSE_ANGLES_CODE },
        retries: 0,
        inputMapping: { brand: "$ref:brand-profile.output", facts: "$ref:gather-facts.output", plan: "$ref:plan-run.output" },
      },
      {
        id: "read-angles",
        type: "http.call",
        // Enrichment: a run without this week's angles still writes from the facts (compose-write logs it).
        config: {
          service: "chat",
          method: "POST",
          path: "/complete",
          body: { provider: THREADS_ANGLES_LLM.provider, model: THREADS_ANGLES_LLM.model, webSearch: true, maxTokens: 4_000 },
          tolerateFailure: true,
        },
        retries: 0,
        inputMapping: { "body.message": "$ref:compose-angles.output.message", "body.systemPrompt": "$ref:compose-angles.output.systemPrompt" },
      },
      {
        id: "compose-write",
        type: "script",
        config: { code: COMPOSE_WRITE_CODE },
        retries: 0,
        inputMapping: {
          plan: "$ref:plan-run.output",
          turn: "$ref:check-turn.output",
          brand: "$ref:brand-profile.output",
          facts: "$ref:gather-facts.output",
          angles: "$ref:read-angles.output",
        },
      },
      {
        id: "write-thread",
        type: "http.call",
        config: {
          service: "chat",
          method: "POST",
          path: "/complete",
          body: {
            provider: THREADS_WRITER_LLM.provider,
            model: THREADS_WRITER_LLM.model,
            responseFormat: "json",
            responseSchema: THREAD_RESPONSE_SCHEMA,
            maxTokens: CHAT_STEP_MAX_TOKENS,
          },
        },
        retries: 0,
        inputMapping: { "body.message": "$ref:compose-write.output.message", "body.systemPrompt": "$ref:compose-write.output.systemPrompt" },
      },
      {
        id: "check-thread",
        type: "script",
        config: { code: CHECK_THREAD_CODE },
        retries: 0,
        inputMapping: { draft: "$ref:write-thread.output", compose: "$ref:compose-write.output" },
      },
      {
        id: "rewrite-thread",
        type: "http.call",
        config: {
          service: "chat",
          method: "POST",
          path: "/complete",
          body: { responseFormat: "json", responseSchema: THREAD_RESPONSE_SCHEMA, maxTokens: CHAT_STEP_MAX_TOKENS },
          skipIf: "results.check_thread.ok == true",
        },
        retries: 0,
        inputMapping: {
          "body.provider": LEG_BEST_LLM_PROVIDER_REF,
          "body.model": LEG_BEST_LLM_MODEL_REF,
          "body.message": "$ref:check-thread.output.rewriteMessage",
          "body.systemPrompt": "$ref:compose-write.output.systemPrompt",
        },
      },
      {
        id: "final-thread",
        type: "script",
        config: { code: FINAL_THREAD_CODE },
        retries: 0,
        inputMapping: {
          first: "$ref:check-thread.output",
          rewrite: "$ref:rewrite-thread.output",
          compose: "$ref:compose-write.output",
          plan: "$ref:plan-run.output",
          turn: "$ref:check-turn.output",
        },
      },
      { id: "check-ship", type: "condition" },
      {
        id: "dry-summary",
        type: "script",
        config: { code: DRY_SUMMARY_CODE },
        retries: 0,
        inputMapping: { thread: "$ref:final-thread.output", turn: "$ref:check-turn.output" },
      },
      {
        id: "publish-main",
        type: "http.call",
        config: { service: "meta", method: "POST", path: "/orgs/threads/accounts/{id}/posts", tolerateFailure: true },
        retries: 0,
        inputMapping: {
          "params.id": "$ref:final-thread.output.accountId",
          "body.text": "$ref:final-thread.output.post",
          "body.idempotencyKey": "$ref:final-thread.output.keys.main",
        },
      },
      {
        id: "classify-main",
        type: "script",
        config: { code: CLASSIFY_MAIN_CODE },
        retries: 0,
        inputMapping: { published: "$ref:publish-main.output", thread: "$ref:final-thread.output" },
      },
      { id: "check-main", type: "condition" },
      endRun("end-run-account-dead", { success: true, stopCampaign: false, noWorkAvailable: true }),
      publishReply(1, "$ref:classify-main.output.postId"),
      publishReply(2, "$ref:publish-reply-1.output.postId"),
      publishReply(3, "$ref:publish-reply-2.output.postId"),
      endRun("end-run", { success: true, stopCampaign: false }),
      {
        id: "end-run-error",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/end-run", body: { success: false, stopCampaign: false }, skipIf: END_RUN_SKIP_ON_DRY },
        retries: 0,
      },
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "plan-run" },
      { from: "plan-run", to: "threads-accounts" },
      { from: "threads-accounts", to: "threads-posts" },
      { from: "threads-posts", to: "check-turn" },
      { from: "check-turn", to: "decide-turn" },
      { from: "decide-turn", to: "end-run-idle", condition: `${TURN}?.proceed == false` },
      { from: "decide-turn", to: "brand-profile", condition: `${TURN}?.proceed == true` },
      { from: "brand-profile", to: "offer-answers" },
      { from: "offer-answers", to: "offer-user-fields" },
      { from: "offer-user-fields", to: "brand-user-fields" },
      { from: "brand-user-fields", to: "gather-facts" },
      { from: "gather-facts", to: "compose-angles" },
      { from: "compose-angles", to: "read-angles" },
      { from: "read-angles", to: "compose-write" },
      { from: "compose-write", to: "write-thread" },
      { from: "write-thread", to: "check-thread" },
      { from: "check-thread", to: "rewrite-thread" },
      { from: "rewrite-thread", to: "final-thread" },
      // Converges (edge from check-turn, outside decide-turn's branches) so it is top level.
      { from: "final-thread", to: "check-ship" },
      { from: "check-turn", to: "check-ship" },
      { from: "check-ship", to: "dry-summary", condition: `${TURN}?.proceed == true && ${DRY} == true` },
      { from: "check-ship", to: "publish-main", condition: `${TURN}?.proceed == true && ${DRY} == false` },
      { from: "publish-main", to: "classify-main" },
      // Converges (edge from check-turn) so it is top level.
      { from: "classify-main", to: "check-main" },
      { from: "check-turn", to: "check-main" },
      { from: "check-main", to: "end-run-account-dead", condition: `${MAIN}?.outcome == 'account_dead'` },
      { from: "check-main", to: "publish-reply-1", condition: `${MAIN}?.outcome == 'published'` },
      { from: "publish-reply-1", to: "publish-reply-2" },
      { from: "publish-reply-2", to: "publish-reply-3" },
      { from: "publish-reply-3", to: "end-run" },
    ],
    onError: "end-run-error",
  };
  return withLegBestLlm(dag, "write-thread");
}
