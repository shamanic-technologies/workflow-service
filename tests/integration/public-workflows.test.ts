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
const mockFetchRunCostsAuth = vi.fn();
const mockFetchEmailStatsAuth = vi.fn();
const mockFetchRunCostsPublic = vi.fn();
const mockFetchEmailStatsPublic = vi.fn();

vi.mock("../../src/lib/stats-client.js", () => ({
  fetchRunCostsAuth: (...args: unknown[]) => mockFetchRunCostsAuth(...args),
  fetchEmailStatsAuth: (...args: unknown[]) => mockFetchEmailStatsAuth(...args),
  fetchRunCostsPublic: (...args: unknown[]) => mockFetchRunCostsPublic(...args),
  fetchEmailStatsPublic: (...args: unknown[]) => mockFetchEmailStatsPublic(...args),
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
vi.mock("../../src/lib/features-client.js", () => ({
  resolveFeatureDynasty: vi.fn().mockImplementation((featureSlug: string) => {
    const dynastySlug = featureSlug.replace(/-v\d+$/, "");
    const dynastyName = dynastySlug
      .split("-")
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    return Promise.resolve({ featureDynastyName: dynastyName, featureDynastySlug: dynastySlug });
  }),
  resolveFeatureDynastySlugs: vi.fn().mockImplementation((dynastySlug: string) => {
    return Promise.resolve([dynastySlug, `${dynastySlug}-v2`, `${dynastySlug}-v3`]);
  }),
  fetchFeatureOutputs: vi.fn().mockResolvedValue([{ key: "emailsReplied", displayOrder: 0 }]),
  fetchStatsRegistry: vi.fn().mockResolvedValue({ emailsReplied: { type: "count", label: "Replies" } }),
}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);

const EMPTY_STATS = {
  sent: 0, delivered: 0, opened: 0, clicked: 0,
  replied: 0, bounced: 0, unsubscribed: 0, recipients: 0,
};

const DEFAULT_WF_SLUG = "sales-email-cold-outreach-alpha";

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: "wf-" + Math.random().toString(36).slice(2, 10),
    orgId: "org1",
    slug: DEFAULT_WF_SLUG,
    name: "Sales Email Cold Outreach Alpha",
    dynastyName: "Sales Email Cold Outreach Alpha",
    version: 1,
    createdForBrandId: null,
    description: null,
    featureSlug: "sales-email-cold-outreach",
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

function makeRun(workflowId: string, runId: string, brandId?: string | null) {
  return {
    id: "wr-" + Math.random().toString(36).slice(2, 10),
    workflowId,
    runId,
    orgId: "org1",
    brandIds: brandId ? [brandId] : null,
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

function makeEmailGroup(workflowSlug: string, overrides: { transactional?: Partial<typeof EMPTY_STATS>; broadcast?: Partial<typeof EMPTY_STATS> } = {}) {
  return {
    workflowSlug,
    transactional: { ...EMPTY_STATS, ...overrides.transactional },
    broadcast: { ...EMPTY_STATS, ...overrides.broadcast },
  };
}

// ==================== GET /public/workflows/ranked ====================

describe("GET /public/workflows/ranked", () => {
  beforeEach(() => {
    mockWorkflowRows.length = 0;
    mockWorkflowRunRows.length = 0;
    mockFetchRunCostsAuth.mockReset();
    mockFetchEmailStatsAuth.mockReset();
    mockFetchRunCostsPublic.mockReset();
    mockFetchEmailStatsPublic.mockReset();
  });

  const RANKED_QUERY = { objective: "emailsReplied" };

  it("returns ranked workflows without auth headers", async () => {
    const wf = makeWorkflow({ id: "wf-pub" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-pub", "ext-run-1"));

    mockFetchRunCostsPublic.mockResolvedValue([
      { workflowSlug: DEFAULT_WF_SLUG, totalCostInUsdCents: 100, runCount: 1 },
    ]);
    mockFetchEmailStatsPublic.mockResolvedValue([
      makeEmailGroup(DEFAULT_WF_SLUG, { transactional: { replied: 10 } }),
    ]);

    const res = await request
      .get("/public/workflows/ranked")
      .query(RANKED_QUERY);

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

    mockFetchRunCostsPublic.mockResolvedValue([
      { workflowSlug: DEFAULT_WF_SLUG, totalCostInUsdCents: 50, runCount: 1 },
    ]);
    mockFetchEmailStatsPublic.mockResolvedValue([
      makeEmailGroup(DEFAULT_WF_SLUG, { transactional: { replied: 5 } }),
    ]);

    const res = await request
      .get("/public/workflows/ranked")
      .query(RANKED_QUERY);

    expect(res.status).toBe(200);
    expect(res.body.results[0]).not.toHaveProperty("dag");
  });

  it("calls public fetch functions without identity", async () => {
    const wf = makeWorkflow({ id: "wf-sys" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-sys", "ext-run-1"));

    mockFetchRunCostsPublic.mockResolvedValue([]);
    mockFetchEmailStatsPublic.mockResolvedValue([]);

    await request
      .get("/public/workflows/ranked")
      .query(RANKED_QUERY);

    // Verify public functions are called
    expect(mockFetchRunCostsPublic).toHaveBeenCalled();
    expect(mockFetchEmailStatsPublic).toHaveBeenCalled();
    // Verify auth functions are NOT called
    expect(mockFetchRunCostsAuth).not.toHaveBeenCalled();
    expect(mockFetchEmailStatsAuth).not.toHaveBeenCalled();
  });

  it("supports groupBy=feature", async () => {
    const wf = makeWorkflow({ id: "wf-sec" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-sec", "ext-run-1"));

    mockFetchRunCostsPublic.mockResolvedValue([
      { workflowSlug: DEFAULT_WF_SLUG, totalCostInUsdCents: 100, runCount: 1 },
    ]);
    mockFetchEmailStatsPublic.mockResolvedValue([
      makeEmailGroup(DEFAULT_WF_SLUG, { transactional: { replied: 5, sent: 50 } }),
    ]);

    const res = await request
      .get("/public/workflows/ranked")
      .query({ ...RANKED_QUERY, groupBy: "feature" });

    expect(res.status).toBe(200);
    expect(res.body.features).toBeDefined();
    expect(res.body.features).toHaveLength(1);
    expect(res.body.features[0].featureSlug).toBe("sales-email-cold-outreach");
    expect(res.body.features[0].workflows[0]).not.toHaveProperty("dag");
  });

  it("returns 200 with empty results when no workflows match", async () => {
    const res = await request
      .get("/public/workflows/ranked")
      .query(RANKED_QUERY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });

  it("supports groupBy=brand (from runs)", async () => {
    const wf1 = makeWorkflow({ id: "wf-1" });
    mockWorkflowRows.push(wf1);
    mockWorkflowRunRows.push(
      makeRun("wf-1", "ext-run-1", "brand-x"),
      makeRun("wf-1", "ext-run-2", "brand-y"),
    );

    mockFetchRunCostsPublic.mockResolvedValue([
      { workflowSlug: DEFAULT_WF_SLUG, totalCostInUsdCents: 350, runCount: 2 },
    ]);
    mockFetchEmailStatsPublic.mockResolvedValue([
      makeEmailGroup(DEFAULT_WF_SLUG, { transactional: { replied: 5 } }),
    ]);

    const res = await request
      .get("/public/workflows/ranked")
      .query({ ...RANKED_QUERY, groupBy: "brand" });

    expect(res.status).toBe(200);
    expect(res.body.brands).toBeDefined();
    expect(res.body.brands).toHaveLength(2);
    expect(res.body.brands[0].workflows[0]).not.toHaveProperty("dag");
  });

  it("supports brandId filter (from runs)", async () => {
    const wf1 = makeWorkflow({ id: "wf-filtered" });
    mockWorkflowRows.push(wf1);
    mockWorkflowRunRows.push(
      makeRun("wf-filtered", "ext-run-f", "brand-y"),
    );

    mockFetchRunCostsPublic.mockResolvedValue([
      { workflowSlug: DEFAULT_WF_SLUG, totalCostInUsdCents: 100, runCount: 1 },
    ]);
    mockFetchEmailStatsPublic.mockResolvedValue([
      makeEmailGroup(DEFAULT_WF_SLUG, { transactional: { replied: 10 } }),
    ]);

    const res = await request
      .get("/public/workflows/ranked")
      .query({ ...RANKED_QUERY, brandId: "brand-y" });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });
});

// ==================== GET /public/workflows/best ====================

describe("GET /public/workflows/best", () => {
  beforeEach(() => {
    mockWorkflowRows.length = 0;
    mockWorkflowRunRows.length = 0;
    mockFetchRunCostsAuth.mockReset();
    mockFetchEmailStatsAuth.mockReset();
    mockFetchRunCostsPublic.mockReset();
    mockFetchEmailStatsPublic.mockReset();
  });

  const BEST_QUERY = { featureSlug: "sales-email-cold-outreach" };

  it("returns hero records without auth headers", async () => {
    const wf = makeWorkflow({ id: "wf-hero-pub", createdForBrandId: "brand-abc" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-hero-pub", "ext-run-hero"));

    mockFetchRunCostsPublic.mockResolvedValue([
      { workflowSlug: DEFAULT_WF_SLUG, totalCostInUsdCents: 100, runCount: 1 },
    ]);
    mockFetchEmailStatsPublic.mockResolvedValue([
      makeEmailGroup(DEFAULT_WF_SLUG, { transactional: { replied: 5 } }),
    ]);

    const res = await request
      .get("/public/workflows/best")
      .query(BEST_QUERY);

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied).toBeDefined();
    expect(res.body.best.emailsReplied.workflowId).toBe("wf-hero-pub");
    expect(res.body.best.emailsReplied.createdForBrandId).toBe("brand-abc");
    expect(res.body.best.emailsReplied.value).toBe(20); // 100 / 5 replies
  });

  it("returns null when no outcomes exist", async () => {
    const wf = makeWorkflow({ id: "wf-no-out" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-no-out", "ext-run-no"));

    mockFetchRunCostsPublic.mockResolvedValue([
      { workflowSlug: DEFAULT_WF_SLUG, totalCostInUsdCents: 100, runCount: 1 },
    ]);
    mockFetchEmailStatsPublic.mockResolvedValue([
      makeEmailGroup(DEFAULT_WF_SLUG),
    ]);

    const res = await request
      .get("/public/workflows/best")
      .query(BEST_QUERY);

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied).toBeNull();
  });

  it("returns 200 with null records when no active workflows exist", async () => {
    const res = await request
      .get("/public/workflows/best")
      .query(BEST_QUERY);

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied).toBeNull();
  });

  it("returns 400 when neither featureSlug nor featureDynastySlug is provided", async () => {
    const res = await request
      .get("/public/workflows/best");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/featureSlug.*featureDynastySlug/);
  });

  it("calls public fetch functions without identity", async () => {
    const wf = makeWorkflow({ id: "wf-sys-best" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-sys-best", "ext-run-1"));

    mockFetchRunCostsPublic.mockResolvedValue([]);
    mockFetchEmailStatsPublic.mockResolvedValue([
      makeEmailGroup(DEFAULT_WF_SLUG, { transactional: { replied: 10 } }),
    ]);

    await request.get("/public/workflows/best").query(BEST_QUERY);

    expect(mockFetchRunCostsPublic).toHaveBeenCalled();
    expect(mockFetchEmailStatsPublic).toHaveBeenCalled();
    expect(mockFetchRunCostsAuth).not.toHaveBeenCalled();
    expect(mockFetchEmailStatsAuth).not.toHaveBeenCalled();
  });

  it("supports by=brand (from runs)", async () => {
    const wf1 = makeWorkflow({ id: "wf-1" });
    mockWorkflowRows.push(wf1);
    mockWorkflowRunRows.push(
      makeRun("wf-1", "ext-run-a", "brand-a"),
      makeRun("wf-1", "ext-run-b", "brand-b"),
    );

    mockFetchRunCostsPublic.mockResolvedValue([
      { workflowSlug: DEFAULT_WF_SLUG, totalCostInUsdCents: 600, runCount: 2 },
    ]);
    mockFetchEmailStatsPublic.mockResolvedValue([
      makeEmailGroup(DEFAULT_WF_SLUG, { transactional: { replied: 10 } }),
    ]);

    const res = await request
      .get("/public/workflows/best")
      .query({ ...BEST_QUERY, by: "brand" });

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied).toBeDefined();
    expect(res.body.best.emailsReplied.workflowCount).toBe(1);
  });

  it("supports brandId filter", async () => {
    const wf = makeWorkflow({ id: "wf-brand-filter", createdForBrandId: "brand-z" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-brand-filter", "ext-run-bz"));

    mockFetchRunCostsPublic.mockResolvedValue([
      { workflowSlug: DEFAULT_WF_SLUG, totalCostInUsdCents: 100, runCount: 1 },
    ]);
    mockFetchEmailStatsPublic.mockResolvedValue([
      makeEmailGroup(DEFAULT_WF_SLUG, { transactional: { replied: 5 } }),
    ]);

    const res = await request
      .get("/public/workflows/best")
      .query({ ...BEST_QUERY, brandId: "brand-z" });

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied.createdForBrandId).toBe("brand-z");
  });

  it("accepts featureDynastySlug as alternative to featureSlug", async () => {
    const wf = makeWorkflow({ id: "wf-dynasty-pub" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-dynasty-pub", "ext-run-dp"));

    mockFetchRunCostsPublic.mockResolvedValue([
      { workflowSlug: DEFAULT_WF_SLUG, totalCostInUsdCents: 200, runCount: 1 },
    ]);
    mockFetchEmailStatsPublic.mockResolvedValue([
      makeEmailGroup(DEFAULT_WF_SLUG, { transactional: { replied: 10 } }),
    ]);

    const res = await request
      .get("/public/workflows/best")
      .query({ featureDynastySlug: "sales-email-cold-outreach" });

    expect(res.status).toBe(200);
    expect(res.body.best.emailsReplied).toBeDefined();
    expect(res.body.best.emailsReplied.workflowId).toBe("wf-dynasty-pub");
  });
});
