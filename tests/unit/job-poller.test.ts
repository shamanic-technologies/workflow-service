import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to mock drizzle operators since they're used internally
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: "eq" })),
  inArray: vi.fn((col: unknown, vals: unknown[]) => ({ col, vals, op: "inArray" })),
}));

vi.mock("../../src/db/index.js", () => ({
  db: "mock-db",
  sql: { end: () => Promise.resolve() },
}));

const mockCloseRun = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  closeRun: (...args: unknown[]) => mockCloseRun(...args),
}));

import { JobPoller } from "../../src/lib/job-poller.js";

describe("JobPoller error serialization", () => {
  let dbSetCalls: Array<Record<string, unknown>>;
  let mockGetJob: ReturnType<typeof vi.fn>;

  function createMockDb(runs: Array<Record<string, unknown>>) {
    dbSetCalls = [];
    return {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(runs),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          dbSetCalls.push(values);
          return {
            where: () => Promise.resolve(),
          };
        },
      }),
    };
  }

  function createMockWindmillClient() {
    mockGetJob = vi.fn();
    return { getJob: mockGetJob } as any;
  }

  const mockTable = {
    status: "status",
    id: "id",
  };

  beforeEach(() => {
    dbSetCalls = [];
    mockCloseRun.mockReset();
    mockCloseRun.mockResolvedValue(undefined);
  });

  it("serializes object errors as JSON instead of [object Object]", async () => {
    const errorResult = { message: "Node gate-check failed", code: 500, details: { step: "gate-check" } };
    const runs = [{ id: "run-1", windmillJobId: "job-1", status: "running" }];
    const mockDb = createMockDb(runs);
    const mockClient = createMockWindmillClient();
    mockGetJob.mockResolvedValue({ type: "CompletedJob", success: false, result: errorResult });

    const poller = new JobPoller(mockDb, mockClient, mockTable, 60_000);

    // Directly call the private poll method via start + immediate trigger
    // Instead, we access poll directly for testing
    const pollMethod = (poller as any).poll.bind(poller);
    await pollMethod();

    expect(dbSetCalls.length).toBe(1);
    expect(dbSetCalls[0].status).toBe("failed");
    expect(dbSetCalls[0].error).toBe(JSON.stringify(errorResult));
    // Must NOT be [object Object]
    expect(dbSetCalls[0].error).not.toBe("[object Object]");
  });

  it("preserves string errors as-is", async () => {
    const runs = [{ id: "run-2", windmillJobId: "job-2", status: "running" }];
    const mockDb = createMockDb(runs);
    const mockClient = createMockWindmillClient();
    mockGetJob.mockResolvedValue({ type: "CompletedJob", success: false, result: "Simple error message" });

    const poller = new JobPoller(mockDb, mockClient, mockTable, 60_000);
    const pollMethod = (poller as any).poll.bind(poller);
    await pollMethod();

    expect(dbSetCalls.length).toBe(1);
    expect(dbSetCalls[0].error).toBe("Simple error message");
  });

  it("handles null/undefined error results", async () => {
    const runs = [{ id: "run-3", windmillJobId: "job-3", status: "queued" }];
    const mockDb = createMockDb(runs);
    const mockClient = createMockWindmillClient();
    mockGetJob.mockResolvedValue({ type: "CompletedJob", success: false, result: null });

    const poller = new JobPoller(mockDb, mockClient, mockTable, 60_000);
    const pollMethod = (poller as any).poll.bind(poller);
    await pollMethod();

    expect(dbSetCalls.length).toBe(1);
    expect(dbSetCalls[0].error).toBe('"Unknown error"');
  });

  it("closes the run in runs-service when a job completes", async () => {
    const runs = [{ id: "run-4", windmillJobId: "job-4", status: "running", runId: "runs-svc-id-1", orgId: "org-1" }];
    const mockDb = createMockDb(runs);
    const mockClient = createMockWindmillClient();
    mockGetJob.mockResolvedValue({ type: "CompletedJob", success: true, result: { ok: true } });

    const poller = new JobPoller(mockDb, mockClient, mockTable, 60_000);
    const pollMethod = (poller as any).poll.bind(poller);
    await pollMethod();

    expect(mockCloseRun).toHaveBeenCalledWith("runs-svc-id-1", "completed", "org-1");
  });

  it("closes the run in runs-service as failed when a job fails", async () => {
    const runs = [{ id: "run-5", windmillJobId: "job-5", status: "running", runId: "runs-svc-id-2", orgId: "org-2" }];
    const mockDb = createMockDb(runs);
    const mockClient = createMockWindmillClient();
    mockGetJob.mockResolvedValue({ type: "CompletedJob", success: false, result: "error" });

    const poller = new JobPoller(mockDb, mockClient, mockTable, 60_000);
    const pollMethod = (poller as any).poll.bind(poller);
    await pollMethod();

    expect(mockCloseRun).toHaveBeenCalledWith("runs-svc-id-2", "failed", "org-2");
  });

  it("does not call closeRun when run has no runId", async () => {
    const runs = [{ id: "run-6", windmillJobId: "job-6", status: "running", runId: null, orgId: "org-1" }];
    const mockDb = createMockDb(runs);
    const mockClient = createMockWindmillClient();
    mockGetJob.mockResolvedValue({ type: "CompletedJob", success: true, result: {} });

    const poller = new JobPoller(mockDb, mockClient, mockTable, 60_000);
    const pollMethod = (poller as any).poll.bind(poller);
    await pollMethod();

    expect(mockCloseRun).not.toHaveBeenCalled();
  });

  it("does not crash if closeRun fails", async () => {
    const runs = [{ id: "run-7", windmillJobId: "job-7", status: "running", runId: "runs-svc-id-3", orgId: "org-1" }];
    const mockDb = createMockDb(runs);
    const mockClient = createMockWindmillClient();
    mockGetJob.mockResolvedValue({ type: "CompletedJob", success: true, result: {} });
    mockCloseRun.mockRejectedValue(new Error("runs-service down"));

    const poller = new JobPoller(mockDb, mockClient, mockTable, 60_000);
    const pollMethod = (poller as any).poll.bind(poller);
    await pollMethod();

    // DB update still happened
    expect(dbSetCalls.length).toBe(1);
    expect(dbSetCalls[0].status).toBe("completed");
  });

  describe("a job still waiting in the Windmill queue is not finished", () => {
    // Real /jobs_u/get shape for a job waiting on a worker (prod, 2026-09-29):
    // type QueuedJob, running=false, and no `success` key at all.
    const queuedWaiting = { id: "job-q", type: "QueuedJob", running: false, canceled: false };

    it("leaves a queued run queued and does not close it", async () => {
      const runs = [{ id: "run-q1", windmillJobId: "job-q", status: "queued", runId: "r-q1", orgId: "org-1" }];
      const mockDb = createMockDb(runs);
      const mockClient = createMockWindmillClient();
      mockGetJob.mockResolvedValue(queuedWaiting);

      const poller = new JobPoller(mockDb, mockClient, mockTable, 60_000);
      await (poller as any).poll.bind(poller)();

      expect(dbSetCalls).toEqual([]);
      expect(mockCloseRun).not.toHaveBeenCalled();
    });

    it("finalizes the same run once Windmill reports it completed", async () => {
      const runs = [{ id: "run-q2", windmillJobId: "job-q", status: "queued", runId: "r-q2", orgId: "org-1" }];
      const mockDb = createMockDb(runs);
      const mockClient = createMockWindmillClient();
      mockGetJob
        .mockResolvedValueOnce(queuedWaiting)
        .mockResolvedValueOnce({ id: "job-q", type: "QueuedJob", running: true })
        .mockResolvedValueOnce({ id: "job-q", type: "CompletedJob", success: true, result: { sent: 1 } });

      const poller = new JobPoller(mockDb, mockClient, mockTable, 60_000);
      const poll = (poller as any).poll.bind(poller);
      await poll();
      expect(dbSetCalls).toEqual([]);
      await poll();
      expect(dbSetCalls[0].status).toBe("running");
      await poll();
      expect(dbSetCalls[1].status).toBe("completed");
      expect(dbSetCalls[1].result).toEqual({ sent: 1 });
      expect(mockCloseRun).toHaveBeenCalledTimes(1);
      expect(mockCloseRun).toHaveBeenCalledWith("r-q2", "completed", "org-1");
    });

    it("does not invent an outcome for a CompletedJob without a boolean success", async () => {
      const runs = [{ id: "run-q3", windmillJobId: "job-q", status: "running", runId: "r-q3", orgId: "org-1" }];
      const mockDb = createMockDb(runs);
      const mockClient = createMockWindmillClient();
      mockGetJob.mockResolvedValue({ id: "job-q", type: "CompletedJob", result: {} });

      const poller = new JobPoller(mockDb, mockClient, mockTable, 60_000);
      await (poller as any).poll.bind(poller)();

      expect(dbSetCalls).toEqual([]);
      expect(mockCloseRun).not.toHaveBeenCalled();
    });

    it("does not finalize a job whose type it does not recognise", async () => {
      const runs = [{ id: "run-q4", windmillJobId: "job-q", status: "running", runId: "r-q4", orgId: "org-1" }];
      const mockDb = createMockDb(runs);
      const mockClient = createMockWindmillClient();
      mockGetJob.mockResolvedValue({ id: "job-q", running: false });

      const poller = new JobPoller(mockDb, mockClient, mockTable, 60_000);
      await (poller as any).poll.bind(poller)();

      expect(dbSetCalls).toEqual([]);
    });
  });
});
