/**
 * X-QUOTE-INDUSTRY-1117: prints the catalogue writes, one JSON line each, dry by construction: pipe them into the
 * container's poster (`scripts/post-catalogue-ops.mjs`), which applies each one idempotently.
 *   npx tsx scripts/engine-ports/x-quote-industry-store.ts | ssh box "docker exec -i -e ... <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 *
 * 1. create X account found / dy_x_industry_accounts (the industry's X accounts);
 * 2. create Industry news found / dy_industry_news_watch: already stored, so UPGRADED to v2 (reads the accounts found);
 * 3. create X post published / dy_x_quote_industry_post (quotes the best industry post) last: once runnable, a
 *    campaign whose strategy keeps it asks for the two above.
 */
import {
  buildIndustryNewsV2Source,
  buildXIndustryAccountsSource,
  buildXQuoteIndustryPostSource,
  INDUSTRY_NEWS_V2,
  X_INDUSTRY_ACCOUNTS,
  X_QUOTE_INDUSTRY_POST,
} from "./x-quote-industry.js";

const out = (o: unknown) => console.log(JSON.stringify(o));
const a = X_INDUSTRY_ACCOUNTS;
out({ op: "create", body: { outcome: a.outcome, dynasty: a.dynasty, name: a.name, code: buildXIndustryAccountsSource(), description: a.description, tactics: a.tactics } });
const w = INDUSTRY_NEWS_V2;
out({ op: "create", body: { outcome: w.outcome, dynasty: w.dynasty, code: buildIndustryNewsV2Source(), description: w.description, tactics: w.tactics } });
const q = X_QUOTE_INDUSTRY_POST;
out({ op: "create", body: { outcome: q.outcome, dynasty: q.dynasty, name: q.name, code: buildXQuoteIndustryPostSource(), description: q.description, tactics: q.tactics } });
