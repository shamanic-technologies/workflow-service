/**
 * A workflow writes with a TEMPLATE DYNASTY, never a template version (TPL-DYNASTY-1021-WF, owner 2026-10-21): every
 * run writes with the dynasty's CURRENT head, so a template fix (a new head version in content-generation) reaches
 * every workflow on that dynasty with no new workflow version.
 *
 * content-generation owns the catalogue (`GET /internal/template-dynasties/{slug}/head` -> `{dynasty, template}`).
 * `withTemplateDynasty(dag, slug, headType)` splices ONE node into the edge running into the DAG's single
 * content-generation `/generate` call:
 *
 *   template-head (http.call content-generation GET /internal/template-dynasties/{slug}/head: a failed read throws,
 *                  nothing is written)
 *
 * and maps the call's `body.type` onto `template-head.output.template.type`, so the run sends the live head.
 * `config.body.type` keeps the head the DAG was last written against: the static base validators and readers check
 * (variables, deprecated templates, the dashboard's template label). The type a run actually used is recorded by
 * content-generation on every email (`prompt_type`).
 */
import type { DAG, DAGNode } from "./dag-validator.js";

export const TEMPLATE_HEAD_NODE_ID = "template-head";
export const TEMPLATE_HEAD_PATH = "/internal/template-dynasties/{slug}/head";
/** The run-time mapping of the content call's `body.type`. Readers treat it as "the static base is the head". */
export const TEMPLATE_HEAD_TYPE_REF = `$ref:${TEMPLATE_HEAD_NODE_ID}.output.template.type`;

const isGenerate = (n: DAGNode) => n.type === "http.call" && n.config?.service === "content-generation" && n.config?.path === "/generate";
const isHeadRead = (n: DAGNode) => n.id === TEMPLATE_HEAD_NODE_ID && n.config?.service === "content-generation" && n.config?.path === TEMPLATE_HEAD_PATH;

/**
 * True when this content call renders its template dynasty's LIVE head (TPL-DYNASTY-1021-WF3): its static
 * `config.body.type` is only the head as of the last write, so a deprecated VERSION (an "Upgraded" one included) says
 * nothing about it. Such a call stops only with the whole template dynasty (its head read fails, nothing is written).
 */
export function followsTemplateDynasty(node: DAGNode): boolean {
  return node.inputMapping?.["body.type"] === TEMPLATE_HEAD_TYPE_REF;
}

/** The template dynasty a DAG writes with, or null when it pins a template version (or writes no email). */
export function templateDynastyOf(dag: { nodes?: DAGNode[] } | null | undefined): string | null {
  const head = (dag?.nodes ?? []).find(isHeadRead);
  const slug = (head?.config?.params as Record<string, unknown> | undefined)?.slug;
  return typeof slug === "string" ? slug : null;
}

/**
 * The DAG writing with `slug`'s head. Idempotent: a DAG already reading a head is re-pointed (slug, static base),
 * never spliced twice. Throws unless the DAG has exactly one content-generation `/generate` call: a workflow is never
 * half-switched.
 */
export function withTemplateDynasty(dag: DAG, slug: string, headType: string): DAG {
  const generates = dag.nodes.filter(isGenerate);
  if (generates.length !== 1) throw new Error(`withTemplateDynasty: expected exactly one content-generation /generate call, found ${generates.length}`);
  const gen = generates[0];
  const repointed: DAGNode = {
    ...gen,
    config: { ...gen.config, body: { ...((gen.config?.body as Record<string, unknown>) ?? {}), type: headType } },
    inputMapping: { ...gen.inputMapping, "body.type": TEMPLATE_HEAD_TYPE_REF },
  };
  const head: DAGNode = {
    id: TEMPLATE_HEAD_NODE_ID,
    type: "http.call",
    config: { service: "content-generation", method: "GET", path: TEMPLATE_HEAD_PATH, params: { slug } },
    retries: 2,
  };

  if (dag.nodes.some((n) => n.id === TEMPLATE_HEAD_NODE_ID)) {
    if (!dag.edges.some((e) => e.from === TEMPLATE_HEAD_NODE_ID && e.to === gen.id)) {
      throw new Error(`withTemplateDynasty: "${TEMPLATE_HEAD_NODE_ID}" exists but does not run into "${gen.id}"`);
    }
    return { ...dag, nodes: dag.nodes.map((n) => (n.id === TEMPLATE_HEAD_NODE_ID ? head : n.id === gen.id ? repointed : n)) };
  }

  // Every edge into the content call now runs into the head read (same sources, same conditions), so the read sits
  // exactly where the call sat in the topology (same branch, same convergence), and the call follows it.
  if (!dag.edges.some((e) => e.to === gen.id)) throw new Error(`withTemplateDynasty: "${gen.id}" has no incoming edge`);
  return {
    ...dag,
    nodes: dag.nodes.flatMap((n) => (n.id === gen.id ? [head, repointed] : [n])),
    edges: [...dag.edges.map((e) => (e.to === gen.id ? { ...e, to: TEMPLATE_HEAD_NODE_ID } : e)), { from: TEMPLATE_HEAD_NODE_ID, to: gen.id }],
  };
}
