import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import type { DAG } from "../../src/lib/dag-validator.js";

// DB mock: `.where()` ignores predicates, so every SELECT is fed in order via
// `mockSelectResponses` (see CLAUDE.md, "Integration-test DB mock").
const mockDbRows: Record<string, unknown>[] = [];
const mockSelectResponses: Record<string, unknown>[][] = [];

const { mockDb } = vi.hoisted(() => ({ mockDb: {} as Record<string, unknown> }));
Object.assign(mockDb, {
  transaction: (fn: (tx: unknown) => unknown) => Promise.resolve(fn(mockDb)),
  insert: () => ({
    values: (row: Record<string, unknown>) => {
      const newRow = { id: crypto.randomUUID(), ...row, createdAt: new Date(), updatedAt: new Date() };
      mockDbRows.push(newRow);
      return { returning: () => Promise.resolve([newRow]) };
    },
  }),
  select: () => ({
    from: () => {
      const result = Promise.resolve(mockDbRows);
      (result as any).where = () =>
        Promise.resolve(mockSelectResponses.length > 0 ? mockSelectResponses.shift()! : []);
      return result;
    },
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        const row = mockDbRows[0];
        if (row) Object.assign(row, values);
        return { returning: () => Promise.resolve([{ ...row, ...values }]) };
      },
    }),
  }),
});

vi.mock("../../src/db/index.js", () => ({ db: mockDb, sql: { end: () => Promise.resolve() } }));

const { mockFetchPromptTemplate, mockCreatePromptVersion } = vi.hoisted(() => ({
  mockFetchPromptTemplate: vi.fn(),
  mockCreatePromptVersion: vi.fn(),
}));
vi.mock("../../src/lib/content-generation-client.js", () => ({
  fetchPromptTemplate: mockFetchPromptTemplate,
  fetchPromptTemplates: vi.fn().mockResolvedValue(new Map()),
  createPromptVersion: mockCreatePromptVersion,
}));

vi.mock("../../src/lib/api-registry-client.js", () => ({
  // No spec → the endpoint check is skipped; topology is still validated.
  fetchSpecsForServices: vi.fn().mockResolvedValue(new Map()),
  fetchServiceList: vi.fn().mockResolvedValue([]),
  fetchServiceSpec: vi.fn().mockResolvedValue({}),
  fetchLlmContext: vi.fn().mockResolvedValue({ services: [] }),
  fetchServiceEndpoints: vi.fn().mockResolvedValue({ service: "", endpoints: [] }),
}));
vi.mock("../../src/lib/features-client.js", () => ({}));

const { mockCreateFlow, mockDeleteFlow } = vi.hoisted(() => ({
  mockCreateFlow: vi.fn().mockResolvedValue("f/workflows/test/flow"),
  mockDeleteFlow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/lib/windmill-client.js", () => ({
  getWindmillClient: () => ({
    createFlow: mockCreateFlow,
    updateFlow: vi.fn().mockResolvedValue(undefined),
    deleteFlow: mockDeleteFlow,
    getFlow: vi.fn().mockResolvedValue({ path: "f/workflows/test/flow" }),
    healthCheck: vi.fn().mockResolvedValue(true),
  }),
  WindmillClient: vi.fn(),
  resetWindmillClient: vi.fn(),
}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const AUTH = {
  "x-api-key": "test-api-key",
  "x-org-id": "staff-org",
  "x-user-id": "staff-user",
  "x-run-id": "run-1",
};

const SOURCE_ID = "00000000-0000-4000-8000-0000000000a1";
const TEMPLATE = "Hi {{leadFirstName}}, about {{leadCompanyName}}.";

const DAG_FIXTURE: DAG = {
  nodes: [
    {
      id: "gen",
      type: "http.call",
      config: {
        service: "content-generation",
        method: "POST",
        path: "/generate",
        body: { type: "cold-email-v7", model: "pro" },
      },
      inputMapping: {
        "body.variables.leadFirstName": "$ref:flow_input.firstName",
        "body.variables.leadCompanyName": "$ref:flow_input.company",
      },
    },
  ],
  edges: [],
};

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_ID,
    orgId: "owner-org",
    featureSlug: "sales-cold-email-outreach",
    workflowSlug: "sales-cold-email-outreach-lithium-v3",
    workflowName: "Sales Cold Email Outreach Lithium v3",
    workflowDynastySlug: "sales-cold-email-outreach-lithium",
    workflowDynastyName: "Sales Cold Email Outreach Lithium",
    workflowDynastySignatureName: "lithium",
    workflowDynastyStatus: "active",
    status: "active",
    version: 3,
    description: "cold email",
    category: "sales",
    channel: "email",
    audienceType: "cold-outreach",
    tags: [],
    signature: computeDAGSignature(DAG_FIXTURE),
    dag: DAG_FIXTURE,
    windmillFlowPath: "f/workflows/owner-org/lithium_v3",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const variables = [
  { name: "leadFirstName", description: "first name" },
  { name: "leadCompanyName", description: "company" },
];

beforeEach(() => {
  mockDbRows.length = 0;
  mockSelectResponses.length = 0;
  mockFetchPromptTemplate.mockReset();
  mockCreatePromptVersion.mockReset();
  mockCreateFlow.mockClear();
  mockDeleteFlow.mockClear();
  mockFetchPromptTemplate.mockResolvedValue({ id: "t1", type: "cold-email-v7", prompt: TEMPLATE, variables });
  mockCreatePromptVersion.mockImplementation(async (_s: string, prompt: string, vars: unknown) => ({
    created: true,
    template: { id: "t2", type: "cold-email-v12", prompt, variables: vars },
  }));
});

describe("POST /workflows/:id/prompt-edit — fork", () => {
  it("creates a new dynasty on a new template and leaves the source untouched", async () => {
    const source = sourceRow();
    mockDbRows.push(source);
    mockSelectResponses.push([source], [], [{ workflowDynastySignatureName: "lithium" }]);

    const edited = "Hello {{leadFirstName}} — quick note for {{leadCompanyName}}.";
    const res = await request
      .post(`/workflows/${SOURCE_ID}/prompt-edit`)
      .set(AUTH)
      .send({ action: "fork", prompt: edited });

    expect(res.status).toBe(201);
    expect(res.body.action).toBe("forked");
    expect(res.body.promptTemplate).toEqual({ previousType: "cold-email-v7", type: "cold-email-v12" });
    expect(res.body.workflow.workflowDynastySlug).not.toBe(source.workflowDynastySlug);
    expect(res.body.workflow.version).toBe(1);
    expect(res.body.workflow.creationType).toBe("fork");
    expect(res.body.workflow.createdFromWorkflow).toBe(SOURCE_ID);
    expect(res.body.workflow.orgId).toBe("owner-org");
    expect(res.body.workflow.contentPromptType).toBe("cold-email-v12");
    expect(res.body.workflow.contentModel).toBe("pro");
    expect(res.body.sourceWorkflow.id).toBe(SOURCE_ID);

    // The new template is created from the source's variables, never an overwrite.
    expect(mockCreatePromptVersion).toHaveBeenCalledWith(
      "cold-email-v7",
      edited,
      variables,
      expect.objectContaining({ "x-org-id": "staff-org", "x-user-id": "staff-user", "x-run-id": "run-1" }),
    );
    // Source untouched.
    expect(source.status).toBe("active");
    expect((source.dag.nodes[0].config.body as Record<string, unknown>).type).toBe("cold-email-v7");
  });

  it("forks from a superseded version too", async () => {
    const source = sourceRow({ status: "deprecated" });
    mockDbRows.push(source);
    mockSelectResponses.push([source], [], []);
    const res = await request
      .post(`/workflows/${SOURCE_ID}/prompt-edit`)
      .set(AUTH)
      .send({ action: "fork", prompt: "{{leadFirstName}} / {{leadCompanyName}}" });
    expect(res.status).toBe(201);
    expect(res.body.action).toBe("forked");
  });
});

describe("POST /workflows/dynasty/:slug/prompt-edit — upgrade", () => {
  it("adds a new version to the same dynasty and supersedes the active one", async () => {
    const source = sourceRow();
    mockDbRows.push(source);
    mockSelectResponses.push([source], []);

    const res = await request
      .post(`/workflows/dynasty/sales-cold-email-outreach-lithium/prompt-edit`)
      .set(AUTH)
      .send({ action: "upgrade", prompt: "Hey {{leadFirstName}} ({{leadCompanyName}})" });

    expect(res.status).toBe(201);
    expect(res.body.action).toBe("upgraded");
    expect(res.body.workflow.workflowDynastySlug).toBe("sales-cold-email-outreach-lithium");
    expect(res.body.workflow.workflowSlug).toBe("sales-cold-email-outreach-lithium-v4");
    expect(res.body.workflow.version).toBe(4);
    expect(res.body.workflow.creationType).toBe("upgrade");
    expect(res.body.workflow.orgId).toBe("owner-org");
    expect(res.body.workflow.contentPromptType).toBe("cold-email-v12");
    expect(source.status).toBe("deprecated");
    expect(mockDeleteFlow).toHaveBeenCalledWith("f/workflows/owner-org/lithium_v3");
  });

  it("404s a dynasty with no active version", async () => {
    mockSelectResponses.push([]);
    const res = await request
      .post(`/workflows/dynasty/nope/prompt-edit`)
      .set(AUTH)
      .send({ action: "upgrade", prompt: "x" });
    expect(res.status).toBe(404);
  });

  it("refuses to upgrade from a superseded version, naming the active one", async () => {
    const source = sourceRow({ status: "deprecated" });
    mockSelectResponses.push([source], [{ id: "active-id", workflowSlug: "sales-cold-email-outreach-lithium-v5" }]);
    const res = await request
      .post(`/workflows/${SOURCE_ID}/prompt-edit`)
      .set(AUTH)
      .send({ action: "upgrade", prompt: "{{leadFirstName}} {{leadCompanyName}}" });
    expect(res.status).toBe(409);
    expect(res.body.activeWorkflowId).toBe("active-id");
    expect(mockCreatePromptVersion).not.toHaveBeenCalled();
  });
});

describe("POST /workflows/:id/prompt-edit — refusals write nothing", () => {
  it("422s an edit that drops a variable, with a readable reason", async () => {
    mockSelectResponses.push([sourceRow()]);
    const res = await request
      .post(`/workflows/${SOURCE_ID}/prompt-edit`)
      .set(AUTH)
      .send({ action: "fork", prompt: "Hi {{leadFirstName}}." });
    expect(res.status).toBe(422);
    expect(res.body.droppedVariables).toEqual(["leadCompanyName"]);
    expect(res.body.error).toMatch(/removes \{\{leadCompanyName\}\}/);
    expect(mockCreatePromptVersion).not.toHaveBeenCalled();
    expect(mockCreateFlow).not.toHaveBeenCalled();
  });

  it("422s an edit that adds a variable the workflow does not provide", async () => {
    mockSelectResponses.push([sourceRow()]);
    const res = await request
      .post(`/workflows/${SOURCE_ID}/prompt-edit`)
      .set(AUTH)
      .send({ action: "upgrade", prompt: `${TEMPLATE} {{leadShoeSize}}` });
    expect(res.status).toBe(422);
    expect(res.body.addedVariables).toEqual(["leadShoeSize"]);
    expect(mockCreatePromptVersion).not.toHaveBeenCalled();
  });

  it("400s an unchanged prompt", async () => {
    mockSelectResponses.push([sourceRow()]);
    const res = await request
      .post(`/workflows/${SOURCE_ID}/prompt-edit`)
      .set(AUTH)
      .send({ action: "fork", prompt: TEMPLATE });
    expect(res.status).toBe(400);
    expect(mockCreatePromptVersion).not.toHaveBeenCalled();
  });

  it("409s a workflow with no fixed template", async () => {
    const dag: DAG = { nodes: [{ id: "a", type: "wait", config: { seconds: 1 } }], edges: [] };
    mockSelectResponses.push([sourceRow({ dag })]);
    const res = await request
      .post(`/workflows/${SOURCE_ID}/prompt-edit`)
      .set(AUTH)
      .send({ action: "fork", prompt: "x" });
    expect(res.status).toBe(409);
    expect(mockFetchPromptTemplate).not.toHaveBeenCalled();
  });

  it("400s an unknown action", async () => {
    const res = await request
      .post(`/workflows/${SOURCE_ID}/prompt-edit`)
      .set(AUTH)
      .send({ action: "replace", prompt: "x" });
    expect(res.status).toBe(400);
  });

  it("502s when content-generation stores nothing new", async () => {
    mockSelectResponses.push([sourceRow()]);
    mockCreatePromptVersion.mockResolvedValue({
      created: false,
      template: { id: "t1", type: "cold-email-v7", prompt: TEMPLATE, variables },
    });
    const res = await request
      .post(`/workflows/${SOURCE_ID}/prompt-edit`)
      .set(AUTH)
      .send({ action: "fork", prompt: "{{leadCompanyName}} {{leadFirstName}}" });
    expect(res.status).toBe(502);
    expect(mockCreateFlow).not.toHaveBeenCalled();
  });
});
