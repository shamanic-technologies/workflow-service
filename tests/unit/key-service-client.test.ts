import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchProviderRequirements, type IdentityHeaders } from "../../src/lib/key-service-client.js";

const TEST_IDENTITY: IdentityHeaders = { orgId: "org-1", userId: "user-1", runId: "run-1" };

describe("fetchProviderRequirements", () => {
  const originalUrl = process.env.KEY_SERVICE_URL;
  const originalKey = process.env.KEY_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.KEY_SERVICE_URL = "http://localhost:4000";
    process.env.KEY_SERVICE_API_KEY = "test-key-svc-key";
  });

  afterEach(() => {
    process.env.KEY_SERVICE_URL = originalUrl;
    process.env.KEY_SERVICE_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("throws if KEY_SERVICE_URL is not set", async () => {
    delete process.env.KEY_SERVICE_URL;
    await expect(fetchProviderRequirements([], TEST_IDENTITY)).rejects.toThrow(
      "KEY_SERVICE_URL and KEY_SERVICE_API_KEY must be set"
    );
  });

  it("throws if KEY_SERVICE_API_KEY is not set", async () => {
    delete process.env.KEY_SERVICE_API_KEY;
    await expect(fetchProviderRequirements([], TEST_IDENTITY)).rejects.toThrow(
      "KEY_SERVICE_URL and KEY_SERVICE_API_KEY must be set"
    );
  });

  it("calls key-service and returns the response", async () => {
    const mockResponse = {
      requirements: [{ provider: "apollo", fields: ["apiKey"] }],
      providers: ["apollo"],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })
    );

    const result = await fetchProviderRequirements([
      { service: "apollo", method: "POST", path: "/search" },
    ], TEST_IDENTITY);

    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4000/provider-requirements",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-api-key": "test-key-svc-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
        }),
      })
    );
  });

  it("strips trailing slash from KEY_SERVICE_URL", async () => {
    process.env.KEY_SERVICE_URL = "http://localhost:4000/";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ requirements: [], providers: [] }),
      })
    );

    await fetchProviderRequirements([], TEST_IDENTITY);

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4000/provider-requirements",
      expect.anything()
    );
  });

  it("calls /provider-requirements without /internal prefix (regression)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ requirements: [], providers: [] }),
      })
    );

    await fetchProviderRequirements([
      { service: "apollo", method: "POST", path: "/search" },
    ], TEST_IDENTITY);

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).not.toContain("/internal/");
    expect(calledUrl.endsWith("/provider-requirements")).toBe(true);
  });

  it("throws on non-2xx response from key-service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve("boom"),
      })
    );

    await expect(
      fetchProviderRequirements([
        { service: "apollo", method: "POST", path: "/search" },
      ], TEST_IDENTITY)
    ).rejects.toThrow("key-service error:");
  });
});

