import { describe, it, expect } from "vitest";
import { getUpgradeChainIds } from "../../src/lib/workflow-scoring.js";

type ChainRow = { id: string; creationType: string; createdFromWorkflow: string | null };

describe("getUpgradeChainIds", () => {
  it("walks linearly from active back through upgrade predecessors", () => {
    const rows: ChainRow[] = [
      { id: "v3", creationType: "upgrade", createdFromWorkflow: "v2" },
      { id: "v2", creationType: "upgrade", createdFromWorkflow: "v1" },
      { id: "v1", creationType: "scratch", createdFromWorkflow: null },
    ];
    expect(getUpgradeChainIds("v3", rows)).toEqual(["v3", "v2", "v1"]);
  });

  it("stops at a fork boundary (forks are not part of the upgrade chain)", () => {
    const rows: ChainRow[] = [
      { id: "active", creationType: "fork", createdFromWorkflow: "source" },
      { id: "source", creationType: "scratch", createdFromWorkflow: null },
    ];
    // creationType='fork' on the active row immediately stops the walk.
    expect(getUpgradeChainIds("active", rows)).toEqual(["active"]);
  });

  it("guards against self-references with a visited set", () => {
    const rows: ChainRow[] = [
      { id: "loop", creationType: "upgrade", createdFromWorkflow: "loop" },
    ];
    expect(getUpgradeChainIds("loop", rows)).toEqual(["loop"]);
  });

  it("crosses dynasties when an upgrade points back to a row in another dynasty", () => {
    // Dynasty B's active row was reached via upgrading from dynasty A's row.
    const rows: ChainRow[] = [
      { id: "B-active", creationType: "upgrade", createdFromWorkflow: "B-v1" },
      { id: "B-v1", creationType: "upgrade", createdFromWorkflow: "A-active" },
      { id: "A-active", creationType: "upgrade", createdFromWorkflow: "A-v0" },
      { id: "A-v0", creationType: "scratch", createdFromWorkflow: null },
    ];
    expect(getUpgradeChainIds("B-active", rows)).toEqual([
      "B-active",
      "B-v1",
      "A-active",
      "A-v0",
    ]);
  });

  it("returns just the active id when the predecessor is missing from the row set", () => {
    const rows: ChainRow[] = [
      { id: "orphan", creationType: "upgrade", createdFromWorkflow: "missing" },
    ];
    expect(getUpgradeChainIds("orphan", rows)).toEqual(["orphan", "missing"]);
  });
});
