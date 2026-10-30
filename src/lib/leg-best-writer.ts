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
 * content calls is untouched. Every write path also gets the current `llm-plan` (`withCurrentLlmPlan`): a DAG cannot be
 * stored with a default writer (NO-WRITER-FALLBACK-1030).
 */
export function freeUnstatedWriter(dag: DAG): DAG {
  const current = withCurrentLlmPlan(dag);
  const gens = current.nodes.filter(isGenerate);
  if (gens.length !== 1 || writesWithLegBest(current) || statesTemplate(gens[0])) return current;
  return withLegBestWriter(current);
}

/**
 * The generation rule: a workflow born from a description never fixes its template nor its LLM (owner 2026-10-22).
 * The generator still writes against a real template (that is how its variable mappings are checked); the stored DAG
 * is freed. A DAG with no or several content calls is untouched.
 */
export function freeGeneratedWriter(dag: DAG): DAG {
  const current = withCurrentLlmPlan(dag);
  return current.nodes.filter(isGenerate).length === 1 ? withLegBestWriter(current) : current;
}

export const LLM_PICK_NODE_ID = "llm-pick";
export const LLM_PLAN_NODE_ID = "llm-plan";
export const LEG_BEST_LLM_MODEL_REF = `$ref:${LLM_PLAN_NODE_ID}.output.model`;
export const LEG_BEST_LLM_PROVIDER_REF = `$ref:${LLM_PLAN_NODE_ID}.output.provider`;

/**
 * The LLM pick for a chat-service `/complete` writer (a pipe with an LLM and no template), read loudly. A run whose
 * writer is skipped (nobody to write to) plans nothing. A pick with no LLM THROWS, whatever features-service's reason
 * (a strategy leaving none, a leg not ranked yet, anything else): nothing is written, the reason is in the run log.
 * There is no default writer (NO-WRITER-FALLBACK-1030, owner 2026-10-30: « WTF is that???? c'est une exception à notre
 * infra?????????? »): the workflow's own LLM used to write when the leg was not ranked, which ignored the per-pipe LLM
 * statuses. Returns the LLM the pick served.
 */
export const LLM_PLAN_CODE = `export async function main(pick, skip) {
  if (skip === true) return { skipped: true, provider: null, model: null, picked: false };
  const leg = pick && pick.legKey ? pick.legKey : "unknown leg";
  const l = pick ? pick.llm : null;
  if (!l || typeof l.model !== "string" || l.model.length === 0 || typeof l.provider !== "string" || l.provider.length === 0) {
    const reason = (pick && pick.llmUnavailableReason) || "features-service served none";
    throw new Error("[llm-plan] no LLM to write with on " + leg + ": " + reason + ". Nothing is written.");
  }
  console.log("[llm-plan] " + leg + (pick.strategyId ? " (strategy " + pick.strategyId + ")" : "") + ": LLM " + l.provider + "/" + l.model +
    " (place " + l.place + ", " + (l.isMature ? "mature" : "learning") + ", $" + l.spentUsd + " spent, " + l.outcomes + " outcomes)");
  return { skipped: false, provider: l.provider, model: l.model, picked: true, legKey: pick.legKey ?? null, strategyId: pick.strategyId ?? null };
}`;

/** True when the DAG carries an `llm-plan` that is not the current one (a stored DAG still holding a default writer). */
export function hasStaleLlmPlan(dag: { nodes?: DAGNode[] } | null | undefined): boolean {
  return (dag?.nodes ?? []).some((n) => n.id === LLM_PLAN_NODE_ID && n.config?.code !== LLM_PLAN_CODE);
}

/** The DAG with its `llm-plan` (if any) set to the current code: no workflow keeps a default writer. Idempotent. */
export function withCurrentLlmPlan<T extends { nodes: DAGNode[] }>(dag: T): T {
  if (!hasStaleLlmPlan(dag)) return dag;
  return { ...dag, nodes: dag.nodes.map((n) => (n.id === LLM_PLAN_NODE_ID ? { ...n, config: { ...n.config, code: LLM_PLAN_CODE } } : n)) };
}

const isComplete = (n: DAGNode) => n.type === "http.call" && n.config?.service === "chat" && n.config?.path === "/complete";

/** True when the chat writer `nodeId` writes with its leg's best LLM, picked per run. */
export function writesWithLegBestLlm(dag: { nodes?: DAGNode[] } | null | undefined, nodeId: string): boolean {
  const node = (dag?.nodes ?? []).find((n) => n.id === nodeId);
  return !!node && node.inputMapping?.["body.model"] === LEG_BEST_LLM_MODEL_REF && (dag?.nodes ?? []).some((n) => n.id === LLM_PICK_NODE_ID);
}

/**
 * The DAG whose chat-service `/complete` writer `nodeId` writes with the LLM features-service ranks best on the leg
 * (BEST-TPL-LLM-1022): `llm-pick` -> `llm-plan` spliced into every edge running into it, its static
 * `body.provider`/`body.model` replaced by the plan's (and no `temperature`, which a picked model may refuse). The
 * LLM the builder stated is DROPPED, never kept as a default (NO-WRITER-FALLBACK-1030). The writer's `skip` mapping (if any) rides both, so
 * a run with nobody to write to asks nothing. Idempotent. Only the WRITER is picked: a reading/classifying call keeps its model.
 */
export function withLegBestLlm(dag: DAG, nodeId: string): DAG {
  const node = dag.nodes.find((n) => n.id === nodeId);
  if (!node || !isComplete(node)) throw new Error(`withLegBestLlm: "${nodeId}" is not a chat-service /complete call`);
  if (writesWithLegBestLlm(dag, nodeId)) return withCurrentLlmPlan(dag);
  if (dag.nodes.some((n) => n.id === LLM_PICK_NODE_ID || n.id === LLM_PLAN_NODE_ID)) throw new Error("withLegBestLlm: the DAG already picks an LLM for another writer");
  const skip: Record<string, string> = node.inputMapping?.skip ? { skip: node.inputMapping.skip } : {};
  const pick: DAGNode = {
    id: LLM_PICK_NODE_ID,
    type: "http.call",
    config: { service: "features", method: "GET", path: WRITER_PICK_PATH },
    inputMapping: { "query.workflowSlug": "$ref:flow_input.workflowSlug", "query.campaignId": "$ref:flow_input.campaignId", ...skip },
    retries: 2,
  };
  const plan: DAGNode = {
    id: LLM_PLAN_NODE_ID,
    type: "script",
    config: { code: LLM_PLAN_CODE },
    retries: 0,
    inputMapping: { pick: `$ref:${LLM_PICK_NODE_ID}.output`, ...skip },
  };
  // `temperature` goes too: chat-service refuses it on models that take no sampling parameter, and any may be picked.
  const body = withoutKeys(node.config?.body as Record<string, unknown> | undefined, ["provider", "model", "temperature"]);
  const picked: DAGNode = {
    ...node,
    config: { ...node.config, body },
    inputMapping: { ...node.inputMapping, "body.provider": LEG_BEST_LLM_PROVIDER_REF, "body.model": LEG_BEST_LLM_MODEL_REF },
  };
  return {
    ...dag,
    nodes: dag.nodes.flatMap((n) => (n.id === nodeId ? [pick, plan, picked] : [n])),
    edges: [
      ...dag.edges.map((e) => (e.to === nodeId ? { ...e, to: LLM_PICK_NODE_ID } : e)),
      { from: LLM_PICK_NODE_ID, to: LLM_PLAN_NODE_ID },
      { from: LLM_PLAN_NODE_ID, to: nodeId },
    ],
  };
}
