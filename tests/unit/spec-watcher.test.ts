import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock API registry client
const mockFetchSpecsForServices = vi.fn();
vi.mock("../../src/lib/api-registry-client.js", () => ({
  fetchSpecsForServices: (...args: unknown[]) => mockFetchSpecsForServices(...args),
}));

// Mock startup-validator
const mockValidateAndUpgradeWorkflows = vi.fn();
vi.mock("../../src/lib/startup-validator.js", () => ({
  validateAndUpgradeWorkflows: (...args: unknown[]) => mockValidateAndUpgradeWorkflows(...args),
}));

import { SpecWatcher } from "../../src/lib/spec-watcher.js";

// Minimal DAG with an http.call node
function makeDag(service: string, method: string, path: string) {
  return {
    nodes: [
      {
        id: "n1",
        type: "http.call",
        config: { service, method, path },
      },
    ],
    edges: [],
  };
}

// Minimal OpenAPI spec where GET /leads exists
function makeSpec(paths: Record<string, Record<string, unknown>>) {
  return { openapi: "3.0.0", paths };
}

// Fake DB that returns active workflows
function makeFakeDb(rows: unknown[]) {
  const selectResult = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
  return {
    select: vi.fn().mockReturnValue(selectResult),
  } as unknown as Parameters<ConstructorParameters<typeof SpecWatcher>[0]["db"] extends never ? never : never>[0] & { select: ReturnType<typeof vi.fn> };
}

describe("SpecWatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Let console.error pass through so test failures are visible
    vi.spyOn(console, "error").mockImplementation((...args) => {
      process.stderr.write(`[test-stderr] ${args.map(String).join(" ")}\n`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores baseline hash on first check and does not trigger upgrade", async () => {
    const dag = makeDag("lead-service", "GET", "/leads");
    const spec = makeSpec({ "/leads": { get: { responses: { "200": {} } } } });

    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "w1", slug: "test-wf", dag, status: "active" },
          ]),
        }),
      }),
    };

    mockFetchSpecsForServices.mockResolvedValue(new Map([["lead-service", spec]]));

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });
    await watcher.check();

    // Should NOT trigger upgrade on first check (baseline)
    expect(mockValidateAndUpgradeWorkflows).not.toHaveBeenCalled();
  });

  it("does not trigger upgrade when specs are unchanged", async () => {
    const dag = makeDag("lead-service", "GET", "/leads");
    const spec = makeSpec({ "/leads": { get: { responses: { "200": {} } } } });

    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "w1", slug: "test-wf", dag, status: "active" },
          ]),
        }),
      }),
    };

    mockFetchSpecsForServices.mockResolvedValue(new Map([["lead-service", spec]]));

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });

    // First check — store baseline
    await watcher.check();
    // Second check — same specs
    await watcher.check();

    expect(mockValidateAndUpgradeWorkflows).not.toHaveBeenCalled();
  });

  it("triggers upgrade when specs change AND workflow has issues", async () => {
    const dag = makeDag("lead-service", "GET", "/leads");

    const specV1 = makeSpec({ "/leads": { get: { responses: { "200": {} } } } });
    // V2: /leads endpoint removed — workflow will have issues
    const specV2 = makeSpec({ "/contacts": { get: { responses: { "200": {} } } } });

    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "w1", slug: "test-wf", dag, status: "active" },
          ]),
        }),
      }),
    };

    mockFetchSpecsForServices
      .mockResolvedValueOnce(new Map([["lead-service", specV1]]))
      .mockResolvedValueOnce(new Map([["lead-service", specV2]]));

    mockValidateAndUpgradeWorkflows.mockResolvedValue(undefined);

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });

    // First check — baseline
    await watcher.check();
    expect(mockValidateAndUpgradeWorkflows).not.toHaveBeenCalled();

    // Second check — specs changed, /leads is gone → workflow broken → upgrade
    await watcher.check();
    expect(mockValidateAndUpgradeWorkflows).toHaveBeenCalledTimes(1);
  });

  it("does not trigger upgrade when specs change but workflows are still valid", async () => {
    const dag = makeDag("lead-service", "GET", "/leads");

    const specV1 = makeSpec({ "/leads": { get: { responses: { "200": {} } } } });
    // V2: /leads still exists, just added a new endpoint
    const specV2 = makeSpec({
      "/leads": { get: { responses: { "200": {} } } },
      "/leads/search": { post: { responses: { "200": {} } } },
    });

    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "w1", slug: "test-wf", dag, status: "active" },
          ]),
        }),
      }),
    };

    mockFetchSpecsForServices
      .mockResolvedValueOnce(new Map([["lead-service", specV1]]))
      .mockResolvedValueOnce(new Map([["lead-service", specV2]]));

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });

    await watcher.check();
    await watcher.check();

    // Specs changed but workflow is still valid — no upgrade
    expect(mockValidateAndUpgradeWorkflows).not.toHaveBeenCalled();
  });

  it("skips check if no active workflows", async () => {
    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });
    await watcher.check();

    expect(mockFetchSpecsForServices).not.toHaveBeenCalled();
  });

  it("does not run concurrent checks", async () => {
    const dag = makeDag("lead-service", "GET", "/leads");
    const spec = makeSpec({ "/leads": { get: { responses: { "200": {} } } } });

    // Make the fetch hang until we resolve it
    let resolveSpecs!: (v: Map<string, unknown>) => void;
    const hangingPromise = new Promise<Map<string, unknown>>((r) => { resolveSpecs = r; });

    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "w1", slug: "test-wf", dag, status: "active" },
          ]),
        }),
      }),
    };

    mockFetchSpecsForServices.mockReturnValue(hangingPromise);

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });

    // Start first check (will hang on fetchSpecsForServices)
    const p1 = watcher.check();
    // Start second check — should skip
    const p2 = watcher.check();

    // Resolve the hanging fetch
    resolveSpecs(new Map([["lead-service", spec]]));
    await p1;
    await p2;

    // Only one call to fetchSpecsForServices (the second check was skipped)
    expect(mockFetchSpecsForServices).toHaveBeenCalledTimes(1);
  });

  it("start() and stop() manage the interval", () => {
    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });

    vi.useFakeTimers();
    watcher.start();
    watcher.stop();
    vi.useRealTimers();

    // No error, no hanging timers
  });
});
