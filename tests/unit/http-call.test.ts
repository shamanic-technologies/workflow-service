import { describe, it, expect, vi, beforeEach } from "vitest";
import { main } from "../../scripts/nodes/http-call.js";

// Mock Bun.env globally (script runs in Bun but we test in Node)
const mockEnv: Record<string, string> = {};
vi.stubGlobal("Bun", { env: mockEnv });

// Capture fetch calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("http-call script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  const serviceEnvs: Record<string, string> = {
    LEAD_SERVICE_URL: "https://lead.example.com",
    LEAD_SERVICE_API_KEY: "lead-key-123",
    SOCIAL_SERVICE_URL: "https://social.example.com",
    SOCIAL_SERVICE_API_KEY: "social-key",
    CAMPAIGN_SERVICE_URL: "https://campaign.example.com",
    CAMPAIGN_SERVICE_API_KEY: "campaign-key-456",
  };

  it("sends default headers (Content-Type + x-api-key)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await main("lead", "POST", "/buffer/next", { foo: "bar" }, undefined, serviceEnvs);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.headers["x-api-key"]).toBe("lead-key-123");
  });

  it("auto-injects identity headers (x-org-id, x-user-id, x-run-id) when params provided", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await main(
      "lead", "POST", "/buffer/next",
      { foo: "bar" },
      undefined,
      serviceEnvs,
      undefined,
      undefined,
      "org-uuid-1",
      "user-uuid-2",
      "run-uuid-3",
    );

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["x-org-id"]).toBe("org-uuid-1");
    expect(options.headers["x-user-id"]).toBe("user-uuid-2");
    expect(options.headers["x-run-id"]).toBe("run-uuid-3");
  });

  it("auto-injects tracking headers (x-campaign-id, x-brand-id, x-workflow-slug, x-feature-slug) when provided", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await main(
      "lead", "POST", "/buffer/next",
      { foo: "bar" },
      undefined,
      serviceEnvs,
      undefined,
      undefined,
      "org-1",
      "user-1",
      "run-1",
      undefined, // params
      "camp-123",
      "brand-456",
      "sales-email-cold-outreach",
      "sales-email-cold-outreach",
    );

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["x-campaign-id"]).toBe("camp-123");
    expect(options.headers["x-brand-id"]).toBe("brand-456");
    expect(options.headers["x-workflow-slug"]).toBe("sales-email-cold-outreach");
    expect(options.headers["x-feature-slug"]).toBe("sales-email-cold-outreach");
  });

  it("auto-injects attribution headers when provided", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await main(
      "lead", "POST", "/buffer/next",
      { foo: "bar" },
      undefined,
      serviceEnvs,
      undefined,
      undefined,
      "org-1",
      "user-1",
      "run-1",
      undefined,
      "camp-123",
      "brand-456",
      "sales-email-cold-outreach",
      "sales-email-cold-outreach",
      "signup",
      "brand-profile-real-1",
      "profile-real-1",
      "persona-real-1",
      "goal-real-1",
      "signups",
      "signups",
    );

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["x-goal"]).toBe("signup");
    expect(options.headers["x-brand-profile-id"]).toBe("brand-profile-real-1");
    expect(options.headers["x-profile-id"]).toBe("profile-real-1");
    expect(options.headers["x-persona-id"]).toBe("persona-real-1");
    expect(options.headers["x-goal-id"]).toBe("goal-real-1");
    expect(options.headers["x-goal-slug"]).toBe("signups");
    expect(options.headers["x-optimization-goal"]).toBe("signups");
  });

  it("forwards x-audience-id when audienceId is provided (per-run audience attribution)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await main(
      "lead", "POST", "/buffer/next",
      { foo: "bar" },
      undefined, // query
      serviceEnvs,
      undefined, // headers
      undefined, // validateResponse
      "org-1",
      "user-1",
      "run-1",
      undefined, // params
      undefined, // campaignId
      undefined, // brandId
      undefined, // workflowSlug
      undefined, // featureSlug
      undefined, // goal
      undefined, // brandProfileId
      undefined, // profileId
      undefined, // personaId
      undefined, // goalId
      undefined, // goalSlug
      undefined, // optimizationGoal
      "audience-real-1", // audienceId
    );

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["x-audience-id"]).toBe("audience-real-1");
  });

  it("validateResponse reads a nested field by its dotted path, and still throws when it differs", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ post: { status: "published" } }));
    await expect(
      main("social", "GET", "/internal/social-posts/1", undefined, undefined, serviceEnvs, undefined, { field: "post.status", equals: "published" }),
    ).resolves.toEqual({ post: { status: "published" } });

    mockFetch.mockResolvedValueOnce(jsonResponse({ post: { status: "queued" } }));
    await expect(
      main("social", "GET", "/internal/social-posts/1", undefined, undefined, serviceEnvs, undefined, { field: "post.status", equals: "published" }),
    ).rejects.toThrow('expected post.status="published", got "queued"');
  });

  it("omits x-audience-id when audienceId is undefined (no empty header)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await main(
      "lead", "POST", "/buffer/next",
      { foo: "bar" },
      undefined,
      serviceEnvs,
      undefined,
      undefined,
      "org-1",
      "user-1",
      "run-1",
    );

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["x-audience-id"]).toBeUndefined();
  });

  it("merges custom headers with defaults", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ found: true }));

    await main(
      "lead", "POST", "/buffer/next",
      { campaignId: "c1" },
      undefined,
      serviceEnvs,
      { "x-app-id": "app-1", "x-org-id": "org-1" },
    );

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.headers["x-api-key"]).toBe("lead-key-123");
    expect(options.headers["x-app-id"]).toBe("app-1");
    expect(options.headers["x-org-id"]).toBe("org-1");
  });

  it("x-api-key takes precedence over custom headers", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await main(
      "lead", "POST", "/test",
      undefined,
      undefined,
      serviceEnvs,
      { "x-api-key": "should-be-overridden" },
    );

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["x-api-key"]).toBe("lead-key-123");
  });

  it("works without custom headers (backward compat)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await main("campaign", "GET", "/status", undefined, undefined, serviceEnvs);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://campaign.example.com/status");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.headers["x-api-key"]).toBe("campaign-key-456");
  });

  it("throws when service URL is missing", async () => {
    await expect(
      main("unknown", "GET", "/test", undefined, undefined, serviceEnvs),
    ).rejects.toThrow("Missing: UNKNOWN_SERVICE_URL");
  });

  it("regression: identity headers are sent even with body containing orgId (gate-check scenario)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ allowed: true }));

    // Simulate what Windmill sends: body has orgId+campaignId, AND orgId/userId/runId as separate params
    await main(
      "campaign", "POST", "/gate-check",
      { orgId: "org-from-body", campaignId: "campaign-uuid" },
      undefined,
      serviceEnvs,
      undefined,
      undefined,
      "org-from-flow-input",
      "user-uuid",
      "run-uuid",
    );

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://campaign.example.com/gate-check");
    // Body should contain both fields
    const sentBody = JSON.parse(options.body);
    expect(sentBody.orgId).toBe("org-from-body");
    expect(sentBody.campaignId).toBe("campaign-uuid");
    // Identity headers must be present
    expect(options.headers["x-org-id"]).toBe("org-from-flow-input");
    expect(options.headers["x-user-id"]).toBe("user-uuid");
    expect(options.headers["x-run-id"]).toBe("run-uuid");
  });

  describe("path params", () => {
    it("replaces {placeholders} in path with params values", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ profile: {} }));

      const brandServiceEnvs = {
        ...serviceEnvs,
        BRAND_SERVICE_URL: "https://brand.example.com",
        BRAND_SERVICE_API_KEY: "brand-key-789",
      };

      await main(
        "brand", "POST", "/internal/brands/{brandId}",
        { workflowSlug: "test" },
        undefined,
        brandServiceEnvs,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { brandId: "brand-uuid-123" },
      );

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://brand.example.com/internal/brands/brand-uuid-123");
    });

    it("replaces multiple path params", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await main(
        "campaign", "GET", "/orgs/{orgId}/campaigns/{campaignId}",
        undefined,
        undefined,
        serviceEnvs,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { orgId: "org-1", campaignId: "camp-2" },
      );

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://campaign.example.com/orgs/org-1/campaigns/camp-2");
    });

    it("replaces :param syntax in path with params values", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ tracked: true }));

      const runsEnvs = {
        ...serviceEnvs,
        RUNS_SERVICE_URL: "https://runs.example.com",
        RUNS_SERVICE_API_KEY: "runs-key-789",
      };

      await main(
        "runs", "POST", "/runs/:id/costs",
        { amount: 0.1, costType: "email_send" },
        undefined,
        runsEnvs,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { id: "run-uuid-456" },
      );

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://runs.example.com/runs/run-uuid-456/costs");
    });

    it("works without params (backward compat)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await main("campaign", "GET", "/status", undefined, undefined, serviceEnvs);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://campaign.example.com/status");
    });
  });

  describe("validateResponse", () => {
    it("passes when response field matches expected value", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ allowed: true, reason: "ok" }));

      const result = await main(
        "campaign", "POST", "/gate-check",
        { campaignId: "c1" },
        undefined,
        serviceEnvs,
        undefined,
        { field: "allowed", equals: true },
      );

      expect(result).toEqual({ allowed: true, reason: "ok" });
    });

    it("throws when response field does not match (gate-check blocked)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ allowed: false, reason: "3 consecutive failures" }));

      await expect(
        main(
          "campaign", "POST", "/gate-check",
          { campaignId: "c1" },
          undefined,
          serviceEnvs,
          undefined,
          { field: "allowed", equals: true },
        ),
      ).rejects.toThrow("validation failed: expected allowed=true, got false");
    });

    it("throws when response field does not match (fetch-lead empty buffer)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ found: false }));

      await expect(
        main(
          "lead", "POST", "/buffer/next",
          { campaignId: "c1" },
          undefined,
          serviceEnvs,
          { "x-app-id": "app-1", "x-org-id": "org-1" },
          { field: "found", equals: true },
        ),
      ).rejects.toThrow("validation failed: expected found=true, got false");
    });

    it("does not validate when validateResponse is omitted", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ found: false }));

      const result = await main(
        "lead", "POST", "/buffer/next",
        undefined,
        undefined,
        serviceEnvs,
      );

      expect(result).toEqual({ found: false });
    });
  });

  describe("tolerateFailure", () => {
    // Windmill passes a DAG's `config.tolerateFailure` by NAME; this suite calls
    // main() positionally, so the flag goes in its declared slot — last, after
    // audienceId. Adding it there is what kept every other positional caller
    // in this file working unchanged.
    const TOLERATE_POSITION = 24;

    function argsWithTolerate(
      leading: unknown[],
      tolerateFailure: boolean,
    ): unknown[] {
      const args = new Array(TOLERATE_POSITION).fill(undefined);
      leading.forEach((v, i) => { args[i] = v; });
      args[TOLERATE_POSITION] = tolerateFailure;
      return args;
    }

    it("returns the failure instead of throwing when a call answers non-2xx", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('{"error":"Scrape failed"}', { status: 500 }),
      );

      const result = await (main as (...a: unknown[]) => Promise<unknown>)(
        ...argsWithTolerate(
          ["scraping", "POST", "/scrape", { url: "https://x.example" }, undefined, {
            SCRAPING_SERVICE_URL: "https://scraping.example.com",
            SCRAPING_SERVICE_API_KEY: "scraping-key",
          }],
          true,
        ),
      );

      expect(result).toEqual({
        ok: false,
        status: 500,
        error: '{"error":"Scrape failed"}',
      });
    });

    it("returns the failure instead of throwing when the request never completes", async () => {
      mockFetch.mockRejectedValueOnce(new Error("connect ETIMEDOUT"));

      const result = await (main as (...a: unknown[]) => Promise<unknown>)(
        ...argsWithTolerate(
          ["scraping", "POST", "/scrape", { url: "https://x.example" }, undefined, {
            SCRAPING_SERVICE_URL: "https://scraping.example.com",
            SCRAPING_SERVICE_API_KEY: "scraping-key",
          }],
          true,
        ),
      );

      expect(result).toEqual({ ok: false, status: 0, error: "connect ETIMEDOUT" });
    });

    it("still throws on non-2xx when the flag is off, so every other node fails loud", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('{"error":"Scrape failed"}', { status: 500 }),
      );

      await expect(
        (main as (...a: unknown[]) => Promise<unknown>)(
          ...argsWithTolerate(
            ["scraping", "POST", "/scrape", { url: "https://x.example" }, undefined, {
              SCRAPING_SERVICE_URL: "https://scraping.example.com",
              SCRAPING_SERVICE_API_KEY: "scraping-key",
            }],
            false,
          ),
        ),
      ).rejects.toThrow("failed (500)");
    });

    it("leaves a successful response untouched", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ cached: false, result: { rawMarkdown: "hi" } }));

      const result = await (main as (...a: unknown[]) => Promise<unknown>)(
        ...argsWithTolerate(
          ["scraping", "POST", "/scrape", { url: "https://x.example" }, undefined, {
            SCRAPING_SERVICE_URL: "https://scraping.example.com",
            SCRAPING_SERVICE_API_KEY: "scraping-key",
          }],
          true,
        ),
      );

      expect(result).toEqual({ cached: false, result: { rawMarkdown: "hi" } });
    });
  });

  describe("skipOnRefusalCodes (RECONTACT-LOOP-1011)", () => {
    // Declared right after tolerateFailure; Windmill passes it by NAME.
    const SKIP_POSITION = 25;
    const GATEWAY_ENVS = {
      EMAIL_GATEWAY_SERVICE_URL: "https://gw.example.com",
      EMAIL_GATEWAY_SERVICE_API_KEY: "gw-key",
    };
    const CODES = ["recent_brand_contact", "lead_opted_out"];

    function callSend(codes: string[] | undefined) {
      const args = new Array(SKIP_POSITION + 1).fill(undefined);
      ["email-gateway", "POST", "/orgs/send", { to: "a@b.com" }, undefined, GATEWAY_ENVS]
        .forEach((v, i) => { args[i] = v; });
      args[7] = { field: "success", equals: true };
      args[SKIP_POSITION] = codes;
      return (main as (...a: unknown[]) => Promise<unknown>)(...args);
    }

    const refusal = {
      error: "Lead was contacted for this brand recently",
      code: "recent_brand_contact",
      details: "No email was sent and nothing was billed.",
    };

    it("returns a skipped outcome on a 409 naming a listed code (validateResponse not applied)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(refusal, 409));
      const result = await callSend(CODES);
      expect(result).toEqual({
        ok: false,
        skipped: true,
        status: 409,
        code: "recent_brand_contact",
        reason: "No email was sent and nothing was billed.",
        refusal: JSON.stringify(refusal),
        delivery: { state: "refused", code: "recent_brand_contact", reason: "No email was sent and nothing was billed." },
      });
    });

    it("reads the code nested under details when a hop wraps the upstream body", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "Lead has opted out", details: { code: "lead_opted_out" } }, 409),
      );
      const result = (await callSend(CODES)) as Record<string, unknown>;
      expect(result.skipped).toBe(true);
      expect(result.code).toBe("lead_opted_out");
    });

    it("still throws on a 5xx even when its body carries a listed code", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "Upstream service error", details: JSON.stringify(refusal), code: "recent_brand_contact" }, 502),
      );
      await expect(callSend(CODES)).rejects.toThrow("failed (502)");
    });

    it("still throws on a 4xx with an unlisted code", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: "x", code: "no_reply_to_thread" }, 409));
      await expect(callSend(CODES)).rejects.toThrow("failed (409)");
    });

    it("still throws on a 4xx whose body is not JSON", async () => {
      mockFetch.mockResolvedValueOnce(new Response("recent_brand_contact", { status: 409 }));
      await expect(callSend(CODES)).rejects.toThrow("failed (409)");
    });

    it("throws on the refusal when no codes are configured", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(refusal, 409));
      await expect(callSend(undefined)).rejects.toThrow("failed (409)");
    });

    describe("\"*\": any code the sender names on a 409 (PUSHED-TRUTH-1015)", () => {
      const ANY = [...CODES, "*"];
      // Prod 2026-10-15, campaign 25036bda: thrown, then redelivered six times over ~4 h.
      const notVerified = {
        error: "Email not verified",
        code: "email_not_verified",
        verdict: "invalid",
        details: "team@x.co.uk was not sent: our verifier's verdict is invalid (verdict_invalid)",
      };

      it("reads an unlisted 409 code as a refusal, with the sender's sentence and the end-run delivery", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse(notVerified, 409));
        const result = (await callSend(ANY)) as Record<string, unknown>;
        expect(result).toMatchObject({ ok: false, skipped: true, status: 409, code: "email_not_verified" });
        expect(result.delivery).toEqual({ state: "refused", code: "email_not_verified", reason: notVerified.details });
      });

      it("takes `error` as the sentence when the body has no `details` sentence", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ error: "Lead is not a prospect", code: "lead_not_a_prospect" }, 409));
        const result = (await callSend(ANY)) as Record<string, unknown>;
        expect(result.delivery).toEqual({ state: "refused", code: "lead_not_a_prospect", reason: "Lead is not a prospect" });
      });

      it("still throws on a 5xx, a 402, a 409 naming no code, and an unlisted code on another 4xx", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ error: "down", code: "email_verification_unavailable" }, 502));
        await expect(callSend(ANY)).rejects.toThrow("failed (502)");
        mockFetch.mockResolvedValueOnce(jsonResponse({ error: "No credits", code: "insufficient_credits" }, 402));
        await expect(callSend(ANY)).rejects.toThrow("failed (402)");
        mockFetch.mockResolvedValueOnce(jsonResponse({ error: "conflict" }, 409));
        await expect(callSend(ANY)).rejects.toThrow("failed (409)");
        mockFetch.mockResolvedValueOnce(jsonResponse({ error: "bad", code: "invalid_body" }, 400));
        await expect(callSend(ANY)).rejects.toThrow("failed (400)");
      });

      it("still throws on a transport error", async () => {
        mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
        await expect(callSend(ANY)).rejects.toThrow("ECONNREFUSED");
      });
    });
  });
  describe("skip (WA-RESPONDER-1012)", () => {
    // Declared right after skipOnRefusalCodes; Windmill passes it by NAME.
    const SKIP_POSITION = 26;

    function call(skip: unknown) {
      const args = new Array(SKIP_POSITION + 1).fill(undefined);
      ["lead", "POST", "/orgs/x", { a: 1 }, undefined, serviceEnvs].forEach((v, i) => { args[i] = v; });
      args[SKIP_POSITION] = skip;
      return (main as (...a: unknown[]) => Promise<unknown>)(...args);
    }

    it("makes no call and says so when skip is true", async () => {
      const result = await call(true);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: false, skipped: true, notCalled: true });
    });

    it("calls as before when skip is false, absent or not exactly true", async () => {
      for (const value of [false, undefined, "true", 1]) {
        mockFetch.mockResolvedValueOnce(jsonResponse({ done: true }));
        expect(await call(value)).toEqual({ done: true });
      }
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });
  describe("omitHeaders (WA-RESPONDER-1012 escalation alert)", () => {
    const POSITION = 27;
    it("drops the named identity headers from this one call only", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "sent" }));
      const args = new Array(POSITION + 1).fill(undefined);
      ["crm", "POST", "/orgs/whatsapp/messages", { text: "x" }, undefined, { CRM_SERVICE_URL: "https://crm", CRM_SERVICE_API_KEY: "k" }]
        .forEach((v, i) => { args[i] = v; });
      args[8] = "org-1";
      args[12] = "camp-1";
      args[POSITION] = ["x-campaign-id"];
      await (main as (...a: unknown[]) => Promise<unknown>)(...args);
      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-campaign-id"]).toBeUndefined();
      expect(options.headers["x-org-id"]).toBe("org-1");
      expect(options.headers["x-api-key"]).toBe("k");
    });
  });
  describe("pollWhile (AIC-COMMON-1015: Apollo's phone reveal arrives after the first answer)", () => {
    const POSITION = 28;
    const call = (pollWhile: unknown, tolerate?: boolean) => {
      const args = new Array(POSITION + 1).fill(undefined);
      ["apollo", "GET", "/people/{apolloPersonId}/phone-reveal", undefined, undefined, { APOLLO_SERVICE_URL: "https://apollo", APOLLO_SERVICE_API_KEY: "k" }]
        .forEach((v, i) => { args[i] = v; });
      args[11] = { apolloPersonId: "p1" };
      if (tolerate) args[24] = true;
      args[POSITION] = pollWhile;
      return (main as (...a: unknown[]) => Promise<Record<string, unknown>>)(...args);
    };

    it("asks again while the field still equals the value, and returns the settled answer", async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(jsonResponse({ status: "pending" }))
          .mockResolvedValueOnce(jsonResponse({ status: "pending" }))
          .mockResolvedValueOnce(jsonResponse({ status: "found", mobilePhone: "+15550001111" }));
        const p = call({ field: "status", equals: "pending", intervalSeconds: 5, timeoutSeconds: 90 });
        await vi.advanceTimersByTimeAsync(20_000);
        const result = await p;
        expect(result).toEqual({ status: "found", mobilePhone: "+15550001111" });
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops at the bound and returns the last answer, marked pollTimedOut, without throwing", async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockImplementation(async () => jsonResponse({ status: "pending" }));
        const p = call({ field: "status", equals: "pending", intervalSeconds: 5, timeoutSeconds: 12 });
        await vi.advanceTimersByTimeAsync(60_000);
        const result = await p;
        expect(result).toEqual({ status: "pending", pollTimedOut: true });
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
        mockFetch.mockReset();
      }
    });

    it("never waits past 300 seconds, whatever the node states", async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockImplementation(async () => jsonResponse({ status: "pending" }));
        const p = call({ field: "status", equals: "pending", intervalSeconds: 60, timeoutSeconds: 99_999 });
        await vi.advanceTimersByTimeAsync(400_000);
        const result = await p;
        expect(result.pollTimedOut).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(6);
      } finally {
        vi.useRealTimers();
        mockFetch.mockReset();
      }
    });

    it("a failed request during the wait behaves as without it (tolerated here)", async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(jsonResponse({ status: "pending" }))
          .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));
        const p = call({ field: "status", equals: "pending", intervalSeconds: 5, timeoutSeconds: 90 }, true);
        await vi.advanceTimersByTimeAsync(10_000);
        const result = await p;
        expect(result.ok).toBe(false);
        expect(result.status).toBe(500);
      } finally {
        vi.useRealTimers();
      }
    });

    it("an answer already settled is returned at once, one request", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "not_found" }));
      const result = await call({ field: "status", equals: "pending", intervalSeconds: 5, timeoutSeconds: 90 });
      expect(result).toEqual({ status: "not_found" });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
