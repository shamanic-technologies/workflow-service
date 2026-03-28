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

// Mock key-service client
const mockFetchPlatformAnthropicKey = vi.fn();
vi.mock("../../src/lib/key-service-client.js", () => ({
  fetchPlatformAnthropicKey: (...args: unknown[]) => mockFetchPlatformAnthropicKey(...args),
}));

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
    dynastyName: "Sales Cold Outreach Sequoia",
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
    dynastyName: "Sales Cold Outreach Broken",
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
    mockFetchSpecsForServices.mockReset();
    mockUpgradeWorkflow.mockReset();
    mockFetchPlatformAnthropicKey.mockReset();
    mockCreatePlatformRun.mockReset();
    mockClosePlatformRun.mockReset();
    dbSelectResult = [];
    dbUpdates = [];
    dbInserts = [];
    dbSignatureMatchResult = [];
    delete process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
    delete process.env.ADMIN_NOTIFICATION_EMAIL;
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

  it("throws when broken workflow cannot be upgraded (no platform key)", async () => {
    dbSelectResult = [BROKEN_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );
    mockFetchPlatformAnthropicKey.mockRejectedValue(new Error("key not found"));

    // Should throw to crash the service at startup
    await expect(
      validateAndUpgradeWorkflows({
        db: createMockDb() as any,
        windmillClient: null,
      }),
    ).rejects.toThrow("workflow(s) have broken endpoints that could not be auto-upgraded");

    // Should NOT deprecate — no DB updates to set status deprecated
    const deprecations = dbUpdates.filter((u) => u.values.status === "deprecated");
    expect(deprecations.length).toBe(0);
  });

  it("upgrades broken workflow using platform key and tracks run", async () => {
    dbSelectResult = [BROKEN_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );
    mockFetchPlatformAnthropicKey.mockResolvedValue({ key: "test-platform-key", keySource: "platform" });
    mockCreatePlatformRun.mockResolvedValue({ runId: "platform-run-123" });
    mockClosePlatformRun.mockResolvedValue(undefined);

    const fixedDag = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
        },
      ],
      edges: [],
    };

    mockUpgradeWorkflow.mockResolvedValue({
      dag: fixedDag,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Fixed workflow",
    });

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: null,
    });

    // Should have resolved the key via platform endpoint
    expect(mockFetchPlatformAnthropicKey).toHaveBeenCalledTimes(1);

    // Should have created a platform run
    expect(mockCreatePlatformRun).toHaveBeenCalledWith({
      serviceName: "workflow",
      taskName: "startup-upgrade",
      workflowName: "sales-email-cold-outreach-Broken",  // uses wf.slug
    });

    // Should have called upgradeWorkflow with the platform key and no identity
    expect(mockUpgradeWorkflow).toHaveBeenCalledWith(
      BROKEN_WORKFLOW.dag,
      expect.any(Array), // invalidEndpoints
      expect.any(Array), // fieldErrors
      "test-platform-key",
      undefined,
      expect.objectContaining({ category: "sales" }),
    );

    // Should have inserted a new workflow with a NEW slug (versioned)
    expect(dbInserts.length).toBe(1);
    expect(dbInserts[0].status).toBe("active");
    expect(dbInserts[0].slug).toMatch(/^sales-email-cold-outreach-/);
    expect(dbInserts[0].slug).not.toBe(BROKEN_WORKFLOW.slug); // slug must change with new version
    // name is the human-readable display name (dynasty name + version suffix)
    expect(dbInserts[0].name).toMatch(/^Sales Cold Outreach Broken/);
    expect(dbInserts[0].dynastyName).toBe(BROKEN_WORKFLOW.dynastyName);
    expect(dbInserts[0].createdByUserId).toBe("workflow-service");
    expect(dbInserts[0].createdByRunId).toBe("platform-run-123");

    // Should have deprecated the old workflow first, then updated its upgradedTo pointer
    expect(dbUpdates.length).toBeGreaterThanOrEqual(2);
    expect(dbUpdates[0].values.status).toBe("deprecated");

    // Should have closed the platform run as completed
    expect(mockClosePlatformRun).toHaveBeenCalledWith("platform-run-123", "completed");
  });

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

  it("upgrades workflow with field errors even when all endpoints are valid", async () => {
    // Workflow has a valid endpoint path but is missing a required body field
    const FIELD_ISSUES_WORKFLOW = {
      ...VALID_WORKFLOW,
      id: "wf-field",
      slug: "sales-email-cold-outreach-FieldIssue",
      name: "Sales Cold Outreach FieldIssue",
      dynastyName: "Sales Cold Outreach FieldIssue",
      signatureName: "FieldIssue",
      dag: {
        nodes: [
          {
            id: "end-run",
            type: "http.call",
            config: { service: "campaign", method: "POST", path: "/end-run" },
            // Missing required "orgId" in body
            inputMapping: { "body.status": "$ref:flow_input.status" },
          },
        ],
        edges: [],
      },
    };

    // Spec declares orgId as required for /end-run
    const SPEC_WITH_REQUIRED = {
      paths: {
        "/end-run": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["orgId", "status"],
                    properties: {
                      orgId: { type: "string" },
                      status: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    dbSelectResult = [FIELD_ISSUES_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", SPEC_WITH_REQUIRED]]),
    );

    mockFetchPlatformAnthropicKey.mockResolvedValue({ key: "test-key", keySource: "platform" });
    mockCreatePlatformRun.mockResolvedValue({ runId: "field-run-1" });
    mockClosePlatformRun.mockResolvedValue(undefined);

    const fixedDag = {
      nodes: [
        {
          id: "end-run",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/end-run" },
          inputMapping: {
            "body.status": "$ref:flow_input.status",
            "body.orgId": "$ref:flow_input.orgId",
          },
        },
      ],
      edges: [],
    };

    mockUpgradeWorkflow.mockResolvedValue({
      dag: fixedDag,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Fixed workflow",
    });

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: null,
    });

    // Should attempt upgrade with field errors passed through
    expect(mockFetchPlatformAnthropicKey).toHaveBeenCalledTimes(1);
    expect(mockUpgradeWorkflow).toHaveBeenCalledTimes(1);

    // upgradeWorkflow should receive empty invalidEndpoints but non-empty fieldErrors
    const callArgs = mockUpgradeWorkflow.mock.calls[0];
    expect(callArgs[1]).toEqual([]); // invalidEndpoints
    expect(callArgs[2]).toEqual([   // fieldErrors
      expect.objectContaining({ nodeId: "end-run", field: "orgId", severity: "error" }),
    ]);

    // Should have inserted a new upgraded workflow
    expect(dbInserts.length).toBe(1);
    expect(dbInserts[0].status).toBe("active");
  });

  it("upgrades workflow with warning-only field issues (unknown body fields)", async () => {
    // Workflow sends "bodyHtml" but schema expects "htmlBody" — this is a warning, not an error
    const WARNING_ONLY_WORKFLOW = {
      ...VALID_WORKFLOW,
      id: "wf-warning",
      slug: "sales-email-cold-outreach-WarningOnly",
      name: "Sales Cold Outreach WarningOnly",
      dynastyName: "Sales Cold Outreach WarningOnly",
      signatureName: "WarningOnly",
      dag: {
        nodes: [
          {
            id: "end-run",
            type: "http.call",
            config: { service: "campaign", method: "POST", path: "/end-run" },
            inputMapping: {
              "body.campaignId": "$ref:flow_input.campaignId",
              "body.orgId": "$ref:flow_input.orgId",
              "body.bodyHtml": "$ref:email-generate.output.bodyHtml",
            },
          },
        ],
        edges: [],
      },
    };

    // Spec has campaignId and orgId as valid fields but NOT bodyHtml
    const SPEC_WITH_KNOWN_FIELDS = {
      paths: {
        "/end-run": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["campaignId", "orgId"],
                    properties: {
                      campaignId: { type: "string" },
                      orgId: { type: "string" },
                      success: { type: "boolean" },
                      leadFound: { type: "boolean" },
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

    mockFetchPlatformAnthropicKey.mockResolvedValue({ key: "test-key", keySource: "platform" });
    mockCreatePlatformRun.mockResolvedValue({ runId: "warning-run-1" });
    mockClosePlatformRun.mockResolvedValue(undefined);

    const fixedDag = {
      nodes: [
        {
          id: "end-run",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/end-run" },
          inputMapping: {
            "body.campaignId": "$ref:flow_input.campaignId",
            "body.orgId": "$ref:flow_input.orgId",
          },
        },
      ],
      edges: [],
    };

    mockUpgradeWorkflow.mockResolvedValue({
      dag: fixedDag,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Fixed workflow",
    });

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: null,
    });

    // Should attempt upgrade even though only warnings (no errors)
    expect(mockUpgradeWorkflow).toHaveBeenCalledTimes(1);

    // upgradeWorkflow should receive the warning-level field issues
    const callArgs = mockUpgradeWorkflow.mock.calls[0];
    expect(callArgs[1]).toEqual([]); // no invalid endpoints
    expect(callArgs[2]).toEqual([   // fieldIssues includes warnings
      expect.objectContaining({ nodeId: "end-run", field: "bodyHtml", severity: "warning" }),
    ]);

    // Should have inserted a new upgraded workflow
    expect(dbInserts.length).toBe(1);
  });

  it("throws when upgrade fails (LLM error) and closes platform run as failed", async () => {
    dbSelectResult = [BROKEN_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );
    mockFetchPlatformAnthropicKey.mockResolvedValue({ key: "test-key", keySource: "platform" });
    mockCreatePlatformRun.mockResolvedValue({ runId: "platform-run-456" });
    mockClosePlatformRun.mockResolvedValue(undefined);
    mockUpgradeWorkflow.mockRejectedValue(new Error("LLM error"));

    // Should throw to crash the service at startup
    await expect(
      validateAndUpgradeWorkflows({
        db: createMockDb() as any,
        windmillClient: null,
      }),
    ).rejects.toThrow("workflow(s) have broken endpoints that could not be auto-upgraded");

    // Should have closed the platform run as failed
    expect(mockClosePlatformRun).toHaveBeenCalledWith("platform-run-456", "failed");

    // Should NOT deprecate the workflow
    const deprecations = dbUpdates.filter((u) => u.values.status === "deprecated");
    expect(deprecations.length).toBe(0);
  });

  it("updates existing flow via updateFlow (no createFlow needed)", async () => {
    dbSelectResult = [BROKEN_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );
    mockFetchPlatformAnthropicKey.mockResolvedValue({ key: "test-key", keySource: "platform" });
    mockCreatePlatformRun.mockResolvedValue({ runId: "run-1" });
    mockClosePlatformRun.mockResolvedValue(undefined);

    const fixedDag = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
        },
      ],
      edges: [],
    };

    mockUpgradeWorkflow.mockResolvedValue({
      dag: fixedDag,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Fixed workflow",
    });

    const mockCreateFlow = vi.fn();
    const mockUpdateFlow = vi.fn().mockResolvedValue(undefined);

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: {
        createFlow: mockCreateFlow,
        updateFlow: mockUpdateFlow,
      } as any,
    });

    // Should have called updateFlow during upgrade + once during sync
    expect(mockUpdateFlow).toHaveBeenCalledTimes(2);
    expect(mockCreateFlow).not.toHaveBeenCalled();

    // The new workflow should still be inserted in the DB
    expect(dbInserts.length).toBe(1);
    expect(dbInserts[0].status).toBe("active");
  });

  it("falls back to createFlow when updateFlow returns 'not found'", async () => {
    dbSelectResult = [BROKEN_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );
    mockFetchPlatformAnthropicKey.mockResolvedValue({ key: "test-key", keySource: "platform" });
    mockCreatePlatformRun.mockResolvedValue({ runId: "run-2" });
    mockClosePlatformRun.mockResolvedValue(undefined);

    const fixedDag = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
        },
      ],
      edges: [],
    };

    mockUpgradeWorkflow.mockResolvedValue({
      dag: fixedDag,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Fixed workflow",
    });

    const mockUpdateFlow = vi.fn().mockRejectedValue(new Error("Flow not found"));
    const mockCreateFlow = vi.fn().mockResolvedValue(undefined);

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: {
        createFlow: mockCreateFlow,
        updateFlow: mockUpdateFlow,
      } as any,
    });

    // Upgrade: updateFlow fails → createFlow fallback (1 each)
    // Sync: updateFlow on the newly-created workflow (may fail, caught by sync loop)
    expect(mockUpdateFlow).toHaveBeenCalledTimes(2);
    // createFlow only called once — during upgrade. Sync uses updateFlow with stored path, no fallback.
    expect(mockCreateFlow).toHaveBeenCalledTimes(1);

    expect(dbInserts.length).toBe(1);
    expect(dbInserts[0].status).toBe("active");
  });

  it("logs error for non-'not found' updateFlow failures without crashing", async () => {
    dbSelectResult = [BROKEN_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );
    mockFetchPlatformAnthropicKey.mockResolvedValue({ key: "test-key", keySource: "platform" });
    mockCreatePlatformRun.mockResolvedValue({ runId: "run-3" });
    mockClosePlatformRun.mockResolvedValue(undefined);

    const fixedDag = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
        },
      ],
      edges: [],
    };

    mockUpgradeWorkflow.mockResolvedValue({
      dag: fixedDag,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Fixed workflow",
    });

    const mockUpdateFlow = vi.fn().mockRejectedValue(new Error("Windmill API error: 500 Internal Server Error"));
    const mockCreateFlow = vi.fn();

    const consoleSpy = vi.spyOn(console, "error");

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: {
        createFlow: mockCreateFlow,
        updateFlow: mockUpdateFlow,
      } as any,
    });

    // Should NOT have called createFlow (error is not "not found")
    expect(mockCreateFlow).not.toHaveBeenCalled();

    // Should have logged the error
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to update flow"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it("deduplicates when upgraded signature matches an existing active workflow", async () => {
    // Regression: two broken workflows upgrade to the same DAG signature.
    // The second should deprecate + point to the first, not fail on unique constraint.
    const BROKEN_A = {
      ...BROKEN_WORKFLOW,
      id: "wf-dup-a",
      slug: "sales-email-cold-outreach-DupA",
      name: "Sales Cold Outreach DupA",
      dynastyName: "Sales Cold Outreach DupA",
      signatureName: "DupA",
      signature: "old-sig-a",
    };
    const BROKEN_B = {
      ...BROKEN_WORKFLOW,
      id: "wf-dup-b",
      slug: "sales-email-cold-outreach-DupB",
      name: "Sales Cold Outreach DupB",
      dynastyName: "Sales Cold Outreach DupB",
      signatureName: "DupB",
      signature: "old-sig-b",
    };

    dbSelectResult = [BROKEN_A, BROKEN_B];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );
    mockFetchPlatformAnthropicKey.mockResolvedValue({ key: "test-key", keySource: "platform" });
    mockCreatePlatformRun.mockResolvedValue({ runId: "dedup-run-1" });
    mockClosePlatformRun.mockResolvedValue(undefined);

    const fixedDag = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
        },
      ],
      edges: [],
    };

    mockUpgradeWorkflow.mockResolvedValue({
      dag: fixedDag,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Fixed workflow",
    });

    // Use a custom mock DB where the insert side-effects set the signature
    // match result, simulating what the real DB would do: after the first
    // workflow is inserted, the second's signature-match query finds it.
    const deduplicatingMockDb = createMockDb();
    const originalInsert = deduplicatingMockDb.insert;
    (deduplicatingMockDb as any).insert = () => {
      const chain = originalInsert();
      const originalValues = chain.values;
      chain.values = (row: Record<string, unknown>) => {
        // After inserting, future signature-match queries will find this workflow
        dbSignatureMatchResult = [{ id: "wf-first-upgraded" }];
        return originalValues(row);
      };
      return chain;
    };

    const consoleSpy = vi.spyOn(console, "log");

    await validateAndUpgradeWorkflows({
      db: deduplicatingMockDb as any,
      windmillClient: null,
    });

    // Both workflows go through upgradeWorkflow (need the result DAG to compute signature)
    // but only the first one inserts — the second deduplicates
    expect(mockUpgradeWorkflow).toHaveBeenCalledTimes(2);
    expect(dbInserts.length).toBe(1); // Only 1 insert, not 2

    // Both should count as upgraded (not failed)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("2 upgraded"),
    );

    // Second workflow should log the dedup path
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("upgraded by dedup"),
    );

    consoleSpy.mockRestore();
  });

  it("upgrades workflows with recent runs before dormant ones", async () => {
    const DORMANT_BROKEN = {
      ...BROKEN_WORKFLOW,
      id: "wf-dormant",
      slug: "sales-email-cold-outreach-Dormant",
      name: "Sales Cold Outreach Dormant",
      dynastyName: "Sales Cold Outreach Dormant",
      signatureName: "Dormant",
    };
    const ACTIVE_BROKEN = {
      ...BROKEN_WORKFLOW,
      id: "wf-active",
      slug: "sales-email-cold-outreach-Active",
      name: "Sales Cold Outreach Active",
      dynastyName: "Sales Cold Outreach Active",
      signatureName: "Active",
    };

    // Return dormant first in DB order — upgrade should reorder
    dbSelectResult = [DORMANT_BROKEN, ACTIVE_BROKEN];

    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );
    mockFetchPlatformAnthropicKey.mockResolvedValue({ key: "sk-test" });
    mockCreatePlatformRun.mockResolvedValue({ runId: "run-1" });
    mockClosePlatformRun.mockResolvedValue(undefined);

    mockUpgradeWorkflow.mockResolvedValue({
      dag: VALID_WORKFLOW.dag,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Fixed",
    });

    const warnSpy = vi.spyOn(console, "warn");

    // Mock DB that returns run data showing wf-active was used recently
    function createMockDbWithRuns() {
      let callCount = 0;
      return {
        select: (selectArg?: any) => ({
          from: (table: unknown) => {
            callCount++;

            // workflowRuns query → return last run for wf-active only
            if (table === workflowRuns) {
              const result = Promise.resolve([]);
              (result as any).where = () => {
                const grouped = Promise.resolve([]);
                (grouped as any).groupBy = () =>
                  Promise.resolve([
                    { workflowId: "wf-active", lastRun: "2026-03-17T08:00:00Z" },
                  ]);
                return grouped;
              };
              return result;
            }

            // Signature-match dedup query
            if (selectArg && 'id' in selectArg && !('signatureName' in selectArg)) {
              const promise = Promise.resolve(dbSignatureMatchResult);
              (promise as any).where = () => Promise.resolve(dbSignatureMatchResult);
              return promise;
            }

            const signatureData = () =>
              Promise.resolve(
                dbSelectResult.map((r) => ({ signatureName: (r as Record<string, unknown>).signatureName })),
              );
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

    try {
      await validateAndUpgradeWorkflows({
        db: createMockDbWithRuns() as any,
        windmillClient: null,
      });
    } catch {
      // May throw due to failedCount — that's OK for this test
    }

    // wf-active (recent run) should be upgraded before wf-dormant (no runs)
    // Check order via console.warn calls which log the workflow name
    const brokenEndpointWarns = warnSpy.mock.calls
      .filter((call) => typeof call[0] === "string" && call[0].includes("broken endpoint"))
      .map((call) => call[0] as string);

    expect(brokenEndpointWarns).toHaveLength(2);
    expect(brokenEndpointWarns[0]).toContain("Active");
    expect(brokenEndpointWarns[1]).toContain("Dormant");

    warnSpy.mockRestore();
  });
});
