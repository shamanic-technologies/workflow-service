import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/lib/stale-workflow-deprecator.js", () => ({
  deprecateStaleWorkflows: vi.fn(),
}));

vi.mock("../../src/lib/windmill-flow-cleanup.js", () => ({
  cleanupOrphanedWindmillFlows: vi.fn(),
}));

vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchActiveWorkflowSlugs: vi.fn(),
}));

import { PeriodicCleanup } from "../../src/lib/periodic-cleanup.js";
import { deprecateStaleWorkflows } from "../../src/lib/stale-workflow-deprecator.js";
import { cleanupOrphanedWindmillFlows } from "../../src/lib/windmill-flow-cleanup.js";
import { fetchActiveWorkflowSlugs } from "../../src/lib/campaign-client.js";

const deprecateMock = vi.mocked(deprecateStaleWorkflows);
const cleanupMock = vi.mocked(cleanupOrphanedWindmillFlows);
const fetchSlugsMock = vi.mocked(fetchActiveWorkflowSlugs);

describe("PeriodicCleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("start schedules an interval and stop clears it", () => {
    vi.useFakeTimers();
    const db = {} as never;
    const windmillClient = {} as never;
    const cleanup = new PeriodicCleanup(db, windmillClient, 60_000);

    cleanup.start();
    expect(vi.getTimerCount()).toBe(1);

    cleanup.start(); // idempotent — should not double-schedule
    expect(vi.getTimerCount()).toBe(1);

    cleanup.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runOnce calls deprecateStaleWorkflows then cleanupOrphanedWindmillFlows with fetched slugs", async () => {
    deprecateMock.mockResolvedValueOnce({
      deprecatedCount: 0,
      keptByCampaign: 0,
      skippedNoCampaignService: false,
    });
    fetchSlugsMock.mockResolvedValueOnce(new Set(["active-slug"]));
    cleanupMock.mockResolvedValueOnce({ deleted: 0, kept: 0, failed: 0 });

    const db = { tag: "db" } as never;
    const windmillClient = { tag: "wm" } as never;
    const cleanup = new PeriodicCleanup(db, windmillClient, 60_000);

    await cleanup.runOnce();

    expect(deprecateMock).toHaveBeenCalledWith(db);
    expect(fetchSlugsMock).toHaveBeenCalledTimes(1);
    expect(cleanupMock).toHaveBeenCalledWith(db, windmillClient, new Set(["active-slug"]));

    const deprecateOrder = deprecateMock.mock.invocationCallOrder[0];
    const cleanupOrder = cleanupMock.mock.invocationCallOrder[0];
    expect(deprecateOrder).toBeLessThan(cleanupOrder);
  });

  it("skips cleanupOrphanedWindmillFlows when fetchActiveWorkflowSlugs throws", async () => {
    deprecateMock.mockResolvedValueOnce({
      deprecatedCount: 0,
      keptByCampaign: 0,
      skippedNoCampaignService: false,
    });
    fetchSlugsMock.mockRejectedValueOnce(new Error("campaign-service down"));

    const cleanup = new PeriodicCleanup({} as never, {} as never, 60_000);

    await expect(cleanup.runOnce()).resolves.toBeUndefined();
    expect(cleanupMock).not.toHaveBeenCalled();
  });

  it("continues if deprecateStaleWorkflows throws — still attempts cleanup", async () => {
    deprecateMock.mockRejectedValueOnce(new Error("db blew up"));
    fetchSlugsMock.mockResolvedValueOnce(new Set());
    cleanupMock.mockResolvedValueOnce({ deleted: 0, kept: 0, failed: 0 });

    const cleanup = new PeriodicCleanup({} as never, {} as never, 60_000);

    await expect(cleanup.runOnce()).resolves.toBeUndefined();
    expect(cleanupMock).toHaveBeenCalledTimes(1);
  });
});
