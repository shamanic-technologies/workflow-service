import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveFeatureDynastySlugs } from "../../src/lib/features-client.js";

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
        headers: { "x-api-key": "test-features-key" },
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
});
