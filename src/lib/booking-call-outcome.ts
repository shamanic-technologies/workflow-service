/**
 * COST-SUPPORT-1024-WORKFLOW (owner 2026-10-24: no cost left undeclared today): the AI Instant Call pipe
 * (`ai-instant-call|conversation_to_booking_call`, `|form_submitted_to_booking_call`) states on runs-service's ledger
 * the outcome its leg produces once the call is PLACED: `booking_call` for the person's lead.
 *
 * The declaring run is the workflow's own `execute-workflow` run (`flow_input.runId`), like `message_written`
 * (`message-written-outcome.ts`): twilio-service's call run is its child and declares nothing, so the call's cost lands
 * on the booking call. Consumed: the occurrence that made the call due, `form_submitted` for a form, else
 * `conversation` (the positive reply), on the same lead.
 *
 * Declared only on the path where `ring-rep` answered (the call was placed); a run that rang nobody declares nothing.
 * Never fails or slows the run (nothing after a placed call may fail it, or campaign-service redelivers and the rep is
 * rung twice): retries transport / 5xx / 429 three times, then logs `DECLARATION FAILED` and returns.
 */
import type { DAG, DAGNode } from "./dag-validator.js";
import { LEAD_SUBJECT_SERVICE } from "./message-written-outcome.js";

export const DECLARE_BOOKING_CALL_NODE_ID = "declare-booking-call";
export const BOOKING_CALL_OUTCOME_KEY = "booking_call";
export const FORM_SUBMITTED_OUTCOME_KEY = "form_submitted";
export const POSITIVE_REPLY_OUTCOME_KEY = "conversation";

/** `main(placed, occasion, leadId, serviceEnvs, orgId, runId)`. Never throws. */
export const DECLARE_BOOKING_CALL_CODE = `
export async function main(placed, occasion, leadId, serviceEnvs, orgId, runId) {
  if (placed !== true) return { declared: false, why: "no call placed" };
  const lead = typeof leadId === "string" && leadId.trim() ? leadId.trim() : null;
  if (!lead) {
    console.error("[outcomes] DECLARATION MISSING: run " + String(runId) + " placed a call but the person carries no lead id; ${BOOKING_CALL_OUTCOME_KEY} is not declared");
    return { declared: false, why: "no lead id" };
  }
  const base = (serviceEnvs?.RUNS_SERVICE_URL ?? "").replace(/\\/$/, "");
  const key = serviceEnvs?.RUNS_SERVICE_API_KEY;
  if (!base || !key || !orgId || !runId) {
    console.error("[outcomes] DECLARATION FAILED: run " + String(runId) + " lead " + lead + ": runs-service url/key, org or run id missing");
    return { declared: false, why: "not configured" };
  }
  const fromKey = occasion && typeof occasion === "object" ? "${FORM_SUBMITTED_OUTCOME_KEY}" : "${POSITIVE_REPLY_OUTCOME_KEY}";
  const subject = { subjectService: "${LEAD_SUBJECT_SERVICE}", subjectId: lead };
  const body = {
    produced: [{ outcomeKey: "${BOOKING_CALL_OUTCOME_KEY}", ...subject }],
    consumed: [{ outcomeKey: fromKey, ...subject }],
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
      if (res.ok) return { declared: true, status: res.status, consumed: fromKey };
      last = res.status + " " + text;
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (attempt < waits.length) await new Promise((r) => setTimeout(r, waits[attempt]));
  }
  console.error("[outcomes] DECLARATION FAILED: run " + String(runId) + " lead " + lead + " ${BOOKING_CALL_OUTCOME_KEY}: " + last);
  return { declared: false, why: "runs-service refused or unreachable", error: last };
}
`.trim();

export interface BookingCallSpec {
  /** The node the declaration runs right after (exactly one unconditional outgoing edge, spliced). */
  after: string;
  /** `$ref` that is `true` when the call was placed. */
  placedRef: string;
  /** `$ref` to the call's occasion (an object for a form, null for a reply). */
  occasionRef: string;
  /** `$ref` to the person's lead id in lead-service. */
  leadIdRef: string;
}

export function withBookingCallDeclaration(dag: DAG, spec: BookingCallSpec): DAG {
  const out = dag.edges.filter((e) => e.from === spec.after);
  if (out.length !== 1 || out[0].condition) {
    throw new Error(`booking-call: ${spec.after} must have exactly one unconditional outgoing edge to splice after`);
  }
  if (dag.nodes.some((n) => n.id === DECLARE_BOOKING_CALL_NODE_ID)) {
    throw new Error("booking-call: the DAG already declares its booking call");
  }
  const node: DAGNode = {
    id: DECLARE_BOOKING_CALL_NODE_ID,
    type: "script",
    config: { code: DECLARE_BOOKING_CALL_CODE },
    retries: 0,
    inputMapping: {
      placed: spec.placedRef,
      occasion: spec.occasionRef,
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

/** True when a stored instant-call DAG does not declare its booking call (seed predicate). */
export function needsBookingCallDeclaration(dag: { nodes?: Array<{ id?: string; config?: Record<string, unknown> }> } | null | undefined): boolean {
  const node = (dag?.nodes ?? []).find((n) => n?.id === DECLARE_BOOKING_CALL_NODE_ID);
  return !node || node.config?.code !== DECLARE_BOOKING_CALL_CODE;
}
