import type { DAG, DAGEdge, DAGNode } from "./dag-validator.js";

/**
 * A lead-serving workflow must tell campaign-service when its run's audience
 * came back empty.
 *
 * campaign-service's `/end-run` contract: `stopCampaign: true` means "this run's
 * audience had nobody". It is AUDIENCE-scoped and stops nothing — campaign-service
 * marks that one audience exhausted for 24h so its bandit picks another one, and
 * rechecks a campaign with no serveable audience every 10 minutes instead of
 * every few seconds. A successful serve ends with `stopCampaign: false`.
 *
 * 221 stored DAGs (every live head of the sales cold-email dynasties included)
 * were generated with ONE `end-run` node shared by both paths: the
 * `found == false` edge out of the lead check and the edge after the send both
 * land on it, and it says `stopCampaign: false`. So an empty serve was reported
 * as a normal run, the audience was never marked, and the bandit asked the same
 * dry audience forever.
 *
 * The repair gives the empty path its own end-run: a copy of the shared node
 * (same service, path, headers, retries, inputMapping) whose body says
 * `stopCampaign: true`, and the `found == false` edge is re-pointed at it. The
 * success path is byte-identical. When the node the empty path lands on is used
 * by nothing else, its body is flipped in place instead.
 *
 * Anything that does not match this exact shape is reported and left alone —
 * a rewrite derived from a guess is worse than the gap.
 */

/** Node id given to the dedicated empty-audience end-run (the generator's own name). */
export const NO_LEAD_END_RUN_ID = "end-run-no-lead";

const LEAD_SERVE_PATH = "/orgs/buffer/next";

export type NoLeadStopPlan =
  | { action: "already-signals" }
  | { action: "flip-in-place"; fetchNodeId: string; endRunNodeId: string }
  | { action: "split"; fetchNodeId: string; sharedEndRunNodeId: string; newNodeId: string }
  | { action: "skip"; reason: string };

function isLeadServe(node: DAGNode): boolean {
  return node.type === "http.call" && node.config?.service === "lead" && node.config?.path === LEAD_SERVE_PATH;
}

function isEndRun(node: DAGNode | undefined): node is DAGNode {
  return (
    !!node &&
    node.type === "http.call" &&
    node.config?.service === "campaign" &&
    node.config?.method === "POST" &&
    typeof node.config?.path === "string" &&
    (node.config.path as string).endsWith("/end-run")
  );
}

/** `results['fetch-lead'].found == false`, whitespace- and quote-insensitive. */
function isNotFoundCondition(condition: string | undefined, fetchNodeId: string): boolean {
  if (!condition) return false;
  const c = condition.replace(/\s+/g, "").replace(/"/g, "'");
  return c === `results['${fetchNodeId}'].found==false`;
}

function body(node: DAGNode): Record<string, unknown> | undefined {
  const b = node.config?.body;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : undefined;
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function planNoLeadStopCampaign(dag: DAG): NoLeadStopPlan {
  const fetches = dag.nodes.filter(isLeadServe);
  if (fetches.length === 0) return { action: "skip", reason: "no lead serve" };
  if (fetches.length > 1) return { action: "skip", reason: `${fetches.length} lead serves` };
  const fetch = fetches[0];

  const emptyEdges = dag.edges.filter((e) => isNotFoundCondition(e.condition, fetch.id));
  if (emptyEdges.length !== 1) {
    return { action: "skip", reason: `${emptyEdges.length} '${fetch.id}.found == false' edges` };
  }
  const edge = emptyEdges[0];
  const target = dag.nodes.find((n) => n.id === edge.to);
  if (!isEndRun(target)) return { action: "skip", reason: `empty path lands on '${edge.to}', not an end-run` };

  const b = body(target);
  if (b?.stopCampaign === true) return { action: "already-signals" };
  if (b?.stopCampaign !== false) return { action: "skip", reason: `'${target.id}' body.stopCampaign is not a literal false` };
  if (target.inputMapping && Object.keys(target.inputMapping).some((k) => k === "body" || k.startsWith("body."))) {
    return { action: "skip", reason: `'${target.id}' takes its body from an inputMapping` };
  }
  if (dag.edges.some((e) => e.from === target.id)) {
    return { action: "skip", reason: `'${target.id}' has outgoing edges` };
  }
  if (dag.onError === target.id) {
    return { action: "skip", reason: `'${target.id}' is the onError handler` };
  }

  const incoming = dag.edges.filter((e) => e.to === target.id);
  if (incoming.length === 1) {
    return { action: "flip-in-place", fetchNodeId: fetch.id, endRunNodeId: target.id };
  }
  return {
    action: "split",
    fetchNodeId: fetch.id,
    sharedEndRunNodeId: target.id,
    newNodeId: uniqueId(NO_LEAD_END_RUN_ID, new Set(dag.nodes.map((n) => n.id))),
  };
}

/** Returns a new DAG; the input is never mutated. */
export function applyNoLeadStopCampaign(dag: DAG): { dag: DAG; plan: NoLeadStopPlan; changed: boolean } {
  const plan = planNoLeadStopCampaign(dag);
  if (plan.action !== "flip-in-place" && plan.action !== "split") return { dag, plan, changed: false };

  const next: DAG = structuredClone(dag);

  if (plan.action === "flip-in-place") {
    const node = next.nodes.find((n) => n.id === plan.endRunNodeId)!;
    (node.config!.body as Record<string, unknown>).stopCampaign = true;
    return { dag: next, plan, changed: true };
  }

  const shared = next.nodes.find((n) => n.id === plan.sharedEndRunNodeId)!;
  const copy: DAGNode = structuredClone(shared);
  copy.id = plan.newNodeId;
  (copy.config!.body as Record<string, unknown>).stopCampaign = true;
  // Right after the shared node, so the stored DAG reads in execution order.
  next.nodes.splice(next.nodes.indexOf(shared) + 1, 0, copy);

  const edge = next.edges.find(
    (e: DAGEdge) => e.to === plan.sharedEndRunNodeId && isNotFoundCondition(e.condition, plan.fetchNodeId),
  )!;
  edge.to = plan.newNodeId;
  return { dag: next, plan, changed: true };
}
