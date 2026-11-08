import { describe, it, expect } from "vitest";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { SERVICE_DOOR_VENDORS } from "../../src/lib/scripts/vendors.js";
import { buildIndustryNewsSource, INDUSTRY_NEWS } from "../../scripts/engine-ports/industry-news.js";

// INDUSTRY-NEWS-ENGINE-1108: the industry news Engine's script, social-service keeping and declaring the Units.
const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const src = buildIndustryNewsSource();
const now = "2026-11-08T09:00:00.000Z";
const request = { now, campaignId: "camp-1" };
const item = { id: "i1", title: "@jdoe: Lemlist changed its pricing", url: "https://x.com/jdoe/status/1", source: "x", author: "jdoe", publishedAt: "2026-11-08T08:00:00.000Z", whyItMatters: "Names Lemlist.", text: "long", score: 4.2 };
const view = { id: "i1", title: item.title, url: item.url, source: "x", author: "jdoe", publishedAt: item.publishedAt, whyItMatters: "Names Lemlist." };

describe("the industry news script", () => {
  it("is a valid script needing no material; its doors are social-service's, the scan declaring the Engine's outcome", async () => {
    expect((await validateSource(src)).materials).toEqual([]);
    expect(SERVICE_DOOR_VENDORS["social.news.scan"]).toMatchObject({ service: "social", method: "POST", path: "/orgs/social/industry-news/scans", asRun: true, outcomeInBody: "outcomeKey" });
    expect(SERVICE_DOOR_VENDORS["social.news.items"]).toMatchObject({ service: "social", method: "GET", path: "/orgs/social/industry-news", asRun: true });
    expect(src).not.toMatch(/"industry_news_found"/); // the script never names its outcome
    expect(INDUSTRY_NEWS.tactics.recorded_by).toBe("social");
  });

  it("scans once for the day and answers the kept items", async () => {
    const c: ReplayCase = {
      id: "kept",
      units: {},
      request,
      tactics: INDUSTRY_NEWS.tactics,
      calls: [
        {
          name: "social.news.scan",
          args: { body: { hours: 36, idempotencyKey: "industry-news:2026-11-08" } },
          answer: ok({ scan: { id: "s", newCount: 1, sourcesOk: ["X:20"] }, items: [item], created: true }),
        },
      ],
      expect: { content: { scanned: true, items: [view] } },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("serves today's items again without a second scan, and is unmade when nothing was kept", async () => {
    const again: ReplayCase = {
      id: "again",
      units: {},
      request,
      tactics: INDUSTRY_NEWS.tactics,
      calls: [{ name: "social.news.scan", answer: ok({ scan: { id: "s", newCount: 1 }, items: [item], created: false }) }],
      expect: { content: { scanned: false, items: [view] } },
    };
    expect((await replayCase(src, again)).diffs).toEqual([]);
    const none: ReplayCase = {
      id: "none",
      units: {},
      request,
      tactics: INDUSTRY_NEWS.tactics,
      calls: [{ name: "social.news.scan", answer: ok({ scan: { id: "s", newCount: 0, sourcesOk: ["HN:3", "X:0"] }, items: [], created: true }) }],
      expect: { fails: "no_new_item: the watch kept nothing new for the brand today (read HN:3, X:0)" },
    };
    expect((await replayCase(src, none)).diffs).toEqual([]);
  });

  it("fails loud when the scan is refused (a spend over the campaign's budget)", async () => {
    const c: ReplayCase = {
      id: "refused",
      units: {},
      request,
      tactics: INDUSTRY_NEWS.tactics,
      calls: [{ name: "social.news.scan", answer: { ok: false, data: { status: 402, error: "Sales funnel max budget reached" } } }],
      expect: { fails: "social.news.scan failed (402): Sales funnel max budget reached" },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });
});
