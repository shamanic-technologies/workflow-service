import { describe, it, expect, vi, beforeEach } from "vitest";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";

// Mock DB (same pattern as workflows.test.ts: from() returns thenable + .where())
const mockDbRows: Record<string, unknown>[] = [];

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        const newRow = {
          id: crypto.randomUUID(),
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
      from: () => {
        const result = Promise.resolve(mockDbRows);
        (result as unknown as { where: (c?: unknown) => Promise<unknown[]> }).where = () =>
          Promise.resolve(mockDbRows);
        return result;
      },
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

vi.mock("../../src/lib/key-service-client.js", () => ({
  fetchProviderRequirements: vi.fn().mockResolvedValue({ requirements: [], providers: [] }),
}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const IDENTITY = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1", "x-brand-id": "brand-1" };
const AUTH = { "x-api-key": "test-api-key", ...IDENTITY };

describe("POST /workflows/create", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockGenerateWorkflow.mockReset();
  });

  it("creates a workflow from a description", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Search leads, generate email, send",
    });

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "cold-email-outreach",
        description: "I want a cold email outreach workflow that finds leads and sends emails",
      });

    expect(res.status).toBe(201);
    expect(res.body.workflow).toBeDefined();
    expect(res.body.workflow.action).toBe("created");
    expect(res.body.workflow.featureSlug).toBe("cold-email-outreach");
    expect(res.body.workflow.workflowSlug).toContain("cold-email-outreach-");
    expect(res.body.dag).toEqual(VALID_LINEAR_DAG);
    expect(res.body.generatedDescription).toBe("Search leads, generate email, send");
    expect(mockGenerateWorkflow).toHaveBeenCalledWith(
      { description: "I want a cold email outreach workflow that finds leads and sends emails", hints: undefined, style: undefined },
      { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1", "x-brand-id": "brand-1" },
    );
    const inserted = mockDbRows[0] as Record<string, unknown>;
    expect(inserted.creationType).toBe("scratch");
    expect(inserted.createdFromWorkflow).toBeNull();
  });

  it("returns 200 with existing workflow when signature matches", async () => {
    // Pre-populate an existing active workflow with matching signature
    const { computeDAGSignature } = await import("../../src/lib/dag-signature.js");
    const sig = computeDAGSignature(VALID_LINEAR_DAG);
    mockDbRows.push({
      id: "00000000-0000-4000-8000-000000000111",
      orgId: "org-1",
      featureSlug: "cold-email-outreach",
      signature: sig,
      signatureName: "obsidian",
      workflowSlug: "cold-email-outreach-obsidian",
      workflowName: "Cold Email Outreach Obsidian",
      dynastySlug: "cold-email-outreach-obsidian",
      dynastyName: "Cold Email Outreach Obsidian",
      version: 1,
      tags: [],
      status: "active",
      dag: VALID_LINEAR_DAG,
      description: "Existing description",
      creationType: "scratch",
      createdFromWorkflow: null,
    });

    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Regenerated description",
    });

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "cold-email-outreach",
        description: "Cold email outreach workflow finds leads and sends emails",
      });

    expect(res.status).toBe(200);
    expect(res.body.workflow.action).toBe("existing");
    expect(res.body.workflow.id).toBe("00000000-0000-4000-8000-000000000111");
    // No new row should have been inserted
    expect(mockDbRows).toHaveLength(1);
  });

  it("returns 422 when LLM generates invalid DAG after retries", async () => {
    const { GenerationValidationError } = await import("../../src/lib/workflow-generator.js");
    mockGenerateWorkflow.mockRejectedValueOnce(
      new GenerationValidationError("Generated DAG is invalid after retries", [
        { field: "nodes", message: 'Unknown node type: "bad-type"' },
      ]),
    );

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "bad-workflow",
        description: "A workflow that does something impossible with bad types",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid");
    expect(res.body.details).toBeDefined();
  });

  it("requires authentication", async () => {
    const res = await request
      .post("/workflows/create")
      .set(IDENTITY)
      .send({
        featureSlug: "test-auth",
        description: "test workflow description here",
      });

    expect(res.status).toBe(401);
  });

  it("validates request body (missing description)", async () => {
    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({});

    expect(res.status).toBe(400);
  });

  it("validates description minimum length", async () => {
    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({ featureSlug: "test", description: "hi" });

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
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "cold-email-hints",
        description: "Cold email outreach with lead search",
        hints: { services: ["lead", "email-gateway"] },
      });

    expect(mockGenerateWorkflow).toHaveBeenCalledWith(
      { description: "Cold email outreach with lead search", hints: { services: ["lead", "email-gateway"] }, style: undefined },
      { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1", "x-brand-id": "brand-1" },
    );
  });

  it("returns 500 when LLM throws unexpected error", async () => {
    mockGenerateWorkflow.mockRejectedValueOnce(
      new Error("Unexpected LLM error"),
    );

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "test-error",
        description: "Some workflow description for testing errors",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Unexpected LLM error");
  });

  it("returns 500 when generator throws unexpected error", async () => {
    mockGenerateWorkflow.mockRejectedValueOnce(
      new Error("chat-service error: POST /complete -> 502 Bad Gateway: upstream unavailable"),
    );

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "test-chat-error",
        description: "Some workflow description for testing chat-service errors",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("chat-service error:");
  });

  // --- Style tests ---

  it("creates a styled workflow with human type", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Hormozi-style cold outreach",
    });

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "cold-email-outreach",
        description: "Cold email outreach in the style of Alex Hormozi",
        style: { type: "human", humanId: "human-123", name: "Hormozi" },
      });

    expect(res.status).toBe(201);
    expect(res.body.workflow.action).toBe("created");
    expect(res.body.workflow.signatureName).toBe("hormozi-v1");
    expect(res.body.workflow.workflowSlug).toBe("cold-email-outreach-hormozi-v1");
    expect(mockGenerateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        style: { type: "human", humanId: "human-123", name: "Hormozi" },
      }),
      { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1", "x-brand-id": "brand-1" },
    );
  });

  it("creates a styled workflow with brand type", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Brand-style cold outreach",
    });

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "cold-email-outreach",
        description: "Cold email outreach in my brand style with good copy",
        style: { type: "brand", brandId: "brand-456", name: "My Brand" },
      });

    expect(res.status).toBe(201);
    expect(res.body.workflow.signatureName).toBe("my-brand-v1");
    expect(res.body.workflow.workflowSlug).toBe("cold-email-outreach-my-brand-v1");
  });

  it("rejects human style without humanId", async () => {
    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "cold-email-outreach",
        description: "Cold email outreach in expert style",
        style: { type: "human", name: "Hormozi" },
      });

    expect(res.status).toBe(400);
  });

  it("rejects brand style without brandId", async () => {
    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "cold-email-outreach",
        description: "Cold email outreach in brand style long description",
        style: { type: "brand", name: "My Brand" },
      });

    expect(res.status).toBe(400);
  });

  it("creates workflow with random naming when no style provided", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Standard cold outreach",
    });

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "cold-email-outreach",
        description: "Standard cold email outreach without any style preference",
      });

    expect(res.status).toBe(201);
    expect(res.body.workflow.signatureName).not.toContain("-v");
    expect(res.body.workflow.workflowSlug).toContain("cold-email-outreach-");
    expect(res.body.workflow.signatureName).toMatch(/^[a-z]+$/);
  });

  it("returns 500 when CHAT_SERVICE_URL is not configured", async () => {
    mockGenerateWorkflow.mockRejectedValueOnce(
      new Error("CHAT_SERVICE_URL and CHAT_SERVICE_API_KEY must be set for LLM calls"),
    );

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "test-missing-config",
        description: "Some workflow description for testing missing config",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("CHAT_SERVICE_URL");
  });
});

describe("POST /workflows/upgrade", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockGenerateWorkflow.mockReset();
  });

  it("returns 404 when no active workflow matches the slug", async () => {
    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowSlug: "missing-slug",
        description: "Upgrade something that does not exist at all",
      });

    expect(res.status).toBe(404);
  });

  it("upgrades in-place when LLM returns the same signature", async () => {
    const { computeDAGSignature } = await import("../../src/lib/dag-signature.js");
    const sig = computeDAGSignature(VALID_LINEAR_DAG);

    mockDbRows.push({
      id: "00000000-0000-4000-8000-000000000222",
      orgId: "org-1",
      featureSlug: "cold-email-outreach",
      signature: sig,
      signatureName: "obsidian",
      workflowSlug: "cold-email-outreach-obsidian",
      workflowName: "Cold Email Outreach Obsidian",
      dynastySlug: "cold-email-outreach-obsidian",
      dynastyName: "Cold Email Outreach Obsidian",
      version: 1,
      tags: [],
      status: "active",
      dag: VALID_LINEAR_DAG,
      description: "Old description",
      creationType: "scratch",
      createdFromWorkflow: null,
      windmillFlowPath: "f/workflows/org-1/cold_email_outreach_obsidian",
    });

    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "New description for the same DAG",
    });

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowSlug: "cold-email-outreach-obsidian",
        description: "Upgrade with same DAG produces same signature",
      });

    expect(res.status).toBe(200);
    expect(res.body.workflow.action).toBe("updated");
    expect(res.body.workflow.id).toBe("00000000-0000-4000-8000-000000000222");
    expect(res.body.workflow.version).toBe(1);
  });
});
