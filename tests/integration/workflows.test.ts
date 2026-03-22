import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  VALID_LINEAR_DAG,
  DAG_WITH_UNKNOWN_TYPE,
  DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
  DAG_WITH_HTTP_CALL,
  DAG_WITH_HTTP_CALL_CHAIN,
  DAG_WITH_CONTENT_GEN_MISSING_VAR,
  DAG_WITH_CONTENT_GEN_ALL_VARS,
} from "../helpers/fixtures.js";

// Mock DB
const mockDbRows: Record<string, unknown>[] = [];
// Optional queue: when populated, select().from().where() shifts from it instead of returning mockDbRows
const mockSelectResponses: Record<string, unknown>[][] = [];

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
      from: () => {
        const result = Promise.resolve(mockDbRows);
        (result as any).where = (_condition?: unknown) =>
          Promise.resolve(
            mockSelectResponses.length > 0 ? mockSelectResponses.shift()! : mockDbRows,
          );
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

// Mock key-service client
const mockFetchProviderRequirements = vi.fn();
vi.mock("../../src/lib/key-service-client.js", () => ({
  fetchProviderRequirements: (...args: unknown[]) =>
    mockFetchProviderRequirements(...args),
}));

// Mock content-generation client (for template contract validation)
const mockFetchPromptTemplates = vi.fn().mockResolvedValue(new Map());
vi.mock("../../src/lib/content-generation-client.js", () => ({
  fetchPromptTemplate: vi.fn().mockResolvedValue(null),
  fetchPromptTemplates: (...args: unknown[]) =>
    mockFetchPromptTemplates(...args),
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

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const IDENTITY = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1", "x-brand-id": "brand-1" };
const AUTH = { "x-api-key": "test-api-key", ...IDENTITY };

describe("POST /workflows", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
  });

  it("creates a workflow with valid DAG", async () => {
    const res = await request
      .post("/workflows")
      .set(AUTH)
      .send({
        name: "Test Flow",
        createdForBrandId: "brand-test-001",
        category: "sales",
        channel: "email",
        audienceType: "cold-outreach",
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Test Flow");
    expect(res.body.orgId).toBe("org-1");
    expect(res.body.category).toBe("sales");
    expect(res.body.channel).toBe("email");
    expect(res.body.audienceType).toBe("cold-outreach");
    expect(res.body.tags).toEqual([]);
    expect(res.body.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.signatureName).toBeTruthy();
    expect(res.body.windmillFlowPath).toContain("f/workflows/org-1/");
  });

  it("creates a workflow with tags", async () => {
    const res = await request
      .post("/workflows")
      .set(AUTH)
      .send({
        name: "Multi-Channel Flow",
        createdForBrandId: "brand-test-001",
        category: "sales",
        channel: "email",
        audienceType: "cold-outreach",
        tags: ["email", "linkedin"],
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(201);
    expect(res.body.tags).toEqual(["email", "linkedin"]);
  });

  it("rejects an invalid DAG", async () => {
    const res = await request
      .post("/workflows")
      .set(AUTH)
      .send({
        name: "Bad Flow",
        createdForBrandId: "brand-test-001",
        category: "sales",
        channel: "email",
        audienceType: "cold-outreach",
        dag: DAG_WITH_UNKNOWN_TYPE,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid DAG");
    expect(res.body.details).toBeDefined();
  });


  it("requires authentication", async () => {
    const res = await request
      .post("/workflows")
      .set(IDENTITY)
      .send({
        name: "No Auth",
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(401);
  });

  it("validates request body with Zod", async () => {
    const res = await request.post("/workflows").set(AUTH).send({
      // Missing required fields
      name: "Incomplete",
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /workflows", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
  });

  it("returns all workflows when no filters provided", async () => {
    mockDbRows.push({
      id: "wf-1",
      orgId: "org-1",
      name: "Flow 1",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request.get("/workflows").set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toHaveLength(1);
  });

  it("returns workflows for orgId", async () => {
    mockDbRows.push({
      id: "wf-1",
      orgId: "org-1",
      name: "Flow 1",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get("/workflows")
      .query({ orgId: "org-1" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toBeDefined();
  });

  it("returns dimensions in response", async () => {
    mockDbRows.push({
      id: "wf-1",
      orgId: "org-1",
      name: "sales-email-cold-outreach-sequoia",
      displayName: "Sales Flow",
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      signature: "abc123",
      signatureName: "sequoia",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get("/workflows")
      .query({ orgId: "org-1" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows[0].category).toBe("sales");
    expect(res.body.workflows[0].channel).toBe("email");
    expect(res.body.workflows[0].audienceType).toBe("cold-outreach");
  });
});

const DEPLOY_ITEM = {
  category: "sales" as const,
  channel: "email" as const,
  audienceType: "cold-outreach" as const,
};

describe("PUT /workflows/upgrade", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockSelectResponses.length = 0;
    mockFetchPromptTemplates.mockReset();
    mockFetchPromptTemplates.mockResolvedValue(new Map());
  });

  it("deploys a workflow with tags", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            ...DEPLOY_ITEM,
            tags: ["email", "linkedin"],
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.workflows[0].tags).toEqual(["email", "linkedin"]);
  });

  it("defaults tags to empty array when omitted", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            ...DEPLOY_ITEM,
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.workflows[0].tags).toEqual([]);
  });

  it("creates a workflow with auto-generated name and signatureName", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            ...DEPLOY_ITEM,
            description: "Cold email outreach",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.workflows).toHaveLength(1);
    const wf = res.body.workflows[0];
    expect(wf.action).toBe("created");
    expect(wf.id).toBeDefined();
    expect(wf.category).toBe("sales");
    expect(wf.channel).toBe("email");
    expect(wf.audienceType).toBe("cold-outreach");
    expect(wf.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(wf.signatureName).toBeTruthy();
    expect(wf.name).toBe(`sales-email-cold-outreach-${wf.signatureName}`);
  });

  it("creates outlets-database-discovery workflow with correct name", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            category: "outlets" as const,
            channel: "database" as const,
            audienceType: "discovery" as const,
            description: "outlets database discovery",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(200);
    const wf = res.body.workflows[0];
    expect(wf.category).toBe("outlets");
    expect(wf.channel).toBe("database");
    expect(wf.audienceType).toBe("discovery");
    expect(wf.name).toBe(`outlets-database-discovery-${wf.signatureName}`);
  });

  it("creates journalists-database-discovery workflow with correct name", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            category: "journalists" as const,
            channel: "database" as const,
            audienceType: "discovery" as const,
            description: "journalists database discovery",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(200);
    const wf = res.body.workflows[0];
    expect(wf.category).toBe("journalists");
    expect(wf.channel).toBe("database");
    expect(wf.audienceType).toBe("discovery");
    expect(wf.name).toBe(`journalists-database-discovery-${wf.signatureName}`);
  });

  it("stores orgId from x-org-id header in DB", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH) // x-org-id: "org-1"
      .send({
        workflows: [
          {
            ...DEPLOY_ITEM,
            description: "Workflow with header orgId",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(200);
    const inserted = mockDbRows[mockDbRows.length - 1];
    expect(inserted.orgId).toBe("org-1"); // from header
  });

  it("updates existing workflow when same DAG is redeployed (idempotent)", async () => {
    const { computeDAGSignature } = await import("../../src/lib/dag-signature.js");
    const sig = computeDAGSignature(DAG_WITH_TRANSACTIONAL_EMAIL_SEND);

    mockDbRows.push({
      id: "wf-existing",
      orgId: "org-deploy",
      name: "sales-email-cold-outreach-sequoia",
      signatureName: "sequoia",
      signature: sig,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Old description",
      dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
      windmillFlowPath: "f/workflows/distribute/sales_email_cold_outreach_sequoia",
      windmillWorkspace: "prod",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            ...DEPLOY_ITEM,
            description: "Updated description",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.workflows[0].action).toBe("updated");
    expect(res.body.workflows[0].signatureName).toBe("sequoia");
  });

  it("same DAG produces same signature across deploys", async () => {
    const payload = {
      workflows: [{ ...DEPLOY_ITEM, dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND }],
    };

    const res1 = await request.put("/workflows/upgrade").set(AUTH).send(payload);
    const res2 = await request.put("/workflows/upgrade").set(AUTH).send(payload);

    expect(res1.body.workflows[0].signature).toBe(res2.body.workflows[0].signature);
  });

  it("different DAG produces different signature", async () => {
    const { computeDAGSignature } = await import("../../src/lib/dag-signature.js");
    const sig1 = computeDAGSignature(DAG_WITH_TRANSACTIONAL_EMAIL_SEND);
    const sig2 = computeDAGSignature(VALID_LINEAR_DAG);
    expect(sig1).not.toBe(sig2);

    // Deploy first DAG
    const res1 = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [{ ...DEPLOY_ITEM, dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND }],
      });
    expect(res1.body.workflows[0].signature).toBe(sig1);

    // Deploy second DAG in fresh state (mock DB doesn't filter by column)
    mockDbRows.length = 0;
    const res2 = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [{ ...DEPLOY_ITEM, dag: VALID_LINEAR_DAG }],
      });
    expect(res2.body.workflows[0].signature).toBe(sig2);
  });

  it("rejects missing dimensions", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            // Missing category, channel, audienceType
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(400);
  });

  it("rejects invalid channel value", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            category: "sales",
            channel: "smoke-signal",
            audienceType: "cold-outreach",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(400);
  });

  it("rejects invalid audienceType value", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            category: "sales",
            channel: "email",
            audienceType: "lukewarm",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(400);
  });

  it("rejects invalid category values", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            category: "invalid-category",
            channel: "email",
            audienceType: "cold-outreach",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(400);
  });

  it("rejects removed enum values (utility, api, internal)", async () => {
    const cases = [
      { category: "utility", channel: "email", audienceType: "cold-outreach" },
      { category: "sales", channel: "api", audienceType: "cold-outreach" },
      { category: "sales", channel: "email", audienceType: "internal" },
    ];

    for (const dims of cases) {
      const res = await request
        .put("/workflows/upgrade")
        .set(AUTH)
        .send({
          orgId: "org-deploy",
          workflows: [{ ...dims, dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND }],
        });

      expect(res.status).toBe(400);
    }
  });

  it("rejects if any DAG is invalid (no partial writes)", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          { ...DEPLOY_ITEM, dag: VALID_LINEAR_DAG },
          { ...DEPLOY_ITEM, dag: DAG_WITH_UNKNOWN_TYPE },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid DAGs");
    expect(res.body.details).toHaveLength(1);
  });

  it("requires authentication", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(IDENTITY)
      .send({
        workflows: [{ ...DEPLOY_ITEM, dag: VALID_LINEAR_DAG }],
      });

    expect(res.status).toBe(401);
  });

  it("validates request body", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({}); // missing workflows

    expect(res.status).toBe(400);
  });

  it("rejects deploy when workflow is missing template variables", async () => {
    const COLD_EMAIL_TEMPLATE = {
      id: "tmpl-1",
      type: "cold-email",
      prompt: "Write for {{leadFirstName}} at {{clientCompanyName}}...",
      variables: [
        "leadFirstName",
        "leadLastName",
        "leadTitle",
        "leadCompanyName",
        "leadCompanyIndustry",
        "clientCompanyName",
        "brandProfile",
      ],
      createdAt: "2026-03-12T00:00:00Z",
      updatedAt: "2026-03-17T00:00:00Z",
    };

    mockFetchPromptTemplates.mockResolvedValueOnce(
      new Map([["cold-email", COLD_EMAIL_TEMPLATE]]),
    );

    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            ...DEPLOY_ITEM,
            dag: DAG_WITH_CONTENT_GEN_MISSING_VAR,
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Template contract validation failed");
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "clientCompanyName",
          severity: "error",
        }),
      ]),
    );
  });

  it("allows deploy when all template variables are provided", async () => {
    const COLD_EMAIL_TEMPLATE = {
      id: "tmpl-1",
      type: "cold-email",
      prompt: "Write for {{leadFirstName}} at {{clientCompanyName}}...",
      variables: [
        "leadFirstName",
        "leadLastName",
        "leadTitle",
        "leadCompanyName",
        "leadCompanyIndustry",
        "clientCompanyName",
        "brandProfile",
      ],
      createdAt: "2026-03-12T00:00:00Z",
      updatedAt: "2026-03-17T00:00:00Z",
    };

    mockFetchPromptTemplates.mockResolvedValueOnce(
      new Map([["cold-email", COLD_EMAIL_TEMPLATE]]),
    );

    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            ...DEPLOY_ITEM,
            dag: DAG_WITH_CONTENT_GEN_ALL_VARS,
          },
        ],
      });

    expect(res.status).toBe(200);
  });

  it("does not block deploy when content-generation service is unreachable", async () => {
    mockFetchPromptTemplates.mockRejectedValueOnce(
      new Error("ECONNREFUSED"),
    );

    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            ...DEPLOY_ITEM,
            dag: DAG_WITH_CONTENT_GEN_MISSING_VAR,
          },
        ],
      });

    // Should still succeed — template validation is best-effort
    expect(res.status).toBe(200);
  });

});

describe("GET /workflows/:id/required-providers", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockFetchProviderRequirements.mockReset();
  });

  it("returns providers for a workflow with http.call nodes", async () => {
    mockDbRows.push({
      id: "wf-http",
      orgId: "org-1",
      name: "HTTP Flow",
      dag: DAG_WITH_HTTP_CALL_CHAIN,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockFetchProviderRequirements.mockResolvedValue({
      requirements: [
        { provider: "client", fields: ["apiKey"] },
        { provider: "transactional-email", fields: ["apiKey"] },
      ],
      providers: ["client", "transactional-email"],
    });

    const res = await request
      .get("/workflows/wf-http/required-providers")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.endpoints).toHaveLength(2);
    expect(res.body.providers).toEqual([
      { name: "client", domain: null },
      { name: "transactional-email", domain: null },
    ]);
    expect(mockFetchProviderRequirements).toHaveBeenCalledWith(
      [
        { service: "client", method: "POST", path: "/users" },
        { service: "transactional-email", method: "POST", path: "/send" },
      ],
      { orgId: "org-1", userId: "user-1", runId: "run-caller-1" },
    );
  });

  it("enriches providers with domain info for known providers", async () => {
    mockDbRows.push({
      id: "wf-http",
      orgId: "org-1",
      name: "HTTP Flow",
      dag: DAG_WITH_HTTP_CALL_CHAIN,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockFetchProviderRequirements.mockResolvedValue({
      requirements: [
        { provider: "anthropic", fields: ["apiKey"] },
        { provider: "apollo", fields: ["apiKey"] },
      ],
      providers: ["anthropic", "apollo"],
    });

    const res = await request
      .get("/workflows/wf-http/required-providers")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual([
      { name: "anthropic", domain: "anthropic.com" },
      { name: "apollo", domain: "apollo.io" },
    ]);
  });

  it("returns empty providers for workflows with no http.call nodes", async () => {
    mockDbRows.push({
      id: "wf-legacy",
      orgId: "org-1",
      name: "Legacy Flow",
      dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get("/workflows/wf-legacy/required-providers")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.endpoints).toEqual([]);
    expect(res.body.requirements).toEqual([]);
    expect(res.body.providers).toEqual([]);
    expect(mockFetchProviderRequirements).not.toHaveBeenCalled();
  });

  it("returns 404 for non-existent workflow", async () => {
    const res = await request
      .get("/workflows/nonexistent-id/required-providers")
      .set(AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Workflow not found");
  });

  it("returns 502 when key-service fails", async () => {
    mockDbRows.push({
      id: "wf-http",
      orgId: "org-1",
      name: "HTTP Flow",
      dag: DAG_WITH_HTTP_CALL,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockFetchProviderRequirements.mockRejectedValue(
      new Error(
        "key-service error: POST /provider-requirements -> 500 Internal Server Error: boom"
      )
    );

    const res = await request
      .get("/workflows/wf-http/required-providers")
      .set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("key-service error:");
  });

  it("returns 502 when KEY_SERVICE env vars are missing", async () => {
    mockDbRows.push({
      id: "wf-http",
      orgId: "org-1",
      name: "HTTP Flow",
      dag: DAG_WITH_HTTP_CALL,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockFetchProviderRequirements.mockRejectedValue(
      new Error(
        "KEY_SERVICE_URL and KEY_SERVICE_API_KEY must be set to fetch provider requirements"
      )
    );

    const res = await request
      .get("/workflows/wf-http/required-providers")
      .set(AUTH);

    expect(res.status).toBe(502);
  });

  it("requires authentication", async () => {
    const res = await request
      .get("/workflows/wf-1/required-providers")
      .set(IDENTITY);
    expect(res.status).toBe(401);
  });
});

describe("PUT /workflows/:id — fork", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockSelectResponses.length = 0;
  });

  it("forks a workflow when DAG changes (returns 201 with new ID)", async () => {
    const originalWorkflow = {
      id: "wf-original",
      orgId: "org-1",
      createdForBrandId: "brand-1",
      humanId: null,
      campaignId: "camp-1",
      subrequestId: null,
      styleName: null,
      name: "sales-email-cold-outreach-jasmine",
      displayName: "Jasmine Flow",
      description: "Original description",
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      tags: ["email"],
      signature: "aaa111",
      signatureName: "jasmine",
      dag: VALID_LINEAR_DAG,
      status: "active",
      upgradedTo: null,
      forkedFrom: null,
      windmillFlowPath: "f/workflows/org-1/sales_email_cold_outreach_jasmine",
      windmillWorkspace: "prod",
      createdByUserId: "user-1",
      createdByRunId: "run-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Queue: 1st select = find existing workflow, 2nd = check conflicting signature, 3rd = get used signatureNames
    mockSelectResponses.push(
      [originalWorkflow],  // existing workflow lookup
      [],                  // no conflicting signature
      [{ signatureName: "jasmine" }],  // existing signatureNames in org
    );

    const res = await request
      .put("/workflows/wf-original")
      .set(AUTH)
      .send({
        dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
        description: "Forked with new DAG",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe("wf-original");
    expect(res.body.forkedFrom).toBe("wf-original");
    expect(res.body.category).toBe("sales");
    expect(res.body.channel).toBe("email");
    expect(res.body.audienceType).toBe("cold-outreach");
    expect(res.body.description).toBe("Forked with new DAG");
    expect(res.body.status).toBe("active");
    // displayName uses the new generated name (not the parent's)
    expect(res.body.displayName).toBe(res.body.name);
    // Original should still be in mockDbRows unchanged
    expect(originalWorkflow.status).toBe("active");
  });

  it("updates in-place when only metadata changes (no DAG)", async () => {
    mockDbRows.push({
      id: "wf-meta",
      orgId: "org-1",
      name: "sales-email-cold-outreach-maple",
      description: "Old desc",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .put("/workflows/wf-meta")
      .set(AUTH)
      .send({
        description: "Updated description",
        tags: ["updated"],
      });

    expect(res.status).toBe(200);
    expect(res.body.description).toBe("Updated description");
    expect(res.body.tags).toEqual(["updated"]);
    // No forkedFrom — it's the same workflow
    expect(res.body.forkedFrom).toBeUndefined();
  });

  it("updates in-place when DAG is provided but signature is unchanged", async () => {
    const { computeDAGSignature } = await import("../../src/lib/dag-signature.js");
    const sig = computeDAGSignature(VALID_LINEAR_DAG);

    mockDbRows.push({
      id: "wf-same-sig",
      orgId: "org-1",
      name: "sales-email-cold-outreach-cedar",
      signature: sig,
      dag: VALID_LINEAR_DAG,
      windmillFlowPath: "f/workflows/org-1/flow",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .put("/workflows/wf-same-sig")
      .set(AUTH)
      .send({
        dag: VALID_LINEAR_DAG,
        description: "Same DAG, new desc",
      });

    expect(res.status).toBe(200);
    expect(res.body.description).toBe("Same DAG, new desc");
  });

  it("returns 404 for non-existent workflow", async () => {
    const res = await request
      .put("/workflows/nonexistent-id")
      .set(AUTH)
      .send({ description: "test" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Workflow not found");
  });

  it("returns 409 when forked DAG conflicts with existing active workflow", async () => {
    const { computeDAGSignature } = await import("../../src/lib/dag-signature.js");
    const conflictingSig = computeDAGSignature(DAG_WITH_TRANSACTIONAL_EMAIL_SEND);

    const originalWorkflow = {
      id: "wf-src",
      orgId: "org-1",
      name: "sales-email-cold-outreach-oak",
      signature: "different-sig",
      dag: VALID_LINEAR_DAG,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockSelectResponses.push(
      [originalWorkflow],  // existing workflow lookup
      [{ id: "wf-conflict", name: "sales-email-cold-outreach-birch", signature: conflictingSig, status: "active" }],  // conflicting workflow
    );

    const res = await request
      .put("/workflows/wf-src")
      .set(AUTH)
      .send({ dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already exists");
    expect(res.body.existingWorkflowId).toBe("wf-conflict");
    expect(res.body.existingWorkflowName).toBe("sales-email-cold-outreach-birch");
  });

  it("forking a fork sets forkedFrom to immediate parent", async () => {
    const fork1 = {
      id: "wf-fork1",
      orgId: "org-1",
      createdForBrandId: null,
      humanId: null,
      campaignId: null,
      subrequestId: null,
      styleName: null,
      name: "sales-email-cold-outreach-birch",
      displayName: "Birch Flow",
      description: "First fork",
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      tags: [],
      signature: "bbb222",
      signatureName: "birch",
      dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
      status: "active",
      upgradedTo: null,
      forkedFrom: "wf-original",
      windmillFlowPath: "f/workflows/org-1/flow",
      windmillWorkspace: "prod",
      createdByUserId: "user-1",
      createdByRunId: "run-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockSelectResponses.push(
      [fork1],             // existing workflow lookup
      [],                  // no conflicting signature
      [{ signatureName: "birch" }, { signatureName: "jasmine" }],  // existing signatureNames
    );

    const res = await request
      .put("/workflows/wf-fork1")
      .set(AUTH)
      .send({ dag: VALID_LINEAR_DAG });

    expect(res.status).toBe(201);
    expect(res.body.forkedFrom).toBe("wf-fork1"); // immediate parent, not wf-original
  });

  it("inherits metadata from parent workflow", async () => {
    const parent = {
      id: "wf-parent",
      orgId: "org-1",
      createdForBrandId: "brand-xyz",
      humanId: "human-abc",
      campaignId: "camp-123",
      subrequestId: "sub-456",
      styleName: "hormozi",
      name: "sales-email-cold-outreach-sequoia",
      displayName: "Sequoia Flow",
      description: "Parent description",
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      tags: ["inherited"],
      signature: "ccc333",
      signatureName: "sequoia",
      dag: VALID_LINEAR_DAG,
      status: "active",
      upgradedTo: null,
      forkedFrom: null,
      windmillFlowPath: "f/workflows/org-1/flow",
      windmillWorkspace: "prod",
      createdByUserId: "user-1",
      createdByRunId: "run-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockSelectResponses.push(
      [parent],
      [],
      [{ signatureName: "sequoia" }],
    );

    const res = await request
      .put("/workflows/wf-parent")
      .set(AUTH)
      .send({ dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND });

    expect(res.status).toBe(201);
    expect(res.body.createdForBrandId).toBe("brand-xyz");
    expect(res.body.category).toBe("sales");
    expect(res.body.channel).toBe("email");
    expect(res.body.audienceType).toBe("cold-outreach");
    expect(res.body.tags).toEqual(["inherited"]);
  });

  it("forks successfully when existing workflow has null description", async () => {
    const originalWorkflow = {
      id: "wf-null-desc",
      orgId: "org-1",
      createdForBrandId: null,
      humanId: null,
      campaignId: null,
      subrequestId: null,
      styleName: null,
      name: "sales-email-cold-outreach-cedar",
      displayName: "Cedar Flow",
      description: null,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      tags: [],
      signature: "ccc333",
      signatureName: "cedar",
      dag: VALID_LINEAR_DAG,
      status: "active",
      upgradedTo: null,
      forkedFrom: null,
      windmillFlowPath: "f/workflows/org-1/sales_email_cold_outreach_cedar",
      windmillWorkspace: "prod",
      createdByUserId: "user-1",
      createdByRunId: "run-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockSelectResponses.push(
      [originalWorkflow],
      [],
      [{ signatureName: "cedar" }],
    );

    const res = await request
      .put("/workflows/wf-null-desc")
      .set(AUTH)
      .send({ dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND });

    expect(res.status).toBe(201);
    expect(res.body.forkedFrom).toBe("wf-null-desc");
  });

  it("forked workflow displayName uses new name, not parent displayName", async () => {
    const originalWorkflow = {
      id: "wf-display",
      orgId: "org-1",
      createdForBrandId: "brand-1",
      humanId: null,
      campaignId: null,
      subrequestId: null,
      styleName: null,
      name: "sales-email-cold-outreach-jasmine",
      displayName: "sales-email-cold-outreach-jasmine",
      description: "Original",
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      tags: [],
      signature: "old-sig-111",
      signatureName: "jasmine",
      dag: VALID_LINEAR_DAG,
      status: "active",
      upgradedTo: null,
      forkedFrom: null,
      windmillFlowPath: "f/workflows/org-1/sales_email_cold_outreach_jasmine",
      windmillWorkspace: "prod",
      createdByUserId: "user-1",
      createdByRunId: "run-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockSelectResponses.push(
      [originalWorkflow],
      [],
      [{ signatureName: "jasmine" }],
    );

    const res = await request
      .put("/workflows/wf-display")
      .set(AUTH)
      .send({ dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND });

    expect(res.status).toBe(201);
    // The new displayName must match the new name (with new signatureName), NOT the parent's
    expect(res.body.displayName).toBe(res.body.name);
    expect(res.body.displayName).not.toBe("sales-email-cold-outreach-jasmine");
    expect(res.body.signatureName).not.toBe("jasmine");
  });

  it("fork avoids signatureNames used by other orgs (global uniqueness)", async () => {
    const { computeDAGSignature } = await import("../../src/lib/dag-signature.js");
    const { pickSignatureName } = await import("../../src/lib/signature-words.js");

    const newDag = DAG_WITH_TRANSACTIONAL_EMAIL_SEND;
    const newSig = computeDAGSignature(newDag);

    // Determine what signatureName pickSignatureName would pick if no names were used
    const firstPick = pickSignatureName(newSig, new Set());

    const originalWorkflow = {
      id: "wf-global-test",
      orgId: "org-1",
      createdForBrandId: null,
      humanId: null,
      campaignId: null,
      subrequestId: null,
      styleName: null,
      name: "sales-email-cold-outreach-cedar",
      displayName: "Cedar Flow",
      description: "Original",
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      tags: [],
      signature: "old-sig-global",
      signatureName: "cedar",
      dag: VALID_LINEAR_DAG,
      status: "active",
      upgradedTo: null,
      forkedFrom: null,
      windmillFlowPath: "f/workflows/org-1/flow",
      windmillWorkspace: "prod",
      createdByUserId: "user-1",
      createdByRunId: "run-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Mock: the signatureNames query returns the first-pick name as already used
    // (simulating another org already having that signatureName globally)
    mockSelectResponses.push(
      [originalWorkflow],  // existing workflow lookup
      [],                  // no conflicting signature
      [{ signatureName: "cedar" }, { signatureName: firstPick }],  // globally used signatureNames
    );

    const res = await request
      .put("/workflows/wf-global-test")
      .set(AUTH)
      .send({ dag: newDag });

    expect(res.status).toBe(201);
    // Must NOT use the firstPick since it's globally taken
    expect(res.body.signatureName).not.toBe(firstPick);
    expect(res.body.signatureName).not.toBe("cedar");
  });

  it("rejects invalid DAG on fork", async () => {
    mockDbRows.push({
      id: "wf-bad",
      orgId: "org-1",
      name: "sales-email-cold-outreach-pine",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .put("/workflows/wf-bad")
      .set(AUTH)
      .send({ dag: DAG_WITH_UNKNOWN_TYPE });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid DAG");
  });
});

describe("POST /workflows/:id/validate", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
  });

  it("validates the DAG of an existing workflow", async () => {
    mockDbRows.push({
      id: "wf-1",
      orgId: "org-1",
      name: "Flow 1",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .post("/workflows/wf-1/validate")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });
});
