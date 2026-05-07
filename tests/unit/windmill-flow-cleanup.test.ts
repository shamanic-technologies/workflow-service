import { describe, it, expect, vi } from "vitest";
import { cleanupOrphanedWindmillFlows } from "../../src/lib/windmill-flow-cleanup.js";

type Row = { id: string; workflowSlug: string; status: string; windmillFlowPath: string | null };

function makeDb(rows: Row[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  };
}

describe("cleanupOrphanedWindmillFlows", () => {
  it("deletes deprecated flows whose slug is not in the active-campaign set", async () => {
    const rows: Row[] = [
      { id: "1", workflowSlug: "active-flow", status: "active", windmillFlowPath: "f/wf/active" },
      { id: "2", workflowSlug: "in-use", status: "deprecated", windmillFlowPath: "f/wf/in-use" },
      { id: "3", workflowSlug: "orphan", status: "deprecated", windmillFlowPath: "f/wf/orphan" },
    ];
    const db = makeDb(rows);
    const deleteFlow = vi.fn().mockResolvedValue(undefined);
    const client = { deleteFlow } as unknown as Parameters<typeof cleanupOrphanedWindmillFlows>[1];

    const result = await cleanupOrphanedWindmillFlows(
      db as unknown as Parameters<typeof cleanupOrphanedWindmillFlows>[0],
      client,
      new Set(["in-use"]),
    );

    expect(result).toEqual({ deleted: 1, kept: 2, failed: 0 });
    expect(deleteFlow).toHaveBeenCalledTimes(1);
    expect(deleteFlow).toHaveBeenCalledWith("f/wf/orphan");
  });

  it("treats 404 as already-gone and counts the row as kept", async () => {
    const rows: Row[] = [
      { id: "1", workflowSlug: "ghost", status: "deprecated", windmillFlowPath: "f/wf/ghost" },
    ];
    const db = makeDb(rows);
    const deleteFlow = vi.fn().mockRejectedValue(new Error("Windmill API error: 404 Not Found"));
    const client = { deleteFlow } as unknown as Parameters<typeof cleanupOrphanedWindmillFlows>[1];

    const result = await cleanupOrphanedWindmillFlows(
      db as unknown as Parameters<typeof cleanupOrphanedWindmillFlows>[0],
      client,
      new Set(),
    );

    expect(result).toEqual({ deleted: 0, kept: 1, failed: 0 });
  });

  it("counts non-404 deletion failures separately", async () => {
    const rows: Row[] = [
      { id: "1", workflowSlug: "broken", status: "deprecated", windmillFlowPath: "f/wf/broken" },
    ];
    const db = makeDb(rows);
    const deleteFlow = vi.fn().mockRejectedValue(new Error("500 Internal Server Error"));
    const client = { deleteFlow } as unknown as Parameters<typeof cleanupOrphanedWindmillFlows>[1];

    const result = await cleanupOrphanedWindmillFlows(
      db as unknown as Parameters<typeof cleanupOrphanedWindmillFlows>[0],
      client,
      new Set(),
    );

    expect(result).toEqual({ deleted: 0, kept: 0, failed: 1 });
  });
});
