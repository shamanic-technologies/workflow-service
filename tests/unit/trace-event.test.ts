import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { traceEvent } from "../../src/lib/trace-event.js";

describe("traceEvent", () => {
  const originalUrl = process.env.RUNS_SERVICE_URL;
  const originalKey = process.env.RUNS_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.RUNS_SERVICE_URL = "http://localhost:5000";
    process.env.RUNS_SERVICE_API_KEY = "test-runs-key";
  });

  afterEach(() => {
    process.env.RUNS_SERVICE_URL = originalUrl;
    process.env.RUNS_SERVICE_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("sends POST to /v1/runs/{runId}/events with correct payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true })
    );

    await traceEvent(
      "run-123",
      { service: "workflow-service", event: "execute-start", detail: "Starting workflow abc" },
      {}
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/v1/runs/run-123/events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-api-key": "test-runs-key",
        }),
        body: JSON.stringify({
          service: "workflow-service",
          event: "execute-start",
          detail: "Starting workflow abc",
        }),
      })
    );
  });

  it("forwards identity headers when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true })
    );

    await traceEvent(
      "run-456",
      { service: "workflow-service", event: "dag-validate" },
      {
        "x-org-id": "org-1",
        "x-user-id": "user-1",
        "x-brand-id": "brand-1",
        "x-campaign-id": "camp-1",
        "x-workflow-slug": "my-workflow",
        "x-feature-slug": "my-feature",
      }
    );

    const calledHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders["x-org-id"]).toBe("org-1");
    expect(calledHeaders["x-user-id"]).toBe("user-1");
    expect(calledHeaders["x-brand-id"]).toBe("brand-1");
    expect(calledHeaders["x-campaign-id"]).toBe("camp-1");
    expect(calledHeaders["x-workflow-slug"]).toBe("my-workflow");
    expect(calledHeaders["x-feature-slug"]).toBe("my-feature");
  });

  it("omits identity headers when not present in request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true })
    );

    await traceEvent(
      "run-789",
      { service: "workflow-service", event: "test" },
      { "x-org-id": "org-1" }
    );

    const calledHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders["x-org-id"]).toBe("org-1");
    expect(calledHeaders).not.toHaveProperty("x-user-id");
    expect(calledHeaders).not.toHaveProperty("x-brand-id");
    expect(calledHeaders).not.toHaveProperty("x-campaign-id");
    expect(calledHeaders).not.toHaveProperty("x-workflow-slug");
    expect(calledHeaders).not.toHaveProperty("x-feature-slug");
  });

  it("does not throw when fetch fails (network error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      traceEvent("run-err", { service: "workflow-service", event: "test" }, {})
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      "[workflow-service] Failed to trace event:",
      expect.any(Error)
    );
  });

  it("does not throw when fetch returns non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 })
    );

    await expect(
      traceEvent("run-500", { service: "workflow-service", event: "test" }, {})
    ).resolves.toBeUndefined();
  });

  it("skips call and logs when RUNS_SERVICE_URL is missing", async () => {
    delete process.env.RUNS_SERVICE_URL;
    vi.stubGlobal("fetch", vi.fn());
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await traceEvent("run-no-url", { service: "workflow-service", event: "test" }, {});

    expect(fetch).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      "[workflow-service] RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not set, skipping trace"
    );
  });

  it("skips call and logs when RUNS_SERVICE_API_KEY is missing", async () => {
    delete process.env.RUNS_SERVICE_API_KEY;
    vi.stubGlobal("fetch", vi.fn());
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await traceEvent("run-no-key", { service: "workflow-service", event: "test" }, {});

    expect(fetch).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      "[workflow-service] RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not set, skipping trace"
    );
  });
});
