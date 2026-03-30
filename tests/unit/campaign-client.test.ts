import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must set env vars before import
const ORIGINAL_ENV = { ...process.env };

describe("campaign-client", () => {
  beforeEach(() => {
    process.env.CAMPAIGN_SERVICE_URL = "http://localhost:5000";
    process.env.CAMPAIGN_SERVICE_API_KEY = "test-key";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe("fetchAllCampaigns", () => {
    it("throws when env vars are missing", async () => {
      delete process.env.CAMPAIGN_SERVICE_URL;
      delete process.env.CAMPAIGN_SERVICE_API_KEY;

      const { fetchAllCampaigns } = await import("../../src/lib/campaign-client.js");
      await expect(fetchAllCampaigns()).rejects.toThrow(
        "CAMPAIGN_SERVICE_URL and CAMPAIGN_SERVICE_API_KEY must be set",
      );
    });

    it("fetches campaigns from campaign-service", async () => {
      const campaigns = [
        { id: "c1", workflowSlug: "wf-1", status: "active", toResumeAt: null },
        { id: "c2", workflowSlug: "wf-2", status: "stopped", toResumeAt: null },
      ];

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ campaigns }), { status: 200 }),
      );

      const { fetchAllCampaigns } = await import("../../src/lib/campaign-client.js");
      const result = await fetchAllCampaigns();

      expect(result).toEqual(campaigns);
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:5000/campaigns/list",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("throws on non-200 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }),
      );

      const { fetchAllCampaigns } = await import("../../src/lib/campaign-client.js");
      await expect(fetchAllCampaigns()).rejects.toThrow("campaign-service error");
    });
  });

  describe("fetchActiveWorkflowSlugs", () => {
    it("returns slugs for active campaigns and campaigns with toResumeAt", async () => {
      const campaigns = [
        { id: "c1", workflowSlug: "wf-active", status: "active", toResumeAt: null },
        { id: "c2", workflowSlug: "wf-stopped", status: "stopped", toResumeAt: null },
        { id: "c3", workflowSlug: "wf-paused", status: "paused", toResumeAt: "2026-04-01T00:00:00Z" },
        { id: "c4", workflowSlug: "wf-completed", status: "completed", toResumeAt: null },
      ];

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ campaigns }), { status: 200 }),
      );

      const { fetchActiveWorkflowSlugs } = await import("../../src/lib/campaign-client.js");
      const result = await fetchActiveWorkflowSlugs();

      expect(result).toEqual(new Set(["wf-active", "wf-paused"]));
      expect(result.has("wf-stopped")).toBe(false);
      expect(result.has("wf-completed")).toBe(false);
    });
  });
});
