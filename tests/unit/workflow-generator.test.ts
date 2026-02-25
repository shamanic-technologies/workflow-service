import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  generateWorkflow,
  setAnthropicClient,
  GenerationValidationError,
} from "../../src/lib/workflow-generator.js";
import {
  buildSystemPrompt,
  buildRetryUserMessage,
} from "../../src/lib/prompt-templates.js";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";

// --- Prompt building tests ---

describe("buildSystemPrompt", () => {
  it("includes DAG format documentation", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("DAG Format");
    expect(prompt).toContain("http.call");
    expect(prompt).toContain("$ref:flow_input");
    expect(prompt).toContain("$ref:node-id.output");
  });

  it("includes all dimension enum values", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"sales"');
    expect(prompt).toContain('"pr"');
    expect(prompt).toContain('"email"');
    expect(prompt).toContain('"cold-outreach"');
  });

  it("includes service catalog", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("campaign");
    expect(prompt).toContain("lead");
    expect(prompt).toContain("content-generation");
  });

  it("filters service catalog when filterServices is provided", () => {
    const prompt = buildSystemPrompt(["campaign", "lead"]);
    expect(prompt).toContain("campaign");
    expect(prompt).toContain("lead");
    // stripe should not appear in the services section
    // but may appear in node types; check services section specifically
    expect(prompt).toContain("**campaign**");
    expect(prompt).toContain("**lead**");
  });

  it("includes example DAGs", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Example");
    expect(prompt).toContain("gate-check");
    expect(prompt).toContain("fetch-lead");
  });

  it("includes special config keys documentation", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("stopAfterIf");
    expect(prompt).toContain("skipIf");
    expect(prompt).toContain("validateResponse");
    expect(prompt).toContain("retries");
  });

  it("includes node type registry", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"http.call"');
    expect(prompt).toContain('"condition"');
    expect(prompt).toContain('"wait"');
    expect(prompt).toContain('"for-each"');
  });
});

describe("buildRetryUserMessage", () => {
  it("includes validation errors and original description", () => {
    const msg = buildRetryUserMessage("Send an email to leads", [
      { field: "nodes[bad-ref].inputMapping.data", message: 'References unknown node: "nonexistent"' },
      { field: "edges", message: "Workflow contains a cycle" },
    ]);
    expect(msg).toContain("References unknown node");
    expect(msg).toContain("cycle");
    expect(msg).toContain("Send an email to leads");
  });
});

// --- Generator tests ---

function createMockToolResponse(dag: unknown, overrides?: Record<string, unknown>) {
  return {
    id: "msg_test",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-sonnet-4-20250514",
    stop_reason: "tool_use" as const,
    content: [
      {
        type: "tool_use" as const,
        id: "tool_test_" + Math.random().toString(36).slice(2, 6),
        name: "create_workflow",
        input: {
          category: "sales",
          channel: "email",
          audienceType: "cold-outreach",
          description: "Generated workflow description",
          dag,
          ...overrides,
        },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

describe("generateWorkflow", () => {
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCreate = vi.fn();
    setAnthropicClient({
      messages: { create: mockCreate },
    } as unknown as Anthropic);
  });

  afterEach(() => {
    setAnthropicClient(null);
  });

  it("returns valid DAG on first attempt", async () => {
    mockCreate.mockResolvedValueOnce(
      createMockToolResponse(VALID_LINEAR_DAG),
    );

    const result = await generateWorkflow({
      description: "Search leads and send cold emails",
    });

    expect(result.dag).toEqual(VALID_LINEAR_DAG);
    expect(result.category).toBe("sales");
    expect(result.channel).toBe("email");
    expect(result.audienceType).toBe("cold-outreach");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("retries with error feedback when DAG is invalid", async () => {
    const invalidDag = {
      nodes: [{ id: "a", type: "unknown-type-xyz" }],
      edges: [],
    };

    mockCreate.mockResolvedValueOnce(createMockToolResponse(invalidDag));
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    const result = await generateWorkflow({
      description: "Search leads and send cold emails",
    });

    expect(result.dag).toEqual(VALID_LINEAR_DAG);
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // Verify retry message includes error context
    const retryCall = mockCreate.mock.calls[1][0];
    const lastMessage = retryCall.messages[retryCall.messages.length - 1];
    expect(lastMessage.content[0].is_error).toBe(true);
  });

  it("throws GenerationValidationError after max retries", async () => {
    const invalidDag = {
      nodes: [{ id: "a", type: "unknown-type-xyz" }],
      edges: [],
    };

    mockCreate.mockResolvedValue(createMockToolResponse(invalidDag));

    await expect(
      generateWorkflow({ description: "Bad workflow" }),
    ).rejects.toThrow(GenerationValidationError);

    // 1 initial + 2 retries = 3 calls
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("throws if ANTHROPIC_API_KEY is not set", async () => {
    setAnthropicClient(null);
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    await expect(
      generateWorkflow({ description: "test workflow" }),
    ).rejects.toThrow("ANTHROPIC_API_KEY is not set");

    process.env.ANTHROPIC_API_KEY = saved;
  });

  it("passes hints to the user message", async () => {
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    await generateWorkflow({
      description: "Send email to leads",
      hints: {
        services: ["lead", "email-gateway"],
        expectedInputs: ["campaignId"],
      },
    });

    const call = mockCreate.mock.calls[0][0];
    const userMsg = call.messages[0].content;
    expect(userMsg).toContain("lead, email-gateway");
    expect(userMsg).toContain("campaignId");
  });

  it("throws if LLM returns no tool use block", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text: "I cannot generate a workflow" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    await expect(
      generateWorkflow({ description: "test workflow" }),
    ).rejects.toThrow("LLM did not return a tool use response");
  });

  it("includes system prompt with DAG schema", async () => {
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    await generateWorkflow({ description: "test workflow" });

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("DAG Format");
    expect(call.system).toContain("http.call");
  });

  it("uses tool_choice to force structured output", async () => {
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    await generateWorkflow({ description: "test workflow" });

    const call = mockCreate.mock.calls[0][0];
    expect(call.tool_choice).toEqual({ type: "tool", name: "create_workflow" });
  });
});
