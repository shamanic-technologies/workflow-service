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
 *  - Two tolerated reads (a run without them still writes, logged): chat-service with live web search finds this
 *    week's fresh angles in the brand's industry (angles only, never a figure); and what the brand ITSELF publishes
 *    on its own domain, generic for every brand: scraping-service maps the site (`map-own-site`), the reading model
 *    picks at most OWN_PAGES pages on the domain likely to hold its figures, customer results and latest items
 *    (`pick-own-pages`, never a keyword rule here), scraping-service reads them (`scrape-own-1..4`), and the reading
 *    model lists their figures with what each counts, its reliability label and its page (`read-own-figures`, no
 *    web search: web search cannot read the brand's own pages). That is where a "finding from our data" thread gets
 *    real served figures.
 *  - The writer holds NO prompt and NO model (THREADS-IDEAS-AB, owner 2026-10-31): content-generation-service
 *    `POST /generate-thread` writes with the pipe's best template dynasty and best LLM, both picked per run by
 *    features-service (`withLegBestTemplate`: writer-pick, writer-plan, template-head; a pick missing either = the
 *    run fails, nothing published), so the dynasties of this pipe are A/B tested like every writer's. `compose-write`
 *    hands it `variables` (`brandName`, `getStartedLine`) and one `context` whose section headers the templates read
 *    by name (BRAND, PUBLISHED ON, TODAY, SUGGESTED SHAPE, OUR FACTS, NEVER STATE OR OFFER, THE BRAND'S INSTRUCTION,
 *    OUR PUBLISHED FIGURES, THIS WEEK IN THE INDUSTRY, ALREADY POSTED). The writer is TRUSTED (owner 2026-10-16):
 *    its thread is published as written, never validated, retried or refused; `final-thread` only rewrites dashes,
 *    keeps at most 3 replies and places the GET STARTED line on the last part.
 *  - meta-service publishes the main post, then each reply under the previous one, each with an idempotency key
 *    (a retried node never publishes twice). A main post refused because the account needs reconnecting ends the
 *    run IDLE (the next run picks another account); every other refusal fails the run loud.
 *
 * Spend: the reading calls by chat-service and the writing by content-generation, both on this run (x-run-id), the
 * features pick by features-service. The outcome
 * (`post_published`, one per thread) is meta-service's, the publisher's (cost-accounting doctrine).
 *
 * Shape: three decisions (`decide-turn`, `check-ship`, `check-main`) are SIBLING top-level branchones, each pinned by
 * a convergence edge from `check-turn` (`nodeToModule` builds a condition nested in a branch as an ordinary module,
 * which silently does nothing); every arm reads positive evidence with `?.`.
 */
import type { DAG } from "./dag-validator.js";
import { GATHER_CLIENT_FACTS_CODE } from "./cold-whatsapp-outreach-dag.js";
import { GENERATE_THREAD_PATH, withLegBestTemplate } from "./whatsapp-template-writer.js";

export const THREADS_POST_FEATURE_SLUG = "threads-post";

/** The step a thread produces: the catalogue's existing `post_published` (object), shared with social-service. */
export const THREADS_POST_STEP_KEY = "post_published";

export const THREADS_POST_LEG_KEY = "start_to_post_published";

export const THREADS_POST_PIPE_ID = `${THREADS_POST_FEATURE_SLUG}|${THREADS_POST_LEG_KEY}`;

export const THREADS_POST_DESCRIPTION =
  "Publishes one Threads thread per run, a main post and two or three replies, on the brand's Threads accounts typed Pro (AI), rotating across them and never on a personal account. Threads go out at least an hour apart during the day, each on a new subject, written only from the brand's own facts.";

/** The LLM of the READING calls (industry angles, picking and reading the brand's own pages). Never the writer. */
export const THREADS_ANGLES_LLM = { provider: "anthropic", model: "sonnet" } as const;

/** UTC hours [from, to) in which a live run may publish: 09:00 to 17:00 in New York, 14:00 to 22:00 in Paris. */
export const PUBLISH_WINDOW_UTC = [13, 21] as const;

/** The least time between two threads of one brand. */
export const MIN_GAP_MINUTES = 60;

/** At most this many of the brand's own pages are read per run (one scrape each). */
export const OWN_PAGES = 4;

/** Per own page, at most this much text reaches the reader. */
export const OWN_PAGE_CHARS = 12_000;

/** At most this many of the site's URLs are offered to the page picker. */
export const OWN_SITE_URLS = 300;

/** The page picker's answer. */
export const OWN_PAGES_SCHEMA = {
  type: "object",
  properties: { urls: { type: "array", items: { type: "string" } } },
  required: ["urls"],
  additionalProperties: false,
} as const;

/** How far back the subjects are read (never twice). */
export const HISTORY_DAYS = 30;

/** meta-service's account types (`src/lib/account-types.ts` there): only this one is posted on by software. */
export const PRO_AI_ACCOUNT_TYPE = "pro_ai";

/** meta-service: the brand's Threads publications over a window (THREADS-CAMPAIGN-1028, meta-service ledger). */
export const META_PUBLICATIONS = { service: "meta", method: "GET", path: "/orgs/threads/publications" } as const;

/** The five shapes a day's threads take, each once while one is free. */
export const THREAD_SHAPES = ["insight", "question to the reader", "short story from our facts", "myth vs fact", "practical tip"] as const;

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

/** The brand's domain, bare (`https://www.x.com/` -> `x.com`). */
const DOMAIN_OF_BRAND = `const b = brand?.brand ?? brand ?? {};
  const domain = String(b.domain ?? b.url ?? "").replace(/^https?:\\/\\//, "").replace(/^www\\./, "").replace(/\\/.*$/, "");`;

/** The brand's own site: its bare domain, the URL scraping-service maps, the brand the reads are billed under. */
export const PLAN_OWN_SITE_CODE = `
export async function main(brand, plan) {
  ${DOMAIN_OF_BRAND}
  if (!domain) throw new Error("plan-own-site: the brand has no domain to read");
  return { domain, brandName: String(b.name ?? domain), url: "https://" + domain, brandIds: [plan.brandId] };
}
`.trim();

/** A URL on the brand's own domain (its subdomains included), never another site's. */
const ON_DOMAIN = `const onDomain = (u, domain) => {
    try { const h = new URL(String(u)).hostname.toLowerCase().replace(/^www\\./, ""); return h === domain || h.endsWith("." + domain); } catch { return false; }
  };`;

/**
 * The page picker's input: the site's URLs on the brand's own domain (scraping-service `/map`), at most
 * OWN_SITE_URLS. Which pages hold figures is the reading model's call, never a keyword rule here.
 */
export const COMPOSE_PICK_PAGES_CODE = `
export async function main(site, map, plan) {
  ${ON_DOMAIN}
  const all = map && map.ok !== false && Array.isArray(map.urls) ? map.urls : null;
  if (!all) console.error("[threads-post] could not map " + site.domain + " (" + JSON.stringify(map?.error ?? map?.status ?? null) + "): no own pages read this run");
  const urls = [...new Set((all ?? []).filter((u) => onDomain(u, site.domain)).map((u) => String(u).replace(/#.*$/, "")))].slice(0, ${OWN_SITE_URLS});
  return {
    candidates: urls,
    count: urls.length,
    systemPrompt: [
      "You pick pages of ONE brand's own website for a social media writer who quotes only what the brand itself publishes.",
      "From the URL list, choose at most ${OWN_PAGES} pages most likely to hold: figures the brand publishes about its own results or data, customer results or case studies, and its most recent articles or launches.",
      "Copy each URL exactly as listed. Never a URL that is not in the list.",
    ].join("\\n"),
    message: ["BRAND: " + site.brandName + " (" + site.domain + ")", "TODAY: " + plan.date, "", "URLS:", ...urls].join("\\n"),
  };
}
`.trim();

/** The picked pages: only URLs the map served on the brand's domain, at most OWN_PAGES. A failed pick reads nothing. */
export const PLAN_OWN_PAGES_CODE = `
export async function main(pick, offered) {
  const listed = new Set(offered?.candidates ?? []);
  const asked = pick && pick.ok !== false && Array.isArray(pick.json?.urls) ? pick.json.urls : null;
  if (asked === null && (offered?.count ?? 0) > 0) console.error("[threads-post] no own pages picked (" + JSON.stringify(pick?.error ?? pick?.status ?? null) + "): no own pages read this run");
  const urls = [...new Set((asked ?? []).map((u) => String(u)).filter((u) => listed.has(u)))].slice(0, ${OWN_PAGES});
  console.log("[threads-post] own pages to read: " + (urls.length ? urls.join(", ") : "(none)"));
  return { count: urls.length, urls, url1: urls[0] ?? null, url2: urls[1] ?? null, url3: urls[2] ?? null, url4: urls[3] ?? null };
}
`.trim();

/**
 * The reader's input: each scraped page's text (link-only and image-only lines dropped, at most OWN_PAGE_CHARS), with
 * its URL. `pageCount: 0` skips the read (the writer gets "(none)").
 */
export const COMPOSE_OWN_FIGURES_CODE = `
export async function main(site, plan, p1, p2, p3, p4) {
  const pages = [];
  for (const p of [p1, p2, p3, p4]) {
    const r = p && p.ok !== false ? p.result : null;
    const text = typeof r?.rawMarkdown === "string" ? r.rawMarkdown : "";
    const kept = text.split("\\n").filter((l) => !/^\\s*([-*+]\\s*)?(!?\\[[^\\]]*\\]\\([^)]*\\)\\s*)+$/.test(l)).join("\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
    if (kept) pages.push("PAGE: " + (r.url ?? "?") + "\\n" + kept.slice(0, ${OWN_PAGE_CHARS}));
    else if (p) console.error("[threads-post] an own page read nothing (" + JSON.stringify(p?.error ?? p?.status ?? null) + ")");
  }
  return {
    pageCount: pages.length,
    systemPrompt: [
      "You read pages of ONE brand's own website for a social media writer. Use only the page text given; never another source, never a figure the pages do not state.",
      "Answer in plain text, at most 15 short lines, each one of:",
      "- a figure a page publishes: the number, what it counts, the sample if stated, the reliability label the page gives it if any (for example Robust, Signal, Early read), the page URL;",
      "- a customer result a page publishes: the result, the customer's name only if that page names it, the page URL;",
      "- an item published recently: the title, the date, the URL.",
      "Never an opinion, never a guess. If the pages publish none of these, answer exactly: (none)",
    ].join("\\n"),
    message: ["BRAND: " + site.brandName + " (" + site.domain + ")", "TODAY: " + plan.date, "", ...pages].join("\\n\\n"),
  };
}
`.trim();

/**
 * The writer's input, for content-generation `/generate-thread`: `variables` (`brandName`, `getStartedLine`) and one
 * `context` whose section headers, in this order, the template dynasties read by name. No rule, no prompt: those are
 * the template's.
 */
export const COMPOSE_WRITE_CODE = `
export async function main(plan, turn, brand, facts, angles, ownFigures) {
  ${DOMAIN_OF_BRAND}
  if (!domain) throw new Error("compose-write: the brand has no domain to close the thread on");
  const brandName = String(b.name ?? domain);
  const getStarted = "Get started: " + domain;
  const exact = (facts?.exact ?? []).map((f) => "- [" + f.id + "] " + f.label + ": " + f.value);
  const never = (facts?.neverGive ?? []).map((t) => "- " + t);
  const read = (r) => (r && r.ok !== false && typeof r.content === "string" && r.content.trim() ? r.content.trim().slice(0, 3000) : null);
  const web = read(angles);
  if (!web) console.error("[threads-post] no web angles this run (" + JSON.stringify(angles?.error ?? angles?.status ?? null) + "): writing without them");
  const own = read(ownFigures);
  if (!own) console.error("[threads-post] no published figures read on " + domain + " this run (" + JSON.stringify(ownFigures?.error ?? ownFigures?.status ?? null) + "): writing without them");
  const context = [
    "BRAND: " + brandName + " (" + domain + ")",
    "PUBLISHED ON: @" + turn.account.username,
    "TODAY: " + plan.date,
    "SUGGESTED SHAPE: " + turn.shape,
    "",
    "OUR FACTS (the only source of numbers besides OUR PUBLISHED FIGURES):",
    ...(exact.length ? exact : ["(none)"]),
    ...(never.length ? ["", "NEVER STATE OR OFFER:", ...never] : []),
    ...(plan.instruction ? ["", "THE BRAND'S INSTRUCTION FOR THESE THREADS:", plan.instruction] : []),
    "",
    "OUR PUBLISHED FIGURES (read today on " + domain + ", each with its page):",
    own ?? "(none)",
    "",
    "THIS WEEK IN THE INDUSTRY (angles only):",
    web ?? "(none)",
    "",
    "ALREADY POSTED (never repeat a subject):",
    ...(turn.history.length ? turn.history : ["(none yet)"]),
  ].join("\\n");
  return { variables: { brandName, getStartedLine: getStarted }, context, getStarted, brandIds: [plan.brandId] };
}
`.trim();

/**
 * The thread to publish: the writer's draft AS WRITTEN (owner 2026-10-16: the writer is TRUSTED, never a validation,
 * a retry or a refusal of its output). Only the deterministic cleanups: em/en dashes rewritten (between digits a
 * hyphen, otherwise a comma), the GET STARTED line closing the last part and nowhere else, at most 3 replies (the
 * DAG chains 3). Each part gets its own idempotency key.
 */
export const FINAL_THREAD_CODE = `
export async function main(draft, compose, plan, turn) {
  // content-generation /generate-thread answers at top level: { subject, post, replies }.
  const j = draft ?? {};
  const undash = (s) => String(s ?? "").replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-").replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ").trim();
  const strip = (s) => undash(s).split("\\n").filter((l) => l.trim() !== compose.getStarted).join("\\n").trim();
  const post = strip(j.post);
  if (!post) throw new Error("final-thread: the writer returned no main post: " + JSON.stringify(j).slice(0, 300));
  const replies = (Array.isArray(j.replies) ? j.replies : []).map(strip).filter(Boolean).slice(0, 3);
  const parts = [post, ...replies];
  parts[parts.length - 1] = parts[parts.length - 1] + "\\n\\n" + compose.getStarted;
  const scope = (plan.campaignId ?? "dry-run") + ":" + plan.now;
  return {
    subject: String(j.subject ?? "").trim(),
    post: parts[0],
    replies: parts.slice(1),
    accountId: turn.account.id,
    username: turn.account.username,
    replyCount: parts.length - 1,
    reply1: parts[1] ?? null,
    reply2: parts[2] ?? null,
    reply3: parts[3] ?? null,
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
export async function main(thread, turn, writer) {
  return { dryRun: true, published: false, account: "@" + thread.username, candidates: turn.candidates, shape: turn.shape, templateDynastySlug: writer?.templateDynastySlug ?? null, model: writer?.model ?? null, subject: thread.subject, post: thread.post, replies: thread.replies };
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
    skipIf: `results.final_thread.replyCount < ${n}`,
  },
  retries: 2,
  inputMapping: {
    "params.id": "$ref:final-thread.output.accountId",
    "body.text": `$ref:final-thread.output.reply${n}`,
    "body.replyToPostId": parentRef,
    "body.idempotencyKey": `$ref:final-thread.output.keys.reply${n}`,
  },
});

/** scraping-service reads the n-th picked own page (raw text, no enrichment); skipped past the picked list. */
const scrapeOwn = (n: 1 | 2 | 3 | 4) => ({
  id: `scrape-own-${n}`,
  type: "http.call" as const,
  config: {
    service: "scraping",
    method: "POST",
    path: "/scrape",
    body: { enrich: false, featureSlug: THREADS_POST_FEATURE_SLUG },
    tolerateFailure: true,
    skipIf: `(results.plan_own_pages?.count ?? 0) < ${n}`,
  },
  retries: 0,
  inputMapping: {
    "body.url": `$ref:plan-own-pages.output.url${n}`,
    "body.brandIds": "$ref:plan-own-site.output.brandIds",
    "body.campaignId": "$ref:flow_input.campaignId",
    "body.workflowSlug": "$ref:flow_input.workflowSlug",
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
        id: "plan-own-site",
        type: "script",
        config: { code: PLAN_OWN_SITE_CODE },
        retries: 0,
        inputMapping: { brand: "$ref:brand-profile.output", plan: "$ref:plan-run.output" },
      },
      {
        id: "map-own-site",
        type: "http.call",
        // Enrichment, like every own-site read: a failure leaves the writer "(none)" under OUR PUBLISHED FIGURES.
        config: { service: "scraping", method: "POST", path: "/map", body: { featureSlug: THREADS_POST_FEATURE_SLUG }, tolerateFailure: true },
        retries: 0,
        inputMapping: {
          "body.url": "$ref:plan-own-site.output.url",
          "body.brandIds": "$ref:plan-own-site.output.brandIds",
          "body.campaignId": "$ref:flow_input.campaignId",
          "body.workflowSlug": "$ref:flow_input.workflowSlug",
        },
      },
      {
        id: "compose-pick-pages",
        type: "script",
        config: { code: COMPOSE_PICK_PAGES_CODE },
        retries: 0,
        inputMapping: { site: "$ref:plan-own-site.output", map: "$ref:map-own-site.output", plan: "$ref:plan-run.output" },
      },
      {
        id: "pick-own-pages",
        type: "http.call",
        config: {
          service: "chat",
          method: "POST",
          path: "/complete",
          body: { provider: THREADS_ANGLES_LLM.provider, model: THREADS_ANGLES_LLM.model, responseFormat: "json", responseSchema: OWN_PAGES_SCHEMA, maxTokens: 2_000 },
          tolerateFailure: true,
          skipIf: "(results.compose_pick_pages?.count ?? 0) == 0",
        },
        retries: 0,
        inputMapping: { "body.message": "$ref:compose-pick-pages.output.message", "body.systemPrompt": "$ref:compose-pick-pages.output.systemPrompt" },
      },
      {
        id: "plan-own-pages",
        type: "script",
        config: { code: PLAN_OWN_PAGES_CODE },
        retries: 0,
        inputMapping: { pick: "$ref:pick-own-pages.output", offered: "$ref:compose-pick-pages.output" },
      },
      scrapeOwn(1),
      scrapeOwn(2),
      scrapeOwn(3),
      scrapeOwn(4),
      {
        id: "compose-own-figures",
        type: "script",
        config: { code: COMPOSE_OWN_FIGURES_CODE },
        retries: 0,
        inputMapping: {
          site: "$ref:plan-own-site.output",
          plan: "$ref:plan-run.output",
          p1: "$ref:scrape-own-1.output",
          p2: "$ref:scrape-own-2.output",
          p3: "$ref:scrape-own-3.output",
          p4: "$ref:scrape-own-4.output",
        },
      },
      {
        id: "read-own-figures",
        type: "http.call",
        // No web search: the reader sees only the brand's own pages. Skipped (writer gets "(none)") with no page read.
        config: {
          service: "chat",
          method: "POST",
          path: "/complete",
          body: { provider: THREADS_ANGLES_LLM.provider, model: THREADS_ANGLES_LLM.model, maxTokens: 4_000 },
          tolerateFailure: true,
          skipIf: "(results.compose_own_figures?.pageCount ?? 0) == 0",
        },
        retries: 0,
        inputMapping: { "body.message": "$ref:compose-own-figures.output.message", "body.systemPrompt": "$ref:compose-own-figures.output.systemPrompt" },
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
          ownFigures: "$ref:read-own-figures.output",
        },
      },
      // content-generation writes with the pipe's best template dynasty (its head) and the leg's best LLM, both picked
      // per run by features-service (withLegBestTemplate): no prompt and no model here.
      {
        id: "write-thread",
        type: "http.call",
        config: { service: "content-generation", method: "POST", path: GENERATE_THREAD_PATH, body: { featureSlug: THREADS_POST_FEATURE_SLUG } },
        retries: 0,
        inputMapping: {
          "body.variables": "$ref:compose-write.output.variables",
          "body.context": "$ref:compose-write.output.context",
          "body.brandIds": "$ref:compose-write.output.brandIds",
          "body.workflowSlug": "$ref:flow_input.workflowSlug",
          "body.campaignId": "$ref:flow_input.campaignId",
        },
      },
      {
        id: "final-thread",
        type: "script",
        config: { code: FINAL_THREAD_CODE },
        retries: 0,
        inputMapping: {
          draft: "$ref:write-thread.output",
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
        inputMapping: { thread: "$ref:final-thread.output", turn: "$ref:check-turn.output", writer: "$ref:writer-plan.output" },
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
      { from: "read-angles", to: "plan-own-site" },
      { from: "plan-own-site", to: "map-own-site" },
      { from: "map-own-site", to: "compose-pick-pages" },
      { from: "compose-pick-pages", to: "pick-own-pages" },
      { from: "pick-own-pages", to: "plan-own-pages" },
      { from: "plan-own-pages", to: "scrape-own-1" },
      { from: "scrape-own-1", to: "scrape-own-2" },
      { from: "scrape-own-2", to: "scrape-own-3" },
      { from: "scrape-own-3", to: "scrape-own-4" },
      { from: "scrape-own-4", to: "compose-own-figures" },
      { from: "compose-own-figures", to: "read-own-figures" },
      { from: "read-own-figures", to: "compose-write" },
      { from: "compose-write", to: "write-thread" },
      { from: "write-thread", to: "final-thread" },
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
  return withLegBestTemplate(dag, "write-thread");
}
