import { describe, it, expect, vi, beforeEach } from "vitest";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";

// --- Mock DB with table awareness ---
const mockWorkflowRows: Record<string, unknown>[] = [];
const mockWorkflowRunRows: Record<string, unknown>[] = [];

// Track the last queried workflow IDs so mock .where() can filter workflow_runs
let lastQueriedWorkflowIds: string[] | null = null;

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    eq: (...args: unknown[]) => {
      // eq(workflowRuns.workflowId, id) — capture the single ID (skip status strings like "completed")
      if (args.length === 2 && typeof args[1] === "string" && args[1].startsWith("wf-")) {
        lastQueriedWorkflowIds = [args[1]];
      }
      return (actual.eq as Function)(...args);
    },
    inArray: (...args: unknown[]) => {
      // inArray(workflowRuns.workflowId, ids) — capture the array
      if (args.length === 2 && Array.isArray(args[1]) && args[1].length > 0 && typeof args[1][0] === "string" && args[1][0].startsWith("wf-")) {
        lastQueriedWorkflowIds = args[1] as string[];
      }
      return (actual.inArray as Function)(...args);
    },
  };
});

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        const newRow = {
          id: "wf-" + Math.random().toString(36).slice(2, 10),
          ...row,
          windmillWorkspace: row.windmillWorkspace ?? "prod",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mockWorkflowRows.push(newRow);
        return {
          returning: () => Promise.resolve([newRow]),
        };
      },
    }),
    select: () => ({
      from: (table: unknown) => {
        const isWorkflowRuns =
          table &&
          typeof table === "object" &&
          "workflowId" in (table as Record<string, unknown>);

        if (isWorkflowRuns) {
          const result = Promise.resolve(mockWorkflowRunRows);
          (result as any).where = (_condition?: unknown) => {
            const ids = lastQueriedWorkflowIds;
            lastQueriedWorkflowIds = null;
            if (ids) {
              return Promise.resolve(
                mockWorkflowRunRows.filter((r) => ids.includes(r.workflowId as string))
              );
            }
            return Promise.resolve(mockWorkflowRunRows);
          };
          return result;
        }

        const rows = mockWorkflowRows;
        const result = Promise.resolve(rows);
        (result as any).where = (_condition?: unknown) => Promise.resolve(rows);
        return result;
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const row = mockWorkflowRows[mockWorkflowRows.length - 1];
          if (row) Object.assign(row, values);
          return {
            returning: () => Promise.resolve([{ ...row, ...values }]),
          };
        },
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
  },
  sql: {
    end: () => Promise.resolve(),
  },
}));

// --- Mock stats-client ---
const mockFetchRunCostsAuth = vi.fn();
const mockFetchEmailStatsAuth = vi.fn();

vi.mock("../../src/lib/stats-client.js", () => ({
  fetchRunCostsAuth: (...args: unknown[]) => mockFetchRunCostsAuth(...args),
  fetchEmailStatsAuth: (...args: unknown[]) => mockFetchEmailStatsAuth(...args),
}));

// --- Mock Windmill ---
vi.mock("../../src/lib/windmill-client.js", () => ({
  getWindmillClient: () => ({
    createFlow: vi.fn().mockResolvedValue("f/workflows/test/flow"),
    updateFlow: vi.fn().mockResolvedValue(undefined),
    deleteFlow: vi.fn().mockResolvedValue(undefined),
    getFlow: vi.fn().mockResolvedValue({ path: "f/workflows/test/flow" }),
    healthCheck: vi.fn().mockResolvedValue(true),
  }),
  WindmillClient: vi.fn(),
  resetWindmillClient: vi.fn(),
}));

// --- Mock key-service ---
vi.mock("../../src/lib/key-service-client.js", () => ({
  fetchProviderRequirements: vi.fn(),
}));

// --- Mock features-client ---
const mockResolveFeatureDynastySlugs = vi.fn();
const mockFetchFeatureOutputs = vi.fn();
const mockFetchStatsRegistry = vi.fn();

vi.mock("../../src/lib/features-client.js", () => ({
  resolveFeatureDynasty: vi.fn().mockImplementation((featureSlug: string) => {
    const dynastySlug = featureSlug.replace(/-v\d+$/, "");
    const dynastyName = dynastySlug
      .split("-")
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    return Promise.resolve({ featureDynastyName: dynastyName, featureDynastySlug: dynastySlug });
  }),
  resolveFeatureDynastySlugs: (...args: unknown[]) => mockResolveFeatureDynastySlugs(...args),
  fetchFeatureOutputs: (...args: unknown[]) => mockFetchFeatureOutputs(...args),
  fetchStatsRegistry: (...args: unknown[]) => mockFetchStatsRegistry(...args),
}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const IDENTITY = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1", "x-brand-id": "brand-1" };
const AUTH = { "x-api-key": "test-api-key", ...IDENTITY };

const BASE_QUERY = {
  orgId: "org1",
  featureSlug: "sales-cold-email-outreach",
  objective: "replies",
};

const DEFAULT_WF_SLUG = "sales-email-cold-outreach-alpha";

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: "wf-" + Math.random().toString(36).slice(2, 10),
    orgId: "org1",
    slug: DEFAULT_WF_SLUG,
    name: "Sales Email Cold Outreach Alpha",
    dynastyName: "Sales Email Cold Outreach Alpha",
    dynastySlug: "sales-email-cold-outreach-alpha",
    version: 1,
    createdForBrandId: null,
    description: null,
    featureSlug: "sales-cold-email-outreach",
    category: "sales",
    channel: "email",
    audienceType: "cold-outreach",
    signature: "sig-" + Math.random().toString(36).slice(2, 8),
    signatureName: "alpha",
    dag: VALID_LINEAR_DAG,
    windmillFlowPath: "f/workflows/test/flow",
    windmillWorkspace: "prod",
    status: "active",
    upgradedTo: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const EMPTY_STATS = {
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  replied: 0,
  bounced: 0,
  unsubscribed: 0,
  recipients: 0,
};

function makeRun(workflowId: string, runId: string, brandId?: string | null) {
  return {
    id: "wr-" + Math.random().toString(36).slice(2, 10),
    workflowId,
    runId,
    orgId: "org1",
    brandId: brandId ?? null,
    campaignId: null,
    subrequestId: null,
    windmillJobId: "wm-job-1",
    windmillWorkspace: "prod",
    status: "completed",
    inputs: null,
    result: null,
    error: null,
    startedAt: new Date(),
    completedAt: new Date(),
    createdAt: new Date(),
  };
}

// Helper: setup email stats mock grouped by workflowSlug
type StatsOverrides = { sent?: number; delivered?: number; opened?: number; clicked?: number; replied?: number; bounced?: number; unsubscribed?: number; recipients?: number };
function setupEmailMock(statsBySlug: Record<string, { transactional?: StatsOverrides; broadcast?: StatsOverrides }>) {
  mockFetchEmailStatsAuth.mockResolvedValue(
    Object.entries(statsBySlug).map(([workflowSlug, s]) => ({
      workflowSlug,
      transactional: { ...EMPTY_STATS, ...s.transactional },
      broadcast: { ...EMPTY_STATS, ...s.broadcast },
    }))
  );
}

// Helper: setup cost mocks from runs-service
function setupCostsMock(costsBySlug: Record<string, { cost: number; runCount: number }>) {
  mockFetchRunCostsAuth.mockResolvedValue(
    Object.entries(costsBySlug).map(([workflowSlug, { cost, runCount }]) => ({
      workflowSlug,
      totalCostInUsdCents: cost,
      runCount,
    }))
  );
}

// ==================== GET /workflows/ranked ====================

describe("GET /workflows/ranked", () => {
  beforeEach(() => {
    mockWorkflowRows.length = 0;
    mockWorkflowRunRows.length = 0;
    mockFetchRunCostsAuth.mockReset();
    mockFetchEmailStatsAuth.mockReset();
    mockResolveFeatureDynastySlugs.mockReset();
    mockFetchFeatureOutputs.mockReset();
    mockFetchStatsRegistry.mockReset();
  });

  it("returns ranked workflows with stats", async () => {
    const wf = makeWorkflow({ id: "wf-a" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-a", "ext-run-1"), makeRun("wf-a", "ext-run-2"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 300, runCount: 2 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { replied: 10 } } });

    const res = await request.get("/workflows/ranked").query(BASE_QUERY).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    const best = res.body.results[0];
    expect(best.workflow.id).toBe("wf-a");
    expect(best.dag).toBeDefined();
    expect(best.stats.totalCostInUsdCents).toBe(300);
    expect(best.stats.totalOutcomes).toBe(10);
    expect(best.stats.costPerOutcome).toBe(30);
    expect(best.stats.completedRuns).toBe(2);
    expect(best.stats.email.transactional.replied).toBe(10);
    expect(best.stats.email.broadcast).toEqual(EMPTY_STATS);
    // Verify workflowNames filter is passed to both endpoints
    expect(mockFetchRunCostsAuth).toHaveBeenCalledWith(
      expect.objectContaining({ "x-org-id": "org-1" }),
      [DEFAULT_WF_SLUG],
    );
    expect(mockFetchEmailStatsAuth).toHaveBeenCalledWith(
      [DEFAULT_WF_SLUG],
      expect.objectContaining({ "x-org-id": "org-1" }),
    );
  });

  it("passes only active workflow slug to costs and email endpoints (no dynasty aggregation)", async () => {
    const wfOldName = "sales-email-cold-outreach-old";
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-active" }),
      makeWorkflow({ id: "wf-old", slug: wfOldName, status: "deprecated", upgradedTo: "wf-active" }),
    );
    mockWorkflowRunRows.push(makeRun("wf-active", "ext-run-active"), makeRun("wf-old", "ext-run-old"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { replied: 5 } } });

    const res = await request.get("/workflows/ranked").query(BASE_QUERY).set(AUTH);
    expect(res.status).toBe(200);

    // Only active workflow slug is passed — no dynasty chain aggregation
    const costNames = mockFetchRunCostsAuth.mock.calls[0][1] as string[];
    expect(costNames).toHaveLength(1);
    expect(costNames).toContain(DEFAULT_WF_SLUG);

    const emailNames = mockFetchEmailStatsAuth.mock.calls[0][0] as string[];
    expect(emailNames).toHaveLength(1);
    expect(emailNames).toContain(DEFAULT_WF_SLUG);
  });

  it("uses clicks objective when specified", async () => {
    mockWorkflowRows.push(makeWorkflow({ id: "wf-a" }));
    mockWorkflowRunRows.push(makeRun("wf-a", "ext-run-1"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 500, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { clicked: 25 }, broadcast: { clicked: 25 } } });

    const res = await request.get("/workflows/ranked").query({ ...BASE_QUERY, objective: "clicks" }).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.results[0].stats.totalOutcomes).toBe(50);
    expect(res.body.results[0].stats.costPerOutcome).toBe(10);
  });

  it("returns 200 with empty results when no workflows match", async () => {
    const res = await request.get("/workflows/ranked").query(BASE_QUERY).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });

  it("returns 502 when email-gateway-service fails", async () => {
    mockWorkflowRows.push(makeWorkflow({ id: "wf-a" }));
    mockWorkflowRunRows.push(makeRun("wf-a", "ext-run-1"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 100, runCount: 1 } });
    mockFetchEmailStatsAuth.mockRejectedValue(
      new Error("email-gateway-service error: GET /stats -> 500 Internal Server Error: boom")
    );

    const res = await request.get("/workflows/ranked").query(BASE_QUERY).set(AUTH);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/email-gateway-service error/);
  });

  it("requires authentication", async () => {
    const res = await request.get("/workflows/ranked").set(IDENTITY).query(BASE_QUERY);
    expect(res.status).toBe(401);
  });

  it("handles workflow with zero outcomes (costPerOutcome is null)", async () => {
    mockWorkflowRows.push(makeWorkflow({ id: "wf-a" }));
    mockWorkflowRunRows.push(makeRun("wf-a", "ext-run-1"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: {} });

    const res = await request.get("/workflows/ranked").query(BASE_QUERY).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.results[0].stats.costPerOutcome).toBeNull();
    expect(res.body.results[0].stats.completedRuns).toBe(1);
  });

  it("excludes deprecated predecessor stats (slug-level only)", async () => {
    const wfOldName = "sales-email-cold-outreach-old";
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-active" }),
      makeWorkflow({ id: "wf-old", slug: wfOldName, status: "deprecated", upgradedTo: "wf-active" }),
    );
    mockWorkflowRunRows.push(makeRun("wf-active", "ext-run-active"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { replied: 5 } } });

    const res = await request.get("/workflows/ranked").query(BASE_QUERY).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.results[0].workflow.id).toBe("wf-active");
    // Only active slug's stats — no dynasty aggregation
    expect(res.body.results[0].stats.totalCostInUsdCents).toBe(100);
    expect(res.body.results[0].stats.totalOutcomes).toBe(5);
    expect(res.body.results[0].stats.completedRuns).toBe(1);
  });

  it("returns only active slug stats even with deep upgrade chain", async () => {
    const nameV2 = "sales-email-cold-outreach-v2";
    const nameV1 = "sales-email-cold-outreach-v1";
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-v3" }),
      makeWorkflow({ id: "wf-v2", slug: nameV2, status: "deprecated", upgradedTo: "wf-v3" }),
      makeWorkflow({ id: "wf-v1", slug: nameV1, status: "deprecated", upgradedTo: "wf-v2" }),
    );
    mockWorkflowRunRows.push(makeRun("wf-v3", "ext-run-v3"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 50, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { replied: 5 } } });

    const res = await request.get("/workflows/ranked").query(BASE_QUERY).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.results[0].workflow.id).toBe("wf-v3");
    // Only v3 stats — no dynasty chain aggregation
    expect(res.body.results[0].stats.totalCostInUsdCents).toBe(50);
    expect(res.body.results[0].stats.totalOutcomes).toBe(5);
    expect(res.body.results[0].stats.completedRuns).toBe(1);
  });

  it("returns multiple workflows ranked when limit > 1", async () => {
    const nameA = "sales-email-cold-outreach-alpha";
    const nameB = "sales-email-cold-outreach-beta";
    const nameC = "sales-email-cold-outreach-gamma";
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-a", slug: nameA, signatureName: "alpha" }),
      makeWorkflow({ id: "wf-b", slug: nameB, signatureName: "beta" }),
      makeWorkflow({ id: "wf-c", slug: nameC, signatureName: "gamma" }),
    );
    mockWorkflowRunRows.push(makeRun("wf-a", "ext-run-a"), makeRun("wf-b", "ext-run-b"), makeRun("wf-c", "ext-run-c"));

    setupCostsMock({ [nameA]: { cost: 100, runCount: 1 }, [nameB]: { cost: 200, runCount: 1 }, [nameC]: { cost: 50, runCount: 1 } });
    setupEmailMock({
      [nameA]: { transactional: { replied: 10 } },
      [nameB]: { transactional: { replied: 5 } },
      [nameC]: { transactional: { replied: 25 } },
    });

    const res = await request.get("/workflows/ranked").query({ ...BASE_QUERY, limit: "3" }).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0].workflow.id).toBe("wf-c");
    expect(res.body.results[1].workflow.id).toBe("wf-a");
    expect(res.body.results[2].workflow.id).toBe("wf-b");
  });

  it("includes name, dynastyName and createdForBrandId in workflow response", async () => {
    mockWorkflowRows.push(makeWorkflow({ id: "wf-dn", name: "Sales Email Cold Outreach Jasmine", dynastyName: "Sales Email Cold Outreach Jasmine", createdForBrandId: "brand-123" }));
    mockWorkflowRunRows.push(makeRun("wf-dn", "ext-run-dn"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { replied: 5 } } });

    const res = await request.get("/workflows/ranked").query(BASE_QUERY).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.results[0].workflow.name).toBe("Sales Email Cold Outreach Jasmine");
    expect(res.body.results[0].workflow.dynastyName).toBe("Sales Email Cold Outreach Jasmine");
    expect(res.body.results[0].workflow.createdForBrandId).toBe("brand-123");
  });

  it("respects limit to cap results", async () => {
    const costs: Record<string, { cost: number; runCount: number }> = {};
    const emails: Record<string, { transactional?: StatsOverrides }> = {};
    for (let i = 0; i < 5; i++) {
      const slug = `sales-email-cold-outreach-wf${i}`;
      mockWorkflowRows.push(makeWorkflow({ id: `wf-${i}`, slug }));
      mockWorkflowRunRows.push(makeRun(`wf-${i}`, `ext-run-${i}`));
      costs[slug] = { cost: 100, runCount: 1 };
      emails[slug] = { transactional: { replied: 5 } };
    }

    setupCostsMock(costs);
    setupEmailMock(emails);

    const res = await request.get("/workflows/ranked").query({ ...BASE_QUERY, limit: "2" }).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
  });

  it("filters by brandId from runs", async () => {
    mockWorkflowRows.push(makeWorkflow({ id: "wf-1", createdForBrandId: "brand-1" }));
    mockWorkflowRunRows.push(makeRun("wf-1", "ext-run-1", "brand-1"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { replied: 5 } } });

    const res = await request.get("/workflows/ranked").query({ ...BASE_QUERY, brandId: "brand-1" }).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });

  it("returns grouped brands with groupBy=brand (from runs)", async () => {
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-1", createdForBrandId: "brand-A" }),
      makeWorkflow({ id: "wf-2", slug: "sales-email-cold-outreach-beta", createdForBrandId: "brand-B" }),
    );
    mockWorkflowRunRows.push(makeRun("wf-1", "ext-run-1", "brand-A"), makeRun("wf-2", "ext-run-2", "brand-B"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 100, runCount: 1 }, "sales-email-cold-outreach-beta": { cost: 200, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { replied: 5 } }, "sales-email-cold-outreach-beta": { transactional: { replied: 5 } } });

    const res = await request.get("/workflows/ranked").query({ ...BASE_QUERY, groupBy: "brand" }).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.brands).toBeDefined();
    expect(res.body.brands).toHaveLength(2);
    const brandA = res.body.brands.find((b: { brandId: string }) => b.brandId === "brand-A");
    const brandB = res.body.brands.find((b: { brandId: string }) => b.brandId === "brand-B");
    expect(brandA).toBeDefined();
    expect(brandA.workflows).toHaveLength(1);
    expect(brandB).toBeDefined();
    expect(brandB.workflows).toHaveLength(1);
  });

  it("excludes runs without brandId when groupBy=brand", async () => {
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-branded", createdForBrandId: "brand-X" }),
      makeWorkflow({ id: "wf-no-brand", slug: "sales-email-cold-outreach-nobrand" }),
    );
    mockWorkflowRunRows.push(makeRun("wf-branded", "ext-run-1", "brand-X"), makeRun("wf-no-brand", "ext-run-2"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 100, runCount: 1 }, "sales-email-cold-outreach-nobrand": { cost: 200, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { replied: 5 } }, "sales-email-cold-outreach-nobrand": { transactional: { replied: 5 } } });

    const res = await request.get("/workflows/ranked").query({ ...BASE_QUERY, groupBy: "brand" }).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.brands).toHaveLength(1);
    expect(res.body.brands[0].brandId).toBe("brand-X");
  });

  it("returns grouped features with groupBy=feature", async () => {
    const nameS1 = "sales-cold-email-outreach-s1";
    const nameS2 = "sales-cold-email-outreach-s2";
    mockWorkflowRows.push(makeWorkflow({ id: "wf-sales", slug: nameS1 }), makeWorkflow({ id: "wf-sales2", slug: nameS2 }));
    mockWorkflowRunRows.push(makeRun("wf-sales", "ext-run-s1"), makeRun("wf-sales2", "ext-run-s2"));

    setupCostsMock({ [nameS1]: { cost: 100, runCount: 1 }, [nameS2]: { cost: 200, runCount: 1 } });
    setupEmailMock({ [nameS1]: { transactional: { replied: 5, sent: 50, opened: 20 } }, [nameS2]: { transactional: { replied: 5, sent: 50, opened: 20 } } });

    const res = await request.get("/workflows/ranked").query({ ...BASE_QUERY, groupBy: "feature" }).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.features).toBeDefined();
    expect(res.body.features).toHaveLength(1);
    const feature = res.body.features[0];
    expect(feature.featureSlug).toBe("sales-cold-email-outreach");
    expect(feature.stats).toBeDefined();
    expect(feature.stats.email).toBeDefined();
    expect(feature.workflows).toHaveLength(2);
  });

  it("accepts featureDynastySlug as alternative to featureSlug for objective resolution", async () => {
    const wf = makeWorkflow({ id: "wf-dynasty-ranked" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-dynasty-ranked", "ext-run-dr1"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 200, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { replied: 8 } } });

    // Mock dynasty resolution → returns the matching featureSlug
    mockResolveFeatureDynastySlugs.mockResolvedValue(["sales-cold-email-outreach", "sales-cold-email-outreach-v2"]);
    // Mock feature outputs → emailsReplied is a count metric
    mockFetchFeatureOutputs.mockResolvedValue([{ key: "emailsReplied", displayOrder: 0 }]);
    mockFetchStatsRegistry.mockResolvedValue({ emailsReplied: { type: "count", label: "Replies" } });

    const res = await request.get("/workflows/ranked").query({
      orgId: "org1",
      featureDynastySlug: "sales-cold-email-outreach",
    }).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].stats.totalOutcomes).toBe(8);
  });

  it("returns 400 when neither objective, featureSlug, nor featureDynastySlug is provided", async () => {
    const res = await request.get("/workflows/ranked").query({ orgId: "org1" }).set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/objective.*featureSlug.*featureDynastySlug/);
  });
});

// ==================== GET /workflows/best (hero records) ====================

describe("GET /workflows/best (hero records)", () => {
  beforeEach(() => {
    mockWorkflowRows.length = 0;
    mockWorkflowRunRows.length = 0;
    mockFetchRunCostsAuth.mockReset();
    mockFetchEmailStatsAuth.mockReset();
    mockResolveFeatureDynastySlugs.mockReset();
    mockFetchFeatureOutputs.mockReset();
    mockFetchStatsRegistry.mockReset();
  });

  // Helper: set up features mocks for best endpoint (which requires featureSlug or featureDynastySlug)
  function setupFeaturesMock(outputs: Array<{ key: string; displayOrder: number }> = [{ key: "emailsReplied", displayOrder: 0 }]) {
    mockFetchFeatureOutputs.mockResolvedValue(outputs);
    mockFetchStatsRegistry.mockResolvedValue(
      Object.fromEntries(outputs.map((o) => [o.key, { type: "count", label: o.key }]))
    );
  }

  const BEST_QUERY = { featureSlug: "sales-cold-email-outreach" };

  it("returns best record keyed by metric", async () => {
    const wf = makeWorkflow({ id: "wf-hero", createdForBrandId: "brand-abc" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-hero", "ext-run-hero"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { replied: 5 } } });
    setupFeaturesMock([{ key: "emailsReplied", displayOrder: 0 }]);

    const res = await request
      .get("/workflows/best")
      .query(BEST_QUERY)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied).toBeDefined();
    expect(res.body.best.emailsReplied.workflowId).toBe("wf-hero");
    expect(res.body.best.emailsReplied.createdForBrandId).toBe("brand-abc");
    expect(res.body.best.emailsReplied.value).toBe(20); // 100 / 5 replies
  });

  it("returns null when no outcomes exist", async () => {
    const wf = makeWorkflow({ id: "wf-no-outcomes" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-no-outcomes", "ext-run-no"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: {} });
    setupFeaturesMock([{ key: "emailsReplied", displayOrder: 0 }]);

    const res = await request
      .get("/workflows/best")
      .query(BEST_QUERY)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied).toBeNull();
  });

  it("returns 200 with null records when no active workflows exist", async () => {
    setupFeaturesMock([{ key: "emailsReplied", displayOrder: 0 }]);

    const res = await request
      .get("/workflows/best")
      .query(BEST_QUERY)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied).toBeNull();
  });

  it("returns 400 when neither featureSlug nor featureDynastySlug is provided", async () => {
    const res = await request
      .get("/workflows/best")
      .set(AUTH);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/featureSlug.*featureDynastySlug/);
  });

  it("requires authentication", async () => {
    const res = await request
      .get("/workflows/best")
      .set(IDENTITY);

    expect(res.status).toBe(401);
  });

  it("includes workflowName in hero records", async () => {
    const wf = makeWorkflow({ id: "wf-dn-hero", name: "Sales Email Cold Outreach Jasmine" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-dn-hero", "ext-run-dn"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { replied: 5 } } });
    setupFeaturesMock([{ key: "emailsReplied", displayOrder: 0 }]);

    const res = await request
      .get("/workflows/best")
      .query(BEST_QUERY)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied.workflowName).toBe("Sales Email Cold Outreach Jasmine");
  });

  it("filters by brandId", async () => {
    const wf1 = makeWorkflow({ id: "wf-b1", createdForBrandId: "brand-target" });
    const wf2 = makeWorkflow({ id: "wf-b2", slug: "sales-email-cold-outreach-other", createdForBrandId: "brand-other" });
    mockWorkflowRows.push(wf1, wf2);
    mockWorkflowRunRows.push(makeRun("wf-b1", "ext-run-b1", "brand-target"), makeRun("wf-b2", "ext-run-b2", "brand-other"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 100, runCount: 1 }, "sales-email-cold-outreach-other": { cost: 200, runCount: 1 } });
    setupEmailMock({
      [DEFAULT_WF_SLUG]: { transactional: { replied: 5 } },
      "sales-email-cold-outreach-other": { transactional: { replied: 5 } },
    });
    setupFeaturesMock([{ key: "emailsReplied", displayOrder: 0 }]);

    const res = await request
      .get("/workflows/best")
      .query({ ...BEST_QUERY, brandId: "brand-target" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied.createdForBrandId).toBe("brand-target");
  });

  it("returns best brand with by=brand", async () => {
    const wf1 = makeWorkflow({ id: "wf-1", createdForBrandId: "brand-A" });
    mockWorkflowRows.push(wf1);
    mockWorkflowRunRows.push(makeRun("wf-1", "ext-run-a", "brand-A"), makeRun("wf-1", "ext-run-b", "brand-A"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 600, runCount: 2 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { replied: 10 } } });
    setupFeaturesMock([{ key: "emailsReplied", displayOrder: 0 }]);

    const res = await request
      .get("/workflows/best")
      .query({ ...BEST_QUERY, by: "brand" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied).toBeDefined();
    expect(res.body.best.emailsReplied.workflowCount).toBe(1);
    expect(res.body.best.emailsReplied.value).toBe(60); // 600 / 10
  });

  it("returns null for by=brand when no branded workflows have outcomes", async () => {
    const wf = makeWorkflow({ id: "wf-no-brand", createdForBrandId: null });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-no-brand", "ext-run-nb"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { replied: 5 } } });
    setupFeaturesMock([{ key: "emailsReplied", displayOrder: 0 }]);

    const res = await request
      .get("/workflows/best")
      .query({ ...BEST_QUERY, by: "brand" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied).toBeNull();
  });

  it("picks the best from multiple workflows", async () => {
    const nameExp = "sales-email-cold-outreach-expensive";
    const nameCheap = "sales-email-cold-outreach-cheap";
    const wfExpensive = makeWorkflow({ id: "wf-expensive", slug: nameExp });
    const wfCheap = makeWorkflow({ id: "wf-cheap", slug: nameCheap });
    mockWorkflowRows.push(wfExpensive, wfCheap);
    mockWorkflowRunRows.push(makeRun("wf-expensive", "ext-run-1"), makeRun("wf-cheap", "ext-run-2"));

    setupCostsMock({ [nameExp]: { cost: 500, runCount: 1 }, [nameCheap]: { cost: 500, runCount: 1 } });
    setupEmailMock({
      [nameExp]: { transactional: { replied: 1 } },
      [nameCheap]: { transactional: { replied: 50 } },
    });
    setupFeaturesMock([{ key: "emailsReplied", displayOrder: 0 }]);

    const res = await request
      .get("/workflows/best")
      .query(BEST_QUERY)
      .set(AUTH);

    expect(res.status).toBe(200);
    // wf-cheap has lower cost-per-reply (500/50=10 vs 500/1=500)
    expect(res.body.best.emailsReplied.workflowId).toBe("wf-cheap");
  });

  it("accepts featureDynastySlug as alternative to featureSlug", async () => {
    const wf = makeWorkflow({ id: "wf-dynasty-best" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-dynasty-best", "ext-run-db1"));

    setupCostsMock({ [DEFAULT_WF_SLUG]: { cost: 200, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_SLUG]: { transactional: { replied: 10 } } });
    setupFeaturesMock([{ key: "emailsReplied", displayOrder: 0 }]);
    mockResolveFeatureDynastySlugs.mockResolvedValue(["sales-cold-email-outreach", "sales-cold-email-outreach-v2"]);

    const res = await request
      .get("/workflows/best")
      .query({ featureDynastySlug: "sales-cold-email-outreach" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied).toBeDefined();
    expect(res.body.best.emailsReplied.workflowId).toBe("wf-dynasty-best");
    expect(res.body.best.emailsReplied.value).toBe(20); // 200 / 10
  });
});

describe("GET /workflows/dynasties", () => {
  beforeEach(() => {
    mockWorkflowRows.length = 0;
  });

  it("returns all dynasties grouped with their slugs", async () => {
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-1", slug: "cold-email-sequoia", dynastySlug: "cold-email-sequoia", dynastyName: "Cold Email Sequoia" }),
      makeWorkflow({ id: "wf-2", slug: "cold-email-sequoia-v2", dynastySlug: "cold-email-sequoia", dynastyName: "Cold Email Sequoia" }),
      makeWorkflow({ id: "wf-3", slug: "warm-intro", dynastySlug: "warm-intro", dynastyName: "Warm Intro" }),
    );

    const res = await request.get("/workflows/dynasties").set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.dynasties).toHaveLength(2);

    const coldEmail = res.body.dynasties.find((d: { dynastySlug: string }) => d.dynastySlug === "cold-email-sequoia");
    expect(coldEmail).toBeDefined();
    expect(coldEmail.dynastyName).toBe("Cold Email Sequoia");
    expect(coldEmail.slugs).toHaveLength(2);
    expect(coldEmail.slugs).toContain("cold-email-sequoia");
    expect(coldEmail.slugs).toContain("cold-email-sequoia-v2");

    const warmIntro = res.body.dynasties.find((d: { dynastySlug: string }) => d.dynastySlug === "warm-intro");
    expect(warmIntro).toBeDefined();
    expect(warmIntro.slugs).toEqual(["warm-intro"]);
  });

  it("returns empty array when no workflows exist", async () => {
    const res = await request.get("/workflows/dynasties").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.dynasties).toEqual([]);
  });
});

describe("GET /workflows/dynasty/slugs", () => {
  beforeEach(() => {
    mockWorkflowRows.length = 0;
    mockWorkflowRunRows.length = 0;
  });

  it("returns all slugs for a dynasty", async () => {
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-v1", slug: "cold-email-sequoia", dynastySlug: "cold-email-sequoia", dynastyName: "Cold Email Sequoia", version: 1, status: "deprecated" }),
      makeWorkflow({ id: "wf-v2", slug: "cold-email-sequoia-v2", dynastySlug: "cold-email-sequoia", dynastyName: "Cold Email Sequoia", version: 2, status: "deprecated" }),
      makeWorkflow({ id: "wf-v3", slug: "cold-email-sequoia-v3", dynastySlug: "cold-email-sequoia", dynastyName: "Cold Email Sequoia", version: 3, status: "active" }),
    );

    const res = await request.get("/workflows/dynasty/slugs").query({ dynastySlug: "cold-email-sequoia" }).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.dynastySlug).toBe("cold-email-sequoia");
    expect(res.body.dynastyName).toBe("Cold Email Sequoia");
    expect(res.body.slugs).toHaveLength(3);
    expect(res.body.slugs).toContain("cold-email-sequoia");
    expect(res.body.slugs).toContain("cold-email-sequoia-v2");
    expect(res.body.slugs).toContain("cold-email-sequoia-v3");
  });

  it("returns 400 when dynastySlug is missing", async () => {
    const res = await request.get("/workflows/dynasty/slugs").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dynastySlug/);
  });

  it("returns 404 when no workflows match", async () => {
    const res = await request.get("/workflows/dynasty/slugs").query({ dynastySlug: "nonexistent" }).set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe("GET /workflows/dynasty/stats", () => {
  beforeEach(() => {
    mockWorkflowRows.length = 0;
    mockWorkflowRunRows.length = 0;
    mockFetchRunCostsAuth.mockReset();
    mockFetchEmailStatsAuth.mockReset();
  });

  it("aggregates stats across dynasty chain", async () => {
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-v2", slug: "cold-email-sequoia-v2", dynastySlug: "cold-email-sequoia", dynastyName: "Cold Email Sequoia", version: 2, status: "active" }),
      makeWorkflow({ id: "wf-v1", slug: "cold-email-sequoia", dynastySlug: "cold-email-sequoia", dynastyName: "Cold Email Sequoia", version: 1, status: "deprecated", upgradedTo: "wf-v2" }),
    );
    mockWorkflowRunRows.push(makeRun("wf-v2", "ext-run-v2"), makeRun("wf-v1", "ext-run-v1"));

    setupCostsMock({ "cold-email-sequoia-v2": { cost: 100, runCount: 1 }, "cold-email-sequoia": { cost: 200, runCount: 1 } });
    setupEmailMock({ "cold-email-sequoia-v2": { transactional: { replied: 5 } }, "cold-email-sequoia": { transactional: { replied: 10 } } });

    const res = await request.get("/workflows/dynasty/stats").query({ dynastySlug: "cold-email-sequoia", objective: "emailsReplied" }).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.dynastySlug).toBe("cold-email-sequoia");
    expect(res.body.dynastyName).toBe("Cold Email Sequoia");
    // Dynasty-level: aggregated across both versions
    expect(res.body.stats.totalCostInUsdCents).toBe(300);
    expect(res.body.stats.totalOutcomes).toBe(15);
    expect(res.body.stats.completedRuns).toBe(2);
  });

  it("returns 400 when dynastySlug is missing", async () => {
    const res = await request.get("/workflows/dynasty/stats").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dynastySlug/);
  });

  it("returns 404 when no workflows match", async () => {
    const res = await request.get("/workflows/dynasty/stats").query({ dynastySlug: "nonexistent", objective: "emailsReplied" }).set(AUTH);
    expect(res.status).toBe(404);
  });
});
