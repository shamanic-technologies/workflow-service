import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveFeatureDynastySlugs, resolveFeatureDynasty, fetchFeatureOutputs, fetchStatsRegistry } from "../../src/lib/features-client.js";
import { extractDownstreamHeaders } from "../../src/lib/downstream-headers.js";

describe("resolveFeatureDynastySlugs", () => {
  const originalUrl = process.env.FEATURES_SERVICE_URL;
  const originalKey = process.env.FEATURES_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.FEATURES_SERVICE_URL = "http://localhost:4000";
    process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
  });

  afterEach(() => {
    process.env.FEATURES_SERVICE_URL = originalUrl;
    process.env.FEATURES_SERVICE_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("calls GET /features/dynasty/slugs and returns the slugs array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            slugs: ["sales-cold-email", "sales-cold-email-v2", "sales-cold-email-v3"],
          }),
      }),
    );

    const result = await resolveFeatureDynastySlugs("sales-cold-email");

    expect(result).toEqual(["sales-cold-email", "sales-cold-email-v2", "sales-cold-email-v3"]);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4000/features/dynasty/slugs?dynastySlug=sales-cold-email",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-api-key": "test-features-key" }),
      }),
    );
  });

  it("throws when features-service is not configured", async () => {
    delete process.env.FEATURES_SERVICE_URL;
    delete process.env.FEATURES_SERVICE_API_KEY;

    await expect(resolveFeatureDynastySlugs("sales-cold-email")).rejects.toThrow(
      "FEATURES_SERVICE_URL and FEATURES_SERVICE_API_KEY must be set",
    );
  });

  it("throws when features-service returns an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: () => Promise.resolve("No features found"),
      }),
    );

    await expect(resolveFeatureDynastySlugs("nonexistent")).rejects.toThrow(
      "features-service error",
    );
  });

  it("forwards x-org-id, x-user-id, x-run-id headers when provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ slugs: ["slug-a"] }),
      }),
    );

    const fwdHeaders = {
      "x-org-id": "org-123",
      "x-user-id": "user-456",
      "x-run-id": "run-789",
    };

    await resolveFeatureDynastySlugs("slug-a", fwdHeaders);

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          "x-api-key": "test-features-key",
          "x-org-id": "org-123",
          "x-user-id": "user-456",
          "x-run-id": "run-789",
        },
      }),
    );
  });
});

describe("extractDownstreamHeaders", () => {
  it("extracts all known contextual headers from request", () => {
    const req = {
      headers: {
        "x-org-id": "org-abc",
        "x-user-id": "user-def",
        "x-run-id": "run-ghi",
        "x-brand-id": "brand-jkl",
        "x-campaign-id": "camp-mno",
        "x-workflow-slug": "my-workflow",
        "x-feature-slug": "my-feature",
        "x-api-key": "should-not-appear",
      },
    };

    const result = extractDownstreamHeaders(req);

    expect(result).toEqual({
      "x-org-id": "org-abc",
      "x-user-id": "user-def",
      "x-run-id": "run-ghi",
      "x-brand-id": "brand-jkl",
      "x-campaign-id": "camp-mno",
      "x-workflow-slug": "my-workflow",
      "x-feature-slug": "my-feature",
    });
    expect(result).not.toHaveProperty("x-api-key");
  });

  it("omits optional headers that are not present", () => {
    const req = {
      headers: {
        "x-org-id": "org-abc",
        "x-user-id": "user-def",
        "x-run-id": "run-ghi",
      },
    };

    const result = extractDownstreamHeaders(req);

    expect(result).toEqual({
      "x-org-id": "org-abc",
      "x-user-id": "user-def",
      "x-run-id": "run-ghi",
    });
  });
});

describe("resolveFeatureDynasty forwards headers", () => {
  const originalUrl = process.env.FEATURES_SERVICE_URL;
  const originalKey = process.env.FEATURES_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.FEATURES_SERVICE_URL = "http://localhost:4000";
    process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
  });

  afterEach(() => {
    process.env.FEATURES_SERVICE_URL = originalUrl;
    process.env.FEATURES_SERVICE_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("forwards identity headers to features-service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            feature_dynasty_name: "Sales Cold Email",
            feature_dynasty_slug: "sales-cold-email",
          }),
      }),
    );

    const fwdHeaders = {
      "x-org-id": "org-123",
      "x-user-id": "user-456",
      "x-run-id": "run-789",
    };

    await resolveFeatureDynasty("sales-cold-email-v2", fwdHeaders);

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          "x-api-key": "test-features-key",
          "x-org-id": "org-123",
          "x-user-id": "user-456",
          "x-run-id": "run-789",
        },
      }),
    );
  });
});

describe("fetchFeatureOutputs forwards headers", () => {
  const originalUrl = process.env.FEATURES_SERVICE_URL;
  const originalKey = process.env.FEATURES_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.FEATURES_SERVICE_URL = "http://localhost:4000";
    process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
  });

  afterEach(() => {
    process.env.FEATURES_SERVICE_URL = originalUrl;
    process.env.FEATURES_SERVICE_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("forwards identity headers to features-service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ feature: { outputs: [{ key: "emails_sent", displayOrder: 1 }] } }),
      }),
    );

    const fwdHeaders = {
      "x-org-id": "org-123",
      "x-user-id": "user-456",
      "x-run-id": "run-789",
    };

    await fetchFeatureOutputs("sales-cold-email", fwdHeaders);

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          "x-api-key": "test-features-key",
          "x-org-id": "org-123",
          "x-user-id": "user-456",
          "x-run-id": "run-789",
        },
      }),
    );
  });
});

describe("fetchStatsRegistry forwards headers", () => {
  const originalUrl = process.env.FEATURES_SERVICE_URL;
  const originalKey = process.env.FEATURES_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.FEATURES_SERVICE_URL = "http://localhost:4000";
    process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
  });

  afterEach(() => {
    process.env.FEATURES_SERVICE_URL = originalUrl;
    process.env.FEATURES_SERVICE_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("forwards identity headers to features-service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ registry: { emails_sent: { type: "count", label: "Emails Sent" } } }),
      }),
    );

    const fwdHeaders = {
      "x-org-id": "org-123",
      "x-user-id": "user-456",
      "x-run-id": "run-789",
    };

    await fetchStatsRegistry(fwdHeaders);

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          "x-api-key": "test-features-key",
          "x-org-id": "org-123",
          "x-user-id": "user-456",
          "x-run-id": "run-789",
        },
      }),
    );
  });
});
