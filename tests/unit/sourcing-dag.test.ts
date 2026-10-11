import { describe, it, expect } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { SOURCING_CHANNEL_SLUGS, buildSourcingDag, sourcingPipeIdOf } from "../../src/lib/sourcing-dag.js";

describe("the workflow of a sourcing pipe (owner 2026-10-11: every pipe runs a workflow)", () => {
  it("one per sourcing channel, Lead Sourcing included, each on its Start -> Lead found pipe", () => {
    expect([...SOURCING_CHANNEL_SLUGS]).toEqual([
      "sourcing-apollo-cold-filters",
      "sourcing-apollo-buying-signals",
      "sourcing-linkedin-engagement-signals",
      "sourcing-crm-contacts",
      "lead-sourcing",
    ]);
    expect(sourcingPipeIdOf("lead-sourcing")).toBe("lead-sourcing|start_to_lead_found");
  });

  it("its one step is the serve (lead-service), a valid DAG", () => {
    const dag = buildSourcingDag();
    expect(validateDAG(dag).valid).toBe(true);
    expect(dag.nodes).toEqual([expect.objectContaining({ type: "http.call", config: expect.objectContaining({ service: "lead", method: "POST", path: "/orgs/buffer/next" }) })]);
  });
});

describe("a pipe from Start (features-service fromStep: null)", () => {
  it("parses, and a workflow generated for it starts at Start", async () => {
    const { CataloguePipeSchema, START_STEP } = await import("../../src/lib/catalogue-client.js");
    const pipe = CataloguePipeSchema.parse({
      id: "lead-sourcing|start_to_lead_found", name: "Wren", line: "Lead Sourcing: Start → Lead found", channelSlug: "lead-sourcing",
      channelName: "Lead Sourcing", legKey: "start_to_lead_found", fromStep: null, toStep: "lead_found", mode: "reactive",
      triggerId: "lead_requested", operatedBy: "platform", runnable: true,
    });
    expect(pipe.fromStep).toBeNull();
    expect(START_STEP.id).toBe("start");
  });
});
