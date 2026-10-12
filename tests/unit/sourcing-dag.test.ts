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

  it("runs as a campaign run on its own (owner 2026-10-12: every pipe is independent): gate -> start -> find -> end", () => {
    const dag = buildSourcingDag();
    expect(validateDAG(dag).valid).toBe(true);
    const byId = Object.fromEntries(dag.nodes.map((n) => [n.id, n]));
    expect(byId["gate-check"].config).toMatchObject({ service: "campaign", path: "/gate-check", stopAfterIf: "result.allowed == false" });
    expect(byId["start-run"].config).toMatchObject({ service: "campaign", path: "/start-run" });
    expect(byId["serve-lead"].config).toMatchObject({ service: "lead", method: "POST", path: "/orgs/buffer/next" });
    expect(byId["end-run"].config).toMatchObject({ service: "campaign", path: "/end-run", body: { success: true, stopCampaign: false } });
    expect(byId["end-run-no-lead"].config).toMatchObject({ path: "/end-run", body: { success: true, stopCampaign: true } });
    expect(byId["end-run-error"].config).toMatchObject({ path: "/end-run", body: { success: false, stopCampaign: false } });
    expect(dag.onError).toBe("end-run-error");
    expect(dag.edges).toEqual([
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "serve-lead" },
      { from: "serve-lead", to: "check-lead" },
      { from: "check-lead", to: "end-run", condition: "results['serve-lead'].found == true" },
      { from: "check-lead", to: "end-run-no-lead", condition: "results['serve-lead'].found == false" },
    ]);
    for (const id of ["end-run", "end-run-no-lead", "end-run-error"]) {
      expect(byId[id].inputMapping).toMatchObject({ "headers.x-run-id": "$ref:flow_input.runId", "headers.x-campaign-id": "$ref:flow_input.campaignId" });
    }
  });

  it("emails nobody: campaign and lead-service calls only", () => {
    const services = buildSourcingDag().nodes.filter((n) => n.type === "http.call").map((n) => n.config?.service);
    expect(new Set(services)).toEqual(new Set(["campaign", "lead"]));
  });

  it("translates to a Windmill flow ending every branch in an end-run", async () => {
    const { dagToOpenFlow } = await import("../../src/lib/dag-to-openflow.js");
    const flow = JSON.stringify(dagToOpenFlow(buildSourcingDag(), "sourcing-apollo-cold-filters-scheat"));
    for (const id of ["gate_check", "start_run", "serve_lead", "end_run", "end_run_no_lead", "end_run_error"]) {
      expect(flow).toContain(`"${id}"`);
    }
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
