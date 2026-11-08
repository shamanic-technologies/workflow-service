/**
 * INDUSTRY-NEWS-ENGINE-1108 (owner 2026-11-08: « Précis dans le WHAT pour le naming, mais pas dans le comment, qui doit
 * être des tactiques »): the industry news Engine (`industry_news_found` « Industry news found »). One run = at most one
 * scan a day of the industry's fresh news for the run's brand, through social-service's door `social.news.scan`:
 * social-service reads the sources, holds + actualizes their spend on its run under this script's, keeps every item new
 * for the brand and declares one Unit per kept item under this Engine's outcome (the door fills `outcomeKey`).
 *
 * The HOW lives in the tactics, never in the outcome: `hours` (how far back the sources are read), `sources`,
 * `ranking` (what the scan keeps), `recorded_by` social (social-service declares the Units). The day's idempotency key
 * makes a second run the same day answer the completed scan again: no second spend.
 *
 * Asked by the X / LinkedIn post scripts inside their own run (`ctx.ask` then `ctx.get("industry_news_found")`): this run is
 * a CHILD of the post run, so the scan's spend and its Units land on the post's campaign through the run tree.
 * Answers: `{content: {scanned, items}}` = today's kept items (`scanned` false = another run paid today's scan: served
 * from the watch, no second spend); `unmade "no_new_item: ..."` = nothing kept today; a throw = the run failed.
 */
import { PORT_HEAD } from "./port-kit.js";

export const INDUSTRY_NEWS = {
  outcome: "industry_news_found",
  dynasty: "dy_industry_news_watch",
  tactics: {
    recorded_by: "social",
    hours: 36,
    sources: "Hacker News, Google News, Clay and Gmail blogs, X search, LinkedIn post search, Reddit (r/coldemail, r/sales, r/SaaS, r/Emailmarketing, r/coldemailing)",
    ranking: "names a watched company or a core B2B sales topic; scored on competitors, topics and reactions; same story told twice kept once; best 4 per source family, top 40",
  },
  description:
    "Reads the brand's industry news of the last day and a half once a day (the press, X, LinkedIn, Reddit, Hacker News) and keeps every new item that names a watched company or a core topic, ranked by relevance and reactions.",
} as const;

export function buildIndustryNewsSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** Industry news found: one scan a day for the run's brand, each new item kept as one Unit by social-service (INDUSTRY-NEWS-ENGINE-1108). */`,
    PORT_HEAD,
    `
export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const now = typeof R.now === "string" ? R.now : "";
  const day = now.slice(0, 10);
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(day)) throw new Error("industry-news: the run states no clock (request.now): " + JSON.stringify(R.now));
  const t: any = ctx.tactics ?? {};
  const hours = Number.isInteger(t.hours) && t.hours > 0 && t.hours <= 168 ? t.hours : 36;
  const scan = must(ctx, "social.news.scan", { body: { hours, idempotencyKey: "industry-news:" + day } });
  // Today's scan already ran (another run paid it): social-service answers that scan and its kept items again, no second spend.
  const items = Array.isArray(scan.items) ? scan.items : [];
  if (!items.length) {
    const seen = Array.isArray(scan.scan?.sourcesOk) ? scan.scan.sourcesOk.join(", ") : "";
    return { unmade: "no_new_item: the watch kept nothing new for the brand today" + (seen ? " (read " + seen + ")" : "") };
  }
  const view = items.map((i: any) => ({ id: i.id, title: i.title, url: i.url, source: i.source, author: i.author ?? null, publishedAt: i.publishedAt ?? null, whyItMatters: i.whyItMatters ?? "" }));
  return { content: { scanned: scan.created === true, items: view } };
}
`,
  ].join("\n");
}
