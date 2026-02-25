import { describe, it, expect, vi, beforeEach } from "vitest";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";

// Mock DB (same pattern as workflows.test.ts)
const mockDbRows: Record<string, unknown>[] = [];

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
        mockDbRows.push(newRow);
        return {
          returning: () => Promise.resolve([newRow]),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => {
          return Promise.resolve(mockDbRows);
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const row = mockDbRows[mockDbRows.length - 1];
          if (row) Object.assign(row, values);
          return {
            returning: () => Promise.resolve([{ ...row, ...values }]),
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

// Mock the workflow generator
const mockGenerateWorkflow = vi.fn();
vi.mock("../../src/lib/workflow-generator.js", () => {
  class MockGenerationValidationError extends Error {
    validationErrors: unknown[];
    constructor(msg: string, errors: unknown[]) {
      super(msg);
      this.name = "GenerationValidationError";
      this.validationErrors = errors;
    }
  }
  return {
    generateWorkflow: (...args: unknown[]) => mockGenerateWorkflow(...args),
    GenerationValidationError: MockGenerationValidationError,
  };
});

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const AUTH = { "x-api-key": "test-api-key" };

describe("POST /workflows/generate", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockGenerateWorkflow.mockReset();
  });

  it("generates and deploys a workflow from description", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Search leads, generate email, send",
    });

    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        appId: "test-app",
        orgId: "org-1",
        description: "I want a cold email outreach workflow that finds leads and sends emails",
      });

    expect(res.status).toBe(200);
    expect(res.body.workflow).toBeDefined();
    expect(res.body.workflow.action).toBe("created");
    expect(res.body.workflow.category).toBe("sales");
    expect(res.body.workflow.name).toContain("sales-email-cold-outreach");
    expect(res.body.dag).toEqual(VALID_LINEAR_DAG);
    expect(res.body.generatedDescription).toBe("Search leads, generate email, send");
    expect(res.body.category).toBe("sales");
    expect(res.body.channel).toBe("email");
    expect(res.body.audienceType).toBe("cold-outreach");
  });

  it("returns 422 when LLM generates invalid DAG after retries", async () => {
    const { GenerationValidationError } = await import("../../src/lib/workflow-generator.js");
    mockGenerateWorkflow.mockRejectedValueOnce(
      new GenerationValidationError("Generated DAG is invalid after retries", [
        { field: "nodes", message: 'Unknown node type: "bad-type"' },
      ]),
    );

    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        appId: "test-app",
        orgId: "org-1",
        description: "A workflow that does something impossible with bad types",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid");
    expect(res.body.details).toBeDefined();
  });

  it("requires authentication", async () => {
    const res = await request.post("/workflows/generate").send({
      appId: "test-app",
      orgId: "org-1",
      description: "test workflow description here",
    });

    expect(res.status).toBe(401);
  });

  it("validates request body (missing description)", async () => {
    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({ appId: "test-app", orgId: "org-1" });

    expect(res.status).toBe(400);
  });

  it("validates description minimum length", async () => {
    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({ appId: "test-app", orgId: "org-1", description: "hi" });

    expect(res.status).toBe(400);
  });

  it("passes hints through to generator", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Test",
    });

    await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        appId: "test-app",
        orgId: "org-1",
        description: "Cold email outreach with lead search",
        hints: { services: ["lead", "email-gateway"] },
      });

    expect(mockGenerateWorkflow).toHaveBeenCalledWith({
      description: "Cold email outreach with lead search",
      hints: { services: ["lead", "email-gateway"] },
    });
  });

  it("returns 500 when LLM throws unexpected error", async () => {
    mockGenerateWorkflow.mockRejectedValueOnce(
      new Error("ANTHROPIC_API_KEY is not set"),
    );

    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        appId: "test-app",
        orgId: "org-1",
        description: "Some workflow description for testing errors",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("ANTHROPIC_API_KEY");
  });
});
