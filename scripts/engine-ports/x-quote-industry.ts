/**
 * X-QUOTE-INDUSTRY-1117 (owner 2026-11-16/17: « peut-on commencer par une stratégie qui va chercher des posts pertinents
 * de notre industrie, prend leur image, et recompose un post macro analyse avec notre texte et leur image/vidéo ? »,
 * « Il faut des nouveaux Engine pour faire proprement chaque étape non ? », then « go » on three Engines):
 *
 *   X account found (`x_account_found`)      dy_x_industry_accounts: the X accounts that matter in the brand's
 *                                            industry ("industry" = its tactic `audience`, never in the outcome name:
 *                                            the same Engine will find clients' or partners' accounts). The model
 *                                            (asked of the LLM completion Engine) names candidate handles and search
 *                                            phrases from the brand's own facts; social-service searches X, verifies
 *                                            each account, keeps every one new for the brand and declares one Unit each.
 *   Industry news found (`industry_news_found`) dy_industry_news_watch v2: the same daily scan, now also reading the
 *                                            recent posts of the accounts found (asked of X account found when the
 *                                            brand holds none yet) and the brand's own topics.
 *   X post published (`x_post_published`)   dy_x_quote_industry_post: asks the watch, picks the best X post this brand
 *                                            never quoted, asks a model for the brand's macro take, publishes it with
 *                                            the post's URL as the LAST line (X renders a quote: their image or video,
 *                                            credited to its author). Never a media download, never `quote_tweet_id`.
 *
 * A script makes ONE outcome: none of them names a model (each asks `llm_completion`, the Rating picks the model per
 * asking script, ONE-WRITER-N-MODELS-1116) and none names its own outcome (the doors fill `outcomeKey`).
 */
import { PORT_HEAD } from "./port-kit.js";
import { CHECK_TURN, gatherFactsFunctions, planRunFunction } from "./social-post.js";
import { buildIndustryNewsSource as buildIndustryNewsV1Source, INDUSTRY_NEWS } from "./industry-news.js";
import { BRIEF_HEADER } from "../../src/lib/campaign-brief.js";

export const X_ACCOUNT_FOUND = "x_account_found";

export const X_INDUSTRY_ACCOUNTS = {
  outcome: X_ACCOUNT_FOUND,
  dynasty: "dy_x_industry_accounts",
  name: "Industry X accounts",
  tactics: { audience: "industry", recorded_by: "social", asks: ["llm_completion"], maxAccounts: 25 },
  description:
    "Finds the X accounts that matter most in the brand's industry, from the brand's own facts, and keeps each account the brand did not hold yet with its followers and why it matters.",
} as const;

export const INDUSTRY_NEWS_V2 = {
  outcome: INDUSTRY_NEWS.outcome,
  dynasty: INDUSTRY_NEWS.dynasty,
  tactics: {
    ...INDUSTRY_NEWS.tactics,
    asks: ["x_account_found"],
    accounts: "also reads the recent posts of the X accounts found in the brand's industry (finds them first when the brand holds none)",
  },
  description:
    "Reads the brand's industry news of the last day and a half once a day (the press, X, LinkedIn, Reddit, Hacker News, and the recent posts of the X accounts that matter in its industry) and keeps every new item that names a watched company or a core topic, ranked by relevance and reactions.",
} as const;

export const X_QUOTE_INDUSTRY_POST = {
  outcome: "x_post_published",
  dynasty: "dy_x_quote_industry_post",
  name: "Quote an industry post",
  tactics: {
    network: "x",
    recorded_by: "social",
    channel: "x-post",
    asks: ["industry_news_found", "llm_completion"],
    post: "quotes an industry post",
    // The UTC hours it posts, [from, to): data on the script, never a constant every brand inherits
    // (X-QUOTE-ANY-HOUR-1117, owner 2026-11-17 « on est encore en test, ça doit envoyer tout le temps »).
    publishHoursUtc: [0, 24],
  },
  description:
    "Publishes one X post per run quoting the day's best post of the brand's industry: the brand's own short macro take, then the original post's link, which X shows as a quote of it. Never quotes the same post twice for a brand; runs on X accounts typed Pro (AI), at any hour, at least an hour apart.",
} as const;

/** The brief sentence a campaign states so its strategy keeps only the quote script on X post published. */
export const QUOTE_BRIEF_SENTENCE = "Every X post quotes the best post of our industry with our own macro take on it.";

/** The writer's answer: one field, strict-schema ready (every property required, nothing else). */
export const QUOTE_TAKE_SCHEMA = {
  type: "object",
  properties: { take: { type: "string", description: "The post text, without any link: the quoted post's URL is added after it." } },
  required: ["take"],
  additionalProperties: false,
} as const;

/** What the model answers when naming the industry's accounts: candidate handles + search phrases, strict-schema ready. */
export const ACCOUNTS_SCHEMA = {
  type: "object",
  properties: {
    handles: {
      type: "array",
      items: {
        type: "object",
        properties: { handle: { type: "string" }, why: { type: "string" } },
        required: ["handle", "why"],
        additionalProperties: false,
      },
    },
    queries: { type: "array", items: { type: "string" } },
  },
  required: ["handles", "queries"],
  additionalProperties: false,
} as const;

/** X counts any link as 23 characters; the take + a blank line + the link stays under 280. */
export const TAKE_MAX_CHARS = 250;

const FACT_LINES = `
/** What the brand told us (offer answers, CONFIRMED fields), one line each; nothing read off its site. */
function factLines(facts: any): string[] {
  const out: string[] = [];
  for (const f of Array.isArray(facts?.exact) ? facts.exact : []) out.push("- " + String(f.label) + ": " + String(f.value).slice(0, 600));
  return out;
}
function brandOf(profile: any): any {
  return profile && typeof profile === "object" && profile.brand && typeof profile.brand === "object" ? profile.brand : profile ?? {};
}
function factsOf(ctx: any, brandId: string, offerId: string | null): any {
  const none = { ok: true };
  const offerAnswers = offerId ? must(ctx, "brand.offer.answers", { params: { brandId, offerId } }) : none;
  const offerFields = offerId ? must(ctx, "brand.offer.fields", { params: { brandId, offerId } }) : none;
  const brandFields = tolerated(ctx, "brand.fields", { params: { brandId } });
  return gatherFacts(offerAnswers, offerFields, brandFields);
}
`;

export function buildXIndustryAccountsSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** X account found (tactic audience): the accounts that matter for the brand, found and kept by social-service (X-QUOTE-INDUSTRY-1117). */`,
    `const BRIEF_HEADER = ${JSON.stringify(BRIEF_HEADER)};`,
    PORT_HEAD,
    gatherFactsFunctions(),
    FACT_LINES,
    `
const ACCOUNTS_SCHEMA = ${JSON.stringify(ACCOUNTS_SCHEMA)};

export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const now = typeof R.now === "string" ? R.now : "";
  const day = now.slice(0, 10);
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(day)) throw new Error("x-accounts: the run states no clock (request.now): " + JSON.stringify(R.now));
  const t: any = ctx.tactics ?? {};
  const audience = typeof t.audience === "string" ? t.audience.trim() : "";
  if (!audience) throw new Error("x-accounts: the script states no audience (tactic audience: whose accounts it finds)");
  const max = Number.isInteger(t.maxAccounts) && t.maxAccounts > 0 && t.maxAccounts <= 50 ? t.maxAccounts : 25;
  const brandId = Array.isArray(R.brandIds) && R.brandIds.length ? String(R.brandIds[0]) : String(ctx.brand ?? "");
  if (!brandId) throw new Error("x-accounts: no brand on this run");
  const offerId = typeof R.offerId === "string" && R.offerId ? R.offerId : null;
  const brief = typeof R.brief === "string" ? R.brief.trim() : "";

  const brand = brandOf(must(ctx, "brand.profile", { params: { id: brandId } }));
  const facts = factLines(factsOf(ctx, brandId, offerId));
  const systemPrompt = [
    "You name the X (Twitter) accounts that matter most to a brand's " + audience + ", and the phrases to search X with to find more of them.",
    "Use web search. Name only accounts you are confident exist today, by their exact @handle (without the @), each with one short line on why it matters.",
    "Prefer active accounts people in that " + audience + " read: analysts, practitioners, media, companies, communities. Never the brand itself.",
    "Give at most " + max + " handles and 3 to 6 search phrases, in the language the " + audience + " posts in.",
  ].join("\\n");
  const message = [
    "THE BRAND: " + String(brand.name ?? "") + (brand.domain ? " (" + String(brand.domain) + ")" : ""),
    facts.length ? "WHAT THE BRAND TOLD US:\\n" + facts.join("\\n") : "WHAT THE BRAND TOLD US: nothing yet beyond its name and site.",
  ].join("\\n\\n");
  ctx.ask({ units: {}, request: withBrief({ message, systemPrompt, webSearch: true, maxTokens: 4000, responseFormat: "json", responseSchema: ACCOUNTS_SCHEMA, strictResponseSchema: ACCOUNTS_SCHEMA }, brief) });
  const done: any = ctx.get("llm_completion");
  if (!done.content) throw new Error("llm_completion: " + String(done.unmade ?? "no completion"));
  const named: any = (done.content.answer && done.content.answer.json) || {};
  const clean = (h: any) => String(h ?? "").trim().replace(/^@/, "").replace(/^https?:[/][/](www[.])?(x|twitter)[.]com[/]/i, "").split(/[/?#\\s]/)[0];
  const handles: string[] = [];
  for (const h of Array.isArray(named.handles) ? named.handles : []) {
    const v = clean(h && h.handle);
    if (/^[A-Za-z0-9_]{1,15}$/.test(v) && !handles.some((x) => x.toLowerCase() === v.toLowerCase())) handles.push(v);
  }
  const queries = (Array.isArray(named.queries) ? named.queries : []).map((q: any) => String(q ?? "").trim()).filter((q: string) => q.length > 1).slice(0, 6);
  if (!handles.length && !queries.length) return { unmade: "no_candidate: the model named no account and no search phrase for the brand's " + audience };

  const found = must(ctx, "social.x.accounts.find", { body: { purpose: audience, ...(handles.length ? { handles: handles.slice(0, max) } : {}), ...(queries.length ? { queries } : {}), idempotencyKey: "x-accounts:" + audience + ":" + day } });
  const kept = Array.isArray(found.accounts) ? found.accounts : [];
  if (!kept.length) return { unmade: "no_new_account: social-service kept no new X account for the brand's " + audience + " (" + handles.length + " named, " + queries.length + " phrases)" };
  return { content: { audience, queries, accounts: kept.map((a: any) => ({ handle: a.handle, name: a.name ?? null, followers: a.followers ?? null, why: a.whyKept ?? null })) } };
}
`,
  ].join("\n");
}

/**
 * The watch's v2: v1's code plus, before the scan, the accounts found for the brand's industry (read back; none yet =
 * asked of X account found inside this run, a child run), passed to the scan as the handles to read. The items now
 * carry what a quoting script needs (post id, text, engagement, score).
 */
export function buildIndustryNewsV2Source(): string {
  const v1 = buildIndustryNewsV1Source();
  const edits: Array<[string, string]> = [
    [
      `/** Industry news found: one scan a day for the run's brand, each new item kept as one Unit by social-service (INDUSTRY-NEWS-ENGINE-1108). */`,
      `/** Industry news found: one scan a day for the run's brand, each new item kept as one Unit by social-service (INDUSTRY-NEWS-ENGINE-1108); v2 also reads the X accounts found in its industry (X-QUOTE-INDUSTRY-1117). */`,
    ],
    [
      `  const scan = must(ctx, "social.news.scan", { body: { hours, idempotencyKey: "industry-news:" + day } });`,
      `  const found = industryAccounts(ctx, R, now);
  const scan = must(ctx, "social.news.scan", { body: { hours, idempotencyKey: "industry-news:" + day, ...(found.handles.length ? { xHandles: found.handles } : {}), ...(found.topics.length ? { topics: found.topics } : {}) } });`,
    ],
    [
      `  const view = items.map((i: any) => ({ id: i.id, title: i.title, url: i.url, source: i.source, author: i.author ?? null, publishedAt: i.publishedAt ?? null, whyItMatters: i.whyItMatters ?? "" }));`,
      `  const view = items.map((i: any) => ({ id: i.id, title: i.title, url: i.url, source: i.source, author: i.author ?? null, publishedAt: i.publishedAt ?? null, whyItMatters: i.whyItMatters ?? "", sources: Array.isArray(i.sources) ? i.sources : [], postId: i.postId ?? null, text: String(i.text ?? "").slice(0, 2000), engagement: i.engagement ?? null, score: typeof i.score === "number" ? i.score : null }));`,
    ],
    [
      `export default function run(ctx: ScriptContext): ScriptResult {`,
      `/**
 * The X accounts that matter in the brand's industry (X account found, tactic audience "industry"): read back from
 * social-service; none kept yet = asked of that Engine inside this run (its spend and Units land on this campaign).
 * Its answer when it found nobody is read as no account (the scan runs as before), never a failure.
 */
function industryAccounts(ctx: any, R: any, now: string): { handles: string[]; topics: string[] } {
  const brandId = Array.isArray(R.brandIds) && R.brandIds.length ? String(R.brandIds[0]) : String(ctx.brand ?? "");
  const held = must(ctx, "social.x.accounts.found", { query: { brandId, purpose: "industry" } });
  let list: any[] = Array.isArray(held.accounts) ? held.accounts : [];
  if (!list.length) {
    ctx.ask({ units: {}, recordedBy: "social", request: { now, brandIds: R.brandIds ?? null, offerId: R.offerId ?? null, brief: R.brief ?? null } });
    const u: any = ctx.get("x_account_found");
    list = u && u.content && Array.isArray(u.content.accounts) ? u.content.accounts : [];
    // The search phrases the finder read the brand's industry with: the brand's own topics from now on.
    const phrases = u && u.content && Array.isArray(u.content.queries) ? u.content.queries.map(String).filter(Boolean).slice(0, 6) : [];
    if (phrases.length) ctx.storage.set("topics", brandId, phrases);
  }
  const kept = ctx.storage.get("topics", brandId);
  return {
    handles: list.map((a: any) => String(a.handle ?? "")).filter(Boolean).slice(0, 50),
    topics: Array.isArray(kept) ? kept.map(String).filter(Boolean) : [],
  };
}

export default function run(ctx: ScriptContext): ScriptResult {`,
    ],
  ];
  let s = v1;
  for (const [from, to] of edits) {
    if (s.split(from).length !== 2) throw new Error(`industry news v2: anchor not found exactly once: ${from.slice(0, 80)}`);
    s = s.replace(from, to);
  }
  return s;
}

export function buildXQuoteIndustryPostSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** X post published by quoting an industry post (X-QUOTE-INDUSTRY-1117): the brand's macro take, the post's URL as the last line. */`,
    `const BRIEF_HEADER = ${JSON.stringify(BRIEF_HEADER)};`,
    PORT_HEAD,
    planRunFunction(),
    CHECK_TURN,
    gatherFactsFunctions(),
    FACT_LINES,
    `
const QUOTE_TAKE_SCHEMA = ${JSON.stringify(QUOTE_TAKE_SCHEMA)};
const TAKE_MAX_CHARS = ${TAKE_MAX_CHARS};
const X_STATUS = /^https:[/][/](x|twitter)[.]com[/]([A-Za-z0-9_]{1,15})[/]status[/]([0-9]{5,25})$/;

/** The posts of the industry's X accounts the watch kept today, best first (score, then newest). */
function quotable(items: any[]): any[] {
  const out: any[] = [];
  for (const i of items) {
    const url = String(i?.url ?? "").trim();
    const m = X_STATUS.exec(url);
    // An industry post = a post of one of the X accounts found for the brand (the scan names them X/@<handle>).
    const watched = Array.isArray(i?.sources) && i.sources.some((s: any) => String(s).startsWith("X/@"));
    if (i?.source !== "x" || !m || !watched) continue;
    out.push({ ...i, url: "https://x.com/" + m[2] + "/status/" + m[3], postId: m[3], handle: m[2] });
  }
  const score = (i: any) => (typeof i.score === "number" ? i.score : -1);
  return out.sort((a, b) => score(b) - score(a) || Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? ""));
}

/** The hours this script posts are its tactic \`publishHoursUtc\` [from, to) in UTC hours, 0 <= from < to <= 24; none stated = refused, never a default. */
function inPublishHours(hours: any, now: string): boolean {
  const ok = Array.isArray(hours) && hours.length === 2 && hours.every((h: any) => typeof h === "number" && Number.isInteger(h)) && hours[0] >= 0 && hours[0] < hours[1] && hours[1] <= 24;
  if (!ok) throw new Error("tactic publishHoursUtc must be [from, to) UTC hours, got " + JSON.stringify(hours));
  const hour = new Date(now).getUTCHours();
  return hour >= hours[0] && hour < hours[1];
}

/** X's own count (twitter-text v3): these code points weigh 1, any other (emoji, CJK) 2; a link weighs 23. */
function xWeight(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2;
  }
  return n;
}
/** What the take may weigh: 280 minus the blank line and the quoted post's link (23). */
const X_TAKE_BUDGET = 280 - 2 - 23;

/** The take as written (the writer is trusted): dashes rewritten, any link or tag it slipped in removed, the URL closing it. */
function finalText(take: string, url: string): string {
  const undash = (s: string) => s.replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-").replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ");
  let body = undash(take).replace(/https?:[/][/]\\S+/g, "").replace(/(^|\\s)@([A-Za-z0-9_]{1,15})/g, "$1$2").replace(/[ \\t]{2,}/g, " ").replace(/[ \\t]+\\n/g, "\\n").trim();
  if (!body) throw new Error("final-text: the writer returned no take");
  // X refuses a post over 280 (MON-SCRIPTS-WATCHING-1119: 14 takes in 2 days, 281 to 342): whole trailing sentences
  // are dropped until it fits, like a thread keeps at most 3 replies; one sentence still too long ends on its last whole word.
  if (xWeight(body) > X_TAKE_BUDGET) {
    const sentences = body.match(/[^.!?\\n]+(?:[.!?]+|\\n+|$)/g) ?? [body];
    let kept = "";
    for (const part of sentences) {
      if (xWeight((kept + part).trim()) > X_TAKE_BUDGET) break;
      kept += part;
    }
    kept = kept.trim();
    if (!kept) {
      const words = body.split(/\\s+/);
      for (const w of words) {
        const next = kept ? kept + " " + w : w;
        if (xWeight(next + "...") > X_TAKE_BUDGET) break;
        kept = next;
      }
      kept = kept.replace(/[,;:]+$/, "") + "...";
    }
    body = kept;
  }
  return body + "\\n\\n" + url;
}

export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const network = String((ctx.tactics as any).network ?? "");
  if (network !== "x") throw new Error("the quote script posts on X only (tactic network x), got " + JSON.stringify(network));
  const brief = typeof R.brief === "string" ? R.brief.trim() : "";
  const campaignId = typeof R.campaignId === "string" ? R.campaignId : null;
  const p = planRun(R.now, false, campaignId, (Array.isArray(R.brandIds) && R.brandIds.length ? R.brandIds.join(",") : ctx.brand), null, R);
  p.inWindow = inPublishHours((ctx.tactics as any).publishHoursUtc, p.now);
  const accounts = must(ctx, "social.accounts", { query: { brandId: p.brandId, network } });
  const posts = must(ctx, "social.publications", { query: { brandId: p.brandId, network, since: p.postsQuery.since, limit: "1000" } });
  const turn = checkTurn(p, network, accounts, posts);
  if (turn.proceed !== true) return turn.unmade ? { unmade: turn.unmade } : null;

  ctx.ask({ units: {}, recordedBy: "social", request: { now: p.now, brandIds: R.brandIds ?? null, offerId: p.offerId, brief: R.brief ?? null } });
  const news: any = ctx.get("industry_news_found");
  if (!news.content) return { unmade: "no_industry_post: " + String(news.unmade ?? "the watch answered nothing") };
  const published: any[] = Array.isArray(posts.publications) ? posts.publications : [];
  const quotedBefore = (i: any) => ctx.storage.get("quoted", p.brandId + ":" + i.postId) !== null || published.some((x: any) => String(x.text ?? "").includes("/status/" + i.postId));
  const candidates = quotable(Array.isArray(news.content.items) ? news.content.items : []).filter((i: any) => !quotedBefore(i));
  if (!candidates.length) return { unmade: "no_quotable_post: the watch kept no post of the industry's X accounts today that the brand has not quoted yet" };
  const best = candidates[0];

  const brand = brandOf(must(ctx, "brand.profile", { params: { id: p.brandId } }));
  const facts = factLines(factsOf(ctx, p.brandId, p.offerId));
  const systemPrompt = [
    "You write one X post for " + String(brand.name ?? "the brand") + ": its own short macro take on the industry post it quotes.",
    "The quoted post is shown right under your text (X renders its link as a quote, with its image or video): never restate it, add what it means for the bigger picture, in the brand's voice.",
    "State only what the brand's facts and the quoted post say; no figure of your own, no promise.",
    "At most " + TAKE_MAX_CHARS + " characters. No link, no @tag, no hashtag, no em dash or en dash. Plain sentences.",
  ].join("\\n");
  const history = (turn.history as string[]).slice(0, 10);
  const message = [
    "THE BRAND: " + String(brand.name ?? "") + (brand.domain ? " (" + String(brand.domain) + ")" : ""),
    facts.length ? "WHAT THE BRAND TOLD US:\\n" + facts.join("\\n") : "WHAT THE BRAND TOLD US: nothing yet beyond its name and site.",
    "THE POST YOU QUOTE (by @" + best.handle + (best.engagement ? ", " + String(best.engagement) : "") + "):\\n" + String(best.text || best.title || "").slice(0, 2000),
    history.length ? "THE BRAND'S LAST POSTS (never repeat one):\\n" + history.join("\\n") : "",
  ].filter(Boolean).join("\\n\\n");
  ctx.ask({ units: {}, request: withBrief({ message, systemPrompt, maxTokens: 1000, responseFormat: "json", responseSchema: QUOTE_TAKE_SCHEMA, strictResponseSchema: QUOTE_TAKE_SCHEMA }, brief) });
  const done: any = ctx.get("llm_completion");
  if (!done.content) throw new Error("llm_completion: " + String(done.unmade ?? "no completion"));
  const take = String(((done.content.answer && done.content.answer.json) || {}).take ?? "");
  const text = finalText(take, best.url);

  // One brand never quotes one post twice: the first run to claim it publishes it, any other stops here.
  const mark = (campaignId ?? "no-campaign") + ":" + p.now;
  const claimed: any = ctx.storage.claim("quoted", p.brandId + ":" + best.postId, { by: mark, url: best.url });
  if (!claimed || claimed.by !== mark) return { unmade: "already_quoted: another run quoted " + best.url + " for the brand" };
  must(ctx, "social.publish", { params: { id: turn.account.id }, body: { text, idempotencyKey: "x-quote:" + (campaignId ?? "no-campaign") + ":" + best.postId } });
  return { content: { end: { success: true, stopCampaign: false }, quoted: best.url } };
}
`,
  ].join("\n");
}

/**
 * MON-XPOST-SCRIPT-1126-WF: the watch's v3 = its stored code with the post text cut on a WHOLE character. v2 cut at
 * 2000 UTF-16 units, which kept half an emoji at index 1999 (a lone surrogate): no row could store that Unit and every
 * quote run stopped. One anchored edit of the stored code, applied by UPGRADE (`replace`, exact dynasty).
 */
export const INDUSTRY_NEWS_WHOLE_CHARS_EDIT = {
  from: `text: String(i.text ?? "").slice(0, 2000),`,
  to: `text: ((t: string) => { const c = t.charCodeAt(t.length - 1); return c >= 0xd800 && c <= 0xdbff ? t.slice(0, -1) : t; })(String(i.text ?? "").slice(0, 2000)),`,
} as const;
