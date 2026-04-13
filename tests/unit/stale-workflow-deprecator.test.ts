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

const TWO_WEEKS_AGO = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? `wf-${Math.random().toString(36).slice(2, 8)}`,
    slug: overrides.slug ?? `workflow-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name ?? "Test Workflow",
    featureSlug: overrides.featureSlug ?? "sales-cold-email",
    status: "active",
    orgId: "org-1",
    createdAt: overrides.createdAt ?? TWO_WEEKS_AGO,
    ...overrides,
  };
}

function createMockDb(activeWorkflows: unknown[], runWorkflowIds: string[]) {
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
          // Second select: workflow IDs that have runs
          return {
            where: vi.fn().mockResolvedValue(
              runWorkflowIds.map((id) => ({ workflowId: id })),
            ),
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

  it("does not deprecate workflows created less than 1 week ago", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-new", slug: "slug-new", createdAt: TWO_DAYS_AGO }),
    ];
    const mockDb = createMockDb(wfs, []);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(0);
    expect(mockFetchActiveWorkflowSlugs).not.toHaveBeenCalled();
  });

  it("does not deprecate workflows that have runs", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-1", slug: "slug-1" }),
      makeWorkflow({ id: "wf-2", slug: "slug-2" }),
    ];
    const mockDb = createMockDb(wfs, ["wf-1", "wf-2"]);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(0);
    expect(mockFetchActiveWorkflowSlugs).not.toHaveBeenCalled();
  });

  it("deprecates old workflows with zero runs and no active campaign", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-1", slug: "slug-1" }),
      makeWorkflow({ id: "wf-2", slug: "slug-2" }),
    ];

    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set<string>());

    const mockDb = createMockDb(wfs, []);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(2);
    expect(mockDb._updateMock).toHaveBeenCalledTimes(2);
  });

  it("keeps zero-run workflows that are used by active campaigns", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-1", slug: "slug-1" }),
      makeWorkflow({ id: "wf-2", slug: "slug-2" }),
    ];

    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set(["slug-1"]));

    const mockDb = createMockDb(wfs, []);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(1); // only wf-2
    expect(result.keptByCampaign).toBe(1);
  });

  it("skips deprecation when campaign-service is unreachable", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-1", slug: "slug-1" }),
    ];

    mockFetchActiveWorkflowSlugs.mockRejectedValue(
      new Error("CAMPAIGN_SERVICE_URL and CAMPAIGN_SERVICE_API_KEY must be set"),
    );

    const mockDb = createMockDb(wfs, []);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(0);
    expect(result.skippedNoCampaignService).toBe(true);
    expect(mockDb._updateMock).not.toHaveBeenCalled();
  });

  it("only deprecates workflows with zero runs, keeps those with runs", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-has-runs", slug: "slug-has-runs" }),
      makeWorkflow({ id: "wf-no-runs", slug: "slug-no-runs" }),
    ];

    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set<string>());

    const mockDb = createMockDb(wfs, ["wf-has-runs"]);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(1); // only wf-no-runs
  });
});
