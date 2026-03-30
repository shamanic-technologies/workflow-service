import { describe, it, expect, vi, beforeEach } from "vitest";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";

// Mock DB state
const mockWorkflows: Record<string, unknown>[] = [];
const mockRuns: Record<string, unknown>[] = [];
// Optional queue: when populated, select().from().where() shifts from it
const mockSelectResponses: Record<string, unknown>[][] = [];

// Helper: creates a thenable query result that also supports .limit()
function mockQueryResult(data: Record<string, unknown>[]) {
  const obj = {
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(data).then(resolve, reject),
    limit: () => obj,
  };
  return obj;
}

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        const newRow = {
          id: crypto.randomUUID(),
          ...row,
          windmillWorkspace: row.windmillWorkspace ?? "prod",
          createdAt: new Date(),
          startedAt: null,
          completedAt: null,
        };
        mockRuns.push(newRow);
        return {
          returning: () => Promise.resolve([newRow]),
        };
      },
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (mockSelectResponses.length > 0) {
            return mockQueryResult(mockSelectResponses.shift()!);
          }
          // Simple mock: return first matching item
          if (mockWorkflows.length > 0) return mockQueryResult([mockWorkflows[0]]);
          if (mockRuns.length > 0) return mockQueryResult([mockRuns[0]]);
          return mockQueryResult([]);
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const run = mockRuns[mockRuns.length - 1];
          if (run) Object.assign(run, values);
          return {
            returning: () => Promise.resolve([{ ...run, ...values }]),
          };
        },
      }),
    }),
  },
  sql: {
    end: () => Promise.resolve(),
  },
}));

// Mock Windmill client
const mockRunFlow = vi.fn().mockResolvedValue("job-uuid-123");
const mockGetJob = vi.fn().mockResolvedValue({
  id: "job-uuid-123",
  running: false,
  success: true,
  result: { output: "done" },
});
const mockCancelJob = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/lib/windmill-client.js", () => ({
  getWindmillClient: () => ({
    createFlow: vi.fn().mockResolvedValue("f/workflows/test/flow"),
    updateFlow: vi.fn().mockResolvedValue(undefined),
    deleteFlow: vi.fn().mockResolvedValue(undefined),
    runFlow: mockRunFlow,
    getJob: mockGetJob,
    cancelJob: mockCancelJob,
    healthCheck: vi.fn().mockResolvedValue(true),
  }),
  WindmillClient: vi.fn(),
  resetWindmillClient: vi.fn(),
}));

// Mock runs-service client
const mockCreateRun = vi.fn().mockResolvedValue({ runId: "run-own-123" });

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
}));

// Mock features-client (for dynasty slug resolution)
vi.mock("../../src/lib/features-client.js", () => ({
  resolveFeatureDynastySlugs: vi.fn().mockImplementation((dynastySlug: string) => {
    return Promise.resolve([dynastySlug, `${dynastySlug}-v2`, `${dynastySlug}-v3`]);
  }),
}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const IDENTITY = {
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-caller-1",
  "x-brand-id": "brand-1",
  "x-campaign-id": "camp-1",
  "x-workflow-slug": "test-workflow",
  "x-feature-slug": "test-feature",
};
const AUTH = { "x-api-key": "test-api-key", ...IDENTITY };

// Valid UUID test IDs
const WF_ID = "00000000-0000-4000-8000-000000000001";
const WF_OLD_ID = "00000000-0000-4000-8000-000000000002";
const WF_NEW_ID = "00000000-0000-4000-8000-000000000003";
const WF_CROSS_ID = "00000000-0000-4000-8000-000000000004";
const WF_V1_ID = "00000000-0000-4000-8000-000000000005";
const WF_V2_ID = "00000000-0000-4000-8000-000000000006";
const WF_V3_ID = "00000000-0000-4000-8000-000000000007";
const WF_DEAD_ID = "00000000-0000-4000-8000-000000000008";
const WF_MISSING_ID = "00000000-0000-4000-8000-000000000009";
const WF_FEAT_ID = "00000000-0000-4000-8000-00000000000a";
const RUN_1_ID = "00000000-0000-4000-8000-000000000010";
const RUN_DEBUG_ID = "00000000-0000-4000-8000-000000000011";
const RUN_NO_JOB_ID = "00000000-0000-4000-8000-000000000012";
const RUN_SIMPLE_ID = "00000000-0000-4000-8000-000000000013";

describe("POST /workflows/:id/execute", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockSelectResponses.length = 0;
    mockRunFlow.mockClear();
    mockCreateRun.mockClear();
    mockCreateRun.mockResolvedValue({ runId: "run-own-123" });
  });

  it("executes a workflow and returns a run", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "org-1",
      slug: "test-flow",
      name: "Test Flow",
      dynastyName: "Test Flow Obsidian",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(AUTH)
      .send({ inputs: { key: "value" } });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(res.body.windmillJobId).toBe("job-uuid-123");
    expect(res.body.runId).toBe("run-own-123");
    expect(mockRunFlow).toHaveBeenCalled();
  });

  it("creates a child run in runs-service with caller's runId as parentRunId", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "org-1",
      slug: "test-flow",
      name: "Test Flow",
      dynastyName: "Test Flow Obsidian",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(AUTH)
      .send({ inputs: {} });

    expect(mockCreateRun).toHaveBeenCalledWith({
      parentRunId: "run-caller-1",
      orgId: "org-1",
      userId: "user-1",
      taskName: "execute-workflow",
      workflowSlug: "test-flow",
      campaignId: "camp-1",
      brandId: "brand-1",
    });
  });

  it("forwards orgId, userId, and own runId into Windmill flow inputs", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "org-1",
      slug: "test-flow",
      name: "Test Flow",
      dynastyName: "Test Flow Obsidian",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(AUTH)
      .send({ inputs: { email: "user@test.com" } });

    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/test_flow",
      expect.objectContaining({ orgId: "org-1", userId: "user-1", runId: "run-own-123", email: "user@test.com" }),
    );
  });

  it("uses x-org-id header (not workflow.orgId) for run attribution", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org-different",
      slug: "test-flow",
      name: "Test Flow",
      dynastyName: "Test Flow Obsidian",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(AUTH) // x-org-id: "org-1"
      .send({ inputs: {} });

    expect(res.status).toBe(201);
    expect(res.body.orgId).toBe("org-1"); // from header, not workflow.orgId
    expect(res.body.userId).toBe("user-1");

    expect(mockCreateRun).toHaveBeenCalledWith({
      parentRunId: "run-caller-1",
      orgId: "org-1", // from header
      userId: "user-1",
      taskName: "execute-workflow",
      workflowSlug: "test-flow",
      campaignId: "camp-1",
      brandId: "brand-1",
    });
  });

  it("returns 502 when runs-service fails", async () => {
    mockCreateRun.mockRejectedValueOnce(
      new Error("runs-service error: POST /runs/start -> 500 Internal Server Error: boom")
    );

    mockWorkflows.push({
      id: WF_ID,
      orgId: "org-1",
      slug: "test-flow",
      name: "Test Flow",
      dynastyName: "Test Flow Obsidian",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("runs-service");
  });

  it("returns 410 when workflow is deprecated (by ID)", async () => {
    mockSelectResponses.push(
      [],  // 1. active-only lookup → not found
      [{   // 2. any-status lookup → deprecated
        id: WF_OLD_ID,
        status: "deprecated",
        upgradedTo: WF_NEW_ID,
      }],
    );

    const res = await request
      .post(`/workflows/${WF_OLD_ID}/execute`)
      .set(AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Workflow has been deprecated");
    expect(res.body.upgradedTo).toBe(WF_NEW_ID);
  });

  it("uses campaignId from header, not from workflow record or inputs", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "org-1",
      slug: "test-flow",
      name: "Test Flow",
      dynastyName: "Test Flow Obsidian",
      version: 1,
      campaignId: "camp-from-wf",
      subrequestId: null,
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(AUTH) // x-campaign-id: "camp-1"
      .send({ inputs: { campaignId: "camp-from-input" } });

    expect(res.status).toBe(201);
    expect(res.body.campaignId).toBe("camp-1"); // from header, not input or workflow record
  });

  it("returns 400 when required execution headers are missing", async () => {
    const res = await request
      .post(`/workflows/${WF_ID}/execute`)
      .set({ "x-api-key": "test-api-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" })
      .send({ inputs: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing required headers");
    expect(res.body.error).toContain("x-campaign-id");
    expect(res.body.error).toContain("x-brand-id");
  });

  it("requires authentication", async () => {
    const res = await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(IDENTITY)
      .send({ inputs: {} });

    expect(res.status).toBe(401);
  });
});

describe("POST /workflows/by-slug/:slug/execute", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockSelectResponses.length = 0;
    mockRunFlow.mockClear();
    mockCreateRun.mockClear();
    mockCreateRun.mockResolvedValue({ runId: "run-own-456" });
  });

  it("executes a workflow by slug (slug-only lookup, no org filter)", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      slug: "newsletter-subscribe",
      name: "Newsletter Subscribe",
      dynastyName: "Newsletter Subscribe Obsidian",
      version: 1,
      windmillFlowPath: "f/workflows/org-1/newsletter_subscribe",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post("/workflows/by-slug/newsletter-subscribe/execute")
      .set(AUTH)
      .send({ inputs: { email: "test@example.com" } });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(res.body.windmillJobId).toBe("job-uuid-123");
    expect(res.body.runId).toBe("run-own-456");
    expect(mockRunFlow).toHaveBeenCalled();
  });

  it("uses x-org-id header (not body orgId) for run attribution", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      slug: "create-user-flow",
      name: "Create User Flow",
      dynastyName: "Create User Flow Obsidian",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/create_user_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post("/workflows/by-slug/create-user-flow/execute")
      .set(AUTH)
      .send({ inputs: {} });

    // orgId in the run comes from header (org-1), not the deployer org
    expect(mockCreateRun).toHaveBeenCalledWith({
      parentRunId: "run-caller-1",
      orgId: "org-1",
      userId: "user-1",
      taskName: "execute-workflow",
      workflowSlug: "create-user-flow",
      campaignId: "camp-1",
      brandId: "brand-1",
    });
  });

  it("forwards header orgId, userId, and own runId into Windmill flow inputs", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      slug: "create-user-flow",
      name: "Create User Flow",
      dynastyName: "Create User Flow Obsidian",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/create_user_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post("/workflows/by-slug/create-user-flow/execute")
      .set(AUTH)
      .send({ inputs: { email: "user@test.com" } });

    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/create_user_flow",
      expect.objectContaining({ orgId: "org-1", userId: "user-1", runId: "run-own-456", email: "user@test.com" }),
    );
  });

  it("cross-org: workflow deployed by org-A can be executed by org-B", async () => {
    // Workflow deployed by a completely different org
    mockWorkflows.push({
      id: WF_CROSS_ID,
      orgId: "8c734aed-45ac-4780-a4ee-1fdcbbedeab1",
      slug: "sales-email-cold-outreach-pharaoh",
      name: "Sales Email Cold Outreach Pharaoh",
      dynastyName: "Sales Email Cold Outreach Pharaoh",
      version: 1,
      windmillFlowPath: "f/workflows/upgradeer/sales_email_cold_outreach_pharaoh",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    // Execute with a different org in headers
    const CROSS_ORG_AUTH = {
      "x-api-key": "test-api-key",
      "x-org-id": "b645207b-d8e9-40b0-9391-072b777cd9a9",
      "x-user-id": "user-b",
      "x-run-id": "run-caller-b",
      "x-brand-id": "brand-b",
      "x-campaign-id": "camp-b",
      "x-workflow-slug": "sales-outreach",
      "x-feature-slug": "cold-outreach",
    };

    const res = await request
      .post("/workflows/by-slug/sales-email-cold-outreach-pharaoh/execute")
      .set(CROSS_ORG_AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    // Run is attributed to the executing org, not the deployer
    expect(res.body.orgId).toBe("b645207b-d8e9-40b0-9391-072b777cd9a9");
    expect(res.body.userId).toBe("user-b");
  });

  it("uses x-org-id header for identity (orgId not in body)", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      slug: "simple-flow",
      name: "Simple Flow",
      dynastyName: "Simple Flow Obsidian",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/simple_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post("/workflows/by-slug/simple-flow/execute")
      .set(AUTH)
      .send({ inputs: {} }); // no orgId in body

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe("user-1");
    expect(res.body.orgId).toBe("org-1");
  });

  it("returns 404 for unknown workflow slug", async () => {
    const res = await request
      .post("/workflows/by-slug/nonexistent/execute")
      .set(AUTH)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("nonexistent");
  });

  it("follows upgrade chain and executes active replacement", async () => {
    mockSelectResponses.push(
      [],  // 1. active-only lookup → not found
      [{   // 2. any-status lookup → deprecated workflow
        id: WF_OLD_ID,
        slug: "deprecated-flow",
        name: "Deprecated Flow",
        dynastyName: "Deprecated Flow Obsidian",
        version: 1,
        status: "deprecated",
        upgradedTo: WF_NEW_ID,
      }],
      [{   // 3. chain follow: replacement is active → execute it
        id: WF_NEW_ID,
        slug: "replacement-flow",
        name: "Replacement Flow",
        dynastyName: "Replacement Flow Obsidian",
        version: 2,
        status: "active",
        windmillFlowPath: "f/workflows/org_1/replacement_flow",
        windmillWorkspace: "prod",
        dag: VALID_LINEAR_DAG,
      }],
    );

    const res = await request
      .post("/workflows/by-slug/deprecated-flow/execute")
      .set(AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/replacement_flow",
      expect.objectContaining({ orgId: "org-1" }),
    );
  });

  it("follows multi-hop upgrade chain to active version", async () => {
    mockSelectResponses.push(
      [],  // 1. active-only lookup → not found
      [{   // 2. any-status lookup → deprecated v1
        id: WF_V1_ID,
        slug: "old-flow",
        name: "Old Flow",
        dynastyName: "Old Flow Obsidian",
        version: 1,
        status: "deprecated",
        upgradedTo: WF_V2_ID,
      }],
      [{   // 3. chain hop 1: v2 is also deprecated
        id: WF_V2_ID,
        slug: "mid-flow",
        name: "Mid Flow",
        dynastyName: "Mid Flow Obsidian",
        version: 2,
        status: "deprecated",
        upgradedTo: WF_V3_ID,
      }],
      [{   // 4. chain hop 2: v3 is active → execute it
        id: WF_V3_ID,
        slug: "current-flow",
        name: "Current Flow",
        dynastyName: "Current Flow Obsidian",
        version: 3,
        status: "active",
        windmillFlowPath: "f/workflows/org_1/current_flow",
        windmillWorkspace: "prod",
        dag: VALID_LINEAR_DAG,
      }],
    );

    const res = await request
      .post("/workflows/by-slug/old-flow/execute")
      .set(AUTH)
      .send({ inputs: { key: "value" } });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/current_flow",
      expect.objectContaining({ orgId: "org-1", key: "value" }),
    );
  });

  it("returns 410 when upgrade chain ends without active workflow", async () => {
    mockSelectResponses.push(
      [],  // 1. active-only lookup → not found
      [{   // 2. any-status lookup → deprecated, no replacement
        id: WF_DEAD_ID,
        slug: "dead-flow",
        name: "Dead Flow",
        dynastyName: "Dead Flow Obsidian",
        version: 1,
        status: "deprecated",
        upgradedTo: null,
      }],
    );

    const res = await request
      .post("/workflows/by-slug/dead-flow/execute")
      .set(AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Workflow has been deprecated");
    expect(res.body.upgradedTo).toBeNull();
    expect(res.body.upgradedToSlug).toBeNull();
  });

  it("returns 410 when upgrade chain points to missing workflow", async () => {
    mockSelectResponses.push(
      [],  // 1. active-only lookup → not found
      [{   // 2. any-status lookup → deprecated with upgradedTo
        id: WF_OLD_ID,
        slug: "orphan-flow",
        name: "Orphan Flow",
        dynastyName: "Orphan Flow Obsidian",
        version: 1,
        status: "deprecated",
        upgradedTo: WF_MISSING_ID,
      }],
      [],  // 3. chain follow: replacement not found → dead end
      [{   // 4. 410 replacement slug lookup → not found
        // empty — replacement doesn't exist
      }],
    );

    const res = await request
      .post("/workflows/by-slug/orphan-flow/execute")
      .set(AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Workflow has been deprecated");
    expect(res.body.upgradedTo).toBe(WF_MISSING_ID);
  });

  it("uses campaignId from header into Windmill flow inputs (by slug)", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      slug: "campaign-flow",
      name: "Campaign Flow",
      dynastyName: "Campaign Flow Obsidian",
      version: 1,
      campaignId: "camp-on-record",
      createdForBrandId: "brand-on-record",
      subrequestId: null,
      windmillFlowPath: "f/workflows/org_1/campaign_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post("/workflows/by-slug/campaign-flow/execute")
      .set(AUTH) // x-campaign-id: "camp-1", x-brand-id: "brand-1"
      .send({ inputs: {} });

    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/campaign_flow",
      expect.objectContaining({
        campaignId: "camp-1",
        brandId: "brand-1",
      }),
    );
  });

  it("returns 400 when required execution headers are missing (by slug)", async () => {
    const res = await request
      .post("/workflows/by-slug/some-flow/execute")
      .set({ "x-api-key": "test-api-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" })
      .send({ inputs: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing required headers");
    expect(res.body.error).toContain("x-campaign-id");
  });

  it("stores campaignId from header when following upgrade chain", async () => {
    mockSelectResponses.push(
      [],  // 1. active-only lookup → not found
      [{   // 2. any-status lookup → deprecated workflow
        id: WF_OLD_ID,
        slug: "old-flow",
        name: "Old Flow",
        dynastyName: "Old Flow Obsidian",
        version: 1,
        status: "deprecated",
        campaignId: null,
        subrequestId: null,
        upgradedTo: WF_NEW_ID,
      }],
      [{   // 3. chain follow: replacement is active
        id: WF_NEW_ID,
        slug: "new-flow",
        name: "New Flow",
        dynastyName: "New Flow Obsidian",
        version: 2,
        status: "active",
        campaignId: null,
        subrequestId: null,
        windmillFlowPath: "f/workflows/org_1/new_flow",
        windmillWorkspace: "prod",
        dag: VALID_LINEAR_DAG,
      }],
    );

    const res = await request
      .post("/workflows/by-slug/old-flow/execute")
      .set(AUTH) // x-campaign-id: "camp-1"
      .send({ inputs: { subrequestId: "sub-runtime" } });

    expect(res.status).toBe(201);
    expect(res.body.campaignId).toBe("camp-1");
    expect(res.body.subrequestId).toBe("sub-runtime");
  });

  it("requires authentication", async () => {
    const res = await request
      .post("/workflows/by-slug/test-flow/execute")
      .set(IDENTITY)
      .send({});

    expect(res.status).toBe(401);
  });
});

describe("GET /workflow-runs/:id", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
  });

  it("returns a completed run after polling Windmill", async () => {
    mockRuns.push({
      id: RUN_1_ID,
      workflowId: WF_ID,
      orgId: "org-1",
      status: "running",
      windmillJobId: "job-uuid-123",
      windmillWorkspace: "prod",
      inputs: {},
      result: null,
      error: null,
      startedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
    });

    const res = await request.get(`/workflow-runs/${RUN_1_ID}`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.result).toEqual({ output: "done" });
  });
});

describe("GET /workflow-runs/:id/debug", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockGetJob.mockClear();
  });

  it("returns flow_status from Windmill for a completed run", async () => {
    const flowStatus = {
      step: 3,
      modules: [
        { id: "fetch_lead", type: "Success", result: { found: true, lead: { data: { firstName: "Alice" } } } },
        { id: "email_generate", type: "Success", result: { subject: "Hello Alice", bodyHtml: "<p>Hi Alice</p>" } },
        { id: "email_send", type: "Success", result: { success: true } },
      ],
    };
    mockGetJob.mockResolvedValueOnce({
      id: "job-uuid-789",
      running: false,
      success: true,
      result: { status: "completed" },
      flow_status: flowStatus,
    });

    mockRuns.push({
      id: RUN_DEBUG_ID,
      workflowId: WF_ID,
      orgId: "org-1",
      status: "completed",
      windmillJobId: "job-uuid-789",
      windmillWorkspace: "prod",
      inputs: { campaignId: "camp-1" },
      result: { status: "completed" },
      error: null,
      startedAt: new Date(),
      completedAt: new Date(),
      createdAt: new Date(),
    });

    const res = await request
      .get(`/workflow-runs/${RUN_DEBUG_ID}/debug`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(RUN_DEBUG_ID);
    expect(res.body.windmillJobId).toBe("job-uuid-789");
    expect(res.body.flowStatus).toEqual(flowStatus);
    expect(res.body.flowStatus.modules).toHaveLength(3);
    expect(res.body.flowStatus.modules[0].result.lead.data.firstName).toBe("Alice");
  });

  it("returns 404 for unknown run", async () => {
    const res = await request
      .get(`/workflow-runs/ffffffff-ffff-4fff-bfff-ffffffffffff/debug`)
      .set(AUTH);

    expect(res.status).toBe(404);
  });

  it("returns 400 if run has no windmill job ID", async () => {
    mockRuns.push({
      id: RUN_NO_JOB_ID,
      workflowId: WF_ID,
      orgId: "org-1",
      status: "queued",
      windmillJobId: null,
      windmillWorkspace: "prod",
      inputs: {},
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date(),
    });

    const res = await request
      .get(`/workflow-runs/${RUN_NO_JOB_ID}/debug`)
      .set(AUTH);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no Windmill job ID");
  });

  it("returns null flowStatus when Windmill has no flow_status", async () => {
    mockGetJob.mockResolvedValueOnce({
      id: "job-uuid-simple",
      running: false,
      success: true,
      result: { output: "done" },
    });

    mockRuns.push({
      id: RUN_SIMPLE_ID,
      workflowId: WF_ID,
      orgId: "org-1",
      status: "completed",
      windmillJobId: "job-uuid-simple",
      windmillWorkspace: "prod",
      inputs: {},
      result: null,
      error: null,
      startedAt: new Date(),
      completedAt: new Date(),
      createdAt: new Date(),
    });

    const res = await request
      .get(`/workflow-runs/${RUN_SIMPLE_ID}/debug`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.flowStatus).toBeNull();
  });

  it("requires authentication", async () => {
    const res = await request
      .get(`/workflow-runs/${RUN_1_ID}/debug`)
      .set(IDENTITY);
    expect(res.status).toBe(401);
  });
});

describe("POST /workflow-runs/:id/cancel", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockCancelJob.mockClear();
  });

  it("cancels a running workflow", async () => {
    mockRuns.push({
      id: RUN_1_ID,
      workflowId: WF_ID,
      orgId: "org-1",
      status: "running",
      windmillJobId: "job-uuid-456",
      windmillWorkspace: "prod",
      inputs: {},
      result: null,
      error: null,
      startedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
    });

    const res = await request
      .post(`/workflow-runs/${RUN_1_ID}/cancel`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(mockCancelJob).toHaveBeenCalled();
  });
});

describe("x-feature-slug tracking", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockSelectResponses.length = 0;
    mockRunFlow.mockClear();
    mockCreateRun.mockClear();
    mockCreateRun.mockResolvedValue({ runId: "run-feat-1" });
  });

  const WORKFLOW_FIXTURE = {
    id: WF_FEAT_ID,
    orgId: "org-1",
    slug: "sales-email-cold-outreach-sequoia",
    name: "Sales Email Cold Outreach Sequoia",
    dynastyName: "Sales Email Cold Outreach Sequoia",
    version: 1,
    campaignId: null,
    subrequestId: null,
    createdForBrandId: null,
    windmillFlowPath: "f/workflows/org_1/sales_email",
    windmillWorkspace: "prod",
    dag: VALID_LINEAR_DAG,
  };

  it("stores featureSlug from x-feature-slug header in the run (execute by slug)", async () => {
    mockWorkflows.push(WORKFLOW_FIXTURE);

    const res = await request
      .post("/workflows/by-slug/sales-email-cold-outreach-sequoia/execute")
      .set({ ...AUTH, "x-feature-slug": "sales-email-cold-outreach" })
      .send({ inputs: {} });

    expect(res.status).toBe(201);
    expect(res.body.featureSlug).toBe("sales-email-cold-outreach");
  });

  it("stores featureSlug from x-feature-slug header in the run (execute by id)", async () => {
    mockWorkflows.push(WORKFLOW_FIXTURE);

    const res = await request
      .post(`/workflows/${WF_FEAT_ID}/execute`)
      .set({ ...AUTH, "x-feature-slug": "sales-email-cold-outreach" })
      .send({ inputs: {} });

    expect(res.status).toBe(201);
    expect(res.body.featureSlug).toBe("sales-email-cold-outreach");
  });

  it("uses featureSlug from header (inputs do not override)", async () => {
    mockWorkflows.push(WORKFLOW_FIXTURE);

    const res = await request
      .post("/workflows/by-slug/sales-email-cold-outreach-sequoia/execute")
      .set({ ...AUTH, "x-feature-slug": "from-header" })
      .send({ inputs: { featureSlug: "from-inputs" } });

    expect(res.status).toBe(201);
    expect(res.body.featureSlug).toBe("from-header");
  });

  it("forwards featureSlug into Windmill flow inputs", async () => {
    mockWorkflows.push(WORKFLOW_FIXTURE);

    await request
      .post("/workflows/by-slug/sales-email-cold-outreach-sequoia/execute")
      .set({ ...AUTH, "x-feature-slug": "sales-email-cold-outreach" })
      .send({ inputs: { email: "test@example.com" } });

    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/sales_email",
      expect.objectContaining({ featureSlug: "sales-email-cold-outreach", email: "test@example.com" }),
    );
  });

});

describe("UUID validation on :id routes", () => {
  it("POST /workflows/:id/execute returns 400 for non-UUID id", async () => {
    const res = await request
      .post("/workflows/new/execute")
      .set(AUTH)
      .send({ inputs: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow ID format");
  });

  it("GET /workflow-runs/:id returns 400 for non-UUID id", async () => {
    const res = await request.get("/workflow-runs/latest").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid run ID format");
  });

  it("GET /workflow-runs/:id/debug returns 400 for non-UUID id", async () => {
    const res = await request.get("/workflow-runs/abc/debug").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid run ID format");
  });

  it("POST /workflow-runs/:id/cancel returns 400 for non-UUID id", async () => {
    const res = await request.post("/workflow-runs/abc/cancel").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid run ID format");
  });
});
