import { describe, it, expect } from "vitest";
import { parseWindmillError, extractRootCause } from "../../src/lib/error-parser.js";

describe("extractRootCause", () => {
  it("extracts innermost error from nested service chain", () => {
    const msg =
      'runs-service POST /v1/runs/abc/costs failed: 502 - {"error":"billing-service unavailable: billing-service returned 400"}';
    expect(extractRootCause(msg)).toBe(
      "billing-service unavailable: billing-service returned 400"
    );
  });

  it("returns the message as-is when no nesting", () => {
    expect(extractRootCause("Something went wrong")).toBe("Something went wrong");
  });

  it("handles double-nested service errors", () => {
    const msg =
      'apollo-service POST /search failed: 500 - {"error":"runs-service POST /v1/runs/xyz/costs failed: 502 - {\\"error\\":\\"billing-service unavailable\\"}"}';
    expect(extractRootCause(msg)).toBe("billing-service unavailable");
  });
});

describe("parseWindmillError", () => {
  it("parses standard Windmill error format with step_id", () => {
    const raw = JSON.stringify({
      error: {
        message: 'POST lead/buffer/next failed (500): {"error":"Internal server error"}',
        name: "Error",
        stack: 'Error: POST lead/buffer/next failed\n    at main (/tmp/windmill/cache/bun/abc:43:16)\n    at async run (/tmp/windmill/wk.mjs:30:21)',
        step_id: "fetch_lead",
      },
    });

    const result = parseWindmillError(raw);
    expect(result.failedStep).toBe("fetch_lead");
    expect(result.message).not.toContain("at main");
    expect(result.message).not.toContain("at async run");
    expect(result.rootCause).toBe("Internal server error");
  });

  it("parses billing-service cascade error", () => {
    const raw = JSON.stringify({
      error: {
        message:
          'Apollo service call failed: 500 - {"error":"runs-service POST /v1/runs/abc/costs failed: 502 - {\\"error\\":\\"billing-service unavailable: billing-service returned 400\\"}"}',
        name: "Error",
        stack: "Error: Apollo service call failed\n    at callApolloService (file:///app/dist/lib/apollo-client.js:16:15)",
        step_id: "search_leads",
      },
    });

    const result = parseWindmillError(raw);
    expect(result.failedStep).toBe("search_leads");
    expect(result.rootCause).toBe("billing-service unavailable: billing-service returned 400");
  });

  it("handles null/undefined input", () => {
    expect(parseWindmillError(null)).toEqual({
      failedStep: null,
      message: "Unknown error",
      rootCause: "Unknown error",
    });
    expect(parseWindmillError(undefined)).toEqual({
      failedStep: null,
      message: "Unknown error",
      rootCause: "Unknown error",
    });
  });

  it("handles plain string error", () => {
    const result = parseWindmillError("Something broke");
    expect(result).toEqual({
      failedStep: null,
      message: "Something broke",
      rootCause: "Something broke",
    });
  });

  it("handles {error: string} format", () => {
    const raw = JSON.stringify({ error: "timeout after 30s" });
    const result = parseWindmillError(raw);
    expect(result.message).toBe("timeout after 30s");
    expect(result.rootCause).toBe("timeout after 30s");
  });

  it("strips stack traces from message", () => {
    const raw = JSON.stringify({
      error: {
        message: "Request failed\n    at doRequest (file:///app/dist/client.js:10:5)\n    at async main (file:///app/dist/index.js:20:3)",
        name: "Error",
        step_id: "api_call",
      },
    });

    const result = parseWindmillError(raw);
    expect(result.message).toBe("Request failed");
    expect(result.failedStep).toBe("api_call");
  });
});
