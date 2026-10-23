/**
 * THE COLD WHATSAPP WRITER WRITES WITH ITS PIPE'S BEST WHATSAPP TEMPLATE AND BEST LLM (WA-BUBBLES-1023, owner
 * 2026-10-23: the Cold WhatsApp pipes are built like Dotterel, « No inline prompt left, no fixed model »).
 *
 * The workflow holds no prompt text: content-generation-service owns the WhatsApp template dynasties (one per pipe)
 * and writes with the head (`POST /generate-whatsapp`: renders the template from the run's variables, adds our
 * client-comms voice, calls the LLM with the decision schema, records what wrote). features-service ranks the
 * template dynasty and the LLM per leg (`GET /internal/writer-pick`), exactly as for cold email (BEST-TPL-LLM-1022).
 *
 * `withLegBestWhatsappTemplate(dag, nodeId)` splices into every edge running into the writer `nodeId`:
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
export const WHATSAPP_WRITER_MODEL_REF = `$ref:${WRITER_PLAN_NODE_ID}.output.model`;

/** The pick, read loudly: a template dynasty AND an LLM, or the run fails naming features-service's reason. */
export const WHATSAPP_WRITER_PLAN_CODE = `export async function main(pick, skip) {
  if (skip === true) return { skipped: true, templateDynastySlug: null, model: null };
  const leg = pick && pick.legKey ? pick.legKey : "unknown leg";
  const templateDynastySlug = pick && pick.template ? pick.template.templateDynastySlug : null;
  const model = pick && pick.llm ? pick.llm.model : null;
  if (typeof templateDynastySlug !== "string" || templateDynastySlug.length === 0) {
    throw new Error("[writer-plan] no WhatsApp template to write with on " + leg + ": " + ((pick && pick.templateUnavailableReason) || "features-service served none") + ". Nothing is written.");
  }
  if (typeof model !== "string" || model.length === 0) {
    throw new Error("[writer-plan] no LLM to write with on " + leg + ": " + ((pick && pick.llmUnavailableReason) || "features-service served none") + ". Nothing is written.");
  }
  console.log("[writer-plan] " + leg + (pick.strategyId ? " (strategy " + pick.strategyId + ")" : "") + ": template dynasty " + templateDynastySlug + ", LLM " + model);
  return { skipped: false, templateDynastySlug, model, provider: pick.llm.provider ?? null, legKey: pick.legKey ?? null, strategyId: pick.strategyId ?? null };
}`;

const isWhatsappWriter = (n: DAGNode | undefined): boolean =>
  !!n && n.type === "http.call" && n.config?.service === "content-generation" && n.config?.path === GENERATE_WHATSAPP_PATH;

/** True when the DAG's WhatsApp writer `nodeId` writes with its leg's best template + LLM, picked per run. */
export function writesWithLegBestWhatsappTemplate(dag: { nodes?: DAGNode[] } | null | undefined, nodeId: string): boolean {
  const nodes = dag?.nodes ?? [];
  const node = nodes.find((n) => n.id === nodeId);
  return (
    isWhatsappWriter(node) &&
    node!.inputMapping?.["body.type"] === TEMPLATE_HEAD_TYPE_REF &&
    node!.inputMapping?.["body.model"] === WHATSAPP_WRITER_MODEL_REF &&
    nodes.some((n) => n.id === WRITER_PICK_NODE_ID)
  );
}

export function withLegBestWhatsappTemplate(dag: DAG, nodeId: string): DAG {
  const node = dag.nodes.find((n) => n.id === nodeId);
  if (!isWhatsappWriter(node)) throw new Error(`withLegBestWhatsappTemplate: "${nodeId}" is not a content-generation ${GENERATE_WHATSAPP_PATH} call`);
  if (writesWithLegBestWhatsappTemplate(dag, nodeId)) return dag;
  const managed = [WRITER_PICK_NODE_ID, WRITER_PLAN_NODE_ID, TEMPLATE_HEAD_NODE_ID];
  if (dag.nodes.some((n) => managed.includes(n.id))) throw new Error("withLegBestWhatsappTemplate: the DAG already picks a writer");
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
    config: { code: WHATSAPP_WRITER_PLAN_CODE },
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
    inputMapping: { ...node!.inputMapping, "body.type": TEMPLATE_HEAD_TYPE_REF, "body.model": WHATSAPP_WRITER_MODEL_REF },
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
