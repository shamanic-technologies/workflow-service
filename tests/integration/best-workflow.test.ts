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
  fetchAnthropicKey: vi.fn(),
}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const IDENTITY = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1", "x-brand-id": "brand-1" };
const AUTH = { "x-api-key": "test-api-key", ...IDENTITY };

const BASE_QUERY = {
  orgId: "org1",
  category: "sales",
  channel: "email",
  audienceType: "cold-outreach",
  objective: "replies",
};

const DEFAULT_WF_NAME = "sales-email-cold-outreach-alpha";

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: "wf-" + Math.random().toString(36).slice(2, 10),
    orgId: "org1",
    name: DEFAULT_WF_NAME,
    displayName: null,
    createdForBrandId: null,
    description: null,
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

// Helper: setup email stats mock grouped by workflowName
type StatsOverrides = { sent?: number; delivered?: number; opened?: number; clicked?: number; replied?: number; bounced?: number; unsubscribed?: number; recipients?: number };
function setupEmailMock(statsByName: Record<string, { transactional?: StatsOverrides; broadcast?: StatsOverrides }>) {
  mockFetchEmailStatsAuth.mockResolvedValue(
    Object.entries(statsByName).map(([workflowName, s]) => ({
      workflowName,
      transactional: { ...EMPTY_STATS, ...s.transactional },
      broadcast: { ...EMPTY_STATS, ...s.broadcast },
    }))
  );
}

// Helper: setup cost mocks from runs-service
function setupCostsMock(costsByName: Record<string, { cost: number; runCount: number }>) {
  mockFetchRunCostsAuth.mockResolvedValue(
    Object.entries(costsByName).map(([workflowName, { cost, runCount }]) => ({
      workflowName,
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
  });

  it("returns ranked workflows with stats", async () => {
    const wf = makeWorkflow({ id: "wf-a" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-a", "ext-run-1"), makeRun("wf-a", "ext-run-2"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 300, runCount: 2 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: { transactional: { replied: 10 } } });

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
      expect.objectContaining({ orgId: "org-1" }),
      [DEFAULT_WF_NAME],
    );
    expect(mockFetchEmailStatsAuth).toHaveBeenCalledWith(
      [DEFAULT_WF_NAME],
      expect.objectContaining({ orgId: "org-1" }),
    );
  });

  it("passes all dynasty workflow names to costs and email endpoints", async () => {
    const wfOldName = "sales-email-cold-outreach-old";
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-active" }),
      makeWorkflow({ id: "wf-old", name: wfOldName, status: "deprecated", upgradedTo: "wf-active" }),
    );
    mockWorkflowRunRows.push(makeRun("wf-active", "ext-run-active"), makeRun("wf-old", "ext-run-old"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 100, runCount: 1 }, [wfOldName]: { cost: 200, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: { transactional: { replied: 5 } }, [wfOldName]: { transactional: { replied: 5 } } });

    const res = await request.get("/workflows/ranked").query(BASE_QUERY).set(AUTH);
    expect(res.status).toBe(200);

    // Both dynasty names should be passed to both endpoints
    const costNames = mockFetchRunCostsAuth.mock.calls[0][1] as string[];
    expect(costNames).toHaveLength(2);
    expect(costNames).toContain(DEFAULT_WF_NAME);
    expect(costNames).toContain(wfOldName);

    const emailNames = mockFetchEmailStatsAuth.mock.calls[0][0] as string[];
    expect(emailNames).toHaveLength(2);
    expect(emailNames).toContain(DEFAULT_WF_NAME);
    expect(emailNames).toContain(wfOldName);
  });

  it("uses clicks objective when specified", async () => {
    mockWorkflowRows.push(makeWorkflow({ id: "wf-a" }));
    mockWorkflowRunRows.push(makeRun("wf-a", "ext-run-1"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 500, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: { transactional: { clicked: 25 }, broadcast: { clicked: 25 } } });

    const res = await request.get("/workflows/ranked").query({ ...BASE_QUERY, objective: "clicks" }).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.results[0].stats.totalOutcomes).toBe(50);
    expect(res.body.results[0].stats.costPerOutcome).toBe(10);
  });

  it("returns 404 when no workflows match", async () => {
    const res = await request.get("/workflows/ranked").query(BASE_QUERY).set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No workflows found/);
  });

  it("returns 502 when email-gateway-service fails", async () => {
    mockWorkflowRows.push(makeWorkflow({ id: "wf-a" }));
    mockWorkflowRunRows.push(makeRun("wf-a", "ext-run-1"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 100, runCount: 1 } });
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

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: {} });

    const res = await request.get("/workflows/ranked").query(BASE_QUERY).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.results[0].stats.costPerOutcome).toBeNull();
    expect(res.body.results[0].stats.completedRuns).toBe(1);
  });

  it("includes runs from deprecated predecessor in stats", async () => {
    const wfOldName = "sales-email-cold-outreach-old";
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-active" }),
      makeWorkflow({ id: "wf-old", name: wfOldName, status: "deprecated", upgradedTo: "wf-active" }),
    );
    mockWorkflowRunRows.push(makeRun("wf-active", "ext-run-active"), makeRun("wf-old", "ext-run-old"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 100, runCount: 1 }, [wfOldName]: { cost: 200, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: { transactional: { replied: 5 } }, [wfOldName]: { transactional: { replied: 5 } } });

    const res = await request.get("/workflows/ranked").query(BASE_QUERY).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.results[0].workflow.id).toBe("wf-active");
    expect(res.body.results[0].stats.totalCostInUsdCents).toBe(300);
    expect(res.body.results[0].stats.totalOutcomes).toBe(10);
    expect(res.body.results[0].stats.completedRuns).toBe(2);
  });

  it("aggregates across deep upgrade chain (3 levels)", async () => {
    const nameV2 = "sales-email-cold-outreach-v2";
    const nameV1 = "sales-email-cold-outreach-v1";
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-v3" }),
      makeWorkflow({ id: "wf-v2", name: nameV2, status: "deprecated", upgradedTo: "wf-v3" }),
      makeWorkflow({ id: "wf-v1", name: nameV1, status: "deprecated", upgradedTo: "wf-v2" }),
    );
    mockWorkflowRunRows.push(makeRun("wf-v3", "ext-run-v3"), makeRun("wf-v2", "ext-run-v2"), makeRun("wf-v1", "ext-run-v1"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 50, runCount: 1 }, [nameV2]: { cost: 100, runCount: 1 }, [nameV1]: { cost: 150, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: { transactional: { replied: 5 } }, [nameV2]: { transactional: { replied: 5 } }, [nameV1]: { transactional: { replied: 5 } } });

    const res = await request.get("/workflows/ranked").query(BASE_QUERY).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.results[0].workflow.id).toBe("wf-v3");
    expect(res.body.results[0].stats.totalCostInUsdCents).toBe(300);
    expect(res.body.results[0].stats.totalOutcomes).toBe(15);
    expect(res.body.results[0].stats.completedRuns).toBe(3);
  });

  it("returns multiple workflows ranked when limit > 1", async () => {
    const nameA = "sales-email-cold-outreach-alpha";
    const nameB = "sales-email-cold-outreach-beta";
    const nameC = "sales-email-cold-outreach-gamma";
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-a", name: nameA, signatureName: "alpha" }),
      makeWorkflow({ id: "wf-b", name: nameB, signatureName: "beta" }),
      makeWorkflow({ id: "wf-c", name: nameC, signatureName: "gamma" }),
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

  it("includes displayName and createdForBrandId in workflow response", async () => {
    mockWorkflowRows.push(makeWorkflow({ id: "wf-dn", displayName: "sales-email-cold-outreach-jasmine", createdForBrandId: "brand-123" }));
    mockWorkflowRunRows.push(makeRun("wf-dn", "ext-run-dn"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: { transactional: { replied: 5 } } });

    const res = await request.get("/workflows/ranked").query(BASE_QUERY).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.results[0].workflow.displayName).toBe("sales-email-cold-outreach-jasmine");
    expect(res.body.results[0].workflow.createdForBrandId).toBe("brand-123");
  });

  it("respects limit to cap results", async () => {
    const costs: Record<string, { cost: number; runCount: number }> = {};
    const emails: Record<string, { transactional?: StatsOverrides }> = {};
    for (let i = 0; i < 5; i++) {
      const name = `sales-email-cold-outreach-wf${i}`;
      mockWorkflowRows.push(makeWorkflow({ id: `wf-${i}`, name }));
      mockWorkflowRunRows.push(makeRun(`wf-${i}`, `ext-run-${i}`));
      costs[name] = { cost: 100, runCount: 1 };
      emails[name] = { transactional: { replied: 5 } };
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

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: { transactional: { replied: 5 } } });

    const res = await request.get("/workflows/ranked").query({ ...BASE_QUERY, brandId: "brand-1" }).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });

  it("returns grouped brands with groupBy=brand (from runs)", async () => {
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-1", createdForBrandId: "brand-A" }),
      makeWorkflow({ id: "wf-2", name: "sales-email-cold-outreach-beta", createdForBrandId: "brand-B" }),
    );
    mockWorkflowRunRows.push(makeRun("wf-1", "ext-run-1", "brand-A"), makeRun("wf-2", "ext-run-2", "brand-B"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 100, runCount: 1 }, "sales-email-cold-outreach-beta": { cost: 200, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: { transactional: { replied: 5 } }, "sales-email-cold-outreach-beta": { transactional: { replied: 5 } } });

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
      makeWorkflow({ id: "wf-no-brand", name: "sales-email-cold-outreach-nobrand" }),
    );
    mockWorkflowRunRows.push(makeRun("wf-branded", "ext-run-1", "brand-X"), makeRun("wf-no-brand", "ext-run-2"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 100, runCount: 1 }, "sales-email-cold-outreach-nobrand": { cost: 200, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: { transactional: { replied: 5 } }, "sales-email-cold-outreach-nobrand": { transactional: { replied: 5 } } });

    const res = await request.get("/workflows/ranked").query({ ...BASE_QUERY, groupBy: "brand" }).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.brands).toHaveLength(1);
    expect(res.body.brands[0].brandId).toBe("brand-X");
  });

  it("returns grouped sections with groupBy=section", async () => {
    const nameS1 = "sales-email-cold-outreach-s1";
    const nameS2 = "sales-email-cold-outreach-s2";
    mockWorkflowRows.push(makeWorkflow({ id: "wf-sales", name: nameS1 }), makeWorkflow({ id: "wf-sales2", name: nameS2 }));
    mockWorkflowRunRows.push(makeRun("wf-sales", "ext-run-s1"), makeRun("wf-sales2", "ext-run-s2"));

    setupCostsMock({ [nameS1]: { cost: 100, runCount: 1 }, [nameS2]: { cost: 200, runCount: 1 } });
    setupEmailMock({ [nameS1]: { transactional: { replied: 5, sent: 50, opened: 20 } }, [nameS2]: { transactional: { replied: 5, sent: 50, opened: 20 } } });

    const res = await request.get("/workflows/ranked").query({ ...BASE_QUERY, groupBy: "section" }).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.sections).toBeDefined();
    expect(res.body.sections).toHaveLength(1);
    const section = res.body.sections[0];
    expect(section.sectionKey).toBe("sales-email-cold-outreach");
    expect(section.stats).toBeDefined();
    expect(section.stats.email).toBeDefined();
    expect(section.workflows).toHaveLength(2);
  });
});

// ==================== GET /workflows/best (hero records) ====================

describe("GET /workflows/best (hero records)", () => {
  beforeEach(() => {
    mockWorkflowRows.length = 0;
    mockWorkflowRunRows.length = 0;
    mockFetchRunCostsAuth.mockReset();
    mockFetchEmailStatsAuth.mockReset();
  });

  it("returns bestCostPerOpen and bestCostPerReply", async () => {
    const wf = makeWorkflow({ id: "wf-hero", createdForBrandId: "brand-abc" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-hero", "ext-run-hero"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: { transactional: { opened: 10, replied: 5 } } });

    const res = await request
      .get("/workflows/best")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.bestCostPerOpen).toBeDefined();
    expect(res.body.bestCostPerOpen.workflowId).toBe("wf-hero");
    expect(res.body.bestCostPerOpen.createdForBrandId).toBe("brand-abc");
    expect(res.body.bestCostPerOpen.value).toBe(10); // 100 / 10 opens
    expect(res.body.bestCostPerReply).toBeDefined();
    expect(res.body.bestCostPerReply.workflowId).toBe("wf-hero");
    expect(res.body.bestCostPerReply.value).toBe(20); // 100 / 5 replies
  });

  it("returns null when no opens or replies exist", async () => {
    const wf = makeWorkflow({ id: "wf-no-outcomes" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-no-outcomes", "ext-run-no"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: {} });

    const res = await request
      .get("/workflows/best")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.bestCostPerOpen).toBeNull();
    expect(res.body.bestCostPerReply).toBeNull();
  });

  it("returns 404 when no active workflows exist", async () => {
    const res = await request
      .get("/workflows/best")
      .set(AUTH);

    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await request
      .get("/workflows/best")
      .set(IDENTITY);

    expect(res.status).toBe(401);
  });

  it("includes displayName in hero records", async () => {
    const wf = makeWorkflow({ id: "wf-dn-hero", displayName: "sales-email-cold-outreach-jasmine" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-dn-hero", "ext-run-dn"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: { transactional: { opened: 10, replied: 5 } } });

    const res = await request
      .get("/workflows/best")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.bestCostPerOpen.displayName).toBe("sales-email-cold-outreach-jasmine");
    expect(res.body.bestCostPerReply.displayName).toBe("sales-email-cold-outreach-jasmine");
  });

  it("filters by brandId", async () => {
    const wf1 = makeWorkflow({ id: "wf-b1", createdForBrandId: "brand-target" });
    const wf2 = makeWorkflow({ id: "wf-b2", name: "sales-email-cold-outreach-other", createdForBrandId: "brand-other" });
    mockWorkflowRows.push(wf1, wf2);
    mockWorkflowRunRows.push(makeRun("wf-b1", "ext-run-b1", "brand-target"), makeRun("wf-b2", "ext-run-b2", "brand-other"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 100, runCount: 1 }, "sales-email-cold-outreach-other": { cost: 200, runCount: 1 } });
    setupEmailMock({
      [DEFAULT_WF_NAME]: { transactional: { opened: 10, replied: 5 } },
      "sales-email-cold-outreach-other": { transactional: { opened: 10, replied: 5 } },
    });

    const res = await request
      .get("/workflows/best")
      .query({ brandId: "brand-target" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.bestCostPerOpen.createdForBrandId).toBe("brand-target");
  });

  it("returns best brand with by=brand", async () => {
    const wf1 = makeWorkflow({ id: "wf-1", createdForBrandId: "brand-A" });
    mockWorkflowRows.push(wf1);
    mockWorkflowRunRows.push(makeRun("wf-1", "ext-run-a", "brand-A"), makeRun("wf-1", "ext-run-b", "brand-A"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 600, runCount: 2 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: { transactional: { opened: 20, replied: 10 } } });

    const res = await request
      .get("/workflows/best")
      .query({ by: "brand" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.bestCostPerOpen).toBeDefined();
    expect(res.body.bestCostPerOpen.workflowCount).toBe(1);
    expect(res.body.bestCostPerOpen.value).toBe(30); // 600 / 20
    expect(res.body.bestCostPerReply).toBeDefined();
    expect(res.body.bestCostPerReply.value).toBe(60); // 600 / 10
  });

  it("returns null for by=brand when no branded workflows have outcomes", async () => {
    const wf = makeWorkflow({ id: "wf-no-brand", createdForBrandId: null });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-no-brand", "ext-run-nb"));

    setupCostsMock({ [DEFAULT_WF_NAME]: { cost: 100, runCount: 1 } });
    setupEmailMock({ [DEFAULT_WF_NAME]: { transactional: { opened: 10, replied: 5 } } });

    const res = await request
      .get("/workflows/best")
      .query({ by: "brand" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.bestCostPerOpen).toBeNull();
    expect(res.body.bestCostPerReply).toBeNull();
  });

  it("picks the best from multiple workflows", async () => {
    const nameExp = "sales-email-cold-outreach-expensive";
    const nameCheap = "sales-email-cold-outreach-cheap";
    const wfExpensive = makeWorkflow({ id: "wf-expensive", name: nameExp });
    const wfCheap = makeWorkflow({ id: "wf-cheap", name: nameCheap });
    mockWorkflowRows.push(wfExpensive, wfCheap);
    mockWorkflowRunRows.push(makeRun("wf-expensive", "ext-run-1"), makeRun("wf-cheap", "ext-run-2"));

    setupCostsMock({ [nameExp]: { cost: 500, runCount: 1 }, [nameCheap]: { cost: 500, runCount: 1 } });
    setupEmailMock({
      [nameExp]: { transactional: { opened: 2, replied: 1 } },
      [nameCheap]: { transactional: { opened: 100, replied: 50 } },
    });

    const res = await request
      .get("/workflows/best")
      .set(AUTH);

    expect(res.status).toBe(200);
    // wf-cheap has lower cost-per-open (500/100=5 vs 500/2=250) and cost-per-reply
    expect(res.body.bestCostPerOpen.workflowId).toBe("wf-cheap");
    expect(res.body.bestCostPerReply.workflowId).toBe("wf-cheap");
  });
});
