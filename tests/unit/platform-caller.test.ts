import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { chatServicePlatformComplete } from "../../src/lib/chat-service-client.js";
import { SIBLING_LINE_CALLER, defaultSiblingLineDeps } from "../../src/lib/sibling-line-refresher.js";

// PLATFORM-CALLER-RUN-1024: every call to a chat-service platform route states whose work it is,
// this service's run (x-run-id) OR a declared support function (body `support`), never both, never neither.

const REQUEST = { provider: "anthropic" as const, model: "sonnet" as const, systemPrompt: "s", message: "m" };

function mockFetch() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: "", json: {}, tokensInput: 1, tokensOutput: 1, model: "x" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sent(fetchMock: ReturnType<typeof mockFetch>) {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
}

describe("chatServicePlatformComplete states whose work it is", () => {
  beforeEach(() => {
    process.env.CHAT_SERVICE_URL = "http://chat";
    process.env.CHAT_SERVICE_API_KEY = "k";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a caller run rides x-run-id, no support in the body", async () => {
    const fetchMock = mockFetch();
    await chatServicePlatformComplete(REQUEST, { runId: "11111111-1111-1111-1111-111111111111" });
    const { url, headers, body } = sent(fetchMock);
    expect(url).toBe("http://chat/internal/platform-complete");
    expect(headers["x-run-id"]).toBe("11111111-1111-1111-1111-111111111111");
    expect(body.support).toBeUndefined();
  });

  it("a support function rides the body, no x-run-id", async () => {
    const fetchMock = mockFetch();
    await chatServicePlatformComplete(REQUEST, { support: { kind: "product_feature", reason: "r" } });
    const { headers, body } = sent(fetchMock);
    expect(headers["x-run-id"]).toBeUndefined();
    expect(body.support).toEqual({ kind: "product_feature", reason: "r" });
    expect(body.message).toBe("m");
  });
});

describe("call sites", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the sibling-line writer declares support product_feature: no run stands behind it, it produces no outcome", async () => {
    expect(SIBLING_LINE_CALLER).toEqual({ support: { kind: "product_feature", reason: expect.stringMatching(/\S/) } });
    process.env.CHAT_SERVICE_URL = "http://chat";
    process.env.CHAT_SERVICE_API_KEY = "k";
    const fetchMock = mockFetch();
    await defaultSiblingLineDeps.complete("sys", "msg");
    const { headers, body } = sent(fetchMock);
    expect(headers["x-run-id"]).toBeUndefined();
    expect(body.support.kind).toBe("product_feature");
  });

  it("no other code calls a chat-service platform route outside the client", () => {
    const hits = execSync(
      `git grep -lE "platform-(complete|judgments|images|transcriptions)|chatServicePlatformComplete" -- src scripts`,
      { encoding: "utf8" },
    ).trim().split("\n").sort();
    // src/lib/scripts/vendors.ts: a stored script run for a service's own sweep (POST /internal/scripts/run) calls the
    // platform doors with ITS run as x-run-id, always (pinned in script-service-switch.test.ts).
    expect(hits).toEqual(["src/lib/chat-service-client.ts", "src/lib/scripts/vendors.ts", "src/lib/sibling-line-refresher.ts"]);
  });
});
