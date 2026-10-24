/**
 * LEDGER-HISTORY-1024 (cost-accounting doctrine: spend that produces no outcome BY DESIGN is marked support, naming
 * its function): a workflow whose run serves a support function states it on runs-service's ledger, on its own
 * `execute-workflow` run (`flow_input.runId`), through the OWNER door `POST /v1/platform-runs/support-marks/apply`
 * (x-service-name = this service, the runs' owner). The mark covers the run's whole subtree that declares nothing, so
 * the children's spend (the Copilot turn, the reads) stops there instead of reading "undeclared".
 *
 * The same statement as an outcome declaration, for a run that by design produces none: a DAG declares what its run
 * produced OR which support it served, never both (runs-service refuses a mark on a declaring run). Never fails or
 * slows the run: retries transport / 5xx / 429 three times, then logs `SUPPORT MARK FAILED` and returns. Idempotent
 * at runs-service (an already marked run is counted, never re-marked).
 */
import type { DAG, DAGNode } from "./dag-validator.js";

export const MARK_SUPPORT_NODE_ID = "mark-support";
export const WORKFLOW_RUNS_SERVICE_NAME = "workflow";

/** runs-service's support functions (`SUPPORT_FUNCTIONS`) this service's runs serve. */
export type WorkflowSupportFunction = "copilot";

/** `main(kind, reason, markedBy, serviceEnvs, runId)`. Never throws. */
export const MARK_SUPPORT_CODE = `
export async function main(kind, reason, markedBy, serviceEnvs, runId) {
  const base = (serviceEnvs?.RUNS_SERVICE_URL ?? "").replace(/\\/$/, "");
  const key = serviceEnvs?.RUNS_SERVICE_API_KEY;
  if (!base || !key || !runId) {
    console.error("[outcomes] SUPPORT MARK FAILED: run " + String(runId) + " " + String(kind) + ": runs-service url/key or run id missing");
    return { marked: false, why: "not configured" };
  }
  const body = { kind, reason, markedBy, runIds: [String(runId)] };
  const waits = [2000, 5000, 15000];
  let last = "";
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    try {
      const res = await fetch(base + "/v1/platform-runs/support-marks/apply", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "x-service-name": "${WORKFLOW_RUNS_SERVICE_NAME}" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      if (res.ok) return { marked: true, status: res.status, kind };
      last = res.status + " " + text;
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (attempt < waits.length) await new Promise((r) => setTimeout(r, waits[attempt]));
  }
  console.error("[outcomes] SUPPORT MARK FAILED: run " + String(runId) + " " + String(kind) + ": " + last);
  return { marked: false, why: "runs-service refused or unreachable", error: last };
}
`.trim();

export interface SupportMarkSpec {
  /** The node the mark runs right after (exactly one unconditional outgoing edge, spliced). */
  after: string;
  kind: WorkflowSupportFunction;
  /** Why this run produces no outcome by design (stored with the mark). */
  reason: string;
  /** Who decided (stored with the mark). */
  markedBy: string;
}

export function withSupportMark(dag: DAG, spec: SupportMarkSpec): DAG {
  const out = dag.edges.filter((e) => e.from === spec.after);
  if (out.length !== 1 || out[0].condition) {
    throw new Error(`support-mark: ${spec.after} must have exactly one unconditional outgoing edge to splice after`);
  }
  if (dag.nodes.some((n) => n.id === MARK_SUPPORT_NODE_ID)) throw new Error("support-mark: the DAG already marks its run");
  const node: DAGNode = {
    id: MARK_SUPPORT_NODE_ID,
    type: "script",
    config: { code: MARK_SUPPORT_CODE },
    retries: 0,
    inputMapping: {
      kind: spec.kind,
      reason: spec.reason,
      markedBy: spec.markedBy,
      serviceEnvs: "$ref:flow_input.serviceEnvs",
      runId: "$ref:flow_input.runId",
    },
  };
  return {
    ...dag,
    nodes: [...dag.nodes, node],
    edges: dag.edges.flatMap((e) => (e === out[0] ? [{ from: spec.after, to: node.id }, { from: node.id, to: e.to }] : [e])),
  };
}
