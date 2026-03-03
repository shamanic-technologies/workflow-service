import { describe, it, expect, vi, beforeEach } from "vitest";

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

describe("node scripts inject identity headers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  const emailEnvs: Record<string, string> = {
    TRANSACTIONAL_EMAIL_SERVICE_URL: "https://email.example.com",
    TRANSACTIONAL_EMAIL_SERVICE_API_KEY: "email-key-123",
  };

  const stripeEnvs: Record<string, string> = {
    STRIPE_SERVICE_URL: "https://stripe.example.com",
    STRIPE_SERVICE_API_KEY: "stripe-key-123",
  };

  const clientEnvs: Record<string, string> = {
    CLIENT_SERVICE_URL: "https://client.example.com",
    CLIENT_SERVICE_API_KEY: "client-key-123",
  };

  describe("transactional-email-send", () => {
    it("sends x-org-id, x-user-id, x-run-id as HTTP headers", async () => {
      const { main } = await import("../../scripts/nodes/transactional-email-send.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await main(
        "contact_welcome",       // eventType
        "test@example.com",      // recipientEmail
        undefined,               // brandId
        undefined,               // campaignId
        undefined,               // productId
        "user-uuid-1",           // userId
        "org-uuid-1",            // orgId
        undefined,               // metadata
        emailEnvs,               // serviceEnvs
        "run-uuid-1",            // runId
      );

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://email.example.com/send");
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
      expect(options.headers["x-api-key"]).toBe("email-key-123");
    });

    it("omits identity headers when params are undefined", async () => {
      const { main } = await import("../../scripts/nodes/transactional-email-send.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await main("contact_welcome", "test@example.com", undefined, undefined, undefined, undefined, undefined, undefined, emailEnvs);

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBeUndefined();
      expect(options.headers["x-user-id"]).toBeUndefined();
      expect(options.headers["x-run-id"]).toBeUndefined();
      expect(options.headers["x-api-key"]).toBe("email-key-123");
    });
  });

  describe("transactional-email-get-stats", () => {
    it("sends x-org-id, x-user-id, x-run-id as HTTP headers", async () => {
      const { main } = await import("../../scripts/nodes/transactional-email-get-stats.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ sent: 10 }));

      await main(
        "org-uuid-1",   // orgId
        "user-uuid-1",  // userId
        "welcome",      // eventType
        emailEnvs,      // serviceEnvs
        "run-uuid-1",   // runId
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
    });
  });

  describe("stripe-create-product", () => {
    it("sends identity headers", async () => {
      const { main } = await import("../../scripts/nodes/stripe-create-product.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ productId: "prod_1" }));

      await main(
        "org-uuid-1",    // orgId
        "Test Product",  // name
        undefined,       // description
        undefined,       // id
        undefined,       // metadata
        stripeEnvs,      // serviceEnvs
        "user-uuid-1",   // userId
        "run-uuid-1",    // runId
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
      expect(options.headers["x-api-key"]).toBe("stripe-key-123");
    });
  });

  describe("client-create-user", () => {
    it("sends identity headers", async () => {
      const { main } = await import("../../scripts/nodes/client-create-user.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "u-1" }));

      await main(
        "org-uuid-1",         // orgId
        "test@example.com",   // email
        undefined,            // firstName
        undefined,            // lastName
        undefined,            // phone
        undefined,            // metadata
        clientEnvs,           // serviceEnvs
        "user-uuid-1",        // userId
        "run-uuid-1",         // runId
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
      expect(options.headers["x-api-key"]).toBe("client-key-123");
    });
  });

  describe("app-resolve-product", () => {
    it("sends identity headers", async () => {
      const { main } = await import("../../scripts/nodes/app-resolve-product.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ productId: "prod_1", name: "Test" }));

      await main(
        "prod_1",        // productId
        stripeEnvs,      // serviceEnvs
        "org-uuid-1",    // orgId
        "user-uuid-1",   // userId
        "run-uuid-1",    // runId
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
      expect(options.headers["x-api-key"]).toBe("stripe-key-123");
    });
  });
});
