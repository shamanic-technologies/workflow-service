import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock API registry client
const mockFetchServiceList = vi.fn();
const mockFetchSpecsForServices = vi.fn();

vi.mock("../../src/lib/api-registry-client.js", () => ({
  fetchServiceList: (...args: unknown[]) => mockFetchServiceList(...args),
  fetchSpecsForServices: (...args: unknown[]) => mockFetchSpecsForServices(...args),
  fetchLlmContext: vi.fn().mockResolvedValue({ services: [] }),
  fetchServiceEndpoints: vi.fn().mockResolvedValue({ service: "", endpoints: [] }),
  fetchServiceSpec: vi.fn().mockResolvedValue({}),
}));

// Mock upgrader
const mockUpgradeWorkflow = vi.fn();
vi.mock("../../src/lib/workflow-upgrader.js", () => ({
  upgradeWorkflow: (...args: unknown[]) => mockUpgradeWorkflow(...args),
}));

// Mock key-service client (no longer needed for Anthropic key, but module must exist)
vi.mock("../../src/lib/key-service-client.js", () => ({}));

// Mock runs-client
const mockCreatePlatformRun = vi.fn();
const mockClosePlatformRun = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  createPlatformRun: (...args: unknown[]) => mockCreatePlatformRun(...args),
  closePlatformRun: (...args: unknown[]) => mockClosePlatformRun(...args),
}));

// Mock dag-to-openflow
vi.mock("../../src/lib/dag-to-openflow.js", () => ({
  dagToOpenFlow: vi.fn().mockReturnValue({
    value: { modules: [], same_worker: false },
    schema: {},
  }),
}));

// Mock dag-signature
vi.mock("../../src/lib/dag-signature.js", () => ({
  computeDAGSignature: vi.fn().mockReturnValue("new-signature-hash"),
}));

// Mock signature-words
vi.mock("../../src/lib/signature-words.js", () => ({
  pickSignatureName: vi.fn().mockReturnValue("Redwood"),
}));

// Mock DB
vi.mock("../../src/db/index.js", () => ({
  db: "mock-db",
  sql: { end: () => Promise.resolve() },
}));

import {
  checkApiRegistryHealth,
  validateAndUpgradeWorkflows,
} from "../../src/lib/startup-validator.js";
import { workflowRuns } from "../../src/db/schema.js";

describe("checkApiRegistryHealth", () => {
  beforeEach(() => {
    mockFetchServiceList.mockReset();
  });

  it("succeeds when API Registry is reachable", async () => {
    mockFetchServiceList.mockResolvedValue([{ service: "campaign" }]);
    await expect(checkApiRegistryHealth()).resolves.toBeUndefined();
    expect(mockFetchServiceList).toHaveBeenCalledTimes(1);
    // Should be called without identity
    expect(mockFetchServiceList).toHaveBeenCalledWith();
  });

  it("throws when API Registry is unreachable", async () => {
    mockFetchServiceList.mockRejectedValue(new Error("Connection refused"));
    await expect(checkApiRegistryHealth()).rejects.toThrow("Connection refused");
  });
});

describe("validateAndUpgradeWorkflows", () => {
  const VALID_WORKFLOW = {
    id: "wf-1",
    orgId: "org-1",
    slug: "sales-email-cold-outreach-Sequoia",
    name: "Sales Cold Outreach Sequoia",
    version: 1,
    featureSlug: "sales-email-cold-outreach",
    category: "sales",
    channel: "email",
    audienceType: "cold-outreach",
    description: "Test",
    status: "active",
    signature: "sig-1",
    signatureName: "Sequoia",
    windmillWorkspace: "prod",
    windmillFlowPath: "f/workflows/org-1/flow",
    dag: {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
        },
      ],
      edges: [],
    },
    tags: [],
    createdForBrandId: null,
    humanId: null,
    campaignId: null,
    subrequestId: null,
    styleName: null,
    upgradedTo: null,
    createdByUserId: null,
    createdByRunId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const BROKEN_WORKFLOW = {
    ...VALID_WORKFLOW,
    id: "wf-2",
    slug: "sales-email-cold-outreach-Broken",
    name: "Sales Cold Outreach Broken",
    signatureName: "Broken",
    dag: {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/internal/gate-check" },
        },
      ],
      edges: [],
    },
  };

  const CAMPAIGN_SPEC = {
    paths: {
      "/gate-check": { post: {} },
      "/start-run": { post: {} },
      "/end-run": { post: {} },
    },
  };

  // Build a mock database that tracks operations
  let dbSelectResult: Record<string, unknown>[] = [];
  let dbUpdates: Array<{ values: Record<string, unknown>; id: string }> = [];
  let dbInserts: Record<string, unknown>[] = [];
  // Controls what the signature-match dedup query returns (default: no match)
  let dbSignatureMatchResult: Record<string, unknown>[] = [];

  let selectCallCount = 0;

  function createMockDb() {
    selectCallCount = 0;
    return {
      select: (selectArg?: any) => ({
        from: (table: unknown) => {
          selectCallCount++;

          // workflowRuns query (last run dates) → return empty array with groupBy chain
          if (table === workflowRuns) {
            const emptyResult = Promise.resolve([]);
            (emptyResult as any).where = () => {
              const grouped = Promise.resolve([]);
              (grouped as any).groupBy = () => Promise.resolve([]);
              return grouped;
            };
            (emptyResult as any).groupBy = () => Promise.resolve([]);
            return emptyResult;
          }

          // Signature-match dedup query: select({ id: ... }).from(workflows).where(...)
          // Distinguished by select arg having 'id' key but not 'signatureName'
          if (selectArg && 'id' in selectArg && !('signatureName' in selectArg)) {
            const promise = Promise.resolve(dbSignatureMatchResult);
            (promise as any).where = () => Promise.resolve(dbSignatureMatchResult);
            return promise;
          }

          // Non-where calls after the first return signatureName-only (for collision detection)
          const signatureData = () =>
            Promise.resolve(
              dbSelectResult.map((r) => ({ signatureName: (r as Record<string, unknown>).signatureName })),
            );

          // .where() calls always return full workflow objects (active workflows query + sync query)
          const fullData = () => Promise.resolve(dbSelectResult);

          const promise = signatureData();
          (promise as any).where = () => fullData();
          return promise;
        },
      }),
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          const newRow = {
            id: "wf-new-" + Math.random().toString(36).slice(2, 8),
            ...row,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          dbInserts.push(newRow);
          return { returning: () => Promise.resolve([newRow]) };
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            dbUpdates.push({ values, id: "unknown" });
            return { returning: () => Promise.resolve([]) };
          },
        }),
      }),
    };
  }

  beforeEach(() => {
    mockFetchServiceList.mockReset();
    mockFetchSpecsForServices.mockReset();
    mockUpgradeWorkflow.mockReset();

    mockCreatePlatformRun.mockReset();
    mockClosePlatformRun.mockReset();
    dbSelectResult = [];
    dbUpdates = [];
    dbInserts = [];
    dbSignatureMatchResult = [];
    delete process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
    delete process.env.ADMIN_NOTIFICATION_EMAIL;

    // By default, API Registry is reachable
    mockFetchServiceList.mockResolvedValue([{ service: "campaign" }]);
  });

  it("skips entire upgrade cycle when API Registry is unreachable", async () => {
    mockFetchServiceList.mockRejectedValue(new Error("Connection refused"));
    dbSelectResult = [BROKEN_WORKFLOW];

    const consoleErrorSpy = vi.spyOn(console, "error");

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: null,
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("API Registry unreachable — skipping upgrade cycle"),
      expect.any(String),
    );
    // Must NOT call fetchSpecsForServices or upgradeWorkflow
    expect(mockFetchSpecsForServices).not.toHaveBeenCalled();
    expect(mockUpgradeWorkflow).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("logs success when all workflows are valid", async () => {
    dbSelectResult = [VALID_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );

    const consoleSpy = vi.spyOn(console, "log");

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: null,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 valid"),
    );
    consoleSpy.mockRestore();
  });

  it("syncs all active workflows to Windmill on startup", async () => {
    dbSelectResult = [VALID_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );

    const mockUpdateFlow = vi.fn().mockResolvedValue(undefined);
    const mockCreateFlow = vi.fn();

    const consoleSpy = vi.spyOn(console, "log");

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: {
        updateFlow: mockUpdateFlow,
        createFlow: mockCreateFlow,
      } as any,
    });

    // Should have synced using the stored windmillFlowPath (not a recalculated one)
    expect(mockUpdateFlow).toHaveBeenCalledTimes(1);
    expect(mockUpdateFlow).toHaveBeenCalledWith(
      "f/workflows/org-1/flow", // exact path from DB, not recalculated
      expect.objectContaining({
        summary: VALID_WORKFLOW.slug,
        value: expect.any(Object),
        schema: expect.any(Object),
      }),
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Synced 1/1 flows to Windmill"),
    );
    consoleSpy.mockRestore();
  });

  it("does not call LLM upgrade when workflow has broken endpoints (upgrade disabled)", async () => {
    dbSelectResult = [BROKEN_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );

    const warnSpy = vi.spyOn(console, "warn");

    // Should NOT throw — broken workflows are kept active without LLM upgrade
    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: null,
    });

    // upgradeWorkflow (LLM) should never be called
    expect(mockUpgradeWorkflow).not.toHaveBeenCalled();

    // Should log that LLM upgrade is disabled
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("LLM upgrade disabled"),
    );

    warnSpy.mockRestore();
  });

  // --- LLM upgrade tests removed: auto-upgrade is disabled to stop Gemini billing ---
  // When re-enabling LLM upgrades, restore these tests from git history.

  it("handles empty workflow list gracefully", async () => {
    dbSelectResult = [];

    const consoleSpy = vi.spyOn(console, "log");

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: null,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[workflow-service] No active workflows to validate",
    );
    consoleSpy.mockRestore();
  });

  it("does not attempt upgrade for warning-only field issues", async () => {
    const WARNING_ONLY_WORKFLOW = {
      ...VALID_WORKFLOW,
      id: "wf-warning",
      slug: "sales-email-cold-outreach-WarningOnly",
      name: "Sales Cold Outreach WarningOnly",
      signatureName: "WarningOnly",
      dag: {
        nodes: [
          {
            id: "end-run",
            type: "http.call",
            config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: false } },
            inputMapping: {
              "body.bodyHtml": "$ref:email-generate.output.bodyHtml",
            },
          },
        ],
        edges: [],
      },
    };

    const SPEC_WITH_KNOWN_FIELDS = {
      paths: {
        "/end-run": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["success", "stopCampaign"],
                    properties: {
                      success: { type: "boolean" },
                      stopCampaign: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    dbSelectResult = [WARNING_ONLY_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", SPEC_WITH_KNOWN_FIELDS]]),
    );

    const warnSpy = vi.spyOn(console, "warn");
    const logSpy = vi.spyOn(console, "log");

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: null,
    });

    expect(mockUpgradeWorkflow).not.toHaveBeenCalled();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('has 1 field issue(s)'),
      expect.stringContaining('bodyHtml'),
    );

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 valid"),
    );

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("does not crash startup when warnings exist and chat-service is down", async () => {
    const WARNING_WORKFLOW = {
      ...VALID_WORKFLOW,
      id: "wf-warning-crash",
      slug: "press-kit-page-generation-cascade",
      name: "Press Kit Page Generation Cascade",
      signatureName: "Cascade",
      dag: {
        nodes: [
          {
            id: "end-run",
            type: "http.call",
            config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: false } },
            inputMapping: {
              "body.extraField": "$ref:flow_input.extraField",
            },
          },
        ],
        edges: [],
      },
    };

    const CAMPAIGN_SPEC_STRICT = {
      paths: {
        "/end-run": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["success", "stopCampaign"],
                    properties: {
                      success: { type: "boolean" },
                      stopCampaign: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    dbSelectResult = [WARNING_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC_STRICT]]),
    );

    mockUpgradeWorkflow.mockRejectedValue(
      new Error("chat-service error: POST /complete -> 502 Bad Gateway: Billing service unavailable"),
    );

    await expect(
      validateAndUpgradeWorkflows({
        db: createMockDb() as any,
        windmillClient: null,
      }),
    ).resolves.toBeUndefined();

    expect(mockUpgradeWorkflow).not.toHaveBeenCalled();
  });
});

