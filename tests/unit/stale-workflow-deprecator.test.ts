import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock campaign client
const mockFetchActiveWorkflowSlugs = vi.fn();
vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchActiveWorkflowSlugs: (...args: unknown[]) => mockFetchActiveWorkflowSlugs(...args),
}));

// Mock features-service pipe assignments
const mockListLegAssignments = vi.fn();
vi.mock("../../src/lib/catalogue-client.js", () => ({
  listLegAssignments: (...args: unknown[]) => mockListLegAssignments(...args),
}));

// Mock DB
vi.mock("../../src/db/index.js", () => ({
  db: "mock-db",
}));

import { deprecateStaleWorkflows } from "../../src/lib/stale-workflow-deprecator.js";

const TWO_WEEKS_AGO = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  const workflowSlug = overrides.workflowSlug ?? `workflow-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: overrides.id ?? `wf-${Math.random().toString(36).slice(2, 8)}`,
    workflowSlug,
    workflowName: overrides.workflowName ?? "Test Workflow",
    workflowDynastySlug: overrides.workflowDynastySlug ?? workflowSlug,
    workflowDynastyName: overrides.workflowDynastyName ?? "Test Workflow",
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
    mockListLegAssignments.mockReset();
    mockListLegAssignments.mockResolvedValue([]);
  });

  it("returns early with no deprecations when there are no active workflows", async () => {
    const mockDb = createMockDb([], []);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(0);
    expect(mockFetchActiveWorkflowSlugs).not.toHaveBeenCalled();
  });

  it("does not deprecate workflows created less than 1 week ago", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-new", workflowSlug: "slug-new", createdAt: TWO_DAYS_AGO }),
    ];
    const mockDb = createMockDb(wfs, []);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(0);
    expect(mockFetchActiveWorkflowSlugs).not.toHaveBeenCalled();
  });

  it("does not deprecate workflows that have runs", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-1", workflowSlug: "slug-1" }),
      makeWorkflow({ id: "wf-2", workflowSlug: "slug-2" }),
    ];
    const mockDb = createMockDb(wfs, ["wf-1", "wf-2"]);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(0);
    expect(mockFetchActiveWorkflowSlugs).not.toHaveBeenCalled();
  });

  it("deprecates old workflows with zero runs and no active campaign", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-1", workflowSlug: "slug-1" }),
      makeWorkflow({ id: "wf-2", workflowSlug: "slug-2" }),
      // The channel keeps a workflow that runs.
      makeWorkflow({ id: "wf-3", workflowSlug: "slug-3" }),
    ];

    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set<string>());

    const mockDb = createMockDb(wfs, ["wf-3"]);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(2);
    expect(mockDb._updateMock).toHaveBeenCalledTimes(2);
  });

  it("never deprecates the LAST active workflow of a channel (a sourcing pipe runs inside another run: zero runs of its own)", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-old", workflowSlug: "lead-sourcing-old", featureSlug: "lead-sourcing", createdAt: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() }),
      makeWorkflow({ id: "wf-new", workflowSlug: "lead-sourcing-new", featureSlug: "lead-sourcing", createdAt: TWO_WEEKS_AGO }),
      makeWorkflow({ id: "wf-crm", workflowSlug: "sourcing-crm-contacts-x", featureSlug: "sourcing-crm-contacts" }),
    ];
    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set<string>());
    const mockDb = createMockDb(wfs, []);
    const result = await deprecateStaleWorkflows(mockDb as any);
    // The older lead-sourcing workflow goes; the newest one of each channel stays.
    expect(result.deprecatedCount).toBe(1);
    expect(mockDb._updateMock).toHaveBeenCalledTimes(1);
  });

  it("keeps zero-run workflows that are used by active campaigns", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-1", workflowSlug: "slug-1" }),
      makeWorkflow({ id: "wf-2", workflowSlug: "slug-2" }),
    ];

    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set(["slug-1"]));

    const mockDb = createMockDb(wfs, []);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(1); // only wf-2
    expect(result.keptByCampaign).toBe(1);
  });

  it("skips deprecation when campaign-service is unreachable", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-1", workflowSlug: "slug-1" }),
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
      makeWorkflow({ id: "wf-has-runs", workflowSlug: "slug-has-runs" }),
      makeWorkflow({ id: "wf-no-runs", workflowSlug: "slug-no-runs" }),
    ];

    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set<string>());

    const mockDb = createMockDb(wfs, ["wf-has-runs"]);
    const result = await deprecateStaleWorkflows(mockDb as any);

    expect(result.deprecatedCount).toBe(1); // only wf-no-runs
  });

  // Regression (FORM-TRIGGER-1012): ai-meeting-booking runs several pipes. Its form pipe's only workflow, bought by
  // nobody yet, has zero runs: the channel guard did not hold it (the channel has others), the pipe would lose it.
  it("never deprecates the LAST active workflow of a PIPE, even when its channel has others", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-conv", workflowSlug: "amb-conv", featureSlug: "ai-meeting-booking" }),
      makeWorkflow({ id: "wf-form", workflowSlug: "amb-form", featureSlug: "ai-meeting-booking" }),
      makeWorkflow({ id: "wf-spare", workflowSlug: "amb-spare", featureSlug: "ai-meeting-booking" }),
    ];
    const assign = (legKey: string, workflowDynastySlug: string) => ({
      featureSlug: "ai-meeting-booking", legKey, workflowDynastySlug, state: "active", decidedBy: "x", decidedAt: "x", note: null,
    });
    mockListLegAssignments.mockResolvedValue([
      assign("conversation_to_meeting_booked", "amb-conv"),
      assign("conversation_to_meeting_booked", "amb-spare"),
      assign("form_submitted_to_meeting_booked", "amb-form"),
    ]);
    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set<string>());
    const mockDb = createMockDb(wfs, ["wf-conv"]);
    const result = await deprecateStaleWorkflows(mockDb as any);
    // amb-spare goes (amb-conv still serves its pipe); amb-form stays, the only one on its pipe.
    expect(result.deprecatedCount).toBe(1);
    expect(mockListLegAssignments).toHaveBeenCalledWith("ai-meeting-booking");
  });

  // Regression (LEAK-1012): the CRM contacts sourcing pipe carries the generic workflow plus two reachableBy copies;
  // no funnel bought the pipe yet, so none ran. "Zero runs" compares nothing there: all three stay.
  it("keeps every workflow of a pipe on which NO workflow ever ran", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-gen", workflowSlug: "crm-gen", featureSlug: "sourcing-crm-contacts", createdAt: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() }),
      makeWorkflow({ id: "wf-phone", workflowSlug: "crm-phone", featureSlug: "sourcing-crm-contacts" }),
      makeWorkflow({ id: "wf-email", workflowSlug: "crm-email", featureSlug: "sourcing-crm-contacts" }),
    ];
    const assign = (workflowDynastySlug: string) => ({
      featureSlug: "sourcing-crm-contacts", legKey: "start_to_lead_found", workflowDynastySlug, state: "active", decidedBy: "x", decidedAt: "x", note: null,
    });
    mockListLegAssignments.mockResolvedValue([assign("crm-gen"), assign("crm-phone"), assign("crm-email")]);
    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set<string>());
    const result = await deprecateStaleWorkflows(createMockDb(wfs, []) as any);
    expect(result.deprecatedCount).toBe(0);
  });

  it("still deprecates a zero-run workflow on a pipe where another workflow ran", async () => {
    const wfs = [
      makeWorkflow({ id: "wf-gen", workflowSlug: "crm-gen", featureSlug: "sourcing-crm-contacts" }),
      makeWorkflow({ id: "wf-phone", workflowSlug: "crm-phone", featureSlug: "sourcing-crm-contacts" }),
    ];
    const assign = (workflowDynastySlug: string) => ({
      featureSlug: "sourcing-crm-contacts", legKey: "start_to_lead_found", workflowDynastySlug, state: "active", decidedBy: "x", decidedAt: "x", note: null,
    });
    mockListLegAssignments.mockResolvedValue([assign("crm-gen"), assign("crm-phone")]);
    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set<string>());
    const result = await deprecateStaleWorkflows(createMockDb(wfs, ["wf-gen"]) as any);
    expect(result.deprecatedCount).toBe(1);
  });

  it("deprecates nothing when the pipe assignments cannot be read", async () => {
    const wfs = [makeWorkflow({ id: "wf-1", workflowSlug: "slug-1" }), makeWorkflow({ id: "wf-2", workflowSlug: "slug-2" })];
    mockFetchActiveWorkflowSlugs.mockResolvedValue(new Set<string>());
    mockListLegAssignments.mockRejectedValue(new Error("features-service down"));
    const mockDb = createMockDb(wfs, []);
    const result = await deprecateStaleWorkflows(mockDb as any);
    expect(result.deprecatedCount).toBe(0);
    expect(result.skippedNoAssignments).toBe(true);
    expect(mockDb._updateMock).not.toHaveBeenCalled();
  });
});
