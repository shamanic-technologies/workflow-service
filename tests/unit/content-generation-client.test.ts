import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We test getConfig indirectly through fetchPromptTemplate
// since getConfig is not exported. We mock fetch to avoid real HTTP calls.

describe("content-generation-client", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.CONTENT_GENERATION_URL;
    delete process.env.CONTENT_GENERATION_API_KEY;
    delete process.env.CONTENT_GENERATION_SERVICE_URL;
    delete process.env.CONTENT_GENERATION_SERVICE_API_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it("uses CONTENT_GENERATION_SERVICE_URL/API_KEY (standard pattern)", async () => {
    process.env.CONTENT_GENERATION_SERVICE_URL = "https://cg.example.com";
    process.env.CONTENT_GENERATION_SERVICE_API_KEY = "key-standard";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          id: "1",
          type: "cold-email",
          prompt: "test",
          variables: ["leadFirstName"],
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPromptTemplate } = await import(
      "../../src/lib/content-generation-client.js"
    );
    const result = await fetchPromptTemplate("cold-email");

    expect(result).not.toBeNull();
    expect(result!.type).toBe("cold-email");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://cg.example.com/platform-prompts?type=cold-email",
      { method: "GET", headers: { "x-api-key": "key-standard" } },
    );
  });

  it("falls back to legacy CONTENT_GENERATION_URL/API_KEY", async () => {
    process.env.CONTENT_GENERATION_URL = "https://cg-legacy.example.com";
    process.env.CONTENT_GENERATION_API_KEY = "key-legacy";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          id: "1",
          type: "cold-email",
          prompt: "test",
          variables: [],
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPromptTemplate } = await import(
      "../../src/lib/content-generation-client.js"
    );
    await fetchPromptTemplate("cold-email");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://cg-legacy.example.com/platform-prompts?type=cold-email",
      { method: "GET", headers: { "x-api-key": "key-legacy" } },
    );
  });

  it("prefers CONTENT_GENERATION_SERVICE_URL over legacy when both are set", async () => {
    process.env.CONTENT_GENERATION_SERVICE_URL = "https://cg-standard.example.com";
    process.env.CONTENT_GENERATION_SERVICE_API_KEY = "key-standard";
    process.env.CONTENT_GENERATION_URL = "https://cg-legacy.example.com";
    process.env.CONTENT_GENERATION_API_KEY = "key-legacy";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          id: "1",
          type: "test",
          prompt: "test",
          variables: [],
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPromptTemplate } = await import(
      "../../src/lib/content-generation-client.js"
    );
    await fetchPromptTemplate("test");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://cg-standard.example.com/platform-prompts?type=test",
      { method: "GET", headers: { "x-api-key": "key-standard" } },
    );
  });

  it("throws when no env vars are set", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPromptTemplate } = await import(
      "../../src/lib/content-generation-client.js"
    );

    await expect(fetchPromptTemplate("cold-email")).rejects.toThrow(
      /CONTENT_GENERATION_SERVICE_URL/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null on 404", async () => {
    process.env.CONTENT_GENERATION_SERVICE_URL = "https://cg.example.com";
    process.env.CONTENT_GENERATION_SERVICE_API_KEY = "key";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPromptTemplate } = await import(
      "../../src/lib/content-generation-client.js"
    );
    const result = await fetchPromptTemplate("nonexistent");

    expect(result).toBeNull();
  });

  it("fetchPromptTemplates logs warning for 404 templates", async () => {
    process.env.CONTENT_GENERATION_SERVICE_URL = "https://cg.example.com";
    process.env.CONTENT_GENERATION_SERVICE_API_KEY = "key";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPromptTemplates } = await import(
      "../../src/lib/content-generation-client.js"
    );
    const result = await fetchPromptTemplates(["cold-email"]);

    expect(result.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Prompt "cold-email" returned 404'),
    );
  });
});
