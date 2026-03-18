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

const EMPTY_STATS = {
  sent: 0, delivered: 0, opened: 0, clicked: 0,
  replied: 0, bounced: 0, unsubscribed: 0, recipients: 0,
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

// ==================== GET /public/workflows/ranked ====================

describe("GET /public/workflows/ranked", () => {
  beforeEach(() => {
    mockWorkflowRows.length = 0;
    mockWorkflowRunRows.length = 0;
    mockFetchRunCosts.mockReset();
    mockFetchEmailStats.mockReset();
  });

  it("returns ranked workflows without auth headers", async () => {
    const wf = makeWorkflow({ id: "wf-pub" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-pub", "ext-run-1"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-1", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, replied: 10 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/public/workflows/ranked")
      .query({ category: "sales", channel: "email", audienceType: "cold-outreach" });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].workflow.id).toBe("wf-pub");
    expect(res.body.results[0].stats.totalCostInUsdCents).toBe(100);
    expect(res.body.results[0].stats.email.transactional.replied).toBe(10);
  });

  it("does NOT include dag field in response", async () => {
    const wf = makeWorkflow({ id: "wf-nodag" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-nodag", "ext-run-1"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-1", totalCostInUsdCents: 50 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, replied: 5 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/public/workflows/ranked")
      .query({ category: "sales", channel: "email", audienceType: "cold-outreach" });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).not.toHaveProperty("dag");
  });

  it("uses system identity for downstream calls", async () => {
    const wf = makeWorkflow({ id: "wf-sys" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-sys", "ext-run-1"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-1", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS },
      broadcast: { ...EMPTY_STATS },
    });

    await request
      .get("/public/workflows/ranked")
      .query({ category: "sales", channel: "email", audienceType: "cold-outreach" });

    // Verify system identity was passed to downstream services
    expect(mockFetchEmailStats).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ orgId: "system", userId: "system", runId: "system-public" }),
    );
  });

  it("supports groupBy=section", async () => {
    const wf = makeWorkflow({ id: "wf-sec" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-sec", "ext-run-1"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-1", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, replied: 5, sent: 50 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/public/workflows/ranked")
      .query({ groupBy: "section" });

    expect(res.status).toBe(200);
    expect(res.body.sections).toBeDefined();
    expect(res.body.sections).toHaveLength(1);
    expect(res.body.sections[0].sectionKey).toBe("sales-email-cold-outreach");
    expect(res.body.sections[0].workflows[0]).not.toHaveProperty("dag");
  });

  it("returns 404 when no workflows match", async () => {
    const res = await request
      .get("/public/workflows/ranked")
      .query({ category: "sales", channel: "email", audienceType: "cold-outreach" });

    expect(res.status).toBe(404);
  });

  it("supports groupBy=brand", async () => {
    const wf1 = makeWorkflow({ id: "wf-b1", brandId: "brand-x" });
    const wf2 = makeWorkflow({ id: "wf-b2", brandId: "brand-x" });
    const wfNoBrand = makeWorkflow({ id: "wf-nb", brandId: null });
    mockWorkflowRows.push(wf1, wf2, wfNoBrand);
    mockWorkflowRunRows.push(
      makeRun("wf-b1", "ext-run-b1"),
      makeRun("wf-b2", "ext-run-b2"),
      makeRun("wf-nb", "ext-run-nb"),
    );

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-b1", totalCostInUsdCents: 100 },
      { runId: "ext-run-b2", totalCostInUsdCents: 200 },
      { runId: "ext-run-nb", totalCostInUsdCents: 50 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, replied: 5 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/public/workflows/ranked")
      .query({ groupBy: "brand" });

    expect(res.status).toBe(200);
    expect(res.body.brands).toBeDefined();
    expect(res.body.brands).toHaveLength(1); // only brand-x, wf without brand excluded
    expect(res.body.brands[0].brandId).toBe("brand-x");
    expect(res.body.brands[0].workflows).toHaveLength(2);
    expect(res.body.brands[0].workflows[0]).not.toHaveProperty("dag");
  });

  it("supports brandId filter", async () => {
    const wf = makeWorkflow({ id: "wf-filtered", brandId: "brand-y" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-filtered", "ext-run-f"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-f", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, replied: 10 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/public/workflows/ranked")
      .query({ brandId: "brand-y" });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].workflow.id).toBe("wf-filtered");
  });
});

// ==================== GET /public/workflows/best ====================

describe("GET /public/workflows/best", () => {
  beforeEach(() => {
    mockWorkflowRows.length = 0;
    mockWorkflowRunRows.length = 0;
    mockFetchRunCosts.mockReset();
    mockFetchEmailStats.mockReset();
  });

  it("returns hero records without auth headers", async () => {
    const wf = makeWorkflow({ id: "wf-hero-pub", brandId: "brand-abc" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-hero-pub", "ext-run-hero"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-hero", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, opened: 10, replied: 5 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/public/workflows/best");

    expect(res.status).toBe(200);
    expect(res.body.bestCostPerOpen).toBeDefined();
    expect(res.body.bestCostPerOpen.workflowId).toBe("wf-hero-pub");
    expect(res.body.bestCostPerOpen.brandId).toBe("brand-abc");
    expect(res.body.bestCostPerOpen.value).toBe(10); // 100 / 10 opens
    expect(res.body.bestCostPerReply.workflowId).toBe("wf-hero-pub");
    expect(res.body.bestCostPerReply.value).toBe(20); // 100 / 5 replies
  });

  it("returns null when no opens or replies exist", async () => {
    const wf = makeWorkflow({ id: "wf-no-out" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-no-out", "ext-run-no"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-no", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/public/workflows/best");

    expect(res.status).toBe(200);
    expect(res.body.bestCostPerOpen).toBeNull();
    expect(res.body.bestCostPerReply).toBeNull();
  });

  it("returns 404 when no active workflows exist", async () => {
    const res = await request
      .get("/public/workflows/best");

    expect(res.status).toBe(404);
  });

  it("uses system identity for downstream calls", async () => {
    const wf = makeWorkflow({ id: "wf-sys-best" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-sys-best", "ext-run-1"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-1", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, opened: 10 },
      broadcast: { ...EMPTY_STATS },
    });

    await request.get("/public/workflows/best");

    expect(mockFetchRunCosts).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ orgId: "system", userId: "system", runId: "system-public" }),
    );
  });

  it("supports by=brand", async () => {
    const wf1 = makeWorkflow({ id: "wf-brand1", brandId: "brand-a" });
    const wf2 = makeWorkflow({ id: "wf-brand2", brandId: "brand-b" });
    mockWorkflowRows.push(wf1, wf2);
    mockWorkflowRunRows.push(
      makeRun("wf-brand1", "ext-run-br1"),
      makeRun("wf-brand2", "ext-run-br2"),
    );

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-br1", totalCostInUsdCents: 100 },
      { runId: "ext-run-br2", totalCostInUsdCents: 500 },
    ]);
    // brand-a: 100 cost / 10 opens = 10 cost-per-open, 100 / 5 replies = 20 cost-per-reply
    mockFetchEmailStats
      .mockResolvedValueOnce({ transactional: { ...EMPTY_STATS, opened: 10, replied: 5 }, broadcast: { ...EMPTY_STATS } })
      // brand-b: 500 cost / 100 opens = 5 cost-per-open, 500 / 50 replies = 10 cost-per-reply
      .mockResolvedValueOnce({ transactional: { ...EMPTY_STATS, opened: 100, replied: 50 }, broadcast: { ...EMPTY_STATS } });

    const res = await request
      .get("/public/workflows/best")
      .query({ by: "brand" });

    expect(res.status).toBe(200);
    // brand-b has lower cost-per-open (5) and cost-per-reply (10)
    expect(res.body.bestCostPerOpen.brandId).toBe("brand-b");
    expect(res.body.bestCostPerOpen.workflowCount).toBe(1);
    expect(res.body.bestCostPerReply.brandId).toBe("brand-b");
  });

  it("supports brandId filter", async () => {
    const wf = makeWorkflow({ id: "wf-brand-filter", brandId: "brand-z" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-brand-filter", "ext-run-bz"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-bz", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, opened: 10, replied: 5 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/public/workflows/best")
      .query({ brandId: "brand-z" });

    expect(res.status).toBe(200);
    expect(res.body.bestCostPerOpen.brandId).toBe("brand-z");
  });
});
