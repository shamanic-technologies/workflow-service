import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchOutletStats } from "../../src/lib/source-stats-client.js";

describe("fetchOutletStats", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      OUTLETS_SERVICE_URL: "https://outlets.test",
      OUTLETS_SERVICE_API_KEY: "test-key",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  const dummyHeaders = {
    "x-org-id": "org-1",
    "x-user-id": "user-1",
    "x-run-id": "run-1",
    "x-campaign-id": "camp-1",
    "x-brand-id": "brand-1",
    "x-feature-slug": "feat",
    "x-workflow-slug": "wf",
  } as any;

  it("calls /org/outlets/stats (not /outlets/stats)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          groups: [
            { key: "wf-slug", outletsDiscovered: 5, avgRelevanceScore: 0.8, searchQueriesUsed: 3 },
          ],
        }),
        { status: 200 },
      ),
    );

    await fetchOutletStats(["wf-slug"], dummyHeaders);

    const calledUrl = spy.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://outlets.test/org/outlets/stats?groupBy=workflowSlug&workflowSlugs=wf-slug");
  });

  it("returns mapped stats by workflow slug", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          groups: [
            { key: "slug-a", outletsDiscovered: 10, avgRelevanceScore: 0.9, searchQueriesUsed: 7 },
            { key: "slug-b", outletsDiscovered: 3, avgRelevanceScore: 0.5, searchQueriesUsed: 2 },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await fetchOutletStats(["slug-a", "slug-b"], dummyHeaders);

    expect(result.get("slug-a")).toEqual({ outletsDiscovered: 10, searchQueriesUsed: 7 });
    expect(result.get("slug-b")).toEqual({ outletsDiscovered: 3, searchQueriesUsed: 2 });
  });

  it("throws with correct path in error message on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("not found", { status: 404, statusText: "Not Found" }),
    );

    await expect(fetchOutletStats(["x"], dummyHeaders)).rejects.toThrow(
      "GET /org/outlets/stats",
    );
  });
});
