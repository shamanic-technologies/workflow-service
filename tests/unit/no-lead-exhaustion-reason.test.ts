import { describe, it, expect } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import type { DAG } from "../../src/lib/dag-validator.js";

/**
 * Regression: campaign 1e95a4c3 (2026-10-09). Its lead sources were OFF, so
 * every serve came back `{ found: false, reason: "source_campaign_off" }`, and
 * every run still ended on the no-lead end-run saying `stopCampaign: true`:
 * campaign-service marked 11 audiences exhausted for 24h within 3 minutes, and
 * the campaign served nobody for a day after the sources were switched on.
 *
 * Only lead-service's `audience_exhausted` may reach /end-run as
 * `stopCampaign: true`; any other empty serve ends the run idle.
 */

type Transform = { type: string; value?: unknown; expr?: string };
type Module = { id: string; value: { type: string; input_transforms?: Record<string, Transform>; branches?: Array<{ modules: Module[] }>; modules?: Module[]; default?: Module[] } };

/** The shape of the live sales cold-email heads after #447. */
function coldEmailDag(): DAG {
  return {
    nodes: [
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" } },
      { id: "check-lead", type: "condition", config: {} },
      {
        id: "email-generate",
        type: "http.call",
        config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email-v30" } },
      },
      { id: "end-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: false } } },
      { id: "end-run-no-lead", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: true } } },
    ],
    edges: [
      { from: "start-run", to: "fetch-lead" },
      { from: "fetch-lead", to: "check-lead" },
      { from: "check-lead", to: "email-generate", condition: "results['fetch-lead'].found == true" },
      { from: "email-generate", to: "end-run" },
      { from: "check-lead", to: "end-run-no-lead", condition: "results['fetch-lead'].found == false" },
    ],
  };
}

function allModules(mods: Module[]): Module[] {
  return mods.flatMap((m) => [
    m,
    ...allModules(m.value.modules ?? []),
    ...allModules(m.value.default ?? []),
    ...(m.value.branches ?? []).flatMap((b) => allModules(b.modules)),
  ]);
}

function bodyTransform(dag: DAG, moduleId: string): Transform {
  const flow = dagToOpenFlow(dag, "no-lead reason");
  const mod = allModules(flow.value.modules as unknown as Module[]).find((m) => m.id === moduleId);
  if (!mod?.value.input_transforms) throw new Error(`module ${moduleId} not found`);
  return mod.value.input_transforms.body;
}

/** Evaluates a compiled transform the way Windmill does, then serialises it like http-call. */
function sentBody(transform: Transform, results: Record<string, unknown>): Record<string, unknown> {
  if (transform.type === "static") return JSON.parse(JSON.stringify(transform.value));
  const evaluate = new Function("results", "flow_input", `return (${transform.expr});`);
  return JSON.parse(JSON.stringify(evaluate(results, {})));
}

const emptyServe = (reason: string | undefined) => ({
  start_run: { audienceId: "aud-1" },
  fetch_lead: reason === undefined ? { found: false } : { found: false, reason },
});

describe("no-lead end-run reports exhaustion only on audience_exhausted", () => {
  it("an audience_exhausted serve still ends with stopCampaign true", () => {
    const body = sentBody(bodyTransform(coldEmailDag(), "end_run_no_lead"), emptyServe("audience_exhausted"));
    expect(body).toEqual({ success: true, stopCampaign: true, noWorkAvailable: false });
  });

  it.each([
    "source_campaign_off",
    "no_audience",
    "serve_timed_out",
    "audience_not_serveable",
    "credit_insufficient",
    "source_budget_reached",
    "a_reason_added_later",
  ])("a %s serve ends idle, never stopCampaign true", (reason) => {
    const body = sentBody(bodyTransform(coldEmailDag(), "end_run_no_lead"), emptyServe(reason));
    expect(body).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
  });

  it("an empty serve with no reason at all is not exhaustion", () => {
    const body = sentBody(bodyTransform(coldEmailDag(), "end_run_no_lead"), emptyServe(undefined));
    expect(body.stopCampaign).toBe(false);
    expect(body.noWorkAvailable).toBe(true);
  });

  it("leaves the success end-run byte-identical", () => {
    const t = bodyTransform(coldEmailDag(), "end_run");
    expect(t).toEqual({ type: "static", value: { success: true, stopCampaign: false } });
  });

  it("leaves an end-run alone when the DAG has no served-lead fetch", () => {
    const dag = coldEmailDag();
    dag.nodes = dag.nodes.map((n) =>
      n.id === "fetch-lead" ? { ...n, config: { ...n.config, service: "journalists", path: "/orgs/next" } } : n,
    );
    const t = bodyTransform(dag, "end_run_no_lead");
    expect(t).toEqual({ type: "static", value: { success: true, stopCampaign: true } });
  });

  it("leaves an end-run alone when its DAG maps the flag itself", () => {
    const dag = coldEmailDag();
    dag.nodes = dag.nodes.map((n) =>
      n.id === "end-run-no-lead" ? { ...n, inputMapping: { "body.stopCampaign": "$ref:fetch-lead.output.found" } } : n,
    );
    const t = bodyTransform(dag, "end_run_no_lead");
    expect(t.expr).not.toContain("audience_exhausted");
  });
});
