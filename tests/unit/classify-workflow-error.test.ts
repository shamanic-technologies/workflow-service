import { describe, it, expect } from "vitest";
import { classifyWorkflowError } from "../../src/lib/classify-workflow-error.js";

describe("classifyWorkflowError", () => {
  it("returns 'llm' when message is a chat-service error", () => {
    const err = new Error(
      "chat-service error: POST /complete -> 502 Bad Gateway: upstream unavailable",
    );
    expect(classifyWorkflowError(err)).toBe("llm");
  });

  it("returns 'registry' when message is an api-registry error", () => {
    const err = new Error(
      "api-registry error: GET /llm-context -> 500 Internal Server Error: db down",
    );
    expect(classifyWorkflowError(err)).toBe("registry");
  });

  it("returns 'config' when CHAT_SERVICE_URL is missing", () => {
    const err = new Error(
      "CHAT_SERVICE_URL and CHAT_SERVICE_API_KEY must be set for LLM calls",
    );
    expect(classifyWorkflowError(err)).toBe("config");
  });

  it("returns 'config' when API_REGISTRY_SERVICE_URL is missing", () => {
    const err = new Error(
      "API_REGISTRY_SERVICE_URL and API_REGISTRY_SERVICE_API_KEY must be set",
    );
    expect(classifyWorkflowError(err)).toBe("config");
  });

  it("returns 'windmill' when message mentions Windmill", () => {
    const err = new Error("Windmill flow creation failed: HTTP 502");
    expect(classifyWorkflowError(err)).toBe("windmill");
  });

  it("returns 'unknown' for generic Error", () => {
    const err = new Error("something broke");
    expect(classifyWorkflowError(err)).toBe("unknown");
  });

  it("returns 'unknown' for non-Error values", () => {
    expect(classifyWorkflowError("string error")).toBe("unknown");
    expect(classifyWorkflowError(undefined)).toBe("unknown");
    expect(classifyWorkflowError(null)).toBe("unknown");
    expect(classifyWorkflowError({ message: "looks like error but isn't" })).toBe(
      "unknown",
    );
  });
});
