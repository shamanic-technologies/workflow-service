import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildColdWhatsappOutreachDag } from "../../src/lib/cold-whatsapp-outreach-dag.js";
import { buildFollowUpProactiveDag, buildFollowUpReactiveDag } from "../../scripts/engine-ports/follow-up-steps.js";
import { buildLeadFollowUpLeadsOnlyDag } from "../../scripts/engine-ports/lead-follow-up-leads-steps.js";

describe("JSON body limit", () => {
  it("is set explicitly and holds the largest DAG this repo builds (a 413 once refused a workflow upgrade)", () => {
    const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    const match = src.match(/express\.json\(\{\s*limit:\s*"(\d+)mb"\s*\}\)/);
    expect(match).not.toBeNull();
    const limitBytes = Number(match![1]) * 1024 * 1024;
    const dags = [buildColdWhatsappOutreachDag(), buildFollowUpProactiveDag(), buildFollowUpReactiveDag({ readFigures: true }), buildLeadFollowUpLeadsOnlyDag({ readFigures: true })];
    const largest = Math.max(...dags.map((dag) => JSON.stringify({ workflowDynastySlug: "x", dag, description: "x" }).length));
    expect(largest * 4).toBeLessThan(limitBytes);
  });
});
