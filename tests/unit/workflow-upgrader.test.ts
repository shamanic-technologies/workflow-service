import { describe, it, expect, vi, afterEach } from "vitest";
import type { DAG } from "../../src/lib/dag-validator.js";
import type {
  ChatServiceCompleteRequest,
  ChatServiceCompleteResponse,
  ChatServiceIdentity,
} from "../../src/lib/chat-service-client.js";

// Mock the API registry client
vi.mock("../../src/lib/api-registry-client.js", () => ({
  fetchLlmContext: vi.fn().mockResolvedValue({
    services: [
      {
        service: "campaign",
        description: "Campaign service",
        endpointCount: 3,
      },
    ],
  }),
  fetchSpecsForServices: vi.fn().mockResolvedValue(new Map([
    ["campaign", {
      paths: {
        "/gate-check": { post: {} },
        "/start-run": { post: {} },
        "/end-run": { post: {} },
      },
    }],
  ])),
}));

import {
  upgradeWorkflow,
  setUpgradeChatServiceClient,
  UpgradeValidationError,
} from "../../src/lib/workflow-upgrader.js";

describe("upgradeWorkflow", () => {
  const BROKEN_DAG: DAG = {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/internal/gate-check", stopAfterIf: "result.allowed == false" },
        inputMapping: { "body.campaignId": "$ref:flow_input.campaignId" },
      },
      {
        id: "end-run",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true } },
        inputMapping: { "body.campaignId": "$ref:flow_input.campaignId" },
      },
    ],
    edges: [{ from: "gate-check", to: "end-run" }],
  };

  const FIXED_DAG: DAG = {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" },
        inputMapping: { "body.campaignId": "$ref:flow_input.campaignId" },
      },
      {
        id: "end-run",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true } },
        inputMapping: { "body.campaignId": "$ref:flow_input.campaignId" },
      },
    ],
    edges: [{ from: "gate-check", to: "end-run" }],
  };

  const IDENTITY = undefined; // Platform-level upgrades don't pass identity
  const METADATA = {
    category: "sales",
    channel: "email",
    audienceType: "cold-outreach",
    description: "Test workflow",
  };

  afterEach(() => {
    setUpgradeChatServiceClient(null);
  });

  function createMockResponse(dag: DAG, overrides?: Partial<{ category: string; channel: string; audienceType: string; description: string }>): ChatServiceCompleteResponse {
    const result = {
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Test workflow (fixed)",
      dag,
      ...overrides,
    };
    return {
      content: JSON.stringify(result),
      json: result as unknown as Record<string, unknown>,
      tokensInput: 100,
      tokensOutput: 200,
      model: "claude-sonnet-4-6",
    };
  }

  it("calls chat-service /complete and returns corrected DAG", async () => {
    const mockComplete = vi.fn().mockResolvedValue(createMockResponse(FIXED_DAG));
    setUpgradeChatServiceClient(mockComplete);

    const result = await upgradeWorkflow(
      BROKEN_DAG,
      [{ service: "campaign", method: "POST", path: "/internal/gate-check", reason: "not found" }],
      [],
      IDENTITY,
      METADATA,
    );

    expect(result.dag.nodes[0].config?.path).toBe("/gate-check");
    expect(result.category).toBe("sales");
    expect(mockComplete).toHaveBeenCalledTimes(1);

    // Verify the system prompt mentions the broken endpoint
    const call = mockComplete.mock.calls[0][0] as ChatServiceCompleteRequest;
    expect(call.systemPrompt).toContain("/internal/gate-check");
    expect(call.systemPrompt).toContain("FIX a broken workflow");
  });

  it("uses claude-sonnet-4-6 and responseFormat json", async () => {
    const mockComplete = vi.fn().mockResolvedValue(createMockResponse(FIXED_DAG));
    setUpgradeChatServiceClient(mockComplete);

    await upgradeWorkflow(
      BROKEN_DAG,
      [{ service: "campaign", method: "POST", path: "/internal/gate-check", reason: "not found" }],
      [],
      IDENTITY,
      METADATA,
    );

    const call = mockComplete.mock.calls[0][0] as ChatServiceCompleteRequest;
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(call.responseFormat).toBe("json");
  });

  it("pre-fetches service context and embeds in system prompt", async () => {
    const mockComplete = vi.fn().mockResolvedValue(createMockResponse(FIXED_DAG));
    setUpgradeChatServiceClient(mockComplete);

    await upgradeWorkflow(
      BROKEN_DAG,
      [{ service: "campaign", method: "POST", path: "/internal/gate-check", reason: "not found" }],
      [],
      IDENTITY,
      METADATA,
    );

    const call = mockComplete.mock.calls[0][0] as ChatServiceCompleteRequest;
    expect(call.systemPrompt).toContain("Service OpenAPI Specs");
    expect(call.systemPrompt).toContain("gate-check");
    // No agentic loop — single call
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it("throws when LLM produces invalid DAG after retries", async () => {
    const invalidDag: DAG = {
      nodes: [
        { id: "a", type: "nonexistent-type" },
      ],
      edges: [{ from: "a", to: "b" }], // 'b' doesn't exist
    };

    const mockComplete = vi.fn().mockResolvedValue(createMockResponse(invalidDag));
    setUpgradeChatServiceClient(mockComplete);

    await expect(
      upgradeWorkflow(
        BROKEN_DAG,
        [{ service: "campaign", method: "POST", path: "/internal/gate-check", reason: "not found" }],
        [],
        IDENTITY,
        METADATA,
      ),
    ).rejects.toThrow(UpgradeValidationError);
  });

  it("uses platform identity when no identity is provided", async () => {
    const mockComplete = vi.fn().mockResolvedValue(createMockResponse(FIXED_DAG));
    setUpgradeChatServiceClient(mockComplete);

    await upgradeWorkflow(
      BROKEN_DAG,
      [{ service: "campaign", method: "POST", path: "/internal/gate-check", reason: "not found" }],
      [],
      undefined,
      METADATA,
    );

    const identity = mockComplete.mock.calls[0][1] as ChatServiceIdentity;
    expect(identity.orgId).toBe("platform");
    expect(identity.userId).toBe("workflow-service");
  });
});
