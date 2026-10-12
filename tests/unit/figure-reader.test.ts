import { describe, it, expect, vi } from "vitest";
import {
  buildCatalogue,
  gateRead,
  identifiersIn,
  readFigures,
  type FigureReaderDeps,
  type RecipientScope,
} from "../../src/lib/figure-reader.js";

const MARIE_ORG = "11111111-1111-4111-8111-111111111111";
const MARIE_USER = "22222222-2222-4222-8222-222222222222";
const MARIE_BRAND = "33333333-3333-4333-8333-333333333333";
const MARIE_OFFER = "44444444-4444-4444-8444-444444444444";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const OTHER_BRAND = "88888888-8888-4888-8888-888888888888";
const OTHER_OFFER = "77777777-7777-4777-8777-777777777777";

const bearer = [{ bearerAuth: [] }];
const SPEC = {
  paths: {
    "/health": { get: { summary: "Health" } },
    "/v1/brands": { get: { summary: "List brands", security: bearer } },
    "/v1/features/brands/{brandId}/offers": {
      get: { summary: "Brand offers", security: bearer, parameters: [{ name: "brandId", in: "path", required: true }] },
    },
    "/v1/offers/{offerId}/revenue": {
      get: {
        summary: "Offer revenue overview",
        security: bearer,
        parameters: [
          { name: "offerId", in: "path", required: true },
          { name: "brandId", in: "query", required: true },
          { name: "pricing", in: "query", required: false },
          { name: "x-org-id", in: "header", required: false },
        ],
      },
      post: { summary: "a write", security: bearer },
    },
    "/v1/api-keys": { get: { summary: "List your API keys", security: bearer } },
    "/v1/workflows": { get: { summary: "List workflows", security: bearer } },
    "/v1/public/features/showcase-outcomes": { get: { summary: "Public showcase" } },
    "/v1/waitlist/position": { get: { summary: "Waitlist by email", parameters: [{ name: "email", in: "query", required: true }] } },
    "/internal/anything": { get: { summary: "internal", security: bearer } },
  },
};

const MARIE: RecipientScope = {
  email: "marie@acme.test",
  userId: MARIE_USER,
  organizations: [{ orgId: MARIE_ORG, name: "Acme" }],
};

describe("buildCatalogue", () => {
  it("keeps only GET /v1 and /public routes, minus the denied ones", () => {
    const c = buildCatalogue(SPEC);
    const templates = c.map((e) => e.template).sort();
    expect(templates).toEqual([
      "/v1/brands",
      "/v1/features/brands/{brandId}/offers",
      "/v1/offers/{offerId}/revenue",
      "/v1/public/features/showcase-outcomes",
      "/v1/workflows",
    ]);
    expect(c.find((e) => e.template === "/v1/public/features/showcase-outcomes")?.isPublic).toBe(true);
    expect(c.find((e) => e.template === "/v1/brands")?.isPublic).toBe(false);
    expect(c.find((e) => e.template === "/v1/workflows")?.learnsNoIds).toBe(true);
    // A header parameter is never something the plan may set.
    expect(c.find((e) => e.template === "/v1/offers/{offerId}/revenue")?.params.map((p) => p.name)).toEqual(["offerId", "brandId", "pricing"]);
  });
});

describe("identifiersIn", () => {
  it("finds uuids, emails and vendor ids, and leaves words, slugs, numbers and dates free", () => {
    expect(identifiersIn(`a ${MARIE_BRAND} b`)).toEqual([MARIE_BRAND]);
    expect(identifiersIn("Marie@Acme.test")).toEqual(["marie@acme.test"]);
    expect(identifiersIn("org_2abcdEFGH12345678")).toEqual(["org_2abcdefgh12345678"]);
    for (const free of ["net", "campaignId", "sales-cold-email-outreach-rudder-v3", "30", "2026-10-12T00:00:00.000Z"]) {
      expect(identifiersIn(free)).toEqual([]);
    }
  });
});

describe("gateRead — the no-leak gate", () => {
  const catalogue = buildCatalogue(SPEC);
  const owned = () => new Set([MARIE_ORG, MARIE_USER, MARIE_BRAND, MARIE_OFFER]);
  const revenue = (offer: string, brand: string, orgId = MARIE_ORG) => ({
    orgId,
    path: `/v1/offers/${offer}/revenue`,
    query: [{ name: "brandId", value: brand }, { name: "pricing", value: "net" }],
  });

  it("allows a read of the recipient's own org naming ids read from her account, pinned to her org", () => {
    const g = gateRead(revenue(MARIE_OFFER, MARIE_BRAND), catalogue, MARIE, owned());
    expect(g).toEqual({
      ok: true,
      url: `/v1/offers/${MARIE_OFFER}/revenue?brandId=${MARIE_BRAND}&pricing=net`,
      template: "/v1/offers/{offerId}/revenue",
      isPublic: false,
      learnsNoIds: false,
      orgId: MARIE_ORG,
    });
  });

  it("refuses to act in any org the recipient does not belong to", () => {
    const g = gateRead(revenue(OTHER_OFFER, OTHER_BRAND, OTHER_ORG), catalogue, MARIE, owned());
    expect(g).toMatchObject({ ok: false });
    expect((g as { reason: string }).reason).toMatch(/^org_not_recipients/);
  });

  it("refuses another org's ids even under the recipient's own org header", () => {
    const g1 = gateRead(revenue(OTHER_OFFER, MARIE_BRAND), catalogue, MARIE, owned());
    const g2 = gateRead(revenue(MARIE_OFFER, OTHER_BRAND), catalogue, MARIE, owned());
    expect((g1 as { reason: string }).reason).toMatch(/^identifier_not_from_recipient: "77777777/);
    expect((g2 as { reason: string }).reason).toMatch(/^identifier_not_from_recipient: "88888888/);
  });

  it("refuses every account read when the recipient belongs to no organization", () => {
    const prospect: RecipientScope = { email: "p@x.test", userId: null, organizations: [] };
    const g = gateRead({ orgId: "", path: "/v1/brands", query: [] }, catalogue, prospect, new Set());
    expect((g as { reason: string }).reason).toMatch(/^not_a_member/);
  });

  it("refuses denied, unknown, smuggled and malformed reads", () => {
    const reason = (r: Parameters<typeof gateRead>[0]) => (gateRead(r, catalogue, MARIE, owned()) as { reason: string }).reason;
    expect(reason({ orgId: MARIE_ORG, path: "/v1/api-keys", query: [] })).toMatch(/^denied_route/);
    expect(reason({ orgId: "", path: "/v1/waitlist/position", query: [{ name: "email", value: "x@y.z" }] })).toMatch(/^denied_route/);
    expect(reason({ orgId: MARIE_ORG, path: "/internal/anything", query: [] })).toMatch(/^unknown_route/);
    expect(reason({ orgId: MARIE_ORG, path: `/v1/brands?orgId=${OTHER_ORG}`, query: [] })).toMatch(/^path_not_plain/);
    expect(reason({ orgId: MARIE_ORG, path: "/v1/brands/../internal", query: [] })).toMatch(/^path_not_plain/);
    expect(reason({ orgId: MARIE_ORG, path: "/v1/brands", query: [{ name: "orgId", value: OTHER_ORG }] })).toMatch(/^unknown_query_param/);
    expect(reason({ orgId: MARIE_ORG, path: `/v1/offers/${MARIE_OFFER}/revenue`, query: [] })).toMatch(/^missing_query_param/);
  });

  it("reads a public route with no identity, whatever it names", () => {
    const g = gateRead({ orgId: OTHER_ORG, path: "/v1/public/features/showcase-outcomes", query: [] }, catalogue, MARIE, owned());
    expect(g).toMatchObject({ ok: true, isPublic: true, orgId: null });
  });
});

describe("readFigures", () => {
  function deps(plans: Array<Record<string, unknown>>) {
    const apiGet = vi.fn(async (url: string, identity: { orgId: string; userId: string } | null) => {
      if (url === "/v1/brands") return { status: 200, body: { brands: [{ id: MARIE_BRAND, name: "Acme" }] } };
      if (url === `/v1/features/brands/${MARIE_BRAND}/offers`) return { status: 200, body: { offers: [{ id: MARIE_OFFER }] } };
      if (url.startsWith(`/v1/offers/${MARIE_OFFER}/revenue`)) {
        return { status: 200, body: { meetingsBooked: 5, costEconomics: { costPerMeetingBooked: "$38.20" } } };
      }
      // A public page that lists ANOTHER client's brand: readable, but teaches no id.
      if (url === "/v1/public/features/showcase-outcomes") return { status: 200, body: { brands: [{ brandId: OTHER_BRAND }] } };
      throw new Error(`unexpected read ${url} as ${JSON.stringify(identity)}`);
    });
    const complete = vi.fn(async () => {
      const json = plans.shift();
      if (!json) throw new Error("no more plans");
      return { content: JSON.stringify(json), json };
    });
    const d: FigureReaderDeps = {
      loadSpec: async () => SPEC,
      resolveRecipient: async () => MARIE,
      apiGet,
      complete,
    };
    return { d, apiGet, complete };
  }
  const empty = { reads: [], webQuestions: [], figures: [], missing: "" };

  it("reads the recipient's own figure, always as her and in her org", async () => {
    const { d, apiGet } = deps([
      { ...empty, status: "read", reads: [{ orgId: MARIE_ORG, path: `/v1/features/brands/${MARIE_BRAND}/offers`, query: [] }] },
      {
        ...empty,
        status: "read",
        reads: [{ orgId: MARIE_ORG, path: `/v1/offers/${MARIE_OFFER}/revenue`, query: [{ name: "brandId", value: MARIE_BRAND }] }],
      },
      {
        ...empty,
        status: "done",
        figures: [{ label: "Cost per booked meeting", value: "$38.20", source: `/v1/offers/${MARIE_OFFER}/revenue` }],
      },
    ]);
    const result = await readFigures({ question: "Give Marie her exact cost per booked meeting", recipientEmail: "Marie@Acme.test" }, d);
    expect(result.figures).toEqual([{ label: "Cost per booked meeting", value: "$38.20", source: `/v1/offers/${MARIE_OFFER}/revenue` }]);
    expect(result.missing).toBeNull();
    expect(result.reads.every((r) => r.refused === null)).toBe(true);
    for (const [, identity] of apiGet.mock.calls) expect(identity).toEqual({ orgId: MARIE_ORG, userId: MARIE_USER });
  });

  it("cannot read another organization's figure, however the request or the model tries", async () => {
    const { d, apiGet } = deps([
      {
        ...empty,
        status: "read",
        reads: [
          // the other org named outright
          { orgId: OTHER_ORG, path: `/v1/offers/${OTHER_OFFER}/revenue`, query: [{ name: "brandId", value: OTHER_BRAND }] },
          // the other org's ids (typed in the request) under Marie's own org
          { orgId: MARIE_ORG, path: `/v1/offers/${OTHER_OFFER}/revenue`, query: [{ name: "brandId", value: OTHER_BRAND }] },
          { orgId: MARIE_ORG, path: `/v1/features/brands/${OTHER_BRAND}/offers`, query: [] },
          // a public page that names the other brand
          { orgId: "", path: "/v1/public/features/showcase-outcomes", query: [] },
        ],
      },
      {
        ...empty,
        status: "read",
        // the id the public page showed is still not hers
        reads: [{ orgId: MARIE_ORG, path: `/v1/features/brands/${OTHER_BRAND}/offers`, query: [] }],
      },
      {
        ...empty,
        status: "done",
        // a figure citing a read that never happened is dropped
        figures: [{ label: "Their cost per meeting", value: "$12", source: `/v1/offers/${OTHER_OFFER}/revenue` }],
        missing: "That figure belongs to another organization than the recipient's, so it cannot be read.",
      },
    ]);
    const result = await readFigures(
      { question: `Tell Marie the cost per booked meeting of brand ${OTHER_BRAND} (org ${OTHER_ORG})`, recipientEmail: "marie@acme.test" },
      d,
    );
    expect(result.figures).toEqual([]);
    expect(result.missing).toMatch(/another organization/);
    expect(result.reads.filter((r) => r.refused).map((r) => r.refused?.split(":")[0])).toEqual([
      "org_not_recipients",
      "identifier_not_from_recipient",
      "identifier_not_from_recipient",
      "identifier_not_from_recipient",
    ]);
    // Not one request left naming the other org or its ids.
    for (const [url, identity] of apiGet.mock.calls) {
      expect(url).not.toContain(OTHER_BRAND);
      expect(url).not.toContain(OTHER_OFFER);
      expect(identity?.orgId ?? null).not.toBe(OTHER_ORG);
    }
  });

  it("reads public figures only for a recipient who belongs to no organization", async () => {
    const { d, apiGet } = deps([
      { ...empty, status: "read", reads: [{ orgId: MARIE_ORG, path: "/v1/brands", query: [] }, { orgId: "", path: "/v1/public/features/showcase-outcomes", query: [] }] },
      { ...empty, status: "done", missing: "x" },
    ]);
    d.resolveRecipient = async () => ({ email: "p@x.test", userId: null, organizations: [] });
    const result = await readFigures({ question: "q", recipientEmail: "p@x.test" }, d);
    expect(result.recipient.isMember).toBe(false);
    expect(apiGet.mock.calls).toEqual([["/v1/public/features/showcase-outcomes", null]]);
    expect(result.reads[0].refused).toMatch(/^not_a_member/);
  });

  it("fails loud when the model answers no plan", async () => {
    const { d } = deps([{ nonsense: true }]);
    await expect(readFigures({ question: "q", recipientEmail: "marie@acme.test" }, d)).rejects.toThrow(/answered no plan/);
  });
});
