import { describe, it, expect } from "vitest";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { SERVICE_DOOR_VENDORS, writesToPerson } from "../../src/lib/scripts/vendors.js";
import {
  ANNOUNCES_QUESTION,
  buildClientPastEmployersSource,
  buildPressMailboxSource,
  CLIENT_PAST_EMPLOYERS,
  PRESS_MAILBOX,
  QUOTES_BRAND_QUESTION,
} from "../../scripts/engine-ports/brand-proof.js";

// BRAND-PROOF-LOGOS-1121: the proof a brand shows on its site, two Engines, one script each, for any brand.
const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const fail = (status: number, body: Record<string, unknown>) => ({ ok: false, data: { status, error: JSON.stringify(body), body } });
const request = { now: "2026-11-21T09:00:00.000Z", brandIds: ["brand-1"] };

describe("Client past employer found: the team and paying clients' past employers script", () => {
  const src = buildClientPastEmployersSource();
  const company = (domain: string | null, leadId: string, extra: Record<string, unknown> = {}) => ({
    companyKey: domain ? `domain:${domain}` : "name:x",
    companyId: null,
    name: domain ? domain.split(".")[0] : "Unknown Co",
    domain,
    logoUrl: null,
    linkedinUrl: null,
    clientCount: 1,
    currentForSome: false,
    clients: [{ leadId, title: "Head of Growth", startDate: "2019-01-01", endDate: "2021-06-01", current: false }],
    ...extra,
  });

  it("needs no material, no campaign, sends to nobody, never names its outcome; brand-service declares the Units", async () => {
    expect((await validateSource(src)).materials).toEqual([]);
    expect(writesToPerson(src)).toBe(false);
    expect(src).not.toMatch(/"client_past_employer_found"/);
    expect(CLIENT_PAST_EMPLOYERS.tactics.recorded_by).toBe("brand");
    // TEAM-PAST-EMPLOYERS-1125: the brand's own team counts beside its paying clients, said to the people who read it.
    expect(CLIENT_PAST_EMPLOYERS.name).toBe("Team and clients' past employers");
    expect(CLIENT_PAST_EMPLOYERS.description).toMatch(/team/);
    expect(CLIENT_PAST_EMPLOYERS.tactics.source).toMatch(/team and paying clients/);
    expect(SERVICE_DOOR_VENDORS["lead.client_past_employers"]).toMatchObject({ service: "lead", method: "POST", path: "/internal/brands/{brandId}/client-past-employers", asRun: true });
    expect(SERVICE_DOOR_VENDORS["brand.proof.employers.store"]).toMatchObject({ service: "brand", method: "PUT", path: "/orgs/brands/{brandId}/proof/employers", asRun: true, outcomeInBody: "outcomeKey" });
  });

  it("asks lead-service again while lookups remain, then stores every identifiable company with its trace", async () => {
    const google = company("google.com", "lead-1");
    const linked = company(null, "lead-2", { name: "Acme", linkedinUrl: "https://www.linkedin.com/company/acme" });
    const nameOnly = company(null, "lead-3");
    const c: ReplayCase = {
      id: "kept",
      units: {},
      request,
      tactics: CLIENT_PAST_EMPLOYERS.tactics,
      calls: [
        { name: "lead.client_past_employers", args: { params: { brandId: "brand-1" } }, answer: ok({ payingClients: 3, clientsWithHistory: 1, companies: [], lookups: { remaining: 2 } }) },
        { name: "lead.client_past_employers", args: { params: { brandId: "brand-1" } }, answer: ok({ payingClients: 3, clientsWithHistory: 3, companies: [google, linked, nameOnly], lookups: { remaining: 0 } }) },
        {
          name: "brand.proof.employers.store",
          args: {
            params: { brandId: "brand-1" },
            body: {
              employers: [
                { company: { domain: "google.com", linkedinUrl: null, name: "google" }, trace: [{ leadId: "lead-1", role: "Head of Growth" }] },
                { company: { domain: null, linkedinUrl: "https://www.linkedin.com/company/acme", name: "Acme" }, trace: [{ leadId: "lead-2", role: "Head of Growth" }] },
              ],
            },
          },
          answer: ok({
            units: [
              { index: 0, unitId: "u1", companyId: "c1", newUnit: true, unresolvedReason: null, notoriety: { status: "judged", score: 99 } },
              { index: 1, unitId: "u2", companyId: "c2", newUnit: false, unresolvedReason: null, notoriety: { status: "judged", score: 20 } },
            ],
          }),
        },
      ],
      expect: { content: { companies: 3, unidentified: 1, pendingNotoriety: 0, kept: [{ unitId: "u1", companyId: "c1", domain: "google.com", name: "google", clients: 1, notoriety: 99 }] } },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("is unmade with lead-service's reason when the brand has no paying client with a history", async () => {
    const c: ReplayCase = {
      id: "none",
      units: {},
      request,
      tactics: CLIENT_PAST_EMPLOYERS.tactics,
      calls: [{ name: "lead.client_past_employers", answer: ok({ payingClients: 0, clientsWithHistory: 0, reason: "no_paying_clients", companies: [], lookups: { remaining: 0 } }) }],
      expect: { fails: "no_employer: no_paying_clients (0 paying clients, 0 with a history)" },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("reads a failed notoriety judgment as stored (retried by the next store), and fails loud on any other refusal", async () => {
    const calls = (answer: unknown) => [
      { name: "lead.client_past_employers", answer: ok({ payingClients: 1, clientsWithHistory: 1, companies: [company("google.com", "lead-1")] }) },
      { name: "brand.proof.employers.store", answer },
    ];
    const pending: ReplayCase = {
      id: "pending",
      units: {},
      request,
      tactics: CLIENT_PAST_EMPLOYERS.tactics,
      calls: calls(fail(502, { error: "notoriety_unavailable" })),
      expect: { fails: "no_new_employer: the 1 companies of the brand's team and paying clients are already kept (1 still waiting for a notoriety judgment)" },
    };
    expect((await replayCase(src, pending)).diffs).toEqual([]);
    const refused: ReplayCase = { ...pending, id: "refused", calls: calls(fail(403, { error: "Brand does not belong to the caller's org" })), expect: { fails: 'brand.proof.employers.store failed (403): {"error":"Brand does not belong to the caller\'s org"}' } };
    expect((await replayCase(src, refused)).diffs).toEqual([]);
  });
});

describe("Press feature found: the mailbox script", () => {
  const src = buildPressMailboxSource();
  const completion = (json: Record<string, unknown>) => ({ answer: { json, content: JSON.stringify(json) }, llm: { provider: "x", model: "y" } });
  const mail = (id: string, subject: string, links: Array<{ url: string; text: string | null }>) => ({
    id,
    mailbox: "owner@brand.test",
    gmailMessageId: `g-${id}`,
    threadId: null,
    fromEmail: "community@press-platform.test",
    fromName: "Press Platform",
    to: ["owner@brand.test"],
    cc: [],
    subject,
    snippet: "",
    sentAt: "2026-10-01T10:00:00.000Z",
    labels: [],
    matchedPhrases: ["now live on"],
    bodyText: "Hi, a new article with your insights just went live!",
    bodyTruncated: false,
    bodyStatus: "clean",
    links,
  });
  const article = "https://outlet.test/news/ai-costs";
  const m1 = mail("m1", "Your insights are now live on Outlet Magazine", [{ url: "https://press-platform.test", text: "logo" }, { url: article, text: "AI costs" }]);
  const m2 = mail("m2", "Our retreats are now live!", []);
  const profile = { name: "Brandy", domain: "brandy.test" };

  it("asks a model (never names one), needs no campaign, sends to nobody, never names its outcome", async () => {
    expect((await validateSource(src)).materials).toEqual(["llm_completion"]);
    expect(writesToPerson(src)).toBe(false);
    expect(src).not.toMatch(/"press_feature_found"/);
    expect(src).not.toMatch(/provider:\s*"|model:\s*"/);
    expect(PRESS_MAILBOX.tactics).toMatchObject({ recorded_by: "brand", asks: ["llm_completion"] });
    expect(SERVICE_DOOR_VENDORS["google.mail.search"]).toMatchObject({ service: "google", method: "POST", path: "/orgs/google/messages/search", asRun: true });
    expect(SERVICE_DOOR_VENDORS["brand.proof.press.store"]).toMatchObject({ service: "brand", method: "PUT", path: "/orgs/brands/{brandId}/proof/press-features", asRun: true, outcomeInBody: "outcomeKey" });
  });

  it("judges each message once: an announcement quoting the brand is read, checked on the article and stored", async () => {
    const c: ReplayCase = {
      id: "kept",
      units: { llm_completion: completion({ articleUrl: article, outlet: "Outlet Magazine", outletDomain: "https://www.Outlet.test/", title: "AI costs", publishedAt: "" }) },
      request,
      tactics: PRESS_MAILBOX.tactics,
      calls: [
        { name: "brand.profile", args: { params: { id: "brand-1" } }, answer: ok({ brand: profile }) },
        { name: "google.mail.search", args: { body: { phrases: PRESS_MAILBOX.tactics.searchPhrases, limit: 50 } }, answer: ok({ mailboxes: ["owner@brand.test"], reason: null, messages: [m1, m2], nextCursor: null }) },
        { name: "jev.noul", answer: ok({ probabilities: { announces: 0.95 } }) },
        { name: "scraping.page", args: { body: { url: article, enrich: false, brandIds: ["brand-1"] } }, answer: ok({ result: { rawMarkdown: "Kevin, founder of Brandy, says..." } }) },
        { name: "jev.noul", answer: ok({ probabilities: { quotesBrand: 0.9 } }) },
        {
          name: "brand.proof.press.store",
          args: { params: { brandId: "brand-1" }, body: { features: [{ articleUrl: article, title: "AI costs", publishedAt: "2026-10-01", outlet: { name: "Outlet Magazine", domain: "outlet.test" } }] } },
          answer: ok({ units: [{ index: 0, unitId: "u1", companyId: "o1", newUnit: true, unresolvedReason: null, notoriety: { status: "judged", score: 72 } }] }),
        },
        { name: "jev.noul", answer: ok({ probabilities: { announces: 0.05 } }) },
      ],
      expect: { content: { judged: 2, notAnnouncing: 1, notThisBrand: 0, kept: [{ outlet: "Outlet Magazine", articleUrl: article, title: "AI costs", publishedAt: "2026-10-01", newUnit: true, notoriety: 72 }] } },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("hands Jev the article's opening and every passage naming the brand, far down a long roundup", async () => {
    const { ARTICLE_VIEW_FN, PAGE_MAX_CHARS, PAGE_OPENING_CHARS, PASSAGE_RADIUS_CHARS } = await import("../../scripts/engine-ports/brand-proof.js");
    const view = new Function("PAGE_MAX_CHARS", "PAGE_OPENING_CHARS", "PASSAGE_RADIUS_CHARS", `${ARTICLE_VIEW_FN}; return articleView;`)(PAGE_MAX_CHARS, PAGE_OPENING_CHARS, PASSAGE_RADIUS_CHARS) as (t: string, w: string[]) => string;
    const filler = "Another leader shared a view on budgets and models. ".repeat(1500);
    const long = "How to Control AI API Costs. " + filler + "Kevin Lourd, Founder of Brandy, says cache every prompt. " + filler;
    const out = view(long, ["Brandy", "brandy.test"]);
    expect(out.startsWith("How to Control AI API Costs.")).toBe(true);
    expect(out).toContain("Kevin Lourd, Founder of Brandy, says cache every prompt.");
    expect(out.length).toBeLessThanOrEqual(PAGE_MAX_CHARS);
    expect(view("short page", ["Brandy"])).toBe("short page");
    expect(src).toContain("articleView(String(page.result?.rawMarkdown");
  });

  it("hands Jev the whole email and the brand, with the stated questions", async () => {
    expect(src).toContain(JSON.stringify(ANNOUNCES_QUESTION));
    expect(src).toContain(JSON.stringify(QUOTES_BRAND_QUESTION));
  });

  it("states a platform-hosted outlet by its name with a null domain (never the platform's own site)", async () => {
    const post = "https://www.linkedin.com/pulse/uk-innovation-landscape";
    const m = mail("m3", "Your insights are now live on The Business Navigator (LinkedIn Newsletter)", [{ url: post, text: "Top Content on LinkedIn" }]);
    const c: ReplayCase = {
      id: "platform",
      units: { llm_completion: completion({ articleUrl: post, outlet: "The Business Navigator", outletDomain: "", title: "", publishedAt: "2026-09-02" }) },
      request,
      tactics: PRESS_MAILBOX.tactics,
      calls: [
        { name: "brand.profile", answer: ok({ brand: profile }) },
        { name: "google.mail.search", answer: ok({ mailboxes: ["owner@brand.test"], reason: null, messages: [m], nextCursor: null }) },
        { name: "jev.noul", answer: ok({ probabilities: { announces: 0.9 } }) },
        { name: "scraping.page", answer: ok({ result: { rawMarkdown: "Kevin of Brandy" } }) },
        { name: "jev.noul", answer: ok({ probabilities: { quotesBrand: 0.8 } }) },
        {
          name: "brand.proof.press.store",
          args: { params: { brandId: "brand-1" }, body: { features: [{ articleUrl: post, title: null, publishedAt: "2026-09-02", outlet: { name: "The Business Navigator", domain: null } }] } },
          answer: ok({ units: [{ index: 0, unitId: "u3", companyId: null, newUnit: true, unresolvedReason: null, notoriety: null }] }),
        },
      ],
      expect: { content: { judged: 1, notAnnouncing: 0, notThisBrand: 0, kept: [{ outlet: "The Business Navigator", articleUrl: post, title: null, publishedAt: "2026-09-02", newUnit: true, notoriety: null }] } },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("keeps nothing for a piece quoting another brand, and is unmade naming why", async () => {
    const c: ReplayCase = {
      id: "other-brand",
      units: { llm_completion: completion({ articleUrl: article, outlet: "Outlet Magazine", outletDomain: "", title: "", publishedAt: "" }) },
      request,
      tactics: PRESS_MAILBOX.tactics,
      calls: [
        { name: "brand.profile", answer: ok({ brand: profile }) },
        { name: "google.mail.search", answer: ok({ mailboxes: ["owner@brand.test"], reason: null, messages: [m1], nextCursor: null }) },
        { name: "jev.noul", answer: ok({ probabilities: { announces: 0.9 } }) },
        { name: "scraping.page", answer: { ok: false, data: { status: 502, error: "blocked" } } },
        { name: "jev.noul", answer: ok({ probabilities: { quotesBrand: 0.1 } }) },
      ],
      expect: { fails: "no_press_feature: none of the 1 messages judged announces a piece quoting the brand (0 announce nothing, 1 not this brand)" },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("is unmade when the brand's organization connected no mailbox", async () => {
    const c: ReplayCase = {
      id: "no-mailbox",
      units: {},
      request,
      tactics: PRESS_MAILBOX.tactics,
      calls: [
        { name: "brand.profile", answer: ok({ brand: profile }) },
        { name: "google.mail.search", answer: ok({ mailboxes: [], reason: "no_google_account_connected", messages: [], nextCursor: null }) },
      ],
      expect: { fails: "no_mailbox: no_google_account_connected (the brand's organization connected no mailbox)" },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("refuses to run without phrases (a tactic, data)", async () => {
    const c: ReplayCase = {
      id: "no-phrases",
      units: {},
      request,
      tactics: { ...PRESS_MAILBOX.tactics, searchPhrases: [] },
      calls: [],
      expect: { fails: "press-mailbox: the script states no searchPhrases (tactic: what an announcing email says)" },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });
});
