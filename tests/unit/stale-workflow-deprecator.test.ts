import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock campaign client
const mockFetchActiveWorkflowSlugs = vi.fn();
vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchActiveWorkflowSlugs: (...args: unknown[]) => mockFetchActiveWorkflowSlugs(...args),
}));

// Mock DB
vi.mock("../../src/db/index.js", () => ({
  db: "mock-db",
}));

import { deprecateStaleWorkflows } from "../../src/lib/stale-workflow-deprecator.js";

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? `wf-${Math.random().toString(36).slice(2, 8)}`,
    slug: overrides.slug ?? `workflow-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name ?? "Test Workflow",
    featureSlug: overrides.featureSlug ?? "sales-cold-email",
    status: "active",
    orgId: "org-1",
    ...overrides,
  };
}

function createMockDb(activeWorkflows: unknown[], lastRuns: { workflowId: string; lastRun: string }[]) {
  let selectCallCount = 0;

  const updateWhereMock = vi.fn().mockResolvedValue(undefined);
  const updateSetMock = vi.fn().mockReturnValue({ where: updateWhereMock });
  const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

  const mockDb = {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++;
      const callNum = selectCallCount;
      return {
        from: vi.fn().mockImplementation(() => {
          if (callNum === 1) {
            // First select: active workflows
            return { where: vi.fn().mockResolvedValue(activeWorkflows) };
          }
          // Second select: last run dates
          return {
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue(
                lastRuns.map((r) => ({ workflowId: r.workflowId, lastRun: r.lastRun })),
              ),
            }),
          };
        }),
      };
    }),
    update: updateMock,
    _updateMock: updateMock,
    _updateWhereMock: updateWhereMock,
  };

  return mockDb;
}

describe("deprecateStaleWorkflows", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetchActiveWorkflowSlugs.mockReset();
  });

  it("returns early with no deprecations when there are no active workflows", async () => {
    const mockDb = createMockDb([], []);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(0);
    expect(mockFetchActiveWorkflowSlugs).not.toHaveBeenCalled();
  });

  it("does not deprecate when a feature has <= 3 active workflows", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-1", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-2", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-3", featureSlug: "feat-a" }),
    ];
    const mockDb = createMockDb(wfs, []);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(0);
    expect(result.keptByRecency).toBe(3);
    expect(mockFetchActiveWorkflowSlugs).not.toHaveBeenCalled();
  });

  it("deprecates workflows outside top 3 by recency when no active campaigns", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-1", slug: "wf-slug-1", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-2", slug: "wf-slug-2", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-3", slug: "wf-slug-3", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-4", slug: "wf-slug-4", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-5", slug: "wf-slug-5", featureSlug: "feat-a" }),
    ];

    const lastRuns = [
      { workflowId: "wf-1", lastRun: "2026-03-30T10:00:00Z" },
      { workflowId: "wf-2", lastRun: "2026-03-29T10:00:00Z" },
      { workflowId: "wf-3", lastRun: "2026-03-28T10:00:00Z" },
      { workflowId: "wf-4", lastRun: "2026-03-27T10:00:00Z" },
      { workflowId: "wf-5", lastRun: "2026-03-26T10:00:00Z" },
    ];

    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set<string>());

    const mockDb = createMockDb(wfs, lastRuns);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(2);
    expect(result.keptByRecency).toBe(3);
    expect(result.keptByCampaign).toBe(0);
    expect(mockDb._updateMock).toHaveBeenCalledTimes(2);
  });

  it("keeps stale workflows that are used by active campaigns", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-1", slug: "wf-slug-1", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-2", slug: "wf-slug-2", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-3", slug: "wf-slug-3", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-4", slug: "wf-slug-4", featureSlug: "feat-a" }),
    ];

    const lastRuns = [
      { workflowId: "wf-1", lastRun: "2026-03-30T10:00:00Z" },
      { workflowId: "wf-2", lastRun: "2026-03-29T10:00:00Z" },
      { workflowId: "wf-3", lastRun: "2026-03-28T10:00:00Z" },
      { workflowId: "wf-4", lastRun: "2026-03-27T10:00:00Z" },
    ];

    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set(["wf-slug-4"]));

    const mockDb = createMockDb(wfs, lastRuns);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(0);
    expect(result.keptByCampaign).toBe(1);
    expect(mockDb._updateMock).not.toHaveBeenCalled();
  });

  it("skips deprecation when campaign-service is unreachable", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-1", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-2", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-3", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-4", featureSlug: "feat-a" }),
    ];

    const lastRuns = [
      { workflowId: "wf-1", lastRun: "2026-03-30T10:00:00Z" },
      { workflowId: "wf-2", lastRun: "2026-03-29T10:00:00Z" },
      { workflowId: "wf-3", lastRun: "2026-03-28T10:00:00Z" },
      { workflowId: "wf-4", lastRun: "2026-03-26T10:00:00Z" },
    ];

    mockFetchActiveWorkflowSlugs.mockRejectedValue(
      new Error("CAMPAIGN_SERVICE_URL and CAMPAIGN_SERVICE_API_KEY must be set"),
    );

    const mockDb = createMockDb(wfs, lastRuns);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(0);
    expect(result.skippedNoCampaignService).toBe(true);
    expect(mockDb._updateMock).not.toHaveBeenCalled();
  });

  it("handles multiple features independently", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-a1", slug: "slug-a1", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-a2", slug: "slug-a2", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-a3", slug: "slug-a3", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-a4", slug: "slug-a4", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-b1", slug: "slug-b1", featureSlug: "feat-b" }),
      makeWorkflow({ id: "wf-b2", slug: "slug-b2", featureSlug: "feat-b" }),
    ];

    const lastRuns = [
      { workflowId: "wf-a1", lastRun: "2026-03-30T10:00:00Z" },
      { workflowId: "wf-a2", lastRun: "2026-03-29T10:00:00Z" },
      { workflowId: "wf-a3", lastRun: "2026-03-28T10:00:00Z" },
      { workflowId: "wf-a4", lastRun: "2026-03-27T10:00:00Z" },
      { workflowId: "wf-b1", lastRun: "2026-03-30T10:00:00Z" },
      { workflowId: "wf-b2", lastRun: "2026-03-29T10:00:00Z" },
    ];

    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set<string>());

    const mockDb = createMockDb(wfs, lastRuns);
    const result = await deprecateStaleWorkflows(mockDb as any);

    // Only 1 deprecated (wf-a4 from feat-a). feat-b has only 2
    expect(result.deprecatedCount).toBe(1);
    expect(result.keptByRecency).toBe(5); // 3 from feat-a + 2 from feat-b
  });

  it("workflows with no runs are considered least recent", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-1", slug: "slug-1", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-2", slug: "slug-2", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-3", slug: "slug-3", featureSlug: "feat-a" }),
      makeWorkflow({ id: "wf-no-runs", slug: "slug-no-runs", featureSlug: "feat-a" }),
    ];

    const lastRuns = [
      { workflowId: "wf-1", lastRun: "2026-03-30T10:00:00Z" },
      { workflowId: "wf-2", lastRun: "2026-03-29T10:00:00Z" },
      { workflowId: "wf-3", lastRun: "2026-03-28T10:00:00Z" },
    ];

    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set<string>());

    const mockDb = createMockDb(wfs, lastRuns);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(1); // wf-no-runs deprecated
  });
});
