import { describe, it, expect } from "vitest";
import type { DAG } from "../../src/lib/dag-validator.js";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  applyNoLeadStopCampaign,
  planNoLeadStopCampaign,
  NO_LEAD_END_RUN_ID,
} from "../../src/lib/no-lead-stop-campaign.js";

/** The shape every live sales cold-email head was stored with (e.g. rudder-v5). */
function sharedEndRunDag(): DAG {
  return {
    nodes: [
      { id: "gate-check", type: "http.call", config: { service: "campaign", method: "POST", path: "/gate-check" } },
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next", body: {} } },
      { id: "check-lead", type: "condition" },
      { id: "email-send", type: "http.call", config: { service: "email-gateway", method: "POST", path: "/orgs/send" } },
      {
        id: "end-run",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: false } },
        retries: 2,
      },
      {
        id: "end-run-error",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/end-run", body: { success: false, stopCampaign: false } },
      },
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "fetch-lead" },
      { from: "fetch-lead", to: "check-lead" },
      { from: "check-lead", to: "email-send", condition: "results['fetch-lead'].found == true" },
      { from: "check-lead", to: "end-run", condition: "results['fetch-lead'].found == false" },
      { from: "email-send", to: "end-run" },
    ],
    onError: "end-run-error",
  };
}

function node(dag: DAG, id: string) {
  return dag.nodes.find((n) => n.id === id)!;
}

describe("applyNoLeadStopCampaign", () => {
  it("gives the empty-audience path its own end-run that says stopCampaign: true", () => {
    const before = sharedEndRunDag();
    const { dag, plan, changed } = applyNoLeadStopCampaign(before);

    expect(changed).toBe(true);
    expect(plan).toEqual({
      action: "split",
      fetchNodeId: "fetch-lead",
      sharedEndRunNodeId: "end-run",
      newNodeId: NO_LEAD_END_RUN_ID,
    });

    const noLead = node(dag, NO_LEAD_END_RUN_ID);
    expect(noLead.config).toEqual({
      service: "campaign",
      method: "POST",
      path: "/end-run",
      body: { success: true, stopCampaign: true },
    });
    expect(noLead.retries).toBe(2);
    expect(dag.edges).toContainEqual({
      from: "check-lead",
      to: NO_LEAD_END_RUN_ID,
      condition: "results['fetch-lead'].found == false",
    });
    expect(validateDAG(dag).valid).toBe(true);
  });

  it("leaves the success path and the error path exactly as they were", () => {
    const { dag } = applyNoLeadStopCampaign(sharedEndRunDag());
    expect(node(dag, "end-run").config?.body).toEqual({ success: true, stopCampaign: false });
    expect(node(dag, "end-run-error").config?.body).toEqual({ success: false, stopCampaign: false });
    expect(dag.onError).toBe("end-run-error");
    expect(dag.edges).toContainEqual({ from: "email-send", to: "end-run" });
    expect(dag.edges.filter((e) => e.to === "end-run")).toHaveLength(1);
  });

  it("does not mutate its input", () => {
    const before = sharedEndRunDag();
    const snapshot = JSON.stringify(before);
    applyNoLeadStopCampaign(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("translates to a flow whose empty branch ends with stopCampaign: true and whose send branch ends with false", () => {
    const { dag } = applyNoLeadStopCampaign(sharedEndRunDag());
    const flow = dagToOpenFlow(dag, "wf");
    const branch = flow.value.modules.find((m) => m.id === "check_lead")!.value as {
      branches: Array<{ expr: string; modules: Array<{ id: string; value: { input_transforms: Record<string, { value?: unknown }> } }> }>;
    };
    const empty = branch.branches.find((b) => b.expr.includes("found == false"))!;
    const sent = branch.branches.find((b) => b.expr.includes("found == true"))!;
    expect(empty.modules.map((m) => m.id)).toEqual(["end_run_no_lead"]);
    expect(empty.modules[0].value.input_transforms.body.value).toEqual({ success: true, stopCampaign: true });
    expect(sent.modules.map((m) => m.id)).toEqual(["email_send", "end_run"]);
    expect(sent.modules[1].value.input_transforms.body.value).toEqual({ success: true, stopCampaign: false });
  });

  it("flips in place when the empty path's end-run is used by nothing else", () => {
    const dag = sharedEndRunDag();
    dag.edges = dag.edges.filter((e) => !(e.from === "email-send" && e.to === "end-run"));
    const { dag: after, plan } = applyNoLeadStopCampaign(dag);
    expect(plan.action).toBe("flip-in-place");
    expect(node(after, "end-run").config?.body).toEqual({ success: true, stopCampaign: true });
    expect(after.nodes).toHaveLength(dag.nodes.length);
  });

  it("is idempotent", () => {
    const once = applyNoLeadStopCampaign(sharedEndRunDag()).dag;
    const twice = applyNoLeadStopCampaign(once);
    expect(twice.changed).toBe(false);
    expect(twice.plan).toEqual({ action: "already-signals" });
  });

  it("picks a free id when end-run-no-lead is already taken", () => {
    const dag = sharedEndRunDag();
    dag.nodes.push({ id: NO_LEAD_END_RUN_ID, type: "wait", config: { seconds: 1 } });
    const plan = planNoLeadStopCampaign(dag);
    expect(plan).toMatchObject({ action: "split", newNodeId: `${NO_LEAD_END_RUN_ID}-2` });
  });

  it("skips shapes it cannot prove", () => {
    const noServe = sharedEndRunDag();
    noServe.nodes = noServe.nodes.filter((n) => n.id !== "fetch-lead");
    expect(planNoLeadStopCampaign(noServe).action).toBe("skip");

    const bodyFromRef = sharedEndRunDag();
    node(bodyFromRef, "end-run").inputMapping = { "body.stopCampaign": "$ref:x.output.y" };
    expect(planNoLeadStopCampaign(bodyFromRef).action).toBe("skip");

    const notEndRun = sharedEndRunDag();
    notEndRun.edges.find((e) => e.condition?.includes("false"))!.to = "email-send";
    expect(planNoLeadStopCampaign(notEndRun).action).toBe("skip");

    const hasOutgoing = sharedEndRunDag();
    hasOutgoing.edges.push({ from: "end-run", to: "end-run-error" });
    expect(planNoLeadStopCampaign(hasOutgoing).action).toBe("skip");
  });
});
