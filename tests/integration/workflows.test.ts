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

// Mock features-client (for fork dynasty name resolution)
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
    // Simulate: dynasty slug resolves to itself + versioned variants
    return Promise.resolve([dynastySlug, `${dynastySlug}-v2`, `${dynastySlug}-v3`]);
  }),
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

// Valid UUID test IDs
const WF_ID = "00000000-0000-4000-8000-000000000001";
const WF_FEATURE_ID = "00000000-0000-4000-8000-000000000002";
const WF_EXISTING_ID = "00000000-0000-4000-8000-000000000003";
const WF_HTTP_ID = "00000000-0000-4000-8000-000000000004";
const WF_LEGACY_ID = "00000000-0000-4000-8000-000000000005";
const WF_META_ID = "00000000-0000-4000-8000-000000000006";
const WF_DAG_REJECT_ID = "00000000-0000-4000-8000-000000000007";

describe("POST /workflows", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
  });

  it("creates a workflow with valid DAG", async () => {
    const res = await request
      .post("/workflows")
      .set(AUTH)
      .send({
        createdForBrandId: "brand-test-001",
        featureSlug: "sales-cold-email-outreach",
        category: "sales",
        channel: "email",
        audienceType: "cold-outreach",
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(201);
    expect(res.body.slug).toBeTruthy();
    expect(res.body.name).toBeTruthy();
    expect(res.body.dynastyName).toBeTruthy();
    expect(res.body.version).toBe(1);
    expect(res.body.orgId).toBe("org-1");
    expect(res.body.featureSlug).toBe("sales-cold-email-outreach");
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
        createdForBrandId: "brand-test-001",
        featureSlug: "sales-multi-channel",
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
        createdForBrandId: "brand-test-001",
        featureSlug: "sales-bad-flow",
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
        featureSlug: "no-auth-test",
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(401);
  });

  it("validates request body with Zod", async () => {
    const res = await request.post("/workflows").set(AUTH).send({
      // Missing required fields (no featureSlug, no dag)
      description: "Incomplete",
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
      id: WF_ID,
      orgId: "org-1",
      slug: "flow-1",
      name: "Flow 1",
      dynastyName: "Flow 1",
      version: 1,
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
      id: WF_ID,
      orgId: "org-1",
      slug: "flow-1",
      name: "Flow 1",
      dynastyName: "Flow 1",
      version: 1,
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

  it("creates a workflow with featureSlug and returns it in response", async () => {
    const res = await request
      .post("/workflows")
      .set(AUTH)
      .send({
        createdForBrandId: "brand-test-001",
        featureSlug: "outlet-database-discovery",
        category: "outlets",
        channel: "database",
        audienceType: "discovery",
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(201);
    expect(res.body.featureSlug).toBe("outlet-database-discovery");
  });

  it("filters workflows by featureSlug", async () => {
    mockDbRows.push({
      id: WF_FEATURE_ID,
      orgId: "org-1",
      slug: "outlet-database-discovery-sequoia",
      name: "Outlet Database Discovery Sequoia",
      dynastyName: "Outlet Database Discovery Sequoia",
      version: 1,
      featureSlug: "outlet-database-discovery",
      category: "outlets",
      channel: "database",
      audienceType: "discovery",
      status: "active",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get("/workflows")
      .query({ featureSlug: "outlet-database-discovery" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toBeDefined();
    expect(res.body.workflows[0].featureSlug).toBe("outlet-database-discovery");
  });

  it("filters workflows by featureDynastySlug via features-service resolution", async () => {
    mockDbRows.push({
      id: WF_FEATURE_ID,
      orgId: "org-1",
      slug: "outlet-database-discovery-sequoia",
      name: "Outlet Database Discovery Sequoia",
      dynastyName: "Outlet Database Discovery Sequoia",
      version: 1,
      featureSlug: "outlet-database-discovery",
      status: "active",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get("/workflows")
      .query({ featureDynastySlug: "outlet-database-discovery" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toBeDefined();
  });

  it("filters workflows by workflowDynastySlug", async () => {
    mockDbRows.push({
      id: WF_FEATURE_ID,
      orgId: "org-1",
      slug: "sales-cold-email-outreach-sequoia-v2",
      name: "Sales Cold Email Outreach Sequoia v2",
      dynastyName: "Sales Cold Email Outreach Sequoia",
      dynastySlug: "sales-cold-email-outreach-sequoia",
      version: 2,
      featureSlug: "sales-cold-email-outreach",
      status: "active",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get("/workflows")
      .query({ workflowDynastySlug: "sales-cold-email-outreach-sequoia" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toBeDefined();
  });

  it("filters workflows by workflowSlug", async () => {
    mockDbRows.push({
      id: WF_FEATURE_ID,
      orgId: "org-1",
      slug: "sales-cold-email-outreach-sequoia",
      name: "Sales Cold Email Outreach Sequoia",
      dynastyName: "Sales Cold Email Outreach Sequoia",
      version: 1,
      featureSlug: "sales-cold-email-outreach",
      status: "active",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get("/workflows")
      .query({ workflowSlug: "sales-cold-email-outreach-sequoia" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toBeDefined();
  });

  it("returns dimensions in response", async () => {
    mockDbRows.push({
      id: WF_ID,
      orgId: "org-1",
      slug: "sales-cold-email-outreach-sequoia",
      name: "Sales Cold Email Outreach Sequoia",
      dynastyName: "Sales Cold Email Outreach Sequoia",
      version: 1,
      featureSlug: "sales-cold-email-outreach",
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
    expect(res.body.workflows[0].featureSlug).toBe("sales-cold-email-outreach");
    // category, channel, audienceType are now optional — may or may not be present
    expect(res.body.workflows[0].category).toBe("sales");
    expect(res.body.workflows[0].channel).toBe("email");
    expect(res.body.workflows[0].audienceType).toBe("cold-outreach");
  });
});

const DEPLOY_ITEM = {
  featureSlug: "sales-cold-email-outreach",
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

  it("deploys a workflow with featureSlug", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            ...DEPLOY_ITEM,
            featureSlug: "outlet-database-discovery",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(200);
    // featureSlug is stored in DB but deploy result only returns standard fields
    expect(res.body.workflows).toHaveLength(1);
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
    expect(wf.featureSlug).toBe("sales-cold-email-outreach");
    expect(wf.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(wf.signatureName).toBeTruthy();
    expect(wf.slug).toBe(`sales-cold-email-outreach-${wf.signatureName}`);
  });

  it("creates outlets-database-discovery workflow with correct slug", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            featureSlug: "outlet-database-discovery",
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
    expect(wf.featureSlug).toBe("outlet-database-discovery");
    expect(wf.slug).toBe(`outlet-database-discovery-${wf.signatureName}`);
  });

  it("creates journalists-database-discovery workflow with correct slug", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            featureSlug: "journalist-database-discovery",
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
    expect(wf.featureSlug).toBe("journalist-database-discovery");
    expect(wf.slug).toBe(`journalist-database-discovery-${wf.signatureName}`);
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
      id: WF_EXISTING_ID,
      orgId: "org-deploy",
      slug: "sales-cold-email-outreach-sequoia",
      name: "Sales Cold Email Outreach Sequoia",
      dynastyName: "Sales Cold Email Outreach Sequoia",
      version: 1,
      signatureName: "sequoia",
      signature: sig,
      featureSlug: "sales-cold-email-outreach",
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Old description",
      dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
      windmillFlowPath: "f/workflows/distribute/sales_cold_email_outreach_sequoia",
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

  it("rejects missing featureSlug", async () => {
    const res = await request
      .put("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflows: [
          {
            // Missing featureSlug (now required)
            category: "sales",
            channel: "email",
            audienceType: "cold-outreach",
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
            featureSlug: "sales-smoke-signal",
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
            featureSlug: "sales-lukewarm",
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
            featureSlug: "invalid-category-test",
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
      { featureSlug: "utility-test", category: "utility", channel: "email", audienceType: "cold-outreach" },
      { featureSlug: "api-test", category: "sales", channel: "api", audienceType: "cold-outreach" },
      { featureSlug: "internal-test", category: "sales", channel: "email", audienceType: "internal" },
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
      id: WF_HTTP_ID,
      orgId: "org-1",
      slug: "http-flow",
      name: "HTTP Flow",
      dynastyName: "HTTP Flow",
      version: 1,
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
      .get(`/workflows/${WF_HTTP_ID}/required-providers`)
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
      { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1", "x-brand-id": "brand-1" },
    );
  });

  it("enriches providers with domain info for known providers", async () => {
    mockDbRows.push({
      id: WF_HTTP_ID,
      orgId: "org-1",
      slug: "http-flow",
      name: "HTTP Flow",
      dynastyName: "HTTP Flow",
      version: 1,
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
      .get(`/workflows/${WF_HTTP_ID}/required-providers`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual([
      { name: "anthropic", domain: "anthropic.com" },
      { name: "apollo", domain: "apollo.io" },
    ]);
  });

  it("returns empty providers for workflows with no http.call nodes", async () => {
    mockDbRows.push({
      id: WF_LEGACY_ID,
      orgId: "org-1",
      slug: "legacy-flow",
      name: "Legacy Flow",
      dynastyName: "Legacy Flow",
      version: 1,
      dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get(`/workflows/${WF_LEGACY_ID}/required-providers`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.endpoints).toEqual([]);
    expect(res.body.requirements).toEqual([]);
    expect(res.body.providers).toEqual([]);
    expect(mockFetchProviderRequirements).not.toHaveBeenCalled();
  });

  it("returns 404 for non-existent workflow", async () => {
    const res = await request
      .get("/workflows/ffffffff-ffff-4fff-bfff-ffffffffffff/required-providers")
      .set(AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Workflow not found");
  });

  it("returns 502 when key-service fails", async () => {
    mockDbRows.push({
      id: WF_HTTP_ID,
      orgId: "org-1",
      slug: "http-flow",
      name: "HTTP Flow",
      dynastyName: "HTTP Flow",
      version: 1,
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
      .get(`/workflows/${WF_HTTP_ID}/required-providers`)
      .set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("key-service error:");
  });

  it("returns 502 when KEY_SERVICE env vars are missing", async () => {
    mockDbRows.push({
      id: WF_HTTP_ID,
      orgId: "org-1",
      slug: "http-flow",
      name: "HTTP Flow",
      dynastyName: "HTTP Flow",
      version: 1,
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
      .get(`/workflows/${WF_HTTP_ID}/required-providers`)
      .set(AUTH);

    expect(res.status).toBe(502);
  });

  it("returns 502 when key-service is unreachable (network error)", async () => {
    mockDbRows.push({
      id: WF_HTTP_ID,
      orgId: "org-1",
      slug: "http-flow",
      name: "HTTP Flow",
      dynastyName: "HTTP Flow",
      version: 1,
      dag: DAG_WITH_HTTP_CALL,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const err = new TypeError("fetch failed");
    (err as unknown as { cause: { code: string } }).cause = {
      code: "UND_ERR_CONNECT_TIMEOUT",
    };
    mockFetchProviderRequirements.mockRejectedValue(err);

    const res = await request
      .get(`/workflows/${WF_HTTP_ID}/required-providers`)
      .set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("key-service unreachable (UND_ERR_CONNECT_TIMEOUT)");
  });

  it("requires authentication", async () => {
    const res = await request
      .get(`/workflows/${WF_ID}/required-providers`)
      .set(IDENTITY);
    expect(res.status).toBe(401);
  });
});

describe("PUT /workflows/:id — update (metadata, same-sig DAG, or fork)", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockSelectResponses.length = 0;
  });

  it("updates in-place when only metadata changes (no DAG)", async () => {
    mockDbRows.push({
      id: WF_META_ID,
      orgId: "org-1",
      slug: "sales-email-cold-outreach-maple",
      name: "Sales Email Cold Outreach Maple",
      dynastyName: "Sales Email Cold Outreach Maple",
      dynastySlug: "sales-email-cold-outreach-maple",
      featureSlug: "sales-email-cold-outreach",
      signatureName: "maple",
      signature: "abc123",
      version: 1,
      description: "Old desc",
      dag: VALID_LINEAR_DAG,
      tags: [],
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .put(`/workflows/${WF_META_ID}`)
      .set(AUTH)
      .send({
        description: "Updated description",
        tags: ["updated"],
      });

    expect(res.status).toBe(200);
    expect(res.body._action).toBe("updated");
    expect(res.body.description).toBe("Updated description");
    expect(res.body.tags).toEqual(["updated"]);
  });

  it("updates in-place when DAG has same signature", async () => {
    // Compute the real signature so it matches
    const { computeDAGSignature } = await import("../../src/lib/dag-signature.js");
    const realSig = computeDAGSignature(VALID_LINEAR_DAG);

    const existingWf = {
      id: WF_META_ID,
      orgId: "org-1",
      slug: "sales-email-cold-outreach-maple",
      name: "Sales Email Cold Outreach Maple",
      dynastyName: "Sales Email Cold Outreach Maple",
      dynastySlug: "sales-email-cold-outreach-maple",
      featureSlug: "sales-email-cold-outreach",
      signatureName: "maple",
      signature: realSig,
      version: 1,
      description: "Old desc",
      dag: VALID_LINEAR_DAG,
      tags: [],
      status: "active",
      windmillFlowPath: "f/workflows/org-1/sales_email_cold_outreach_maple",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Queue: 1) existing lookup
    mockSelectResponses.push([existingWf]);

    // Send the same DAG — signature will match
    const res = await request
      .put(`/workflows/${WF_META_ID}`)
      .set(AUTH)
      .send({ dag: VALID_LINEAR_DAG, description: "Same DAG, new desc" });

    expect(res.status).toBe(200);
    expect(res.body._action).toBe("updated");
    expect(res.body.description).toBe("Same DAG, new desc");
  });

  it("forks when DAG has a new signature", async () => {
    const existingWf = {
      id: WF_DAG_REJECT_ID,
      orgId: "org-1",
      slug: "sales-email-cold-outreach-pine",
      name: "Sales Email Cold Outreach Pine",
      dynastyName: "Sales Email Cold Outreach Pine",
      dynastySlug: "sales-email-cold-outreach-pine",
      featureSlug: "sales-email-cold-outreach",
      signatureName: "pine",
      signature: "old-sig-123",
      version: 1,
      description: "Original",
      dag: VALID_LINEAR_DAG,
      tags: [],
      status: "active",
      windmillWorkspace: "prod",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Queue responses: 1) existing lookup, 2) conflict check (empty), 3) used signatureNames, 4) dynasty workflows, 5) campaign runs
    mockSelectResponses.push([existingWf]); // existing workflow lookup
    mockSelectResponses.push([]); // no conflicting workflow with same signature
    mockSelectResponses.push([{ signatureName: "pine" }]); // existing signatureNames
    mockSelectResponses.push([{ id: WF_DAG_REJECT_ID }]); // dynasty workflows
    mockSelectResponses.push([]); // zero campaign runs → safe to deprecate

    const res = await request
      .put(`/workflows/${WF_DAG_REJECT_ID}`)
      .set(AUTH)
      .send({ dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND });

    expect(res.status).toBe(201);
    expect(res.body._action).toBe("forked");
    expect(res.body._forkedFromName).toBe("Sales Email Cold Outreach Pine");
    expect(res.body._forkedFromId).toBe(WF_DAG_REJECT_ID);
    expect(res.body._sourceDynastyDeprecated).toBe(true);
    expect(res.body.forkedFrom).toBe(WF_DAG_REJECT_ID);
    expect(res.body.version).toBe(1);
  });

  it("returns 409 with existingWorkflowId and existingWorkflowSlug when DAG signature conflicts", async () => {
    const conflictingId = "00000000-0000-4000-8000-000000000099";
    const existingWf = {
      id: WF_DAG_REJECT_ID,
      orgId: "org-1",
      slug: "sales-email-cold-outreach-pine",
      name: "Sales Email Cold Outreach Pine",
      dynastyName: "Sales Email Cold Outreach Pine",
      dynastySlug: "sales-email-cold-outreach-pine",
      featureSlug: "sales-email-cold-outreach",
      signatureName: "pine",
      signature: "old-sig-123",
      version: 1,
      description: "Original",
      dag: VALID_LINEAR_DAG,
      tags: [],
      status: "active",
      windmillWorkspace: "prod",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const conflictingWf = {
      id: conflictingId,
      slug: "sales-email-cold-outreach-maple",
    };

    // Queue responses: 1) existing lookup, 2) conflict check (found!)
    mockSelectResponses.push([existingWf]); // existing workflow lookup
    mockSelectResponses.push([conflictingWf]); // conflicting workflow with same new signature

    const res = await request
      .put(`/workflows/${WF_DAG_REJECT_ID}`)
      .set(AUTH)
      .send({ dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("A workflow with this DAG signature already exists");
    expect(res.body.existingWorkflowId).toBe(conflictingId);
    expect(res.body.existingWorkflowSlug).toBe("sales-email-cold-outreach-maple");
  });

  it("returns 404 for non-existent workflow", async () => {
    const res = await request
      .put("/workflows/ffffffff-ffff-4fff-bfff-ffffffffffff")
      .set(AUTH)
      .send({ description: "test" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Workflow not found");
  });
});

describe("POST /workflows/:id/validate", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
  });

  it("validates the DAG of an existing workflow", async () => {
    mockDbRows.push({
      id: WF_ID,
      orgId: "org-1",
      slug: "flow-1",
      name: "Flow 1",
      dynastyName: "Flow 1",
      version: 1,
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .post(`/workflows/${WF_ID}/validate`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });
});

describe("UUID validation on :id routes", () => {
  it("GET /workflows/:id returns 400 for non-UUID id", async () => {
    const res = await request.get("/workflows/new").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow ID format");
  });

  it("GET /workflows/:id/required-providers returns 400 for non-UUID id", async () => {
    const res = await request.get("/workflows/new/required-providers").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow ID format");
  });

  it("PUT /workflows/:id returns 400 for non-UUID id", async () => {
    const res = await request.put("/workflows/not-a-uuid").set(AUTH).send({ description: "test" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow ID format");
  });

  it("DELETE /workflows/:id returns 400 for non-UUID id", async () => {
    const res = await request.delete("/workflows/abc").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow ID format");
  });

  it("POST /workflows/:id/validate returns 400 for non-UUID id", async () => {
    const res = await request.post("/workflows/ranked/validate").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow ID format");
  });
});
