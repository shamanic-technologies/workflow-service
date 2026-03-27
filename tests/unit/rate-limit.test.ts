import { describe, it, expect, vi, beforeEach } from "vitest";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";

// Override the rate-limit module to use real rate limiters (not the test passthrough)
vi.mock("../../src/middleware/rate-limit.js", async () => {
  const { default: rateLimit } = await import("express-rate-limit");
  const keyGen = (req: import("express").Request) =>
    (req.res?.locals.orgId as string) ?? "unknown";
  return {
    executeRateLimit: rateLimit({
      windowMs: 60 * 1000,
      limit: 60,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      keyGenerator: keyGen,
      message: { error: "Too many workflow executions — limit is 60 per minute per organization" },
    }),
    createRateLimit: rateLimit({
      windowMs: 60 * 1000,
      limit: 10,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      keyGenerator: keyGen,
      message: { error: "Too many workflow creations — limit is 10 per minute per organization" },
    }),
  };
});

// Mock DB, Windmill, and runs-client (required by app import)
const mockWorkflows: Record<string, unknown>[] = [];
const mockRuns: Record<string, unknown>[] = [];

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
          id: "wf-" + Math.random().toString(36).slice(2, 10),
          ...row,
          status: row.status ?? "active",
          tags: row.tags ?? [],
          windmillWorkspace: row.windmillWorkspace ?? "prod",
          createdAt: new Date(),
          startedAt: null,
          completedAt: null,
        };
        mockRuns.push(newRow);
        return { returning: () => Promise.resolve([newRow]) };
      },
    }),
    select: (cols?: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          if (cols) return mockQueryResult([]);
          if (mockWorkflows.length > 0) return mockQueryResult([mockWorkflows[0]]);
          return mockQueryResult([]);
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: () => Promise.resolve([{ ...mockRuns[0], ...values }]),
        }),
      }),
    }),
  },
  sql: { end: () => Promise.resolve() },
}));

vi.mock("../../src/lib/windmill-client.js", () => ({
  getWindmillClient: () => ({
    createFlow: vi.fn().mockResolvedValue("f/workflows/test/flow"),
    updateFlow: vi.fn(),
    deleteFlow: vi.fn(),
    runFlow: vi.fn().mockResolvedValue("job-uuid-123"),
    getJob: vi.fn(),
    cancelJob: vi.fn(),
    healthCheck: vi.fn(),
  }),
  WindmillClient: vi.fn(),
  resetWindmillClient: vi.fn(),
}));

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ runId: "run-own-123" }),
}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const AUTH = {
  "x-api-key": "test-api-key",
  "x-org-id": "org-rate-test",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
  "x-brand-id": "brand-1",
  "x-campaign-id": "camp-1",
  "x-workflow-name": "test-workflow",
  "x-feature-slug": "test-feature",
};

describe("Execute endpoint rate limiting", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockWorkflows.push({
      id: "wf-1",
      name: "Rate Test Flow",
      status: "active",
      windmillFlowPath: "f/workflows/test/flow",
      windmillWorkspace: "prod",
      dag: { nodes: [], edges: [] },
    });
  });

  it("returns 429 after exceeding 60 requests per minute for the same org", async () => {
    const promises = [];
    for (let i = 0; i < 61; i++) {
      promises.push(
        request
          .post("/workflows/wf-1/execute")
          .set(AUTH)
          .send({ inputs: {} })
      );
    }

    const results = await Promise.all(promises);
    const statuses = results.map((r) => r.status);

    expect(statuses).toContain(429);
    const successCount = statuses.filter((s) => s === 201).length;
    expect(successCount).toBe(60);
  });

  it("does not rate limit a different org", async () => {
    const exhaustPromises = [];
    for (let i = 0; i < 60; i++) {
      exhaustPromises.push(
        request
          .post("/workflows/wf-1/execute")
          .set(AUTH)
          .send({ inputs: {} })
      );
    }
    await Promise.all(exhaustPromises);

    const res = await request
      .post("/workflows/wf-1/execute")
      .set({ ...AUTH, "x-org-id": "org-other" })
      .send({ inputs: {} });

    expect(res.status).toBe(201);
  });

  it("rate limits by-name execute endpoint too", async () => {
    const promises = [];
    for (let i = 0; i < 61; i++) {
      promises.push(
        request
          .post("/workflows/by-name/Rate Test Flow/execute")
          .set(AUTH)
          .send({ inputs: {} })
      );
    }

    const results = await Promise.all(promises);
    const statuses = results.map((r) => r.status);
    expect(statuses).toContain(429);
  });
});

describe("Create endpoint rate limiting", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
  });

  const createBody = {
    name: "Test Workflow",
    description: "test",
    featureSlug: "test-feature",
    dag: VALID_LINEAR_DAG,
  };

  it("returns 429 after exceeding 10 creation requests per minute for the same org", async () => {
    const promises = [];
    for (let i = 0; i < 11; i++) {
      promises.push(
        request.post("/workflows").set(AUTH).send(createBody)
      );
    }

    const results = await Promise.all(promises);
    const statuses = results.map((r) => r.status);

    expect(statuses).toContain(429);
    const successCount = statuses.filter((s) => s === 201).length;
    expect(successCount).toBe(10);
  });

  it("does not rate limit a different org for creation", async () => {
    // Exhaust org-rate-test's create limit
    const exhaustPromises = [];
    for (let i = 0; i < 10; i++) {
      exhaustPromises.push(
        request.post("/workflows").set(AUTH).send(createBody)
      );
    }
    await Promise.all(exhaustPromises);

    // Different org should still work
    const res = await request
      .post("/workflows")
      .set({ ...AUTH, "x-org-id": "org-create-other" })
      .send(createBody);

    expect(res.status).toBe(201);
  });
});
