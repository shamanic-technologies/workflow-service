import { describe, it, expect } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import type { DAG } from "../../src/lib/dag-validator.js";

/**
 * A served lead's offer checks (lead-service `lead.qualification`) must reach
 * the email writer's inputs as `body.variables.leadQualification`, verbatim
 * (pass AND fail), and a lead with no checks must send exactly the body it sent
 * before.
 */

type Transform = { type: string; value?: unknown; expr?: string };
type Module = { id: string; value: { type: string; input_transforms?: Record<string, Transform>; branches?: Array<{ modules: Module[] }>; modules?: Module[] } };

const QUALIFICATION = {
  domain: "acmeclinics.com",
  checks: [
    { question: "Is the site slow on mobile?", role: "must_pass", outcome: "pass", evidence: "Mobile LCP is 6.1s.", screenshotUrl: "https://shots.example/1.png" },
    { question: "Do they run a newsletter?", role: "mention", outcome: "fail", evidence: "A signup form is in the footer.", screenshotUrl: null },
    { question: "Are they hiring support?", role: "mention", outcome: "unavailable", evidence: null, screenshotUrl: null },
  ],
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
  const flow = dagToOpenFlow(dag, "qualification");
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

function leadResult(qualification: unknown) {
  return {
    fetch_lead: {
      found: true,
      lead: { data: { firstName: "Sara", organization: { name: "Acme Clinics" } }, buyingSignal: null, qualification },
    },
    start_run: {},
  };
}

describe("offer checks reach the email writer", () => {
  it("puts the served lead's qualification, pass AND fail, verbatim into the generation step's variables", () => {
    const body = JSON.parse(sentBody(bodyTransform(coldEmailDag()), leadResult(QUALIFICATION)));
    expect(body.variables.leadQualification).toEqual(QUALIFICATION);
    expect(body.variables.leadQualification.checks.map((c: { outcome: string }) => c.outcome)).toEqual(["pass", "fail", "unavailable"]);
    expect(body.type).toBe("cold-email-v30");
    expect(body.variables.leadFirstName).toBe("Sara");
  });

  it("sends a lead with no checks exactly the body it sent before", () => {
    const noFetch = coldEmailDag();
    noFetch.nodes = noFetch.nodes.map((n) =>
      n.id === "fetch-lead" ? { ...n, config: { ...n.config, path: "/orgs/something-else" } } : n,
    );
    const before = sentBody(bodyTransform(noFetch), leadResult(undefined));
    for (const q of [{ domain: "acmeclinics.com", checks: [] }, { domain: null, checks: [] }, null, undefined]) {
      const sent = sentBody(bodyTransform(coldEmailDag()), leadResult(q));
      expect(sent).not.toContain("leadQualification");
      expect(sent).toBe(before);
    }
  });

  it("reaches every generation step downstream of the fetch (follow-up steps too)", () => {
    const dag = coldEmailDag();
    dag.nodes.push({
      id: "followup-generate",
      type: "http.call",
      config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email-followup-v3" } },
    });
    dag.edges.push({ from: "email-generate", to: "followup-generate" });
    const body = JSON.parse(sentBody(bodyTransform(dag, "followup_generate"), leadResult(QUALIFICATION)));
    expect(body.variables.leadQualification).toEqual(QUALIFICATION);
  });

  it("never overrides a qualification the DAG maps itself", () => {
    const dag = coldEmailDag({
      inputMapping: { "body.variables.leadQualification": "$ref:fetch-lead.output.lead.qualification.domain" },
    });
    const expr = bodyTransform(dag).expr!;
    expect(expr).toContain("results.fetch_lead?.lead?.qualification?.domain");
    expect(expr).not.toContain("q.checks.length");
  });

  it("does not add the variable to any non-generation call", () => {
    const flow = dagToOpenFlow(coldEmailDag(), "qualification");
    const others = allModules(flow.value.modules as unknown as Module[]).filter((m) => m.id !== "email_generate" && m.value.type === "script");
    expect(JSON.stringify(others)).not.toContain("qualification");
  });
});
