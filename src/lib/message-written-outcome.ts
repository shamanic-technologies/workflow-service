/**
 * COST-ACCOUNTING-1023-P1 (owner 2026-10-23): a workflow run that WROTE a message for one person through chat-service
 * `/complete` states it on runs-service's general ledger, so what a written message costs can be read.
 *
 * The run that declares is the workflow's own `execute-workflow` run (`flow_input.runId`). It holds no cost of its
 * own; every child that declares nothing (the chat `/complete` writer and the reading/judging calls around it) rolls
 * into it, so the whole subtree's spend lands on the message. A child that declares keeps its own cost
 * (content-generation, scraping, lead-service), so nothing is counted twice.
 *
 * Produced: `message_written`. Consumed: `lead_found`. Both name the SAME subject, the person's lead in lead-service
 * (`subjectService: "lead-service"`, the lead id), so the consumption resolves to the occurrence lead-service declared
 * when it served them. Declared only when the message was KEPT (it went out): a draft never sent rides the kept ones.
 *
 * The declaration never fails or slows the send: the node runs strictly after it, retries a transport error, a 5xx
 * or a 429 a few times, then logs loudly and returns. A replay of the same run is `already_recorded` at runs-service.
 * A sent message whose person carries no lead id is logged loudly (never an invented id).
 */
import type { DAG, DAGNode } from "./dag-validator.js";

export const DECLARE_MESSAGE_WRITTEN_NODE_ID = "declare-message-written";
export const MESSAGE_WRITTEN_OUTCOME_KEY = "message_written";
export const LEAD_FOUND_OUTCOME_KEY = "lead_found";
export const LEAD_SUBJECT_SERVICE = "lead-service";

/**
 * `main(signal, sentWhen, leadId, serviceEnvs, orgId, runId)`: kept iff `String(signal) === String(sentWhen)`.
 * Never throws: a failed declaration is the ledger's gap, never the run's failure.
 */
export const DECLARE_MESSAGE_WRITTEN_CODE = `
export async function main(signal, sentWhen, leadId, serviceEnvs, orgId, runId) {
  const kept = signal !== undefined && signal !== null && String(signal) === String(sentWhen);
  if (!kept) return { declared: false, why: "no message kept" };
  const lead = typeof leadId === "string" && leadId.trim() ? leadId.trim() : null;
  if (!lead) {
    console.error("[outcomes] DECLARATION MISSING: run " + String(runId) + " sent a written message but the person carries no lead id; message_written is not declared");
    return { declared: false, why: "no lead id" };
  }
  const base = (serviceEnvs?.RUNS_SERVICE_URL ?? "").replace(/\\/$/, "");
  const key = serviceEnvs?.RUNS_SERVICE_API_KEY;
  if (!base || !key || !orgId || !runId) {
    console.error("[outcomes] DECLARATION FAILED: run " + String(runId) + " lead " + lead + ": runs-service url/key, org or run id missing");
    return { declared: false, why: "not configured" };
  }
  const body = {
    produced: [{ outcomeKey: "${MESSAGE_WRITTEN_OUTCOME_KEY}", subjectService: "${LEAD_SUBJECT_SERVICE}", subjectId: lead }],
    consumed: [{ outcomeKey: "${LEAD_FOUND_OUTCOME_KEY}", subjectService: "${LEAD_SUBJECT_SERVICE}", subjectId: lead }],
  };
  const url = base + "/v1/runs/" + encodeURIComponent(String(runId)) + "/outcomes";
  const waits = [2000, 5000, 15000];
  let last = "";
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "x-org-id": String(orgId) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      if (res.ok) {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        return { declared: true, status: res.status, recordedCount: parsed?.recordedCount ?? null, alreadyRecordedCount: parsed?.alreadyRecordedCount ?? null };
      }
      last = res.status + " " + text;
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (attempt < waits.length) await new Promise((r) => setTimeout(r, waits[attempt]));
  }
  console.error("[outcomes] DECLARATION FAILED: run " + String(runId) + " lead " + lead + " message_written: " + last);
  return { declared: false, why: "runs-service refused or unreachable", error: last };
}
`.trim();

export interface MessageWrittenSpec {
  /** The node the declaration runs right after (exactly one outgoing edge, spliced). */
  after: string;
  /** `$ref` to the value telling a message went out. */
  signalRef: string;
  /** The value `signalRef` holds when it did (compared as strings). */
  sentWhen: string;
  /** `$ref` to the person's lead id in lead-service. */
  leadIdRef: string;
}

/** Splices the declaration right after `spec.after`, on its one outgoing edge. */
export function withMessageWrittenDeclaration(dag: DAG, spec: MessageWrittenSpec): DAG {
  const out = dag.edges.filter((e) => e.from === spec.after);
  if (out.length !== 1 || out[0].condition) {
    throw new Error(`message-written: ${spec.after} must have exactly one unconditional outgoing edge to splice after`);
  }
  if (dag.nodes.some((n) => n.id === DECLARE_MESSAGE_WRITTEN_NODE_ID)) {
    throw new Error("message-written: the DAG already declares its written message");
  }
  const node: DAGNode = {
    id: DECLARE_MESSAGE_WRITTEN_NODE_ID,
    type: "script",
    config: { code: DECLARE_MESSAGE_WRITTEN_CODE },
    retries: 0,
    inputMapping: {
      signal: spec.signalRef,
      sentWhen: spec.sentWhen,
      leadId: spec.leadIdRef,
      serviceEnvs: "$ref:flow_input.serviceEnvs",
      orgId: "$ref:flow_input.orgId",
      runId: "$ref:flow_input.runId",
    },
  };
  return {
    ...dag,
    nodes: [...dag.nodes, node],
    edges: dag.edges.flatMap((e) =>
      e === out[0] ? [{ from: spec.after, to: node.id }, { from: node.id, to: e.to }] : [e],
    ),
  };
}

/** True when a stored writer DAG does not declare its written message (seed predicate). */
export function needsMessageWrittenDeclaration(dag: { nodes?: Array<{ id?: string; config?: Record<string, unknown> }> } | null | undefined): boolean {
  const node = (dag?.nodes ?? []).find((n) => n?.id === DECLARE_MESSAGE_WRITTEN_NODE_ID);
  return !node || node.config?.code !== DECLARE_MESSAGE_WRITTEN_CODE;
}
