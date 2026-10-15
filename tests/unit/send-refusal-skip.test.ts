import { describe, it, expect } from "vitest";
import { dagToOpenFlow, REFUSAL_SKIP_CODES } from "../../src/lib/dag-to-openflow.js";
import type { DAG } from "../../src/lib/dag-validator.js";

/**
 * Regression: RECONTACT-LOOP-1011 (Perky, 2026-10-11). instantly-service refused
 * 7 of 10 served leads with 409 `recent_brand_contact` (emailed for the brand in
 * July). The send node threw, every run failed, campaign-service backed off 30
 * minutes each time, and the next run was served the same people: the funnel
 * froze. A send whose only successor is the campaign end-run now carries
 * `skipOnRefusalCodes`, so http-call returns the refusal as a skipped outcome
 * and the run ends normally. Everything else keeps failing loud.
 */

type Transform = { type: string; value?: unknown; expr?: string };
type Module = { id: string; value: { type: string; input_transforms?: Record<string, Transform>; branches?: Array<{ modules: Module[] }>; modules?: Module[]; default?: Module[] } };

const send = {
  id: "email-send",
  type: "http.call",
  config: { service: "email-gateway", method: "POST", path: "/orgs/send", body: { type: "broadcast" }, validateResponse: { field: "success", equals: true } },
  retries: 0,
};

/** The shape of the 39 live cold-email heads. */
function coldEmailDag(): DAG {
  return {
    nodes: [
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" } },
      { id: "check-lead", type: "condition", config: {} },
      { id: "email-generate", type: "http.call", config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email-v30" } } },
      send,
      { id: "end-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: false } } },
      { id: "end-run-no-lead", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true, stopCampaign: true } } },
      { id: "end-run-error", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: false, stopCampaign: false } } },
    ],
    edges: [
      { from: "start-run", to: "fetch-lead" },
      { from: "fetch-lead", to: "check-lead" },
      { from: "check-lead", to: "email-generate", condition: "results['fetch-lead'].found == true" },
      { from: "email-generate", to: "email-send" },
      { from: "email-send", to: "end-run" },
      { from: "check-lead", to: "end-run-no-lead", condition: "results['fetch-lead'].found == false" },
    ],
    onError: "end-run-error",
  } as DAG;
}

function allModules(mods: Module[]): Module[] {
  return mods.flatMap((m) => [
    m,
    ...allModules(m.value.modules ?? []),
    ...allModules(m.value.default ?? []),
    ...(m.value.branches ?? []).flatMap((b) => allModules(b.modules)),
  ]);
}

/** Evaluates a compiled transform the way Windmill does. */
function evaluated(transform: Transform, flowInput: Record<string, unknown> = {}, results: Record<string, unknown> = {}): unknown {
  if (transform.type === "static") return transform.value;
  return JSON.parse(JSON.stringify(new Function("results", "flow_input", `return (${transform.expr});`)(results, flowInput)));
}

function transforms(dag: DAG, moduleId: string): Record<string, Transform> {
  const flow = dagToOpenFlow(dag, "send refusal");
  const mod = allModules(flow.value.modules as unknown as Module[]).find((m) => m.id === moduleId);
  if (!mod?.value.input_transforms) throw new Error(`module ${moduleId} not found`);
  return mod.value.input_transforms;
}

describe("a cold-email send skips a sender refusal instead of failing the run", () => {
  it("the send feeding only the end-run carries the closed refusal list", () => {
    expect(evaluated(transforms(coldEmailDag(), "email_send").skipOnRefusalCodes)).toEqual(["recent_brand_contact", "lead_opted_out"]);
    expect([...REFUSAL_SKIP_CODES]).toEqual(["recent_brand_contact", "lead_opted_out"]);
  });

  it("the end-run after it still ends the run successfully", () => {
    expect(evaluated(transforms(coldEmailDag(), "end_run").body, {}, { email_send: { ok: true } })).toEqual({
      success: true,
      stopCampaign: false,
    });
  });

  it("no other node gets the list", () => {
    for (const id of ["email_generate", "fetch_lead", "end_run", "start_run"]) {
      expect(transforms(coldEmailDag(), id).skipOnRefusalCodes).toBeUndefined();
    }
  });

  it("a send followed by a record of the send keeps failing loud (would record a send that never happened)", () => {
    const dag = coldEmailDag();
    dag.nodes.push({ id: "record-sent", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/leads/{id}/followups" } });
    dag.edges = dag.edges.map((e) => (e.from === "email-send" ? { from: "email-send", to: "record-sent" } : e));
    dag.edges.push({ from: "record-sent", to: "end-run" });
    expect(transforms(dag, "email_send").skipOnRefusalCodes).toBeUndefined();
  });

  it("a DAG that states the list itself keeps its own", () => {
    const dag = coldEmailDag();
    dag.nodes = dag.nodes.map((n) => (n.id === "email-send" ? { ...n, config: { ...n.config, skipOnRefusalCodes: ["lead_opted_out"] } } : n));
    expect(transforms(dag, "email_send").skipOnRefusalCodes).toEqual({ type: "static", value: ["lead_opted_out"] });
  });
});
