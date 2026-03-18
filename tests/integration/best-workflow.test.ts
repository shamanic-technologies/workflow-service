import { describe, it, expect, vi, beforeEach } from "vitest";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";

// --- Mock DB with table awareness ---
const mockWorkflowRows: Record<string, unknown>[] = [];
const mockWorkflowRunRows: Record<string, unknown>[] = [];

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

        const rows = isWorkflowRuns ? mockWorkflowRunRows : mockWorkflowRows;
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
const mockFetchRunCosts = vi.fn();
const mockFetchEmailStats = vi.fn();

vi.mock("../../src/lib/stats-client.js", () => ({
  fetchRunCosts: (...args: unknown[]) => mockFetchRunCosts(...args),
  fetchEmailStats: (...args: unknown[]) => mockFetchEmailStats(...args),
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
const IDENTITY = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1" };
const AUTH = { "x-api-key": "test-api-key", ...IDENTITY };

const BASE_QUERY = {
  orgId: "org1",
  category: "sales",
  channel: "email",
  audienceType: "cold-outreach",
  objective: "replies",
};

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: "wf-" + Math.random().toString(36).slice(2, 10),
    orgId: "org1",
    name: "sales-email-cold-outreach-alpha",
    displayName: null,
    brandId: null,
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

function makeRun(workflowId: string, runId: string) {
  return {
    id: "wr-" + Math.random().toString(36).slice(2, 10),
    workflowId,
    runId,
    orgId: "org1",
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

// ==================== GET /workflows/ranked ====================

describe("GET /workflows/ranked", () => {
  beforeEach(() => {
    mockWorkflowRows.length = 0;
    mockWorkflowRunRows.length = 0;
    mockFetchRunCosts.mockReset();
    mockFetchEmailStats.mockReset();
  });

  it("returns ranked workflows with stats", async () => {
    const wf = makeWorkflow({ id: "wf-a" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(
      makeRun("wf-a", "ext-run-1"),
      makeRun("wf-a", "ext-run-2"),
    );

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-1", totalCostInUsdCents: 100 },
      { runId: "ext-run-2", totalCostInUsdCents: 200 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, replied: 10 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/workflows/ranked")
      .query(BASE_QUERY)
      .set(AUTH);

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
  });

  it("uses clicks objective when specified", async () => {
    const wf = makeWorkflow({ id: "wf-a" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-a", "ext-run-1"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-1", totalCostInUsdCents: 500 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, clicked: 25 },
      broadcast: { ...EMPTY_STATS, clicked: 25 },
    });

    const res = await request
      .get("/workflows/ranked")
      .query({ ...BASE_QUERY, objective: "clicks" })
      .set(AUTH);

    expect(res.status).toBe(200);
    const best = res.body.results[0];
    expect(best.stats.totalOutcomes).toBe(50);
    expect(best.stats.costPerOutcome).toBe(10);
  });

  it("returns 404 when no workflows match", async () => {
    const res = await request
      .get("/workflows/ranked")
      .query(BASE_QUERY)
      .set(AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No workflows found/);
  });

  it("returns 502 when email-gateway-service fails", async () => {
    mockWorkflowRows.push(makeWorkflow({ id: "wf-a" }));
    mockWorkflowRunRows.push(makeRun("wf-a", "ext-run-1"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-1", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockRejectedValue(
      new Error(
        "email-gateway-service error: POST /stats -> 500 Internal Server Error: boom"
      )
    );

    const res = await request
      .get("/workflows/ranked")
      .query(BASE_QUERY)
      .set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/email-gateway-service error/);
  });

  it("requires authentication", async () => {
    const res = await request
      .get("/workflows/ranked")
      .set(IDENTITY)
      .query(BASE_QUERY);

    expect(res.status).toBe(401);
  });

  it("handles workflow with zero outcomes (costPerOutcome is null)", async () => {
    mockWorkflowRows.push(makeWorkflow({ id: "wf-a" }));
    mockWorkflowRunRows.push(makeRun("wf-a", "ext-run-1"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-1", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/workflows/ranked")
      .query(BASE_QUERY)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.results[0].stats.costPerOutcome).toBeNull();
    expect(res.body.results[0].stats.completedRuns).toBe(1);
  });

  it("includes runs from deprecated predecessor in stats", async () => {
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-active" }),
      makeWorkflow({ id: "wf-old", status: "deprecated", upgradedTo: "wf-active" }),
    );
    mockWorkflowRunRows.push(
      makeRun("wf-active", "ext-run-active"),
      makeRun("wf-old", "ext-run-old"),
    );

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-active", totalCostInUsdCents: 100 },
      { runId: "ext-run-old", totalCostInUsdCents: 200 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, replied: 10 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/workflows/ranked")
      .query(BASE_QUERY)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.results[0].workflow.id).toBe("wf-active");
    expect(res.body.results[0].stats.totalCostInUsdCents).toBe(300);
    expect(res.body.results[0].stats.completedRuns).toBe(2);
  });

  it("aggregates across deep upgrade chain (3 levels)", async () => {
    mockWorkflowRows.push(
      makeWorkflow({ id: "wf-v3" }),
      makeWorkflow({ id: "wf-v2", status: "deprecated", upgradedTo: "wf-v3" }),
      makeWorkflow({ id: "wf-v1", status: "deprecated", upgradedTo: "wf-v2" }),
    );
    mockWorkflowRunRows.push(
      makeRun("wf-v3", "ext-run-v3"),
      makeRun("wf-v2", "ext-run-v2"),
      makeRun("wf-v1", "ext-run-v1"),
    );

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-v3", totalCostInUsdCents: 50 },
      { runId: "ext-run-v2", totalCostInUsdCents: 100 },
      { runId: "ext-run-v1", totalCostInUsdCents: 150 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, replied: 15 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/workflows/ranked")
      .query(BASE_QUERY)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.results[0].workflow.id).toBe("wf-v3");
    expect(res.body.results[0].stats.totalCostInUsdCents).toBe(300);
    expect(res.body.results[0].stats.completedRuns).toBe(3);
  });

  it("returns multiple workflows ranked when limit > 1", async () => {
    const wfA = makeWorkflow({ id: "wf-a", signatureName: "alpha" });
    const wfB = makeWorkflow({ id: "wf-b", signatureName: "beta" });
    const wfC = makeWorkflow({ id: "wf-c", signatureName: "gamma" });
    mockWorkflowRows.push(wfA, wfB, wfC);
    mockWorkflowRunRows.push(
      makeRun("wf-a", "ext-run-a"),
      makeRun("wf-b", "ext-run-b"),
      makeRun("wf-c", "ext-run-c"),
    );

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-a", totalCostInUsdCents: 100 },
      { runId: "ext-run-b", totalCostInUsdCents: 200 },
      { runId: "ext-run-c", totalCostInUsdCents: 50 },
    ]);
    mockFetchEmailStats
      .mockResolvedValueOnce({ transactional: { ...EMPTY_STATS, replied: 10 }, broadcast: { ...EMPTY_STATS } })
      .mockResolvedValueOnce({ transactional: { ...EMPTY_STATS, replied: 5 }, broadcast: { ...EMPTY_STATS } })
      .mockResolvedValueOnce({ transactional: { ...EMPTY_STATS, replied: 25 }, broadcast: { ...EMPTY_STATS } });

    const res = await request
      .get("/workflows/ranked")
      .query({ ...BASE_QUERY, limit: "3" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    // Sorted by costPerOutcome: wf-c (2), wf-a (10), wf-b (40)
    expect(res.body.results[0].workflow.id).toBe("wf-c");
    expect(res.body.results[1].workflow.id).toBe("wf-a");
    expect(res.body.results[2].workflow.id).toBe("wf-b");
  });

  it("includes displayName and brandId in workflow response", async () => {
    const wf = makeWorkflow({ id: "wf-dn", displayName: "sales-email-cold-outreach-jasmine", brandId: "brand-123" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-dn", "ext-run-dn"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-dn", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, replied: 5 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/workflows/ranked")
      .query(BASE_QUERY)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.results[0].workflow.displayName).toBe("sales-email-cold-outreach-jasmine");
    expect(res.body.results[0].workflow.brandId).toBe("brand-123");
  });

  it("respects limit to cap results", async () => {
    for (let i = 0; i < 5; i++) {
      mockWorkflowRows.push(makeWorkflow({ id: `wf-${i}` }));
      mockWorkflowRunRows.push(makeRun(`wf-${i}`, `ext-run-${i}`));
    }

    mockFetchRunCosts.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ runId: `ext-run-${i}`, totalCostInUsdCents: 100 }))
    );
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, replied: 5 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/workflows/ranked")
      .query({ ...BASE_QUERY, limit: "2" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
  });

  it("returns grouped sections with groupBy=section", async () => {
    const wfSales = makeWorkflow({ id: "wf-sales", category: "sales", channel: "email", audienceType: "cold-outreach" });
    const wfSales2 = makeWorkflow({ id: "wf-sales2", category: "sales", channel: "email", audienceType: "cold-outreach" });
    mockWorkflowRows.push(wfSales, wfSales2);
    mockWorkflowRunRows.push(
      makeRun("wf-sales", "ext-run-s1"),
      makeRun("wf-sales2", "ext-run-s2"),
    );

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-s1", totalCostInUsdCents: 100 },
      { runId: "ext-run-s2", totalCostInUsdCents: 200 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, replied: 5, sent: 50, opened: 20 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/workflows/ranked")
      .query({ ...BASE_QUERY, groupBy: "section" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.sections).toBeDefined();
    expect(res.body.sections).toHaveLength(1);
    const section = res.body.sections[0];
    expect(section.sectionKey).toBe("sales-email-cold-outreach");
    expect(section.category).toBe("sales");
    expect(section.channel).toBe("email");
    expect(section.audienceType).toBe("cold-outreach");
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
    mockFetchRunCosts.mockReset();
    mockFetchEmailStats.mockReset();
  });

  it("returns bestCostPerOpen and bestCostPerReply", async () => {
    const wf = makeWorkflow({ id: "wf-hero", brandId: "brand-abc" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-hero", "ext-run-hero"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-hero", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, opened: 10, replied: 5 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/workflows/best")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.bestCostPerOpen).toBeDefined();
    expect(res.body.bestCostPerOpen.workflowId).toBe("wf-hero");
    expect(res.body.bestCostPerOpen.brandId).toBe("brand-abc");
    expect(res.body.bestCostPerOpen.value).toBe(10); // 100 / 10 opens
    expect(res.body.bestCostPerReply).toBeDefined();
    expect(res.body.bestCostPerReply.workflowId).toBe("wf-hero");
    expect(res.body.bestCostPerReply.value).toBe(20); // 100 / 5 replies
  });

  it("returns null when no opens or replies exist", async () => {
    const wf = makeWorkflow({ id: "wf-no-outcomes" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-no-outcomes", "ext-run-no"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-no", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS },
      broadcast: { ...EMPTY_STATS },
    });

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

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-dn", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, opened: 10, replied: 5 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/workflows/best")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.bestCostPerOpen.displayName).toBe("sales-email-cold-outreach-jasmine");
    expect(res.body.bestCostPerReply.displayName).toBe("sales-email-cold-outreach-jasmine");
  });

  it("picks the best from multiple workflows", async () => {
    // Mock DB returns all runs for all workflows, so both workflows see the same runs.
    // To test ranking, we use different mockFetchEmailStats responses per workflow call.
    // wf-expensive gets called first (higher cost-per-outcome), wf-cheap second (lower).
    const wfExpensive = makeWorkflow({ id: "wf-expensive" });
    const wfCheap = makeWorkflow({ id: "wf-cheap" });
    mockWorkflowRows.push(wfExpensive, wfCheap);
    mockWorkflowRunRows.push(
      makeRun("wf-expensive", "ext-run-1"),
      makeRun("wf-cheap", "ext-run-2"),
    );

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-1", totalCostInUsdCents: 500 },
      { runId: "ext-run-2", totalCostInUsdCents: 500 },
    ]);
    // First call (wf-expensive): low opens/replies → high cost-per
    mockFetchEmailStats
      .mockResolvedValueOnce({ transactional: { ...EMPTY_STATS, opened: 2, replied: 1 }, broadcast: { ...EMPTY_STATS } })
      // Second call (wf-cheap): high opens/replies → low cost-per
      .mockResolvedValueOnce({ transactional: { ...EMPTY_STATS, opened: 100, replied: 50 }, broadcast: { ...EMPTY_STATS } });

    const res = await request
      .get("/workflows/best")
      .set(AUTH);

    expect(res.status).toBe(200);
    // wf-cheap has lower cost-per-open (1000/100=10 vs 1000/2=500) and cost-per-reply
    expect(res.body.bestCostPerOpen.workflowId).toBe("wf-cheap");
    expect(res.body.bestCostPerReply.workflowId).toBe("wf-cheap");
  });
});
