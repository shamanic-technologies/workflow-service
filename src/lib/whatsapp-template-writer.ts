/**
 * A CONTENT-GENERATION TEMPLATE WRITER WRITES WITH ITS PIPE'S BEST TEMPLATE DYNASTY AND BEST LLM (WA-BUBBLES-1023,
 * owner 2026-10-23: « No inline prompt left, no fixed model »; THREADS-IDEAS-AB 2026-10-31: the Threads writer too).
 *
 * The workflow holds no prompt text: content-generation-service owns the template dynasties (one per pipe) and writes
 * with the head (`POST /generate-whatsapp`, `POST /generate-thread`: renders the template from the run's variables,
 * calls the LLM with the endpoint's schema, records what wrote). features-service ranks the template dynasty and the
 * LLM per leg (`GET /internal/writer-pick`), exactly as for cold email (BEST-TPL-LLM-1022), and A/B tests the
 * dynasties of a pipe through that pick.
 *
 * `withLegBestTemplate(dag, nodeId)` splices into every edge running into the writer `nodeId` (any endpoint of
 * TEMPLATE_WRITER_PATHS, one shared code path, never a per-pipe branch):
 *
 *   writer-pick   (features-service: the leg's best template dynasty + LLM for this workflow and campaign)
 *   writer-plan   (script: both or THROW, nothing written; a run with nobody to write to plans nothing)
 *   template-head (content-generation: the picked dynasty's head version)
 *
 * and maps the writer's `body.type` on the head and `body.model` on the picked LLM. The writer's `skip` rides all
 * three, so an idle run asks nothing. Never a fallback template or model: a pick missing either is a failed run.
 */
import type { DAG, DAGNode } from "./dag-validator.js";
import { TEMPLATE_HEAD_NODE_ID, TEMPLATE_HEAD_PATH, TEMPLATE_HEAD_TYPE_REF } from "./template-dynasty.js";
import { WRITER_PICK_NODE_ID, WRITER_PICK_PATH, WRITER_PLAN_NODE_ID } from "./leg-best-writer.js";

export const GENERATE_WHATSAPP_PATH = "/generate-whatsapp";
export const GENERATE_THREAD_PATH = "/generate-thread";
export const TEMPLATE_WRITER_MODEL_REF = `$ref:${WRITER_PLAN_NODE_ID}.output.model`;
export const WHATSAPP_WRITER_MODEL_REF = TEMPLATE_WRITER_MODEL_REF;

/** content-generation's template writers, each with the name its plan uses in a "nothing to write with" error. */
export const TEMPLATE_WRITER_PATHS: Readonly<Record<string, string>> = {
  [GENERATE_WHATSAPP_PATH]: "WhatsApp template",
  [GENERATE_THREAD_PATH]: "Threads template",
};

/** The pick, read loudly: a template dynasty AND an LLM, or the run fails naming features-service's reason. */
export function templateWriterPlanCode(what: string): string {
  return `export async function main(pick, skip) {
  if (skip === true) return { skipped: true, templateDynastySlug: null, model: null };
  const leg = pick && pick.legKey ? pick.legKey : "unknown leg";
  const templateDynastySlug = pick && pick.template ? pick.template.templateDynastySlug : null;
  const model = pick && pick.llm ? pick.llm.model : null;
  if (typeof templateDynastySlug !== "string" || templateDynastySlug.length === 0) {
    throw new Error("[writer-plan] no ${what} to write with on " + leg + ": " + ((pick && pick.templateUnavailableReason) || "features-service served none") + ". Nothing is written.");
  }
  if (typeof model !== "string" || model.length === 0) {
    throw new Error("[writer-plan] no LLM to write with on " + leg + ": " + ((pick && pick.llmUnavailableReason) || "features-service served none") + ". Nothing is written.");
  }
  console.log("[writer-plan] " + leg + (pick.strategyId ? " (strategy " + pick.strategyId + ")" : "") + ": template dynasty " + templateDynastySlug + ", LLM " + model);
  return { skipped: false, templateDynastySlug, model, provider: pick.llm.provider ?? null, legKey: pick.legKey ?? null, strategyId: pick.strategyId ?? null };
}`;
}

export const WHATSAPP_WRITER_PLAN_CODE = templateWriterPlanCode(TEMPLATE_WRITER_PATHS[GENERATE_WHATSAPP_PATH]);
export const THREAD_WRITER_PLAN_CODE = templateWriterPlanCode(TEMPLATE_WRITER_PATHS[GENERATE_THREAD_PATH]);

const templateWriterPath = (n: DAGNode | undefined): string | null => {
  if (!n || n.type !== "http.call" || n.config?.service !== "content-generation") return null;
  const path = String(n.config?.path ?? "");
  return Object.prototype.hasOwnProperty.call(TEMPLATE_WRITER_PATHS, path) ? path : null;
};

/** True when the DAG's template writer `nodeId` writes with its leg's best template + LLM, picked per run. */
export function writesWithLegBestTemplate(dag: { nodes?: DAGNode[] } | null | undefined, nodeId: string): boolean {
  const nodes = dag?.nodes ?? [];
  const node = nodes.find((n) => n.id === nodeId);
  return (
    templateWriterPath(node) !== null &&
    node!.inputMapping?.["body.type"] === TEMPLATE_HEAD_TYPE_REF &&
    node!.inputMapping?.["body.model"] === TEMPLATE_WRITER_MODEL_REF &&
    nodes.some((n) => n.id === WRITER_PICK_NODE_ID)
  );
}

export function withLegBestTemplate(dag: DAG, nodeId: string): DAG {
  const node = dag.nodes.find((n) => n.id === nodeId);
  const path = templateWriterPath(node);
  if (path === null) throw new Error(`withLegBestTemplate: "${nodeId}" is not a content-generation template writer (${Object.keys(TEMPLATE_WRITER_PATHS).join(", ")})`);
  if (writesWithLegBestTemplate(dag, nodeId)) return dag;
  const managed = [WRITER_PICK_NODE_ID, WRITER_PLAN_NODE_ID, TEMPLATE_HEAD_NODE_ID];
  if (dag.nodes.some((n) => managed.includes(n.id))) throw new Error("withLegBestTemplate: the DAG already picks a writer");
  const skip: Record<string, string> = node!.inputMapping?.skip ? { skip: node!.inputMapping.skip } : {};
  const pick: DAGNode = {
    id: WRITER_PICK_NODE_ID,
    type: "http.call",
    config: { service: "features", method: "GET", path: WRITER_PICK_PATH },
    inputMapping: { "query.workflowSlug": "$ref:flow_input.workflowSlug", "query.campaignId": "$ref:flow_input.campaignId", ...skip },
    retries: 2,
  };
  const plan: DAGNode = {
    id: WRITER_PLAN_NODE_ID,
    type: "script",
    config: { code: templateWriterPlanCode(TEMPLATE_WRITER_PATHS[path]) },
    retries: 0,
    inputMapping: { pick: `$ref:${WRITER_PICK_NODE_ID}.output`, ...skip },
  };
  const head: DAGNode = {
    id: TEMPLATE_HEAD_NODE_ID,
    type: "http.call",
    config: { service: "content-generation", method: "GET", path: TEMPLATE_HEAD_PATH },
    inputMapping: { "params.slug": `$ref:${WRITER_PLAN_NODE_ID}.output.templateDynastySlug`, ...skip },
    retries: 2,
  };
  const writer: DAGNode = {
    ...node!,
    inputMapping: { ...node!.inputMapping, "body.type": TEMPLATE_HEAD_TYPE_REF, "body.model": TEMPLATE_WRITER_MODEL_REF },
  };
  return {
    ...dag,
    nodes: dag.nodes.flatMap((n) => (n.id === nodeId ? [pick, plan, head, writer] : [n])),
    edges: [
      ...dag.edges.map((e) => (e.to === nodeId ? { ...e, to: WRITER_PICK_NODE_ID } : e)),
      { from: WRITER_PICK_NODE_ID, to: WRITER_PLAN_NODE_ID },
      { from: WRITER_PLAN_NODE_ID, to: TEMPLATE_HEAD_NODE_ID },
      { from: TEMPLATE_HEAD_NODE_ID, to: nodeId },
    ],
  };
}

