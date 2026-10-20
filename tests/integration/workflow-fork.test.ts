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
const mockFetchPipe = vi.fn();
// features-service owns the pipe <-> workflow link: these tests record what is assigned there.
const mockAssignWorkflowToLeg = vi.fn(async (a: Record<string, unknown>) => ({ ...a, state: "active", decidedAt: "2026-10-10T00:00:00.000Z" }));
const mockActiveLegsOfDynasty = vi.fn(async () => [] as string[]);
vi.mock("../../src/lib/catalogue-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/catalogue-client.js")>();
  return {
    ...actual,
    fetchPipe: (...a: unknown[]) => mockFetchPipe(...a),
    assignWorkflowToLeg: (...a: unknown[]) => mockAssignWorkflowToLeg(...(a as [Record<string, unknown>])),
    activeLegsOfDynasty: (...a: unknown[]) => mockActiveLegsOfDynasty(...(a as [])),
  };
});

import app from "../../src/index.js";

const request = supertest(app);
const AUTH = {
  "x-api-key": "test-api-key",
  "x-org-id": "staff-org",
  "x-user-id": "staff-user",
  "x-run-id": "run-1",
};

const SOURCE_ID = "00000000-0000-4000-8000-0000000000a1";

const DAG_FIXTURE: DAG = {
  nodes: [
    {
      id: "fetch-lead",
      type: "http.call",
      config: { service: "lead", method: "POST", path: "/orgs/buffer/next", body: { sourceType: "apollo" } },
    },
    {
      id: "gen",
      type: "http.call",
      config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email-v7", model: "pro" } },
      inputMapping: { "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.firstName" },
    },
  ],
  edges: [{ from: "fetch-lead", to: "gen" }],
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
    category: null,
    channel: null,
    audienceType: null,
    tags: ["t"],
    signature: computeDAGSignature(DAG_FIXTURE),
    dag: DAG_FIXTURE,
    windmillFlowPath: "f/workflows/owner-org/lithium_v3",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const CHANGE = [{ op: "add", path: "/nodes/fetch-lead/config/body/acceptedEmails", value: "valid_and_catch_all" }];

beforeEach(() => {
  mockDbRows.length = 0;
  mockSelectResponses.length = 0;
  mockCreateFlow.mockClear();
  mockAssignWorkflowToLeg.mockClear();
  mockActiveLegsOfDynasty.mockReset();
  mockActiveLegsOfDynasty.mockResolvedValue([]);
});

describe("POST /workflows/:id/fork", () => {
  it("creates a new dynasty with only the stated change, on the source's legs, owner org, source untouched", async () => {
    const source = sourceRow();
    const snapshot = JSON.stringify(source);
    mockDbRows.push(source);
    mockActiveLegsOfDynasty.mockResolvedValue(["lead_found_to_website_visit"]);
    mockSelectResponses.push([source], [], [{ workflowDynastySignatureName: "lithium" }]);

    const res = await request
      .post(`/workflows/${SOURCE_ID}/fork`)
      .set(AUTH)
      .send({ changes: CHANGE, description: "cold email. Valid + Catch-all copy." });

    expect(res.status).toBe(201);
    const wf = res.body.workflow;
    expect(wf.workflowDynastySlug).not.toBe(source.workflowDynastySlug);
    expect(wf.version).toBe(1);
    expect(wf.creationType).toBe("fork");
    expect(wf.createdFromWorkflow).toBe(SOURCE_ID);
    expect(wf.orgId).toBe("owner-org");
    expect(wf.description).toBe("cold email. Valid + Catch-all copy.");
    expect(wf.tags).toEqual(["t"]);
    expect(wf.dag.nodes[0].config.body).toEqual({ sourceType: "apollo", acceptedEmails: "valid_and_catch_all" });
    expect(wf.dag.nodes[1]).toEqual(DAG_FIXTURE.nodes[1]);
    expect(wf.dag.edges).toEqual(DAG_FIXTURE.edges);
    expect(res.body.sourceWorkflow).toEqual({
      id: SOURCE_ID,
      workflowSlug: source.workflowSlug,
      workflowDynastySlug: source.workflowDynastySlug,
      version: 3,
    });
    expect(res.body.changesApplied).toBe(1);
    expect(mockCreateFlow).toHaveBeenCalledTimes(1);
    expect(mockAssignWorkflowToLeg).toHaveBeenCalledWith(
      expect.objectContaining({ legKey: "lead_found_to_website_visit", workflowDynastySlug: wf.workflowDynastySlug }),
    );
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it("defaults description to the source's", async () => {
    const source = sourceRow();
    mockDbRows.push(source);
    mockSelectResponses.push([source], [], []);
    const res = await request.post(`/workflows/${SOURCE_ID}/fork`).set(AUTH).send({ changes: CHANGE });
    expect(res.status).toBe(201);
    expect(res.body.workflow.description).toBe("cold email");
  });

  it("409 naming the existing copy when the changed DAG already exists", async () => {
    const source = sourceRow();
    mockSelectResponses.push([source], [{ id: "00000000-0000-4000-8000-0000000000b2", workflowSlug: "sales-cold-email-outreach-vega" }]);
    const res = await request.post(`/workflows/${SOURCE_ID}/fork`).set(AUTH).send({ changes: CHANGE });
    expect(res.status).toBe(409);
    expect(res.body.existingWorkflowId).toBe("00000000-0000-4000-8000-0000000000b2");
    expect(mockCreateFlow).not.toHaveBeenCalled();
  });

  it("422 naming the change that cannot apply, nothing written", async () => {
    const source = sourceRow();
    mockSelectResponses.push([source]);
    const res = await request
      .post(`/workflows/${SOURCE_ID}/fork`)
      .set(AUTH)
      .send({ changes: [{ op: "replace", path: "/nodes/nope/config/x", value: 1 }] });
    expect(res.status).toBe(422);
    expect(res.body.changeIndex).toBe(0);
    expect(res.body.error).toMatch(/no node with id "nope"/);
    expect(mockCreateFlow).not.toHaveBeenCalled();
  });

  it("400 when the change leaves the DAG identical", async () => {
    const source = sourceRow();
    mockSelectResponses.push([source]);
    const res = await request
      .post(`/workflows/${SOURCE_ID}/fork`)
      .set(AUTH)
      .send({ changes: [{ op: "replace", path: "/nodes/fetch-lead/config/body/sourceType", value: "apollo" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/identical/);
  });

  it("400 on empty changes or a value-less add", async () => {
    expect((await request.post(`/workflows/${SOURCE_ID}/fork`).set(AUTH).send({ changes: [] })).status).toBe(400);
    expect(
      (await request.post(`/workflows/${SOURCE_ID}/fork`).set(AUTH).send({ changes: [{ op: "add", path: "/x" }] })).status,
    ).toBe(400);
  });

  it("404 on an unknown id", async () => {
    mockSelectResponses.push([]);
    const res = await request.post(`/workflows/${SOURCE_ID}/fork`).set(AUTH).send({ changes: CHANGE });
    expect(res.status).toBe(404);
  });
});

describe("POST /workflows/:id/fork with pipeId (ONE-LEG-FORKS-1020)", () => {
  const PIPE = "sales-cold-email-outreach|lead_found_to_conversation";
  const catalogued = (id: string) => ({
    id, name: "Bird", line: "x", channelSlug: id.split("|")[0], channelName: "Cold Email",
    legKey: id.split("|")[1], fromStep: "lead_found", toStep: "conversation",
    mode: "proactive", triggerId: null, operatedBy: "us", runnable: true,
  });
  beforeEach(() => {
    mockFetchPipe.mockReset();
  });

  it("copies the same steps as a new dynasty registered on THAT pipe only, never on the source's", async () => {
    const source = sourceRow();
    mockDbRows.push(source);
    mockFetchPipe.mockImplementation(async (id: string) => catalogued(id));
    mockActiveLegsOfDynasty.mockResolvedValue(["start_to_paid_client"]);
    mockSelectResponses.push([source], [], [{ workflowDynastySignatureName: "lithium" }]);

    const res = await request.post(`/workflows/${SOURCE_ID}/fork`).set(AUTH).send({ pipeId: PIPE });

    expect(res.status).toBe(201);
    const wf = res.body.workflow;
    expect(wf.workflowDynastySlug).not.toBe(source.workflowDynastySlug);
    expect(wf.creationType).toBe("fork");
    expect(wf.createdFromWorkflow).toBe(SOURCE_ID);
    expect(wf.dag).toEqual({ ...DAG_FIXTURE, forkedForPipe: PIPE });
    expect(wf.signature).not.toBe(source.signature);
    expect(mockActiveLegsOfDynasty).not.toHaveBeenCalled();
    expect(mockAssignWorkflowToLeg).toHaveBeenCalledTimes(1);
    expect(mockAssignWorkflowToLeg).toHaveBeenCalledWith(
      expect.objectContaining({
        featureSlug: "sales-cold-email-outreach",
        legKey: "lead_found_to_conversation",
        workflowDynastySlug: wf.workflowDynastySlug,
      }),
    );
  });

  it("400 for a pipe of another channel, nothing written", async () => {
    const source = sourceRow();
    mockSelectResponses.push([source]);
    const res = await request
      .post(`/workflows/${SOURCE_ID}/fork`)
      .set(AUTH)
      .send({ pipeId: "cold-whatsapp-outreach|lead_found_to_conversation" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a pipe of the source's channel/);
    expect(mockCreateFlow).not.toHaveBeenCalled();
    expect(mockAssignWorkflowToLeg).not.toHaveBeenCalled();
  });

  it("400 for a pipe the catalogue does not know, nothing written", async () => {
    const source = sourceRow();
    mockSelectResponses.push([source]);
    const { PipeResolutionError } = await import("../../src/lib/catalogue-client.js");
    mockFetchPipe.mockRejectedValue(new PipeResolutionError(`No pipe "${PIPE}" in the features-service catalogue`));
    const res = await request.post(`/workflows/${SOURCE_ID}/fork`).set(AUTH).send({ pipeId: PIPE });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No pipe/);
    expect(mockCreateFlow).not.toHaveBeenCalled();
  });
});

describe("POST /workflows/dynasty/:slug/fork", () => {
  it("forks the dynasty's active version", async () => {
    const source = sourceRow();
    mockDbRows.push(source);
    mockSelectResponses.push([source], [], []);
    const res = await request
      .post(`/workflows/dynasty/sales-cold-email-outreach-lithium/fork`)
      .set(AUTH)
      .send({ changes: CHANGE });
    expect(res.status).toBe(201);
    expect(res.body.sourceWorkflow.id).toBe(SOURCE_ID);
  });

  it("404 when the dynasty has no active version", async () => {
    mockSelectResponses.push([]);
    const res = await request.post(`/workflows/dynasty/nope/fork`).set(AUTH).send({ changes: CHANGE });
    expect(res.status).toBe(404);
  });
});
