import { describe, it, expect } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import type { DAG } from "../../src/lib/dag-validator.js";

/**
 * A served lead's buying signal (lead-service `lead.buyingSignal`) must reach
 * the email writer's inputs as `body.variables.leadBuyingSignal`, and a lead
 * with no signal must send exactly the body it sent before.
 */

type Transform = { type: string; value?: unknown; expr?: string };
type Module = { id: string; value: { type: string; input_transforms?: Record<string, Transform>; branches?: Array<{ modules: Module[] }>; modules?: Module[] } };

const SIGNAL = {
  type: "hiring",
  occurredOn: "2026-09-21",
  fact: "Acme Clinics posted a job for Office Manager (Austin, United States) on September 21, 2026",
  source: "apollo:job_postings",
  sourceUrl: null,
};

/** The shape of every active sales cold-email head: fetch, branch on found, generate. */
function coldEmailDag(generateOverrides: Partial<DAG["nodes"][number]> = {}): DAG {
  return {
    nodes: [
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" } },
      {
        id: "check-found",
        type: "condition",
        config: {},
      },
      {
        id: "email-generate",
        type: "http.call",
        config: {
          service: "content-generation",
          method: "POST",
          path: "/generate",
          body: { type: "cold-email-v30", model: "pro" },
        },
        inputMapping: {
          "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
          "body.variables.leadCompanyName": "$ref:fetch-lead.output.lead.data.organization.name",
        },
        ...generateOverrides,
      },
      { id: "end-run-no-lead", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { stopCampaign: true } } },
    ],
    edges: [
      { from: "start-run", to: "fetch-lead" },
      { from: "fetch-lead", to: "check-found" },
      { from: "check-found", to: "email-generate", condition: "results['fetch-lead'].found == true" },
      { from: "check-found", to: "end-run-no-lead", condition: "results['fetch-lead'].found == false" },
    ],
  };
}

function allModules(mods: Module[]): Module[] {
  return mods.flatMap((m) => [
    m,
    ...allModules(m.value.modules ?? []),
    ...(m.value.branches ?? []).flatMap((b) => allModules(b.modules)),
  ]);
}

function bodyTransform(dag: DAG, moduleId = "email_generate"): Transform {
  const flow = dagToOpenFlow(dag, "buying signal");
  const mod = allModules(flow.value.modules as unknown as Module[]).find((m) => m.id === moduleId);
  if (!mod?.value.input_transforms) throw new Error(`module ${moduleId} not found`);
  return mod.value.input_transforms.body;
}

/** Evaluates a compiled transform the way Windmill does, then serialises it like http-call. */
function sentBody(transform: Transform, results: Record<string, unknown>): string {
  if (transform.type === "static") return JSON.stringify(transform.value);
  const evaluate = new Function("results", "flow_input", `return (${transform.expr});`);
  return JSON.stringify(evaluate(results, {}));
}

function leadResult(buyingSignal: unknown) {
  return {
    fetch_lead: {
      found: true,
      lead: { data: { firstName: "Sara", organization: { name: "Acme Clinics" } }, buyingSignal },
    },
    start_run: {},
  };
}

describe("buying signal reaches the email writer", () => {
  it("puts the served lead's signal into the generation step's variables", () => {
    const body = JSON.parse(sentBody(bodyTransform(coldEmailDag()), leadResult(SIGNAL)));
    expect(body.variables.leadBuyingSignal).toEqual(SIGNAL);
    expect(body.variables.leadBuyingSignal.type).toBe("hiring");
    expect(body.variables.leadBuyingSignal.occurredOn).toBe("2026-09-21");
    expect(body.variables.leadBuyingSignal.fact).toContain("Office Manager");
    // Everything the DAG itself states survives untouched.
    expect(body.type).toBe("cold-email-v30");
    expect(body.model).toBe("pro");
    expect(body.variables.leadFirstName).toBe("Sara");
  });

  it("sends a lead with no signal exactly the body it sent before (no key, no placeholder)", () => {
    const withInjection = sentBody(bodyTransform(coldEmailDag()), leadResult(null));
    expect(withInjection).not.toContain("leadBuyingSignal");

    // The same DAG with no served-lead fetch compiles to the pre-change body.
    const dag = coldEmailDag();
    dag.nodes = dag.nodes.map((n) =>
      n.id === "fetch-lead" ? { ...n, config: { ...n.config, path: "/orgs/something-else" } } : n,
    );
    const before = sentBody(bodyTransform(dag), leadResult(null));
    expect(withInjection).toBe(before);
  });

  it("treats an absent buyingSignal (a pre-signal lead-service) as no signal", () => {
    const body = JSON.parse(sentBody(bodyTransform(coldEmailDag()), leadResult(undefined)));
    expect("leadBuyingSignal" in body.variables).toBe(false);
  });

  it("never overrides a signal the DAG maps itself", () => {
    const dag = coldEmailDag({
      inputMapping: {
        "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
        "body.variables.leadBuyingSignal": "$ref:fetch-lead.output.lead.buyingSignal.fact",
      },
    });
    const expr = bodyTransform(dag).expr!;
    expect(expr).toContain("results.fetch_lead?.lead?.buyingSignal?.fact");
    expect(expr).not.toContain("?? undefined");
  });

  it("leaves a node that maps its whole variables object alone", () => {
    const dag = coldEmailDag({ inputMapping: { "body.variables": "$ref:build-vars.output" } });
    expect(bodyTransform(dag).expr).not.toContain("buyingSignal");
  });

  it("does not touch a generation step that runs before the lead fetch", () => {
    const dag = coldEmailDag();
    dag.edges = [
      { from: "start-run", to: "email-generate" },
      { from: "email-generate", to: "fetch-lead" },
    ];
    dag.nodes = dag.nodes.filter((n) => n.id !== "check-found" && n.id !== "end-run-no-lead");
    expect(JSON.stringify(bodyTransform(dag))).not.toContain("buyingSignal");
  });

  it("does not guess when a DAG fetches several served leads", () => {
    const dag = coldEmailDag();
    dag.nodes.push({ id: "fetch-lead-2", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" } });
    dag.edges.push({ from: "start-run", to: "fetch-lead-2" });
    expect(JSON.stringify(bodyTransform(dag))).not.toContain("buyingSignal");
  });

  it("does not add the variable to any non-generation call", () => {
    const flow = dagToOpenFlow(coldEmailDag(), "buying signal");
    const others = allModules(flow.value.modules as unknown as Module[]).filter((m) => m.id !== "email_generate" && m.value.type === "script");
    expect(JSON.stringify(others)).not.toContain("buyingSignal");
  });
});
