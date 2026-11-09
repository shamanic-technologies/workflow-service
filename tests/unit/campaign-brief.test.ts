import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { evalAsWindmill, windmillAddsReturn } from "../../src/lib/windmill-expr.js";
import type { DAG, DAGNode } from "../../src/lib/dag-validator.js";
import {
  BRIEF_HEADER,
  aliasRetiredInstructionRef,
  bodyWithBriefExpr,
  callsContentWriterDoor,
  chatLlmDoorKind,
} from "../../src/lib/campaign-brief.js";
import { buildColdWhatsappOutreachDag } from "../../src/lib/cold-whatsapp-outreach-dag.js";
import { buildIndustryUpdateVideoDag } from "../../src/lib/industry-update-video-dag.js";
import { buildAiLeadProposalDag } from "../../src/lib/ai-lead-proposal-dag.js";
import { buildFollowUpProactiveDag, buildFollowUpReactiveDag } from "../../src/lib/follow-up-dag.js";
import { buildClientCheckInDag } from "../../src/lib/client-check-in-dag.js";
import { buildClientSatisfiedDag } from "../../src/lib/client-satisfied-dag.js";
import { buildBrandTeamDag } from "../../src/lib/brand-team-dag.js";
import { buildFounderHelloDag } from "../../src/lib/founder-hello-dag.js";

/**
 * ONE-BRIEF-1105: every LLM step of a campaign run reads the campaign's brief, verbatim, through ONE conversion-time
 * mechanism (`campaign-brief.ts`), for every workflow builder, and nothing reads the retired `instruction`.
 */
type Mod = {
  id: string;
  value: {
    type: string;
    input_transforms?: Record<string, { type: string; expr?: string; value?: unknown }>;
    branches?: { modules: Mod[] }[];
    default?: Mod[];
    modules?: Mod[];
  };
};


/** A cold email head (content-generation `/generate` + its script-writer materials door). */
const COLD_EMAIL: DAG = {
  nodes: [
    { id: "gate-check", type: "http.call", config: { service: "campaign", method: "POST", path: "/gate-check" } },
    { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
    { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" } },
    { id: "materials", type: "http.call", config: { service: "content-generation", method: "POST", path: "/generate/materials", body: { type: "cold-email-v16" } } },
    { id: "email-generate", type: "http.call", config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email-v16" } } },
    { id: "end-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true } } },
  ],
  edges: [
    { from: "gate-check", to: "start-run" },
    { from: "start-run", to: "fetch-lead" },
    { from: "fetch-lead", to: "materials" },
    { from: "materials", to: "email-generate" },
    { from: "email-generate", to: "end-run" },
  ],
};

const DAGS: Record<string, DAG> = {
  "cold-email": COLD_EMAIL,
  "cold-whatsapp-outreach": buildColdWhatsappOutreachDag(),
  "industry-update-video": buildIndustryUpdateVideoDag(),
  "ai-lead-proposal": buildAiLeadProposalDag(),
  "follow-up-proactive": buildFollowUpProactiveDag(),
  "follow-up-reactive": buildFollowUpReactiveDag({ readFigures: false }),
  "follow-up-reactive-figures": buildFollowUpReactiveDag({ readFigures: true }),
  "client-check-in": buildClientCheckInDag(),
  "client-satisfied": buildClientSatisfiedDag(),
  "brand-team": buildBrandTeamDag(),
  "founder-hello": buildFounderHelloDag(),
};

function allModules(mods: Mod[]): Mod[] {
  return mods.flatMap((m) => [
    m,
    ...allModules((m.value.branches ?? []).flatMap((b) => b.modules)),
    ...allModules(m.value.default ?? []),
    ...allModules(m.value.modules ?? []),
  ]);
}

const llmDoors = (dag: DAG): DAGNode[] => dag.nodes.filter((n) => n.id !== dag.onError && (callsContentWriterDoor(n) || chatLlmDoorKind(n)));

describe("every LLM step of every workflow reads the campaign's brief (ONE-BRIEF-1105)", () => {
  let doorsSeen = 0;
  for (const [name, dag] of Object.entries(DAGS)) {
    it(`${name}: each LLM call carries the brief, none reads the instruction`, () => {
      const mods = allModules(dagToOpenFlow(dag, `${name}-test`).value.modules as Mod[]);
      for (const node of llmDoors(dag)) {
        const mod = mods.find((m) => m.id === node.id.replace(/-/g, "_"));
        expect(mod, `${name}/${node.id}`).toBeDefined();
        const body = mod!.value.input_transforms?.body;
        expect(body?.type, `${name}/${node.id}`).toBe("javascript");
        if (callsContentWriterDoor(node)) expect(body!.expr, `${name}/${node.id}`).toMatch(/brief: \(.*(\?\.brief|__wf_brief)\) \?\? undefined/);
        else expect(body!.expr, `${name}/${node.id}`).toContain(JSON.stringify(BRIEF_HEADER));
        doorsSeen++;
      }
      for (const m of mods) {
        for (const t of Object.values(m.value.input_transforms ?? {})) {
          expect(t.expr ?? "", `${name}/${m.id}`).not.toMatch(/start_run\?\.instruction/);
        }
      }
    });
  }
  it("the builders hold LLM doors at all (the loop above judged something)", () => {
    expect(doorsSeen).toBeGreaterThan(10);
  });

  it("no source file reads the retired instruction off /start-run", () => {
    const dir = join(__dirname, "../../src/lib");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && x !== "campaign-brief.ts")) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/start-run\.output\.instruction|startRun\??\.instruction\b|start_run\?\.instruction/);
    }
  });
});

/** Evaluated the way Windmill does: an expression holding a ";" gets no implicit return and yields null. */
const run = (expr: string, brief: unknown) => evalAsWindmill(expr, { results: { start_run: { brief } } }) as Record<string, any>;

describe("bodyWithBriefExpr", () => {
  const BODY = JSON.stringify({ systemPrompt: "You write.", message: "Hi", provider: "anthropic" });

  it("appends the brief verbatim under the header to the system prompt", () => {
    const out = run(bodyWithBriefExpr(BODY, "results.start_run?.brief", "systemPrompt"), "  Sell to dentists only.\nBe short.  ");
    expect(out.systemPrompt).toBe(`You write.\n\n${BRIEF_HEADER}\nSell to dentists only.\nBe short.`);
    expect(out.message).toBe("Hi");
  });

  it("no brief (null, absent, blank) = the body byte for byte", () => {
    for (const b of [null, undefined, "   "]) {
      expect(JSON.stringify(run(bodyWithBriefExpr(BODY, "results.start_run?.brief", "systemPrompt"), b))).toBe(BODY);
    }
  });

  it("a writer that already carries the brief word for word is not handed it twice", () => {
    const body = JSON.stringify({ systemPrompt: "S", message: "INSTRUCTION from our client:\nSell to dentists only." });
    expect(JSON.stringify(run(bodyWithBriefExpr(body, "results.start_run?.brief", "systemPrompt"), "Sell to dentists only."))).toBe(body);
  });

  it("Windmill adds its implicit return to both forms: one expression, no \";\" outside strings (2026-11-05 body: null)", () => {
    for (const kind of ["systemPrompt", "state"] as const) {
      expect(windmillAddsReturn(bodyWithBriefExpr(BODY, "results.start_run?.brief", kind)), kind).toBe(true);
    }
  });

  it("the compiled draft body is an object under Windmill's evaluation, brief or not", () => {
    const fu = allModules(dagToOpenFlow(buildFollowUpReactiveDag({ readFigures: false }), "fu").value.modules as Mod[]);
    for (const [m, id] of [[fu, "draft"]] as const) {
      const expr = m.find((x) => x.id === id)!.value.input_transforms!.body.expr!;
      for (const brief of ["Sell to dentists only.", null]) {
        const out = evalAsWindmill(expr, { results: { start_run: { brief } }, flow_input: {} });
        expect(out && typeof out === "object", `${id} brief=${brief}`).toBe(true);
      }
    }
  });

  it("a judged state gets the brief: text under the header, object as campaignBrief, list wrapped", () => {
    const e = (state: unknown) => bodyWithBriefExpr(JSON.stringify({ state, questions: { q: {} } }), "results.start_run?.brief", "state");
    expect(run(e("A reply."), "B").state).toBe(`A reply.\n\n${BRIEF_HEADER}\nB`);
    expect(run(e({ a: 1 }), "B").state).toEqual({ a: 1, campaignBrief: "B" });
    expect(run(e([1, 2]), "B").state).toEqual({ items: [1, 2], campaignBrief: "B" });
  });
});

describe("aliasRetiredInstructionRef", () => {
  it("a stored mapping of the retired instruction reads the brief", () => {
    expect(aliasRetiredInstructionRef({ a: "$ref:start-run.output.instruction", b: "$ref:x.output.y" }, "start-run")).toEqual({
      a: "$ref:start-run.output.brief",
      b: "$ref:x.output.y",
    });
  });

  it("a stored DAG's instruction mapping converts to a brief read", () => {
    const dag: DAG = {
      nodes: [
        { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
        { id: "compose", type: "script", config: { code: "export async function main(instruction) { return instruction; }" }, inputMapping: { instruction: "$ref:start-run.output.instruction" } },
      ],
      edges: [{ from: "start-run", to: "compose" }],
    };
    const mods = allModules(dagToOpenFlow(dag, "alias-test").value.modules as Mod[]);
    expect(mods.find((m) => m.id === "compose")!.value.input_transforms!.instruction.expr).toBe("results.start_run?.brief");
  });
});
