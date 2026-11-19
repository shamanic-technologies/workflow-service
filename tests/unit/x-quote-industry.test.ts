import { describe, it, expect } from "vitest";
import { transformSync } from "esbuild";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { SERVICE_DOOR_VENDORS } from "../../src/lib/scripts/vendors.js";
import {
  buildIndustryNewsV2Source,
  buildXIndustryAccountsSource,
  buildXQuoteIndustryPostSource,
  INDUSTRY_NEWS_V2,
  X_INDUSTRY_ACCOUNTS,
  X_QUOTE_INDUSTRY_POST,
} from "../../scripts/engine-ports/x-quote-industry.js";
import { buildIndustryNewsSource } from "../../scripts/engine-ports/industry-news.js";

// X-QUOTE-INDUSTRY-1117: find the industry's X accounts, read their posts in the watch, quote the best post by link.
const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const completion = (json: Record<string, unknown>) => ({ answer: { content: JSON.stringify(json), json }, llm: { provider: "anthropic", model: "claude-sonnet", name: "Claude Sonnet" } });

describe("X account found: the industry accounts script", () => {
  const src = buildXIndustryAccountsSource();
  const request = { now: "2026-11-17T09:00:00.000Z", brandIds: ["brand-1"] };

  it("asks a model (never names one) and never names its outcome; social-service finds, keeps and declares", async () => {
    expect((await validateSource(src)).materials).toEqual(["llm_completion"]);
    expect(src).not.toMatch(/"x_account_found"/);
    expect(src).not.toMatch(/provider:\s*"|model:\s*"/);
    expect(X_INDUSTRY_ACCOUNTS.tactics).toMatchObject({ audience: "industry", recorded_by: "social", asks: ["llm_completion"] });
    expect(SERVICE_DOOR_VENDORS["social.x.accounts.find"]).toMatchObject({ service: "social", asRun: true, outcomeInBody: "outcomeKey" });
    expect(SERVICE_DOOR_VENDORS["social.x.accounts.found"]).toMatchObject({ service: "social", method: "GET", asRun: true });
  });

  it("hands social-service the handles and phrases the model named, and answers the accounts it kept", async () => {
    const c: ReplayCase = {
      id: "found",
      units: { llm_completion: completion({ handles: [{ handle: "@sirensmall", why: "small caps" }, { handle: "https://x.com/MicroCapClub", why: "club" }, { handle: "!!bad", why: "x" }], queries: ["small cap research", "microcap"] }) },
      request,
      tactics: X_INDUSTRY_ACCOUNTS.tactics,
      calls: [
        { name: "brand.profile", args: { params: { id: "brand-1" } }, answer: ok({ brand: { name: "Dualis", domain: "dualisresearch.com" } }) },
        { name: "brand.fields", answer: ok({ fields: { industry: { value: "Equity research", provenance: "confirmed" } } }) },
        {
          name: "social.x.accounts.find",
          args: { body: { purpose: "industry", handles: ["sirensmall", "MicroCapClub"], queries: ["small cap research", "microcap"], idempotencyKey: "x-accounts:industry:2026-11-17" } },
          answer: ok({ search: { id: "s" }, accounts: [{ handle: "MicroCapClub", name: "MicroCapClub", followers: 90000, whyKept: "club" }], created: true }),
        },
      ],
      expect: { content: { audience: "industry", queries: ["small cap research", "microcap"], accounts: [{ handle: "MicroCapClub", name: "MicroCapClub", followers: 90000, why: "club" }] } },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("is unmade when social-service kept nothing new", async () => {
    const c: ReplayCase = {
      id: "none",
      units: { llm_completion: completion({ handles: [{ handle: "a", why: "b" }], queries: [] }) },
      request,
      tactics: X_INDUSTRY_ACCOUNTS.tactics,
      calls: [
        { name: "brand.profile", answer: ok({ name: "Dualis" }) },
        { name: "brand.fields", answer: ok({ fields: {} }) },
        { name: "social.x.accounts.find", answer: ok({ accounts: [] }) },
      ],
      expect: { fails: "no_new_account: social-service kept no new X account for the brand's industry (1 named, 0 phrases)" },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });
});

describe("Industry news found v2: the watch reads the accounts found", () => {
  const src = buildIndustryNewsV2Source();
  const request = { now: "2026-11-17T09:00:00.000Z" };
  const post = { id: "i1", title: "@MicroCapClub: margins", url: "https://x.com/MicroCapClub/status/123456", source: "x", sources: ["X/@MicroCapClub"], author: "MicroCapClub", publishedAt: "2026-11-17T08:00:00.000Z", whyItMatters: "From an industry account.", text: "Margins are turning.", postId: "123456", engagement: "40♥ 5rt 3c", score: 61 };
  const view = { ...post };

  it("is v1's code plus the accounts read (an upgrade of the same dynasty), asking X account found itself", async () => {
    expect((await validateSource(src)).materials).toEqual(["x_account_found"]);
    expect(src).toContain(buildIndustryNewsSource().split("export default function run")[1]!.split("const scan =")[0]!);
    expect(INDUSTRY_NEWS_V2.dynasty).toBe("dy_industry_news_watch");
    expect(INDUSTRY_NEWS_V2.tactics.asks).toEqual(["x_account_found"]);
  });

  it("passes the accounts held for the brand to the scan and returns their posts", async () => {
    const c: ReplayCase = {
      id: "held",
      units: {},
      request,
      tactics: INDUSTRY_NEWS_V2.tactics,
      calls: [
        { name: "social.x.accounts.found", args: { query: { brandId: "replay", purpose: "industry" } }, answer: ok({ accounts: [{ handle: "MicroCapClub" }, { handle: "sirensmall" }] }) },
        { name: "social.news.scan", args: { body: { hours: 36, idempotencyKey: "industry-news:2026-11-17", xHandles: ["MicroCapClub", "sirensmall"] } }, answer: ok({ scan: { id: "s" }, items: [post], created: true }) },
      ],
      expect: { content: { scanned: true, items: [view] } },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("asks X account found when the brand holds none, and scans as before when it found nobody", async () => {
    const asked: ReplayCase = {
      id: "asked",
      units: { x_account_found: { audience: "industry", queries: ["small cap research"], accounts: [{ handle: "MicroCapClub" }] } },
      request,
      tactics: INDUSTRY_NEWS_V2.tactics,
      calls: [
        { name: "social.x.accounts.found", answer: ok({ accounts: [] }) },
        { name: "social.news.scan", args: { body: { hours: 36, idempotencyKey: "industry-news:2026-11-17", xHandles: ["MicroCapClub"], topics: ["small cap research"] } }, answer: ok({ scan: { id: "s" }, items: [post], created: true }) },
      ],
      expect: { content: { scanned: true, items: [view] } },
    };
    expect((await replayCase(src, asked)).diffs).toEqual([]);
  });
});

describe("X post published: the quote script", () => {
  const src = buildXQuoteIndustryPostSource();
  const now = "2026-11-17T15:30:00.000Z";
  const request = { now, campaignId: "camp-1", offerId: "offer-1", brandIds: ["brand-1"], brief: "Write for small cap investors." };
  const acc = { id: "x-1", username: "sirensmallcaps", accountType: "pro_ai", accountTypeLabel: "Pro (AI)", health: "connected", publishable: true, notPublishableReason: null, createdAt: "2026-11-16T00:00:00Z" };
  const item = (id: string, score: number) => ({ id: "i" + id, title: "t" + id, url: `https://x.com/MicroCapClub/status/${id}`, source: "x", sources: ["X/@MicroCapClub"], author: "MicroCapClub", publishedAt: "2026-11-17T08:00:00.000Z", whyItMatters: "", postId: id, text: "Post " + id, engagement: "10♥", score });
  const brandCalls = [
    { name: "brand.profile", answer: ok({ brand: { name: "Dualis", domain: "dualisresearch.com" } }) },
    { name: "brand.offer.answers", answer: ok({ answers: [{ question: "What do you sell?", answer: "Independent research on small caps" }] }) },
    { name: "brand.offer.fields", answer: ok({ fields: {} }) },
    { name: "brand.fields", answer: ok({ fields: {} }) },
  ];

  it("asks the watch and a model, never names a model nor its outcome, never uploads media nor quote_tweet_id", async () => {
    expect((await validateSource(src)).materials.sort()).toEqual(["industry_news_found", "llm_completion"]);
    expect(src).not.toMatch(/"x_post_published"|quote_tweet_id|media/i);
    expect(X_QUOTE_INDUSTRY_POST.tactics).toMatchObject({ network: "x", channel: "x-post", asks: ["industry_news_found", "llm_completion"], post: "quotes an industry post" });
  });

  it("publishes the take with the best post's URL as the last line, skipping a post the brand already quoted", async () => {
    const c: ReplayCase = {
      id: "quote",
      units: {
        industry_news_found: { scanned: true, items: [item("111111", 90), item("222222", 50), { ...item("333333", 99), source: "news", url: "https://news.example.com/a" }, { ...item("444444", 98), sources: ["X"] }] },
        llm_completion: completion({ take: "Margins turning at the small end — the cycle is moving. https://spam.example @someone" }),
      },
      request,
      tactics: X_QUOTE_INDUSTRY_POST.tactics,
      calls: [
        { name: "social.accounts", args: { query: { brandId: "brand-1", network: "x" } }, answer: ok({ accounts: [acc] }) },
        // 111111 was quoted 5 days ago: never again.
        { name: "social.publications", answer: ok({ publications: [{ id: "p", accountId: "x-1", publishedAt: "2026-11-12T10:00:00.000Z", text: "Old take\n\nhttps://x.com/MicroCapClub/status/111111" }] }) },
        ...brandCalls,
        {
          name: "social.publish",
          args: { params: { id: "x-1" }, body: { text: "Margins turning at the small end, the cycle is moving. someone\n\nhttps://x.com/MicroCapClub/status/222222", idempotencyKey: "x-quote:camp-1:222222" } },
          answer: ok({ publication: { id: "row" }, created: true }),
        },
      ],
      expect: { content: { end: { success: true, stopCampaign: false }, quoted: "https://x.com/MicroCapClub/status/222222" } },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  // MON-SCRIPTS-WATCHING-1119: X refused 14 takes in 2 days (281 to 342 weighted chars), each run failed. The stored
  // script's own functions, lifted out of its source.
  const finalText = (() => {
    const from = src.indexOf("function xWeight");
    const to = src.indexOf("export default function run");
    const js = transformSync(src.slice(from, to), { loader: "ts" }).code;
    return new Function(js + "\nreturn finalText;")() as (take: string, url: string) => string;
  })();
  const URL = "https://x.com/MicroCapClub/status/222222";
  const publishOf = async (take: string) => finalText(take, URL);
  const weight = (t: string) => {
    let n = 0;
    const rest = t.replace(/https?:\/\/\S+/g, () => { n += 23; return ""; });
    for (const ch of rest) { const cp = ch.codePointAt(0)!; n += cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2; }
    return n;
  };

  it("a take too long for X keeps its whole first sentences and fits 280 with the link", async () => {
    const take = "Small caps are where the next cycle starts. " + "Funds are crowding into the same ten names while real growth sits below them. ".repeat(4) + "That gap is the opportunity 🚀.";
    const text = await publishOf(take);
    expect(text.startsWith("Small caps are where the next cycle starts.")).toBe(true);
    expect(text.endsWith("\n\n" + URL)).toBe(true);
    expect(text).not.toContain("opportunity");
    expect(weight(text)).toBeLessThanOrEqual(280);
  });

  it("one sentence too long for X ends on a whole word", async () => {
    const text = await publishOf("word ".repeat(80).trim());
    expect(weight(text)).toBeLessThanOrEqual(280);
    expect(text).toMatch(/word\.\.\.\n\nhttps:/);
  });

  it("emoji weigh 2 on X: a take under 255 characters but over its weight is cut", async () => {
    const text = await publishOf("Growth is here. " + "🚀".repeat(130));
    expect(text).toBe("Growth is here.\n\n" + URL);
  });

  it("a take that fits is published as written", async () => {
    expect(await publishOf("Margins turn at the small end first.")).toBe("Margins turn at the small end first.\n\nhttps://x.com/MicroCapClub/status/222222");
  });

  it("is unmade when every X post of the day was already quoted by the brand", async () => {
    const c: ReplayCase = {
      id: "all-quoted",
      units: { industry_news_found: { scanned: false, items: [item("111111", 90)] } },
      request,
      tactics: X_QUOTE_INDUSTRY_POST.tactics,
      calls: [
        { name: "social.accounts", answer: ok({ accounts: [acc] }) },
        { name: "social.publications", answer: ok({ publications: [{ id: "p", accountId: "x-1", publishedAt: "2026-11-12T10:00:00.000Z", text: "t\n\nhttps://x.com/MicroCapClub/status/111111" }] }) },
      ],
      expect: { fails: "no_quotable_post: the watch kept no post of the industry's X accounts today that the brand has not quoted yet" },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  // X-QUOTE-ANY-HOUR-1117: the hours it posts are its tactic, any hour for this version.
  it("posts at any hour: at 03:00 UTC it goes past the turn check and asks the watch", async () => {
    expect(X_QUOTE_INDUSTRY_POST.tactics.publishHoursUtc).toEqual([0, 24]);
    const c: ReplayCase = {
      id: "night",
      units: { industry_news_found: { scanned: false, items: [] } },
      request: { ...request, now: "2026-11-17T03:00:00.000Z" },
      tactics: X_QUOTE_INDUSTRY_POST.tactics,
      calls: [
        { name: "social.accounts", answer: ok({ accounts: [acc] }) },
        { name: "social.publications", answer: ok({ publications: [] }) },
      ],
      expect: { fails: "no_quotable_post: the watch kept no post of the industry's X accounts today that the brand has not quoted yet" },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("ends idle outside the hours its tactic states, and refuses a run whose tactic states none", async () => {
    const calls = [
      { name: "social.accounts", answer: ok({ accounts: [acc] }) },
      { name: "social.publications", answer: ok({ publications: [] }) },
    ];
    const idle: ReplayCase = { id: "out", units: {}, request: { ...request, now: "2026-11-17T03:00:00.000Z" }, tactics: { ...X_QUOTE_INDUSTRY_POST.tactics, publishHoursUtc: [13, 21] }, calls, expect: { nothing: true } };
    expect((await replayCase(src, idle)).diffs).toEqual([]);
    const { publishHoursUtc: _drop, ...noHours } = X_QUOTE_INDUSTRY_POST.tactics;
    const refused: ReplayCase = { id: "none", units: {}, request, tactics: noHours, calls: [], expect: { fails: "tactic publishHoursUtc must be [from, to) UTC hours, got undefined" } };
    expect((await replayCase(src, refused)).diffs).toEqual([]);
  });

  it("forwards the watch's unmade answer", async () => {
    const c: ReplayCase = {
      id: "no-news",
      units: { industry_news_found: { scanned: false, items: [] } },
      request,
      tactics: X_QUOTE_INDUSTRY_POST.tactics,
      calls: [
        { name: "social.accounts", answer: ok({ accounts: [acc] }) },
        { name: "social.publications", answer: ok({ publications: [] }) },
      ],
      expect: { fails: "no_quotable_post: the watch kept no post of the industry's X accounts today that the brand has not quoted yet" },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });
});
