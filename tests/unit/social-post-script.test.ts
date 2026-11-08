import { describe, it, expect } from "vitest";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { SERVICE_DOOR_VENDORS } from "../../src/lib/scripts/vendors.js";
import { buildSocialPostSource, SOCIAL_POSTS } from "../../scripts/engine-ports/social-post.js";

// SOCIAL-POSTS-ENGINES-1107: ONE code, two dynasties (x_post_published, linkedin_post_published), the network a tactic.
const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const src = buildSocialPostSource();
const now = "2026-11-07T15:30:00.000Z";
const request = { now, campaignId: "camp-1", offerId: "offer-1", brief: "Write for founders." };
const since = "2026-10-08T15:30:00.000Z";
const acc = (id: string, username: string, extra: Record<string, unknown> = {}) => ({ id, username, accountType: "pro_ai", accountTypeLabel: "Pro (AI)", health: "connected", publishable: true, notPublishableReason: null, createdAt: "2026-10-30T00:00:00Z", ...extra });

describe("the X / LinkedIn post script", () => {
  it("is a valid script whose one material it ASKS for itself (industry news); its doors are social-service's, the publish declaring the Engine's outcome", async () => {
    expect((await validateSource(src)).materials).toEqual(["industry_news_found"]);
    expect(SERVICE_DOOR_VENDORS["social.publish"]).toMatchObject({ service: "social", path: "/orgs/social/accounts/{id}/posts", outcomeInBody: "outcomeKey" });
    expect(SOCIAL_POSTS.x.tactics.network).toBe("x");
    expect(SOCIAL_POSTS.linkedin.tactics.network).toBe("linkedin");
    expect(src).not.toMatch(/"x_post_published"|"linkedin_post_published"/); // the script never names its outcome
  });

  it("ends unmade, naming every account, when the brand has none software may post on (never a personal profile)", async () => {
    const c: ReplayCase = {
      id: "no-account",
      units: {},
      request,
      tactics: SOCIAL_POSTS.linkedin.tactics,
      calls: [
        { name: "social.accounts", args: { query: { brandId: "replay", network: "linkedin" } }, answer: ok({ accounts: [
          acc("li-page", "Distribute.you", { publishable: false, notPublishableReason: "linkedin_page_not_publishable: needs w_organization_social" }),
          acc("li-me", "Kevin Lourd", { accountType: "personal_human", accountTypeLabel: "Personal (human)", publishable: false, notPublishableReason: "account_not_pro_ai: typed Personal (human)" }),
        ] }) },
        { name: "social.publications", args: { query: { brandId: "replay", network: "linkedin", since, limit: "1000" } }, answer: ok({ publications: [] }) },
      ],
      expect: { fails: "no_publishable_account: no linkedin account of the brand may be posted on by software: Distribute.you (linkedin_page_not_publishable: needs w_organization_social); Kevin Lourd (account_not_pro_ai: typed Personal (human))" },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("ends idle when the brand posted on that network less than an hour ago", async () => {
    const c: ReplayCase = {
      id: "idle",
      units: {},
      request,
      tactics: SOCIAL_POSTS.x.tactics,
      calls: [
        { name: "social.accounts", answer: ok({ accounts: [acc("x-1", "DistributeYou")] }) },
        { name: "social.publications", answer: ok({ publications: [{ id: "p", accountId: "x-1", kind: "post", publishedAt: "2026-11-07T15:00:00.000Z", text: "t" }] }) },
      ],
      expect: { nothing: true },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("writes with the picked template + LLM and publishes ONE post on the account whose last post is oldest", async () => {
    const c: ReplayCase = {
      id: "published",
      units: { industry_news_found: { scanned: true, items: [] } },
      request,
      tactics: SOCIAL_POSTS.x.tactics,
      calls: [
        { name: "social.accounts", answer: ok({ accounts: [acc("x-1", "KevinLourd"), acc("x-2", "DistributeYou")] }) },
        { name: "social.publications", answer: ok({ publications: [{ id: "p", accountId: "x-1", kind: "post", publishedAt: "2026-11-07T10:00:00.000Z", text: "earlier" }] }) },
        { name: "brand.profile", args: { params: { id: "replay" } }, answer: ok({ brand: { name: "Brand", domain: "brand.com" } }) },
        { name: "brand.offer.answers", answer: ok({ answers: [] }) },
        { name: "brand.offer.fields", answer: ok({ fields: [] }) },
        { name: "brand.fields", answer: ok({ fields: [] }) },
        { name: "llm.complete", answer: ok({ content: "angle" }) },
        { name: "scraping.site.map", answer: { ok: false, data: { error: "down", status: 502 } } },
        { name: "features.writer_pick", args: { query: { campaignId: "camp-1" } }, answer: ok({ template: { templateDynastySlug: "x-tpl" }, llm: { model: "sonnet", provider: "anthropic" } }) },
        { name: "content.template_head", args: { params: { slug: "x-tpl" } }, answer: ok({ template: { type: "x-tpl-v1" } }) },
        { name: "content.thread.generate", answer: ok({ subject: "s", post: "One idea — told plainly", replies: [] }) },
        { name: "social.publish", args: { params: { id: "x-2" }, body: { text: "One idea, told plainly\n\nGet started: brand.com", idempotencyKey: `x-post:camp-1:${now}` } }, answer: ok({ publication: { id: "row" }, created: true }) },
      ],
      expect: { content: { end: { success: true, stopCampaign: false } } },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("asks the Industry news found Engine inside its run and hands the watch's items to the angle reader (INDUSTRY-NEWS-ENGINE-1108)", async () => {
    const news = { scanned: true, items: [{ id: "n1", title: "@jdoe: Lemlist changed its pricing", url: "https://x.com/jdoe/status/1", source: "x", whyItMatters: "Names Lemlist." }] };
    const c: ReplayCase = {
      id: "with-news",
      units: { industry_news_found: news },
      request,
      tactics: SOCIAL_POSTS.x.tactics,
      calls: [
        { name: "social.accounts", answer: ok({ accounts: [acc("x-2", "DistributeYou")] }) },
        { name: "social.publications", answer: ok({ publications: [] }) },
        { name: "brand.profile", answer: ok({ brand: { name: "Brand", domain: "brand.com" } }) },
        { name: "brand.offer.answers", answer: ok({ answers: [] }) },
        { name: "brand.offer.fields", answer: ok({ fields: [] }) },
        { name: "brand.fields", answer: ok({ fields: [] }) },
        { name: "llm.complete", answer: ok({ content: "angle" }) },
        { name: "scraping.site.map", answer: { ok: false, data: { error: "down", status: 502 } } },
        { name: "features.writer_pick", answer: ok({ template: { templateDynastySlug: "x-tpl" }, llm: { model: "sonnet", provider: "anthropic" } }) },
        { name: "content.template_head", answer: ok({ template: { type: "x-tpl-v1" } }) },
        { name: "content.thread.generate", answer: ok({ subject: "s", post: "One idea", replies: [] }) },
        { name: "social.publish", answer: ok({ publication: { id: "row" }, created: true }) },
      ],
      expect: { content: { end: { success: true, stopCampaign: false } } },
    };
    const r = await replayCase(src, c);
    expect(r.diffs).toEqual([]);
    expect(src).toContain('ctx.get("industry_news_found")');
    expect(SOCIAL_POSTS.x.tactics.asks).toEqual(["industry_news_found"]);
    expect(SOCIAL_POSTS.linkedin.tactics.asks).toEqual(["industry_news_found"]);
  });

  it("refuses a script stored without a network tactic", async () => {
    const r = await replayCase(src, { id: "no-network", units: {}, request, tactics: {}, calls: [], expect: { fails: "the script's tactic network must be x or linkedin" } });
    expect(r.match || r.diffs.join(" ").includes("tactic network")).toBe(true);
  });
});
