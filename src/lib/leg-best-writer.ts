/**
 * A workflow never fixes its template nor its LLM: every run writes with the template dynasty AND the LLM
 * features-service ranks best on the workflow's leg (BEST-TPL-LLM-1022, owner 2026-10-22: « les workflows existent
 * independamment (sans specifier) le template et le LLM, seulement en pouvant reduire le champ des possibles via des
 * tactiques »). Three independent choices per pipe: the workflow (sequence shape, chosen by features as today), the
 * template dynasty (lowest $/outcome on the leg) and the LLM (lowest $/outcome on the leg), each ranked by
 * features-service, a strategy's tactics narrowing the candidates. This service only reads the pick.
 *
 * `withLegBestWriter(dag)` turns the DAG's single content-generation `/generate` call into one that states no
 * template and no model, and splices three nodes into the edge running into it:
 *
 *   writer-pick   (http.call features-service GET /internal/writer-pick?workflowSlug=&campaignId=: the leg is
 *                  features-service's to resolve from the workflow, the strategy from the campaign)
 *   writer-plan   (script: the pick's template dynasty + LLM alias; a pick missing either THROWS, nothing is written:
 *                  "keep what the workflow states" would hand a run a template/LLM its strategy may exclude)
 *   template-head (content-generation GET /internal/template-dynasties/{slug}/head, slug = the picked dynasty)
 *
 * and maps `body.type` on the head (TPL-DYNASTY-1021-WF) and `body.model` on the picked LLM. What actually wrote is
 * recorded by content-generation on every generation (`prompt_type`, `model`), which is what features-service measures.
 *
 * Two workflows that differ only by the template/LLM they used to pin become the SAME DAG once freed (same
 * signature): the second one's upgrade is a 409 naming its twin, which is then merged (dynasty-merge.ts).
 */
import type { DAG, DAGNode } from "./dag-validator.js";
import { TEMPLATE_HEAD_NODE_ID, TEMPLATE_HEAD_PATH, TEMPLATE_HEAD_TYPE_REF } from "./template-dynasty.js";

export const WRITER_PICK_NODE_ID = "writer-pick";
export const WRITER_PLAN_NODE_ID = "writer-plan";
export const WRITER_PICK_PATH = "/internal/writer-pick";
export const LEG_BEST_TEMPLATE_DYNASTY_REF = `$ref:${WRITER_PLAN_NODE_ID}.output.templateDynastySlug`;
export const LEG_BEST_MODEL_REF = `$ref:${WRITER_PLAN_NODE_ID}.output.model`;

/**
 * The pick, read loudly. `pick` is features-service's answer verbatim: a null `template` / `llm` carries a reason
 * (`templateUnavailableReason` / `llmUnavailableReason`), named in the error so the run log says why nothing went out.
 */
export const WRITER_PLAN_CODE = `export async function main(pick) {
  const leg = pick && pick.legKey ? pick.legKey : "unknown leg";
  const templateDynastySlug = pick && pick.template ? pick.template.templateDynastySlug : null;
  const model = pick && pick.llm ? pick.llm.model : null;
  if (typeof templateDynastySlug !== "string" || templateDynastySlug.length === 0) {
    throw new Error("[writer-plan] no template to write with on " + leg + ": " + ((pick && pick.templateUnavailableReason) || "features-service served none") + ". Nothing is written.");
  }
  if (typeof model !== "string" || model.length === 0) {
    throw new Error("[writer-plan] no LLM to write with on " + leg + ": " + ((pick && pick.llmUnavailableReason) || "features-service served none") + ". Nothing is written.");
  }
  const t = pick.template;
  const l = pick.llm;
  console.log("[writer-plan] " + leg + (pick.strategyId ? " (strategy " + pick.strategyId + ")" : "") +
    ": template dynasty " + templateDynastySlug + " (place " + t.place + ", " + (t.isMature ? "mature" : "learning") + ", $" + t.spentUsd + " spent, " + t.outcomes + " outcomes)" +
    ", LLM " + model + " (place " + l.place + ", " + (l.isMature ? "mature" : "learning") + ", $" + l.spentUsd + " spent, " + l.outcomes + " outcomes)");
  return { templateDynastySlug, model, provider: l.provider ?? null, legKey: pick.legKey ?? null, strategyId: pick.strategyId ?? null };
}`;

const isGenerate = (n: DAGNode) => n.type === "http.call" && n.config?.service === "content-generation" && n.config?.path === "/generate";
const MANAGED = new Set([WRITER_PICK_NODE_ID, WRITER_PLAN_NODE_ID, TEMPLATE_HEAD_NODE_ID]);

/** True when the DAG's content call writes with the leg's best template + LLM, picked per run. */
export function writesWithLegBest(dag: { nodes?: DAGNode[] } | null | undefined): boolean {
  const nodes = dag?.nodes ?? [];
  const gens = nodes.filter(isGenerate);
  return (
    gens.length > 0 &&
    gens.every((g) => g.inputMapping?.["body.model"] === LEG_BEST_MODEL_REF && g.inputMapping?.["body.type"] === TEMPLATE_HEAD_TYPE_REF) &&
    nodes.some((n) => n.id === WRITER_PICK_NODE_ID && n.config?.service === "features" && n.config?.path === WRITER_PICK_PATH)
  );
}

function withoutKeys<T extends Record<string, unknown>>(o: T | undefined, keys: string[]): T {
  const copy = { ...(o ?? {}) } as Record<string, unknown>;
  for (const k of keys) delete copy[k];
  return copy as T;
}

/**
 * The DAG writing with its leg's best template + LLM. Idempotent (a freed DAG comes back equal). Throws unless the DAG
 * has exactly one content-generation `/generate` call: a workflow is never half-switched. A content call with no
 * incoming edge (a root) gets a root pick.
 * A DAG already reading a template dynasty's head (TPL-DYNASTY-1021-WF) keeps that read, now fed by the pick.
 */
export function withLegBestWriter(dag: DAG): DAG {
  const generates = dag.nodes.filter(isGenerate);
  if (generates.length !== 1) throw new Error(`withLegBestWriter: expected exactly one content-generation /generate call, found ${generates.length}`);
  const gen = generates[0];

  // Edges into the writer chain from outside it: the sources the content call ran after (none for a root call). The
  // managed nodes are rebuilt, so their own edges are dropped and re-laid in one fixed line.
  const outside = (id: string) => !MANAGED.has(id) && id !== gen.id;
  const incoming = dag.edges.filter((e) => outside(e.from) && (e.to === gen.id || MANAGED.has(e.to)));
  const otherOut = dag.edges.filter((e) => MANAGED.has(e.from) && e.to !== gen.id && !MANAGED.has(e.to));
  if (otherOut.length > 0) throw new Error(`withLegBestWriter: "${otherOut[0].from}" also runs into "${otherOut[0].to}": not a writer chain this can rebuild`);

  const pick: DAGNode = {
    id: WRITER_PICK_NODE_ID,
    type: "http.call",
    config: { service: "features", method: "GET", path: WRITER_PICK_PATH },
    inputMapping: { "query.workflowSlug": "$ref:flow_input.workflowSlug", "query.campaignId": "$ref:flow_input.campaignId" },
    retries: 2,
  };
  const plan: DAGNode = {
    id: WRITER_PLAN_NODE_ID,
    type: "script",
    config: { code: WRITER_PLAN_CODE },
    retries: 0,
    inputMapping: { pick: `$ref:${WRITER_PICK_NODE_ID}.output` },
  };
  const head: DAGNode = {
    id: TEMPLATE_HEAD_NODE_ID,
    type: "http.call",
    config: { service: "content-generation", method: "GET", path: TEMPLATE_HEAD_PATH },
    inputMapping: { "params.slug": LEG_BEST_TEMPLATE_DYNASTY_REF },
    retries: 2,
  };
  const body = withoutKeys(gen.config?.body as Record<string, unknown> | undefined, ["type", "model"]);
  const freed: DAGNode = {
    ...gen,
    config: { ...gen.config, body },
    inputMapping: { ...gen.inputMapping, "body.type": TEMPLATE_HEAD_TYPE_REF, "body.model": LEG_BEST_MODEL_REF },
  };

  const nodes = dag.nodes.filter((n) => !MANAGED.has(n.id)).flatMap((n) => (n.id === gen.id ? [pick, plan, head, freed] : [n]));
  const seen = new Set<string>();
  const into = incoming
    .map((e) => ({ ...e, to: WRITER_PICK_NODE_ID }))
    .filter((e) => {
      const k = `${e.from}>${e.condition ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const edges = [
    ...dag.edges.filter((e) => !(MANAGED.has(e.from) || MANAGED.has(e.to) || e.to === gen.id)),
    ...into,
    { from: WRITER_PICK_NODE_ID, to: WRITER_PLAN_NODE_ID },
    { from: WRITER_PLAN_NODE_ID, to: TEMPLATE_HEAD_NODE_ID },
    { from: TEMPLATE_HEAD_NODE_ID, to: gen.id },
  ];
  return { ...dag, nodes, edges };
}

/** The DAG's content call states a template (a literal or a mapping of `body.type`). */
function statesTemplate(gen: DAGNode): boolean {
  return gen.inputMapping?.["body.type"] !== undefined || typeof (gen.config?.body as Record<string, unknown> | undefined)?.type === "string";
}

/**
 * The write-path rule (creation, upgrade, fork): a DAG whose single content call names NO template is a workflow
 * that lets its leg choose, so it is stored freed. A DAG stating one is stored as written; a DAG with no or several
 * content calls is untouched.
 */
export function freeUnstatedWriter(dag: DAG): DAG {
  const gens = dag.nodes.filter(isGenerate);
  if (gens.length !== 1 || writesWithLegBest(dag) || statesTemplate(gens[0])) return dag;
  return withLegBestWriter(dag);
}

/**
 * The generation rule: a workflow born from a description never fixes its template nor its LLM (owner 2026-10-22).
 * The generator still writes against a real template (that is how its variable mappings are checked); the stored DAG
 * is freed. A DAG with no or several content calls is untouched.
 */
export function freeGeneratedWriter(dag: DAG): DAG {
  return dag.nodes.filter(isGenerate).length === 1 ? withLegBestWriter(dag) : dag;
}
