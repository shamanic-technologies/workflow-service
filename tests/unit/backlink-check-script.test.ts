import { describe, it, expect } from "vitest";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { SERVICE_DOOR_VENDORS } from "../../src/lib/scripts/vendors.js";
import { buildBacklinkCheckSource, BACKLINK_CHECK } from "../../scripts/engine-ports/backlink.js";

// BACKLINK-ENGINE-1109: the Backlink Engine's first script, scraping-service verifying, keeping and declaring the Units.
const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const src = buildBacklinkCheckSource();
const now = "2026-11-09T09:00:00.000Z";
const request = { now, campaignId: "camp-1" };
const link = { id: "l1", referringDomain: "toolradar.com", referringUrl: "https://toolradar.com/tools/distribute-you", targetUrl: "https://distribute.you/", domainRank: 412, firstSeenAt: "2026-11-06T00:00:00.000Z", extra: "dropped" };
const view = { id: "l1", referringDomain: "toolradar.com", referringUrl: link.referringUrl, targetUrl: link.targetUrl, domainRank: 412, firstSeenAt: link.firstSeenAt };

describe("the backlink check script", () => {
  it("is a valid script needing no material; its doors are scraping-service's, the check declaring the Engine's outcome", async () => {
    expect((await validateSource(src)).materials).toEqual([]);
    expect(SERVICE_DOOR_VENDORS["scraping.backlinks.check"]).toMatchObject({ service: "scraping", method: "POST", path: "/orgs/backlinks/checks", asRun: true, outcomeInBody: "outcomeKey" });
    expect(SERVICE_DOOR_VENDORS["scraping.backlinks.list"]).toMatchObject({ service: "scraping", method: "GET", path: "/orgs/backlinks", asRun: true });
    expect(SERVICE_DOOR_VENDORS["scraping.backlinks.link_gap"]).toMatchObject({ service: "scraping", method: "POST", path: "/orgs/backlinks/link-gaps", asRun: true });
    expect(src).not.toMatch(/"backlink_earned"/); // the script never names its outcome
    expect(BACKLINK_CHECK.tactics.recorded_by).toBe("scraping");
  });

  it("checks once for the day and answers the new links", async () => {
    const c: ReplayCase = {
      id: "kept",
      units: {},
      request,
      tactics: BACKLINK_CHECK.tactics,
      calls: [
        {
          name: "scraping.backlinks.check",
          args: { body: { windowDays: 60, idempotencyKey: "backlinks:2026-11-09" } },
          answer: ok({ checkId: "c", status: "new_links_kept", newLinks: [link], unitsDeclared: 1, rejected: [], replayed: false }),
        },
      ],
      expect: { content: { checked: true, links: [view] } },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("passes the provider tactic, and is unmade when nothing new was kept", async () => {
    const none: ReplayCase = {
      id: "none",
      units: {},
      request,
      tactics: { ...BACKLINK_CHECK.tactics, provider: "dataforseo" },
      calls: [
        {
          name: "scraping.backlinks.check",
          args: { body: { windowDays: 60, idempotencyKey: "backlinks:2026-11-09", provider: "dataforseo" } },
          answer: ok({ checkId: "c", status: "nothing_new", newLinks: [], unitsDeclared: 0, rejected: [{ referringDomain: "x.com" }, { referringDomain: "y.com" }], replayed: false }),
        },
      ],
      expect: { fails: "no_new_link: no new live link to the brand's site today (2 candidate links not live or not to the brand)" },
    };
    expect((await replayCase(src, none)).diffs).toEqual([]);
  });

  it("fails loud when the check is refused (a spend over the campaign's budget)", async () => {
    const c: ReplayCase = {
      id: "refused",
      units: {},
      request,
      tactics: BACKLINK_CHECK.tactics,
      calls: [{ name: "scraping.backlinks.check", answer: { ok: false, data: { status: 402, error: "Sales funnel max budget reached" } } }],
      expect: { fails: "scraping.backlinks.check failed (402): Sales funnel max budget reached" },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });
});
