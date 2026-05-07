import { describe, it, expect, vi } from "vitest";
import { deprecateWorkflow } from "../../src/lib/workflow-deprecation.js";

type Row = { id: string; workflowSlug: string; windmillFlowPath: string | null; status: string };

function makeDb(rows: Row[]) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push(values);
          return Promise.resolve();
        },
      }),
    }),
  };
  return { db, updates };
}

describe("deprecateWorkflow", () => {
  it("marks workflow deprecated and deletes its Windmill flow when no campaign uses it", async () => {
    const rows: Row[] = [
      { id: "w1", workflowSlug: "old-flow", windmillFlowPath: "f/wf/old", status: "active" },
    ];
    const { db, updates } = makeDb(rows);
    const deleteFlow = vi.fn().mockResolvedValue(undefined);
    const client = { deleteFlow } as unknown as Parameters<typeof deprecateWorkflow>[2];

    await deprecateWorkflow(db as unknown as Parameters<typeof deprecateWorkflow>[0], "w1", client);

    expect(updates[0]).toMatchObject({ status: "deprecated" });
    expect(deleteFlow).toHaveBeenCalledWith("f/wf/old");
  });

  it("skips Windmill deletion when slug is in the active-campaign set", async () => {
    const rows: Row[] = [
      { id: "w1", workflowSlug: "in-use", windmillFlowPath: "f/wf/in-use", status: "active" },
    ];
    const { db, updates } = makeDb(rows);
    const deleteFlow = vi.fn().mockResolvedValue(undefined);
    const client = { deleteFlow } as unknown as Parameters<typeof deprecateWorkflow>[2];

    await deprecateWorkflow(
      db as unknown as Parameters<typeof deprecateWorkflow>[0],
      "w1",
      client,
      new Set(["in-use"]),
    );

    expect(updates[0]).toMatchObject({ status: "deprecated" });
    expect(deleteFlow).not.toHaveBeenCalled();
  });

  it("swallows 404 from Windmill and does not throw", async () => {
    const rows: Row[] = [
      { id: "w1", workflowSlug: "gone", windmillFlowPath: "f/wf/gone", status: "active" },
    ];
    const { db } = makeDb(rows);
    const deleteFlow = vi.fn().mockRejectedValue(new Error("Windmill API error: 404 Not Found"));
    const client = { deleteFlow } as unknown as Parameters<typeof deprecateWorkflow>[2];

    await expect(
      deprecateWorkflow(db as unknown as Parameters<typeof deprecateWorkflow>[0], "w1", client),
    ).resolves.toBeUndefined();
  });

  it("logs and does not throw on non-404 Windmill errors", async () => {
    const rows: Row[] = [
      { id: "w1", workflowSlug: "broken", windmillFlowPath: "f/wf/broken", status: "active" },
    ];
    const { db } = makeDb(rows);
    const deleteFlow = vi.fn().mockRejectedValue(new Error("500 Internal Server Error"));
    const client = { deleteFlow } as unknown as Parameters<typeof deprecateWorkflow>[2];

    await expect(
      deprecateWorkflow(db as unknown as Parameters<typeof deprecateWorkflow>[0], "w1", client),
    ).resolves.toBeUndefined();
  });

  it("does not call Windmill when no client is provided", async () => {
    const rows: Row[] = [
      { id: "w1", workflowSlug: "no-client", windmillFlowPath: "f/wf/no-client", status: "active" },
    ];
    const { db, updates } = makeDb(rows);

    await deprecateWorkflow(db as unknown as Parameters<typeof deprecateWorkflow>[0], "w1", null);

    expect(updates[0]).toMatchObject({ status: "deprecated" });
  });
});
