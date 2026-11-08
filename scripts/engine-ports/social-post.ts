/**
 * SOCIAL-POSTS-ENGINES-1107 (owner 2026-11-07, « Sure go »): the X post Engine (`x_post_published`) and the LinkedIn
 * post Engine (`linkedin_post_published`), ONE script code stored as two dynasties (a script makes one outcome), each
 * told its network by its tactic `network`. No old workflow behind them: built from the Threads post script's own step
 * code (the same writing chain), never a fork of that dynasty. One run = one post on the brand's next account of that
 * network that software may post on, or an idle end:
 *
 *   social-service     the brand's accounts of the network (typed; `publishable` or why not) + what this Engine
 *                      published on them over 30 days -> whose turn, is one owed now;
 *   brand-service      the brand profile, the offer's answers, the CONFIRMED fields (the brand's own facts);
 *   chat-service       this week's industry angles (web search), the own pages to read, the figures they publish;
 *   scraping-service   the brand's site map and those pages;
 *   features-service   the best template dynasty + LLM for this campaign (never fixed here: the templates of each
 *                      network say its format, X's 280 characters, a LinkedIn post);
 *   content-generation the post, written with that template head + LLM;
 *   social-service     publishes it through the account's own login (refused unless Pro (AI)), declares the Unit under
 *                      this Engine's outcome (the door fills `outcomeKey`) and the spend (the X post fee).
 *
 * Answers: `null` = nothing owed now (outside the day's window, under an hour since the last post: idle, rechecked);
 * `unmade "no_publishable_account: <why>"` = the brand has no account of this network software may post on (each
 * connected one named with its reason: personal, human-run, a LinkedIn company page our login cannot post as):
 * idle, never a post on a personal profile; `{content: {end}}` = the post went out; a throw = the run failed.
 * Tactics: `network` (x | linkedin, social-service's word), `recorded_by` social (social-service declares the Unit), `channel`
 * (x-post | linkedin-post): features-service runs a pipe on a script only when it states the pipe's channel or the pipe
 * names a finer Engine outcome (`scriptWorksPipe`); these pipes end on the outcome itself. Stored as v2 with it.
 */
import { asFunction, PORT_HEAD } from "./port-kit.js";
import {
  COMPOSE_ANGLES_CODE,
  COMPOSE_OWN_FIGURES_CODE,
  COMPOSE_PICK_PAGES_CODE,
  COMPOSE_WRITE_CODE,
  MIN_GAP_MINUTES,
  OWN_PAGES_SCHEMA,
  PLAN_OWN_PAGES_CODE,
  PLAN_OWN_SITE_CODE,
  PLAN_RUN_CODE,
  PRO_AI_ACCOUNT_TYPE,
  THREAD_SHAPES,
  THREADS_ANGLES_LLM,
} from "./threads-post-steps.js";
import { GATHER_CLIENT_FACTS_CODE } from "../../src/lib/cold-whatsapp-outreach-dag.js";
import { THREAD_WRITER_PLAN_CODE } from "../../src/lib/whatsapp-template-writer.js";
import { BRIEF_HEADER } from "../../src/lib/campaign-brief.js";

export const SOCIAL_POSTS = {
  x: {
    outcome: "x_post_published",
    dynasty: "dy_x_post",
    tactics: { network: "x", recorded_by: "social", channel: "x-post", asks: ["industry_news_found"] },
    description:
      "Publishes one X post per run on the brand's X accounts typed Pro (AI), rotating across them and never on a personal account. Posts go out at least an hour apart during the day, each on a new subject, written only from the brand's own facts.",
  },
  linkedin: {
    outcome: "linkedin_post_published",
    dynasty: "dy_linkedin_post",
    tactics: { network: "linkedin", recorded_by: "social", channel: "linkedin-post", asks: ["industry_news_found"] },
    description:
      "Publishes one LinkedIn post per run on the brand's LinkedIn accounts typed Pro (AI), rotating across them and never on a personal profile. Posts go out at least an hour apart during the day, each on a new subject, written only from the brand's own facts.",
  },
} as const;

/** GATHER_CLIENT_FACTS_CODE is a helper + a `main`: the helper keeps its name, the main becomes `gatherFacts`. */
function gatherFactsFunctions(): string {
  const code = GATHER_CLIENT_FACTS_CODE.replace("async function gatherFacts(", "function gatherFactsWith(").replace("return gatherFacts(null,", "return gatherFactsWith(null,");
  return asFunction(code, "gatherFacts");
}

/**
 * Whose turn, and is a post owed now (the Threads rule on social-service's answers): the candidates are the accounts
 * social-service says software may post on (`publishable`: Pro (AI), connected, able to post where the page is), the
 * one whose last post is the oldest first. None = unmade with every account's reason, never a guess.
 */
const CHECK_TURN = `
function checkTurn(plan: any, network: string, accounts: any, posts: any): any {
  const all = Array.isArray(accounts?.accounts) ? accounts.accounts : null;
  if (all === null) throw new Error("check-turn: social-service served no accounts list: " + JSON.stringify(accounts).slice(0, 300));
  const list = Array.isArray(posts?.publications) ? posts.publications : null;
  if (list === null) throw new Error("check-turn: social-service served no publications list: " + JSON.stringify(posts).slice(0, 300));
  const at = (p: any) => Date.parse(p.publishedAt ?? "");
  const mains = list.filter((p: any) => Number.isFinite(at(p))).sort((a: any, b: any) => at(b) - at(a));
  const skipped: string[] = [];
  const candidates: any[] = [];
  for (const a of all) {
    if (a.publishable === true && a.accountType === ${JSON.stringify(PRO_AI_ACCOUNT_TYPE)} && a.health === "connected") candidates.push(a);
    else skipped.push(a.username + " (" + String(a.notPublishableReason ?? a.accountTypeLabel ?? a.accountType) + ")");
  }
  const lastOn = (a: any) => { const m = mains.find((p: any) => p.accountId === a.id); return m ? at(m) : -Infinity; };
  candidates.sort((a, b) => lastOn(a) - lastOn(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const account = candidates[0] ?? null;
  const today = mains.filter((p: any) => new Date(at(p)).toISOString().slice(0, 10) === plan.date);
  const history = mains.map((p: any) => new Date(at(p)).toISOString().slice(0, 10) + ": " + String(p.text ?? "").slice(0, 400));
  const shapes = ${JSON.stringify(THREAD_SHAPES)};
  const base = { account, history, shape: shapes[today.length % shapes.length], todayCount: today.length };
  if (!account) {
    const why = all.length ? skipped.join("; ") : "no " + network + " account is connected to the brand";
    return { ...base, proceed: false, unmade: "no_publishable_account: no " + network + " account of the brand may be posted on by software: " + why };
  }
  if (!plan.inWindow) return { ...base, proceed: false, unmade: null };
  const last = mains[0] ? at(mains[0]) : null;
  if (last !== null && Date.parse(plan.now) - last < ${MIN_GAP_MINUTES} * 60 * 1000) return { ...base, proceed: false, unmade: null };
  return { ...base, proceed: true, unmade: null };
}
`;

export function buildSocialPostSource(): string {
  const plan = asFunction(PLAN_RUN_CODE.replace("const now = new Date();", "const now = new Date(__now);"), "planRun").replace("function planRun(", "function planRun(__now, ");
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** X / LinkedIn post (x_post_published | linkedin_post_published by tactic network): one post per run on the brand's next publishable account (SOCIAL-POSTS-ENGINES-1107). */`,
    `const BRIEF_HEADER = ${JSON.stringify(BRIEF_HEADER)};`,
    PORT_HEAD,
    plan,
    CHECK_TURN,
    gatherFactsFunctions(),
    asFunction(COMPOSE_ANGLES_CODE, "composeAngles"),
    asFunction(PLAN_OWN_SITE_CODE, "planOwnSite"),
    asFunction(COMPOSE_PICK_PAGES_CODE, "composePickPages"),
    asFunction(PLAN_OWN_PAGES_CODE, "planOwnPages"),
    asFunction(COMPOSE_OWN_FIGURES_CODE, "composeOwnFigures"),
    asFunction(COMPOSE_WRITE_CODE, "composeWrite"),
    asFunction(THREAD_WRITER_PLAN_CODE, "writerPlan"),
    `
const LLM = ${JSON.stringify(THREADS_ANGLES_LLM)};
const OWN_PAGES_SCHEMA = ${JSON.stringify(OWN_PAGES_SCHEMA)};

/**
 * INDUSTRY-NEWS-ENGINE-1108: the brand's fresh industry news, asked of the Industry news found Engine inside THIS run (a
 * child run: its scan's spend and Units land on this campaign through the run tree; the day's scan is paid once, a second
 * ask the same day reads it back). Social-service declares the Units (recordedBy social). No script / nothing kept = [].
 */
function freshNews(ctx: any, now: string): any[] {
  ctx.ask({ units: {}, recordedBy: "social", request: { now } });
  const u = ctx.get("industry_news_found");
  return u && u.content && Array.isArray(u.content.items) ? u.content.items : [];
}

/** The angle reader's message with the watch's items first (each with its source URL), when there are any. */
function withNews(message: string, news: any[]): string {
  if (!news.length) return message;
  const lines = news.slice(0, 12).map((i: any) => "- " + String(i.title ?? "").slice(0, 200) + " (" + String(i.url ?? "") + ")" + (i.whyItMatters ? ": " + String(i.whyItMatters).slice(0, 200) : ""));
  return message + "\\n\\nFRESH INDUSTRY NEWS (the last day and a half, kept by the brand's own watch; start from these, with their source URL):\\n" + lines.join("\\n");
}

/** The post as written (the writer is trusted): dashes rewritten, its parts joined, the GET STARTED line closing it. */
function finalPost(draft: any, compose: any): string {
  const undash = (s: any) => String(s ?? "").replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-").replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ").trim();
  const strip = (s: any) => undash(s).split("\\n").filter((l: string) => l.trim() !== compose.getStarted).join("\\n").trim();
  const parts = [draft?.post, ...(Array.isArray(draft?.replies) ? draft.replies : [])].map(strip).filter(Boolean);
  if (!parts.length) throw new Error("final-post: the writer returned no post: " + JSON.stringify(draft).slice(0, 300));
  return parts.join("\\n\\n") + "\\n\\n" + compose.getStarted;
}

export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const network = String((ctx.tactics as any).network ?? "");
  if (network !== "x" && network !== "linkedin") throw new Error("the script's tactic network must be x or linkedin, got " + JSON.stringify(network));
  const brief = typeof R.brief === "string" ? R.brief.trim() : "";
  const campaignId = typeof R.campaignId === "string" ? R.campaignId : null;
  const p = planRun(R.now, false, campaignId, (Array.isArray(R.brandIds) && R.brandIds.length ? R.brandIds.join(",") : ctx.brand), null, R);
  const accounts = must(ctx, "social.accounts", { query: { brandId: p.brandId, network } });
  const posts = must(ctx, "social.publications", { query: { brandId: p.brandId, network, since: p.postsQuery.since, limit: "1000" } });
  const turn = checkTurn(p, network, accounts, posts);
  if (turn.proceed !== true) return turn.unmade ? { unmade: turn.unmade } : null;

  const brand = must(ctx, "brand.profile", { params: { id: p.brandId } });
  const offerAnswers = must(ctx, "brand.offer.answers", { params: { brandId: p.brandId, offerId: p.offerId } });
  const offerFields = must(ctx, "brand.offer.fields", { params: { brandId: p.brandId, offerId: p.offerId } });
  const brandFields = tolerated(ctx, "brand.fields", { params: { brandId: p.brandId } });
  const facts = gatherFacts(offerAnswers, offerFields, brandFields);

  const news = freshNews(ctx, p.now);
  const a = composeAngles(brand, facts, p);
  const angles = tolerated(ctx, "llm.complete", withBrief({ provider: LLM.provider, model: LLM.model, webSearch: true, maxTokens: 4000, message: withNews(a.message, news), systemPrompt: a.systemPrompt }, brief));

  const site = planOwnSite(brand, p);
  const map = tolerated(ctx, "scraping.site.map", { body: { url: site.url, brandIds: site.brandIds, campaignId } });
  const offered = composePickPages(site, map, p);
  const pick = (offered.count ?? 0) === 0
    ? { ok: false, notCalled: true }
    : tolerated(ctx, "llm.complete", withBrief({ provider: LLM.provider, model: LLM.model, responseFormat: "json", responseSchema: OWN_PAGES_SCHEMA, maxTokens: 2000, message: offered.message, systemPrompt: offered.systemPrompt }, brief));
  const pages = planOwnPages(pick, offered);
  const scraped: any[] = [];
  for (const url of [pages.url1, pages.url2, pages.url3, pages.url4]) {
    if (scraped.length >= (pages.count ?? 0)) { scraped.push(null); continue; }
    scraped.push(tolerated(ctx, "scraping.page", { body: { enrich: false, url, brandIds: site.brandIds, campaignId } }));
  }
  const own = composeOwnFigures(site, p, scraped[0], scraped[1], scraped[2], scraped[3]);
  const ownFigures = (own.pageCount ?? 0) === 0
    ? null
    : tolerated(ctx, "llm.complete", withBrief({ provider: LLM.provider, model: LLM.model, maxTokens: 4000, message: own.message, systemPrompt: own.systemPrompt }, brief));

  const write = composeWrite(p, turn, brand, facts, angles, ownFigures);
  const writerPick = must(ctx, "features.writer_pick", { query: { campaignId } });
  const writer = writerPlan(writerPick, undefined);
  const head = must(ctx, "content.template_head", { params: { slug: writer.templateDynastySlug } });
  const draft = must(ctx, "content.thread.generate", {
    body: {
      variables: write.variables,
      context: write.context,
      brandIds: write.brandIds,
      campaignId,
      dryRun: false,
      type: head.template.type,
      model: writer.model,
      ...(R.brief !== null && R.brief !== undefined ? { brief: R.brief } : {}),
    },
  });
  const text = finalPost(draft, write);
  must(ctx, "social.publish", { params: { id: turn.account.id }, body: { text, idempotencyKey: network + "-post:" + (campaignId ?? "no-campaign") + ":" + p.now } });
  return { content: { end: { success: true, stopCampaign: false } } };
}
`,
  ].join("\n");
}
