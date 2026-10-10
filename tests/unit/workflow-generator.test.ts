import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateWorkflow,
  setChatServiceClient,
  GenerationValidationError,
  GENERATION_LLM,
} from "../../src/lib/workflow-generator.js";
import {
  buildSystemPrompt,
  buildRetryUserMessage,
  buildServicePickPrompt,
  buildEndpointPickPrompt,
  type PipeContext,
} from "../../src/lib/prompt-templates.js";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";
import type {
  ChatServiceCompleteRequest,
  ChatServiceCompleteResponse,
} from "../../src/lib/chat-service-client.js";
import type { DownstreamHeaders } from "../../src/lib/downstream-headers.js";
import type { CataloguePipe } from "../../src/lib/catalogue-client.js";

const mockDiscoverServices = vi.fn();
const mockDiscoverServiceEndpoints = vi.fn();
const mockDiscoverEndpoint = vi.fn();
const mockFetchSpecsForServices = vi.fn();

vi.mock("../../src/lib/api-registry-client.js", () => ({
  discoverServices: (...a: unknown[]) => mockDiscoverServices(...a),
  discoverServiceEndpoints: (...a: unknown[]) => mockDiscoverServiceEndpoints(...a),
  discoverEndpoint: (...a: unknown[]) => mockDiscoverEndpoint(...a),
  fetchSpecsForServices: (...a: unknown[]) => mockFetchSpecsForServices(...a),
}));

const mockFetchPipe = vi.fn();
const mockFetchChannelPipes = vi.fn();
const mockFetchStep = vi.fn();

vi.mock("../../src/lib/catalogue-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/catalogue-client.js")>();
  return {
    ...actual,
    fetchPipe: (...a: unknown[]) => mockFetchPipe(...a),
    fetchChannelPipes: (...a: unknown[]) => mockFetchChannelPipes(...a),
    fetchStep: (...a: unknown[]) => mockFetchStep(...a),
  };
});

// --- Fixtures ---

const COLD_PIPE: CataloguePipe = {
  id: "sales-cold-email-outreach|lead_found_to_conversation",
  name: "Dotterel",
  line: "Sales Cold Email Outreach: Lead found → Positive reply",
  channelSlug: "sales-cold-email-outreach",
  channelName: "Sales Cold Email Outreach",
  legKey: "lead_found_to_conversation",
  fromStep: "lead_found",
  toStep: "conversation",
  mode: "proactive",
  triggerId: null,
  operatedBy: "platform",
  runnable: true,
};
const VISIT_PIPE: CataloguePipe = {
  ...COLD_PIPE,
  id: "sales-cold-email-outreach|lead_found_to_website_visit",
  legKey: "lead_found_to_website_visit",
  toStep: "website_visit",
  line: "Sales Cold Email Outreach: Lead found → Website visit",
};
const REACTIVE_PIPE: CataloguePipe = {
  ...COLD_PIPE,
  id: "ai-meeting-booking|conversation_to_meeting_booked",
  channelSlug: "ai-meeting-booking",
  channelName: "AI Meeting Booking",
  legKey: "conversation_to_meeting_booked",
  fromStep: "conversation",
  toStep: "meeting_booked",
  mode: "reactive",
  triggerId: "conversation",
  line: "AI Meeting Booking: Positive reply → Meeting booked",
};
const STEPS: Record<string, { id: string; name: string; line: string }> = {
  lead_found: { id: "lead_found", name: "Lead found", line: "Finds the right people" },
  conversation: { id: "conversation", name: "Positive reply", line: "Replies they're interested" },
  website_visit: { id: "website_visit", name: "Website visit", line: "Clicks through to your site" },
  meeting_booked: { id: "meeting_booked", name: "Meeting booked", line: "Books a meeting with you" },
};
const PIPE_CTX: PipeContext = { pipe: COLD_PIPE, fromStep: STEPS.lead_found, toStep: STEPS.conversation };

const LEVEL1 = {
  serviceCount: 4,
  services: [
    { name: "api", description: "Public API gateway", endpoints: 375 },
    { name: "campaign", description: "Campaigns and the runs they trigger.", endpoints: 39 },
    { name: "lead", description: "Serves the next qualified lead.", endpoints: 52 },
    { name: "content-generation", description: "Writes outreach content.", endpoints: 21 },
  ],
};
const LEVEL2: Record<string, unknown> = {
  lead: {
    service: "lead",
    description: "Serves the next qualified lead.",
    endpointCount: 1,
    endpoints: [{ method: "POST", path: "/buffer/next", summary: "Pull the next lead", stats: { successRate: 1, avgCostUsd: 0.03 }, roi: { step: "lead_found", roi: 89 } }],
  },
  "content-generation": {
    service: "content-generation",
    description: "Writes outreach content.",
    endpointCount: 1,
    endpoints: [{ method: "POST", path: "/generate", summary: "Generate content" }],
  },
};
const FULL_SPECS = new Map([
  ["lead", {
    openapi: "3.0.0",
    info: { title: "FULL-SPEC-MARKER Lead Service", version: "1.0.0" },
    paths: {
      "/buffer/next": {
        post: {
          summary: "Get next lead",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { campaignId: { type: "string" } } } } } },
        },
      },
    },
  }],
  ["content-generation", {
    openapi: "3.0.0",
    info: { title: "Content Generation Service", version: "1.0.0" },
    paths: {
      "/generate": {
        post: {
          summary: "Generate content",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { type: { type: "string" } } } } } },
        },
      },
    },
  }],
]);

function reply(json: Record<string, unknown>, tokensInput = 100, tokensOutput = 50): ChatServiceCompleteResponse {
  return { content: JSON.stringify(json), json, tokensInput, tokensOutput, model: "claude-opus-5-5" };
}

const SERVICES_REPLY = { services: ["lead", "content-generation"] };
const ENDPOINTS_REPLY = {
  endpoints: [
    { service: "lead", method: "POST", path: "/buffer/next" },
    { service: "content-generation", method: "POST", path: "/generate" },
  ],
};
const DAG_REPLY = { description: "Finds a lead and writes them a cold email.", dag: JSON.stringify(VALID_LINEAR_DAG) };

type Stage = "services" | "endpoints" | "dag";
function stageOf(req: ChatServiceCompleteRequest): Stage {
  if (req.systemPrompt.includes("Name every service the workflow will call")) return "services";
  if (req.systemPrompt.includes("Pick every endpoint the workflow will call")) return "endpoints";
  return "dag";
}

const TEST_IDENTITY: DownstreamHeaders = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };

// --- Prompts ---

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt({ pipeContext: PIPE_CTX, endpointDocs: { docs: [{ service: "lead", method: "POST", path: "/buffer/next", responses: { "200": {} } }] } });

  it("keeps the DAG format, special keys, node types and output format", () => {
    for (const s of ["DAG Format", "http.call", "$ref:flow_input", "stopAfterIf", "skipIf", "validateResponse", '"for-each"', "Output Format", "Return ONLY the JSON object"]) {
      expect(prompt).toContain(s);
    }
  });

  it("speaks the owner's vocabulary (2026-10-10)", () => {
    for (const s of ["**Step**", "**Sales Path**", "**Channel**", "**Pipe**", "**Sales Funnel**", "**Workflow**", "**Campaign**", "proactive", "reactive", '"Up to"']) {
      expect(prompt).toContain(s);
    }
    expect(prompt).toContain("Every pipe of the funnel stops when the funnel's cap is reached");
  });

  it("names the pipe, its leg, its mode and the step it produces", () => {
    expect(prompt).toContain("sales-cold-email-outreach|lead_found_to_conversation");
    expect(prompt).toContain("`lead_found_to_conversation`");
    expect(prompt).toContain("PROACTIVE");
    expect(prompt).toContain("Produces step: `conversation` (Positive reply)");
  });

  it("names the trigger of a reactive pipe", () => {
    const reactive = buildSystemPrompt({
      pipeContext: { pipe: REACTIVE_PIPE, fromStep: STEPS.conversation, toStep: STEPS.meeting_booked },
    });
    expect(reactive).toContain('REACTIVE on trigger "conversation"');
    expect(reactive).toContain("Produces step: `meeting_booked`");
  });

  it("carries no retired vertical or dimension tag vocabulary", () => {
    for (const s of ['"pr"', '"journalists"', '"outlets"', '"advertising"', "audienceType", "Dimension Enums", '"category"']) {
      expect(prompt).not.toContain(s);
    }
  });

  it("injects the picked endpoints' docs, never whole OpenAPI specs", () => {
    expect(prompt).toContain("## Endpoint Docs");
    expect(prompt).toContain('"path":"/buffer/next"');
    expect(prompt).not.toContain("Service OpenAPI Specs");
  });

  it("asks for description + dag only", () => {
    expect(prompt).toMatch(/"description": "Human-readable description[^"]*",\n {2}"dag": "the DAG serialized as ONE JSON string"/);
  });
});

describe("discovery prompts", () => {
  it("level 1 lists services in one line each and hides api-service", () => {
    const p = buildServicePickPrompt({ pipeContext: PIPE_CTX, candidatePipes: [], services: LEVEL1.services });
    expect(p).toContain("- **lead**: Serves the next qualified lead.");
    expect(p).not.toContain("**api**");
    expect(p).not.toContain('"pipeId"');
  });

  it("level 1 asks for the pipe when the channel has several", () => {
    const p = buildServicePickPrompt({
      pipeContext: null,
      candidatePipes: [COLD_PIPE, VISIT_PIPE].map((x) => ({ id: x.id, line: x.line, mode: x.mode, runnable: true })),
      services: LEVEL1.services,
    });
    expect(p).toContain("## Pick The Pipe");
    expect(p).toContain(VISIT_PIPE.id);
    expect(p).toContain('"pipeId"');
  });

  it("level 2 shows each endpoint's measured stats and ROI", () => {
    const p = buildEndpointPickPrompt({ pipeContext: PIPE_CTX, endpoints: [LEVEL2.lead as never] });
    expect(p).toContain("POST /buffer/next: Pull the next lead");
    expect(p).toContain('"avgCostUsd":0.03');
    expect(p).toContain('"roi":89');
  });
});

describe("buildRetryUserMessage", () => {
  it("includes validation errors and original description", () => {
    const msg = buildRetryUserMessage("Send an email to leads", [
      { field: "edges", message: "Workflow contains a cycle" },
    ]);
    expect(msg).toContain("cycle");
    expect(msg).toContain("Send an email to leads");
  });
});

// --- Generator ---

describe("generateWorkflow", () => {
  let mockComplete: ReturnType<typeof vi.fn>;
  let replies: Record<Stage, Array<Record<string, unknown> | null>>;

  beforeEach(() => {
    replies = { services: [SERVICES_REPLY], endpoints: [ENDPOINTS_REPLY], dag: [DAG_REPLY] };
    mockComplete = vi.fn(async (req: ChatServiceCompleteRequest) => {
      const stage = stageOf(req);
      const queue = replies[stage];
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      if (next === null) return { content: "not json", tokensInput: 1, tokensOutput: 1, model: "x" };
      return reply(next);
    });
    setChatServiceClient(mockComplete);
    process.env.API_REGISTRY_SERVICE_URL = "http://fake-registry";
    process.env.API_REGISTRY_SERVICE_API_KEY = "test-key";
    for (const m of [mockDiscoverServices, mockDiscoverServiceEndpoints, mockDiscoverEndpoint, mockFetchSpecsForServices, mockFetchPipe, mockFetchChannelPipes, mockFetchStep]) m.mockReset();
    mockDiscoverServices.mockResolvedValue(LEVEL1);
    mockDiscoverServiceEndpoints.mockImplementation(async (s: string) => LEVEL2[s]);
    mockDiscoverEndpoint.mockImplementation(async (service: string, method: string, path: string) => ({ service, method, path, summary: "LEVEL3-DOC", responses: {} }));
    mockFetchSpecsForServices.mockResolvedValue(FULL_SPECS);
    mockFetchPipe.mockImplementation(async (id: string) => [COLD_PIPE, VISIT_PIPE, REACTIVE_PIPE].find((p) => p.id === id));
    mockFetchChannelPipes.mockResolvedValue([{ id: COLD_PIPE.id, line: COLD_PIPE.line, mode: "proactive", runnable: true }]);
    mockFetchStep.mockImplementation(async (id: string) => STEPS[id]);
  });

  afterEach(() => {
    setChatServiceClient(null);
    delete process.env.API_REGISTRY_SERVICE_URL;
    delete process.env.API_REGISTRY_SERVICE_API_KEY;
  });

  const INPUT = { description: "Search leads and send cold emails", featureSlug: "sales-cold-email-outreach" };

  it("throws if API_REGISTRY env vars are missing", async () => {
    delete process.env.API_REGISTRY_SERVICE_URL;
    await expect(generateWorkflow(INPUT, TEST_IDENTITY)).rejects.toThrow("API_REGISTRY_SERVICE_URL and API_REGISTRY_SERVICE_API_KEY must be set");
  });

  it("runs every call on Anthropic opus, JSON out, never haiku", async () => {
    await generateWorkflow(INPUT, TEST_IDENTITY);
    expect(GENERATION_LLM).toEqual({ provider: "anthropic", model: "opus" });
    expect(mockComplete).toHaveBeenCalledTimes(3);
    for (const [req, headers] of mockComplete.mock.calls as Array<[ChatServiceCompleteRequest, DownstreamHeaders]>) {
      expect(req.provider).toBe("anthropic");
      expect(req.model).toBe("opus");
      expect(req.model).not.toBe("haiku");
      expect(req.responseFormat).toBe("json");
      // Anthropic only enforces JSON through a strict schema: every object closed.
      const objects: Array<Record<string, unknown>> = [];
      const walk = (n: unknown): void => {
        if (!n || typeof n !== "object") return;
        const o = n as Record<string, unknown>;
        if (o.type === "object") objects.push(o);
        Object.values(o).forEach(walk);
      };
      walk(req.responseSchema);
      expect(objects.length).toBeGreaterThan(0);
      for (const o of objects) {
        expect(o.additionalProperties).toBe(false);
        expect(o.required).toEqual(Object.keys(o.properties as object));
      }
      expect(req.temperature).toBeUndefined();
      expect(headers).toEqual(TEST_IDENTITY);
    }
  });

  it("walks the discovery levels: services, then endpoints, then the docs of the picked endpoints only", async () => {
    const result = await generateWorkflow(INPUT, TEST_IDENTITY);
    const stages = (mockComplete.mock.calls as Array<[ChatServiceCompleteRequest]>).map(([r]) => stageOf(r));
    expect(stages).toEqual(["services", "endpoints", "dag"]);
    expect(mockDiscoverServiceEndpoints.mock.calls.map((c) => c[0])).toEqual(["lead", "content-generation"]);
    expect(mockDiscoverEndpoint.mock.calls.map((c) => `${c[0]} ${c[1]} ${c[2]}`)).toEqual([
      "lead POST /buffer/next",
      "content-generation POST /generate",
    ]);
    const dagPrompt = (mockComplete.mock.calls[2] as [ChatServiceCompleteRequest])[0].systemPrompt;
    expect(dagPrompt).toContain("LEVEL3-DOC");
    expect(dagPrompt).not.toContain("FULL-SPEC-MARKER");
    expect(result.dag).toEqual(VALID_LINEAR_DAG);
    expect(result.description).toBe(DAG_REPLY.description);
  });

  it("names its pipe and the step it produces, as the catalogue serves them", async () => {
    const result = await generateWorkflow(INPUT, TEST_IDENTITY);
    expect(result.pipe).toEqual({
      id: COLD_PIPE.id,
      channelSlug: "sales-cold-email-outreach",
      legKey: "lead_found_to_conversation",
      mode: "proactive",
      triggerId: null,
      toStep: "conversation",
    });
    expect(result.producesStep).toBe("conversation");
  });

  it("sums token usage across the three calls", async () => {
    const result = await generateWorkflow(INPUT, TEST_IDENTITY);
    expect(result.usage).toMatchObject({ calls: 3, tokensInput: 300, tokensOutput: 150 });
    expect(result.usage.systemPromptChars).toBeGreaterThan(0);
  });

  it("lets the model pick the pipe when the channel has several, and retries an invented one", async () => {
    mockFetchChannelPipes.mockResolvedValue([COLD_PIPE, VISIT_PIPE].map((x) => ({ id: x.id, line: x.line, mode: x.mode, runnable: true })));
    replies.services = [{ ...SERVICES_REPLY, pipeId: "nope|nope" }, { ...SERVICES_REPLY, pipeId: VISIT_PIPE.id }];
    const result = await generateWorkflow(INPUT, TEST_IDENTITY);
    expect(result.pipe.id).toBe(VISIT_PIPE.id);
    expect(result.producesStep).toBe("website_visit");
    const retry = (mockComplete.mock.calls[1] as [ChatServiceCompleteRequest])[0].message;
    expect(retry).toContain("pipeId");
  });

  it("uses the pipe the caller names", async () => {
    const result = await generateWorkflow({ ...INPUT, pipeId: VISIT_PIPE.id }, TEST_IDENTITY);
    expect(result.pipe.id).toBe(VISIT_PIPE.id);
    expect(mockFetchChannelPipes).not.toHaveBeenCalled();
  });

  it("refuses a pipe of another channel, a customer-worked pipe, and a channel with no pipe", async () => {
    await expect(generateWorkflow({ ...INPUT, pipeId: REACTIVE_PIPE.id }, TEST_IDENTITY)).rejects.toMatchObject({ name: "PipeResolutionError" });
    mockFetchPipe.mockResolvedValue({ ...COLD_PIPE, operatedBy: "customer" });
    await expect(generateWorkflow({ ...INPUT, pipeId: COLD_PIPE.id }, TEST_IDENTITY)).rejects.toMatchObject({ name: "PipeResolutionError" });
    mockFetchChannelPipes.mockResolvedValue([]);
    await expect(generateWorkflow(INPUT, TEST_IDENTITY)).rejects.toMatchObject({ name: "PipeResolutionError" });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("retries a service or endpoint the listing does not hold", async () => {
    replies.services = [{ services: ["api"] }, SERVICES_REPLY];
    replies.endpoints = [{ endpoints: [{ service: "lead", method: "GET", path: "/invented" }] }, ENDPOINTS_REPLY];
    await generateWorkflow(INPUT, TEST_IDENTITY);
    expect(mockComplete).toHaveBeenCalledTimes(5);
  });

  it("retries an invalid DAG with the errors, then fails loudly", async () => {
    replies.dag = [{ description: "x", dag: JSON.stringify({ nodes: [{ id: "a", type: "unknown-type-xyz" }], edges: [] }) }];
    await expect(generateWorkflow(INPUT, TEST_IDENTITY)).rejects.toBeInstanceOf(GenerationValidationError);
    const dagCalls = (mockComplete.mock.calls as Array<[ChatServiceCompleteRequest]>).filter(([r]) => stageOf(r) === "dag");
    expect(dagCalls).toHaveLength(3);
    expect(dagCalls[1][0].message).toContain("The DAG you generated was invalid");
  });

  it("retries a dag that is not one parseable JSON string", async () => {
    replies.dag = [{ description: "x", dag: "{not json" }, DAG_REPLY];
    const result = await generateWorkflow(INPUT, TEST_IDENTITY);
    expect(result.dag).toEqual(VALID_LINEAR_DAG);
    const dagCalls = (mockComplete.mock.calls as Array<[ChatServiceCompleteRequest]>).filter(([r]) => stageOf(r) === "dag");
    expect(dagCalls[1][0].message).toContain("dag must be ONE JSON string");
  });

  it("throws if the LLM returns no JSON", async () => {
    replies.services = [null];
    await expect(generateWorkflow(INPUT, TEST_IDENTITY)).rejects.toThrow("LLM did not return valid JSON");
  });

  it("passes hints: services to call 1, node types and inputs to the DAG call", async () => {
    await generateWorkflow({ ...INPUT, hints: { services: ["lead"], nodeTypes: ["http.call"], expectedInputs: ["campaignId"] } }, TEST_IDENTITY);
    const calls = mockComplete.mock.calls as Array<[ChatServiceCompleteRequest]>;
    expect(calls[0][0].message).toContain("Relevant services: lead");
    expect(calls[2][0].message).toContain("Preferred node types: http.call");
    expect(calls[2][0].message).toContain("Expected flow_input fields: campaignId");
  });
});
