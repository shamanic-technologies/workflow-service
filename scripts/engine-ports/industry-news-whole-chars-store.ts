/**
 * MON-XPOST-SCRIPT-1126-WF: prints the ONE catalogue write that upgrades industry_news_found/dy_industry_news_watch
 * to a version cutting the post text on a whole character (no half emoji). Pipe it into the container's poster:
 *   npx tsx scripts/engine-ports/industry-news-whole-chars-store.ts | ssh box "docker exec -i -e ... <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 * Already upgraded (the stored code holds the new cut) = skipped.
 */
import { INDUSTRY_NEWS_V2, INDUSTRY_NEWS_WHOLE_CHARS_EDIT } from "./x-quote-industry.js";

const e = INDUSTRY_NEWS_WHOLE_CHARS_EDIT;
console.log(
  JSON.stringify({
    op: "replace",
    outcome: INDUSTRY_NEWS_V2.outcome,
    dynastyPrefix: INDUSTRY_NEWS_V2.dynasty,
    dynasty: INDUSTRY_NEWS_V2.dynasty,
    from: e.from,
    to: e.to,
    skipIfIncludes: "charCodeAt(t.length - 1)",
  }),
);
