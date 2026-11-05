/**
 * MIGRATE-1105 S4: the Threads post Engine (`post_published`) as ONE stored script, ported from the Threads workflow
 * DAG step by step (`buildThreadsPostSource()` assembles it from the DAG's own step code, so nothing is rewritten by
 * hand). One run = one Threads thread on the brand's next Pro (AI) account, or an idle end:
 *
 *   meta-service       the brand's Threads accounts + what it published over 30 days -> whose turn, is one owed now;
 *   brand-service      the brand profile, the offer's answers, the CONFIRMED fields (the brand's own facts);
 *   chat-service       this week's industry angles (web search), the own pages to read, the figures they publish;
 *   scraping-service   the brand's site map and those pages;
 *   features-service   the pipe's best template dynasty + LLM for this campaign (never fixed here);
 *   content-generation the thread, written with that template head + LLM (its writer, its outcome rows);
 *   meta-service       publishes the main post then each reply (idempotent per part), and declares `post_published`.
 *
 * The campaign chassis (gate, start, end) is the Engine runner's. The script answers: `null` = nothing owed now (idle,
 * campaign-service rechecks), `{content: {end}}` = the thread went out, a throw = the run failed (as every DAG failure).
 * Tactics: `channel` threads-post (the campaign's), `recorded_by` meta (meta-service declares the outcome).
 */
import { asFunction, PORT_HEAD } from "./port-kit.js";
import {
  CHECK_TURN_CODE,
  CLASSIFY_MAIN_CODE,
  COMPOSE_ANGLES_CODE,
  COMPOSE_OWN_FIGURES_CODE,
  COMPOSE_PICK_PAGES_CODE,
  COMPOSE_WRITE_CODE,
  FINAL_THREAD_CODE,
  OWN_PAGES_SCHEMA,
  PLAN_OWN_PAGES_CODE,
  PLAN_OWN_SITE_CODE,
  PLAN_RUN_CODE,
  THREADS_ANGLES_LLM,
  THREADS_POST_FEATURE_SLUG,
} from "./threads-post-steps.js";
import { GATHER_CLIENT_FACTS_CODE } from "../../src/lib/cold-whatsapp-outreach-dag.js";
import { THREAD_WRITER_PLAN_CODE } from "../../src/lib/whatsapp-template-writer.js";
import { BRIEF_HEADER } from "../../src/lib/campaign-brief.js";

export const THREADS_POST_OUTCOME = "post_published";
export const THREADS_POST_DYNASTY = "dy_threads_thread";
export const THREADS_POST_TACTICS = { channel: THREADS_POST_FEATURE_SLUG, recorded_by: "meta" };

/** GATHER_CLIENT_FACTS_CODE is a helper + a `main`: the helper keeps its name, the main becomes `gatherFacts`. */
function gatherFactsFunctions(): string {
  const code = GATHER_CLIENT_FACTS_CODE.replace("async function gatherFacts(", "function gatherFactsWith(").replace("return gatherFacts(null,", "return gatherFactsWith(null,");
  return asFunction(code, "gatherFacts");
}

export function buildThreadsPostSource(): string {
  const plan = asFunction(PLAN_RUN_CODE.replace("const now = new Date();", "const now = new Date(__now);"), "planRun").replace("function planRun(", "function planRun(__now, ");
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** Threads post (post_published): one thread per run on the brand's next Pro (AI) account, ported from the Threads workflow (MIGRATE-1105 S4). */`,
    `const BRIEF_HEADER = ${JSON.stringify(BRIEF_HEADER)};`,
    PORT_HEAD,
    plan,
    asFunction(CHECK_TURN_CODE, "checkTurn"),
    gatherFactsFunctions(),
    asFunction(COMPOSE_ANGLES_CODE, "composeAngles"),
    asFunction(PLAN_OWN_SITE_CODE, "planOwnSite"),
    asFunction(COMPOSE_PICK_PAGES_CODE, "composePickPages"),
    asFunction(PLAN_OWN_PAGES_CODE, "planOwnPages"),
    asFunction(COMPOSE_OWN_FIGURES_CODE, "composeOwnFigures"),
    asFunction(COMPOSE_WRITE_CODE, "composeWrite"),
    asFunction(THREAD_WRITER_PLAN_CODE, "writerPlan"),
    asFunction(FINAL_THREAD_CODE, "finalThread"),
    asFunction(CLASSIFY_MAIN_CODE, "classifyMain"),
    `
const LLM = ${JSON.stringify(THREADS_ANGLES_LLM)};
const FEATURE = ${JSON.stringify(THREADS_POST_FEATURE_SLUG)};
const OWN_PAGES_SCHEMA = ${JSON.stringify(OWN_PAGES_SCHEMA)};

export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const brief = typeof R.brief === "string" ? R.brief.trim() : "";
  const campaignId = typeof R.campaignId === "string" ? R.campaignId : null;
  const p = planRun(R.now, false, campaignId, (Array.isArray(R.brandIds) && R.brandIds.length ? R.brandIds.join(",") : ctx.brand), null, R);
  const accounts = must(ctx, "meta.threads.accounts", { query: p.accountsQuery });
  const posts = must(ctx, "meta.threads.publications", { query: p.postsQuery });
  const turn = checkTurn(p, accounts, posts);
  if (turn.proceed !== true) return null;

  const brand = must(ctx, "brand.profile", { params: { id: p.brandId } });
  const offerAnswers = must(ctx, "brand.offer.answers", { params: { brandId: p.brandId, offerId: p.offerId } });
  const offerFields = must(ctx, "brand.offer.fields", { params: { brandId: p.brandId, offerId: p.offerId } });
  const brandFields = tolerated(ctx, "brand.fields", { params: { brandId: p.brandId } });
  const facts = gatherFacts(offerAnswers, offerFields, brandFields);

  const a = composeAngles(brand, facts, p);
  const angles = tolerated(ctx, "llm.complete", withBrief({ provider: LLM.provider, model: LLM.model, webSearch: true, maxTokens: 4000, message: a.message, systemPrompt: a.systemPrompt }, brief));

  const site = planOwnSite(brand, p);
  const map = tolerated(ctx, "scraping.site.map", { body: { featureSlug: FEATURE, url: site.url, brandIds: site.brandIds, campaignId } });
  const offered = composePickPages(site, map, p);
  const pick = (offered.count ?? 0) === 0
    ? { ok: false, notCalled: true }
    : tolerated(ctx, "llm.complete", withBrief({ provider: LLM.provider, model: LLM.model, responseFormat: "json", responseSchema: OWN_PAGES_SCHEMA, maxTokens: 2000, message: offered.message, systemPrompt: offered.systemPrompt }, brief));
  const pages = planOwnPages(pick, offered);
  const scraped: any[] = [];
  for (const url of [pages.url1, pages.url2, pages.url3, pages.url4]) {
    if (scraped.length >= (pages.count ?? 0)) { scraped.push(null); continue; }
    scraped.push(tolerated(ctx, "scraping.page", { body: { enrich: false, featureSlug: FEATURE, url, brandIds: site.brandIds, campaignId } }));
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
      featureSlug: FEATURE,
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
  const thread = finalThread(draft, write, p, turn);

  const main = tolerated(ctx, "meta.threads.publish", { params: { id: thread.accountId }, body: { text: thread.post, idempotencyKey: thread.keys.main } });
  const published = classifyMain(main, thread);
  if (published.outcome === "account_dead") return null;
  let parent = published.postId;
  for (const n of [1, 2, 3]) {
    if (thread.replyCount < n) break;
    const reply = must(ctx, "meta.threads.publish", {
      params: { id: thread.accountId },
      body: { text: thread["reply" + n], replyToPostId: parent, idempotencyKey: thread.keys["reply" + n] },
    });
    parent = reply.postId;
  }
  return { content: { end: { success: true, stopCampaign: false } } };
}
`,
  ].join("\n");
}
