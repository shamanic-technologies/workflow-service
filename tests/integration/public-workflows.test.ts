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

// ==================== GET /public/workflows ====================

describe("GET /public/workflows", () => {
  const API_KEY = { "x-api-key": "test-api-key" };

  beforeEach(() => {
    mockWorkflowRows.length = 0;
  });

  it("returns 401 without x-api-key", async () => {
    const res = await request.get("/public/workflows").query({ featureSlugs: "sales-v1" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when featureSlugs is missing", async () => {
    const res = await request.get("/public/workflows").set(API_KEY);
    expect(res.status).toBe(400);
  });

  it("returns workflows for given feature slugs (mock returns all rows)", async () => {
    const wf1 = makeWorkflow({ id: "wf-a1", featureSlug: "sales-v1", status: "active", dynastySlug: "sales-cold-outreach-alpha" });
    const wf2 = makeWorkflow({ id: "wf-a2", featureSlug: "sales-v2", status: "active", slug: "sales-cold-outreach-alpha-v2", name: "Sales Alpha v2", dynastySlug: "sales-cold-outreach-alpha" });
    mockWorkflowRows.push(wf1, wf2);

    const res = await request
      .get("/public/workflows")
      .set(API_KEY)
      .query({ featureSlugs: "sales-v1,sales-v2" });

    expect(res.status).toBe(200);
    expect(res.body.workflows.length).toBeGreaterThanOrEqual(2);
    const ids = res.body.workflows.map((w: { id: string }) => w.id);
    expect(ids).toContain("wf-a1");
    expect(ids).toContain("wf-a2");
  });

  it("passes status filter to DB query and returns upgradedTo", async () => {
    const wfDepr = makeWorkflow({ id: "wf-dep", featureSlug: "feat-x", status: "deprecated", slug: "feat-dep", name: "Depr", upgradedTo: "wf-act-uuid", dynastySlug: "feat-dep" });
    mockWorkflowRows.push(wfDepr);

    const res = await request
      .get("/public/workflows")
      .set(API_KEY)
      .query({ featureSlugs: "feat-x", status: "deprecated" });

    expect(res.status).toBe(200);
    const dep = res.body.workflows.find((w: { id: string }) => w.id === "wf-dep");
    expect(dep).toBeDefined();
    expect(dep.upgradedTo).toBe("wf-act-uuid");
  });

  it("returns workflows with status=all", async () => {
    const wf1 = makeWorkflow({ id: "wf-all-1", featureSlug: "feat-y", status: "active" });
    const wf2 = makeWorkflow({ id: "wf-all-2", featureSlug: "feat-y", status: "deprecated", slug: "feat-y-old", name: "Old", dynastySlug: "feat-y-old" });
    mockWorkflowRows.push(wf1, wf2);

    const res = await request
      .get("/public/workflows")
      .set(API_KEY)
      .query({ featureSlugs: "feat-y", status: "all" });

    expect(res.status).toBe(200);
    expect(res.body.workflows.length).toBeGreaterThanOrEqual(2);
  });

  it("returns correct shape with all expected fields", async () => {
    const wf = makeWorkflow({
      id: "wf-shape",
      slug: "sales-cold-outreach-obsidian-v3",
      name: "Sales Cold Outreach Obsidian v3",
      dynastyName: "Sales Cold Outreach Obsidian",
      dynastySlug: "sales-cold-outreach-obsidian",
      version: 3,
      featureSlug: "sales-cold-outreach-v2",
      createdForBrandId: "brand-123",
      status: "active",
      upgradedTo: null,
    });
    mockWorkflowRows.push(wf);

    const res = await request
      .get("/public/workflows")
      .set(API_KEY)
      .query({ featureSlugs: "sales-cold-outreach-v2" });

    expect(res.status).toBe(200);
    expect(res.body.workflows).toHaveLength(1);
    const w = res.body.workflows[0];
    expect(w).toEqual({
      id: "wf-shape",
      slug: "sales-cold-outreach-obsidian-v3",
      name: "Sales Cold Outreach Obsidian v3",
      dynastyName: "Sales Cold Outreach Obsidian",
      dynastySlug: "sales-cold-outreach-obsidian",
      version: 3,
      status: "active",
      featureSlug: "sales-cold-outreach-v2",
      createdForBrandId: "brand-123",
      upgradedTo: null,
    });
    // Must NOT include DAG or internal fields
    expect(w).not.toHaveProperty("dag");
    expect(w).not.toHaveProperty("orgId");
    expect(w).not.toHaveProperty("signature");
    expect(w).not.toHaveProperty("windmillFlowPath");
  });

  it("returns empty array when no workflows match", async () => {
    const res = await request
      .get("/public/workflows")
      .set(API_KEY)
      .query({ featureSlugs: "nonexistent-feature" });

    expect(res.status).toBe(200);
    expect(res.body.workflows).toEqual([]);
  });
});
