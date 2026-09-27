import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Track all updates for assertion ---
const updateCalls: Array<{ set: Record<string, unknown>; table: string }> = [];
const executeCalls: Array<{ query: string; params: unknown[] }> = [];

// --- Mock DB ---
vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([{}]),
      }),
    }),
    select: () => ({
      from: () => {
        const result = Promise.resolve([]);
        (result as any).where = () => Promise.resolve([]);
        return result;
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const tableName =
            table && typeof table === "object" && "workflowId" in (table as Record<string, unknown>)
              ? "workflow_runs"
              : "workflows";
          updateCalls.push({ set: values, table: tableName });
          return Promise.resolve({ rowCount: tableName === "workflows" ? 2 : 0 });
        },
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
    execute: (query: unknown) => {
      executeCalls.push({ query: String(query), params: [] });
      return Promise.resolve({ rowCount: 3 });
    },
  },
  sql: {
    end: () => Promise.resolve(),
  },
}));

// --- Mock the transfer itself (its SQL is covered against real Postgres in tests/unit/transfer-brand.test.ts) ---
const transferBrandMock = vi.fn();
vi.mock("../../src/lib/transfer-brand.js", () => ({
  transferBrand: (...args: unknown[]) => transferBrandMock(...args),
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

// --- Mock stats-client ---
vi.mock("../../src/lib/stats-client.js", () => ({
  fetchRunCostsAuth: vi.fn(),
  fetchEmailStatsAuth: vi.fn(),
  fetchRunCostsPublic: vi.fn(),
  fetchEmailStatsPublic: vi.fn(),
}));

// --- Mock key-service ---
vi.mock("../../src/lib/key-service-client.js", () => ({
  fetchProviderRequirements: vi.fn(),
}));

// --- Mock features-client ---
vi.mock("../../src/lib/features-client.js", () => ({
  fetchFeatureOutputs: vi.fn().mockResolvedValue([]),
  fetchStatsRegistry: vi.fn().mockResolvedValue({}),
}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const API_KEY = { "x-api-key": "test-api-key" };

describe("POST /internal/transfer-brand", () => {
  beforeEach(() => {
    transferBrandMock.mockReset();
    transferBrandMock.mockResolvedValue({
      updatedTables: [
        { tableName: "workflows", count: 2 },
        { tableName: "workflow_runs", count: 3 },
      ],
    });
  });

  it("returns 401 without x-api-key", async () => {
    const res = await request
      .post("/internal/transfer-brand")
      .send({ sourceBrandId: "b1", sourceOrgId: "org1", targetOrgId: "org2" });
    expect(res.status).toBe(401);
    expect(transferBrandMock).not.toHaveBeenCalled();
  });

  it("returns 400 when body is missing required fields", async () => {
    const res = await request.post("/internal/transfer-brand").set(API_KEY).send({ sourceBrandId: "b1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(transferBrandMock).not.toHaveBeenCalled();
  });

  it("returns 400 when sourceBrandId is empty", async () => {
    const res = await request
      .post("/internal/transfer-brand")
      .set(API_KEY)
      .send({ sourceBrandId: "", sourceOrgId: "org1", targetOrgId: "org2" });
    expect(res.status).toBe(400);
  });

  it("passes the body to the transfer and returns its per-table counts", async () => {
    const res = await request
      .post("/internal/transfer-brand")
      .set(API_KEY)
      .send({ sourceBrandId: "brand-123", sourceOrgId: "org-source", targetOrgId: "org-target", targetBrandId: "brand-456" });

    expect(res.status).toBe(200);
    expect(transferBrandMock).toHaveBeenCalledWith(expect.anything(), {
      sourceBrandId: "brand-123",
      sourceOrgId: "org-source",
      targetOrgId: "org-target",
      targetBrandId: "brand-456",
    });
    expect(res.body.updatedTables).toEqual([
      { tableName: "workflows", count: 2 },
      { tableName: "workflow_runs", count: 3 },
    ]);
  });
});
