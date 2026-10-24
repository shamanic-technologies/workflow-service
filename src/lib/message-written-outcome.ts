/**
 * COST-ACCOUNTING-1023-P1 (owner 2026-10-23): a workflow run that WROTE a message for one person through chat-service
 * `/complete` states it on runs-service's general ledger, so what a written message costs can be read.
 *
 * The run that declares is the workflow's own `execute-workflow` run (`flow_input.runId`). It holds no cost of its
 * own; every child that declares nothing (the chat `/complete` writer and the reading/judging calls around it) rolls
 * into it, so the whole subtree's spend lands on the message. A child that declares keeps its own cost
 * (content-generation, scraping, lead-service), so nothing is counted twice.
 *
 * Produced: `message_written`. Consumed: the occurrence the run's PIPE starts from (LEDGER-HISTORY-1024 doctrine: a run
 * consumes its leg's `from` step, never an invented `lead_found`): the run's own campaign states its leg
 * (campaign-service `GET /campaigns/{id}` -> `campaign.legKey`, `<from>_to_<to>`), so a reply answered on
 * `conversation_to_meeting_booked` consumes the `conversation`, a served lead on `lead_found_to_conversation` the
 * `lead_found`, and a Start leg (`start_to_*`) consumes nothing. Both name the SAME subject, the person's lead in
 * lead-service (`subjectService: "lead-service"`, the lead id). A leg that cannot be read declares NOTHING (logged
 * loudly): never a guessed input. Declared only when the message was KEPT (it went out): a draft never sent rides the
 * kept ones.
 *
 * The declaration never fails or slows the send: the node runs strictly after it, retries a transport error, a 5xx
 * or a 429 a few times, then logs loudly and returns. A replay of the same run is `already_recorded` at runs-service.
 * A sent message whose person carries no lead id is logged loudly (never an invented id).
 */
import type { DAG, DAGNode } from "./dag-validator.js";

export const DECLARE_MESSAGE_WRITTEN_NODE_ID = "declare-message-written";
/** Reads the run's own campaign, whose `legKey` names the pipe (and so the occurrence it consumes). */
export const PIPE_OF_RUN_NODE_ID = "pipe-of-run";
export const MESSAGE_WRITTEN_OUTCOME_KEY = "message_written";
export const LEAD_FOUND_OUTCOME_KEY = "lead_found";
export const LEAD_SUBJECT_SERVICE = "lead-service";

/** The step a leg starts from (`conversation_to_meeting_booked` -> `conversation`); `start` = no input occurrence. */
export function legFromStep(legKey: unknown): string | null | undefined {
  if (typeof legKey !== "string" || !legKey.includes("_to_")) return undefined;
  const from = legKey.slice(0, legKey.indexOf("_to_"));
  return from === "start" ? null : from;
}

/**
 * `main(signal, sentWhen, leadId, campaignRead, serviceEnvs, orgId, runId)`: kept iff `String(signal) === String(sentWhen)`.
 * Never throws: a failed declaration is the ledger's gap, never the run's failure.
 */
export const DECLARE_MESSAGE_WRITTEN_CODE = `
export async function main(signal, sentWhen, leadId, campaignRead, serviceEnvs, orgId, runId) {
  const kept = signal !== undefined && signal !== null && String(signal) === String(sentWhen);
  if (!kept) return { declared: false, why: "no message kept" };
  const lead = typeof leadId === "string" && leadId.trim() ? leadId.trim() : null;
  if (!lead) {
    console.error("[outcomes] DECLARATION MISSING: run " + String(runId) + " sent a written message but the person carries no lead id; message_written is not declared");
    return { declared: false, why: "no lead id" };
  }
  const legKey = campaignRead?.campaign?.legKey;
  // legFromStep, inline: "<from>_to_<to>" -> from; "start" -> null (no input); anything else -> undefined.
  const cut = typeof legKey === "string" ? legKey.indexOf("_to_") : -1;
  const fromStep = cut <= 0 ? undefined : legKey.slice(0, cut) === "start" ? null : legKey.slice(0, cut);
  if (fromStep === undefined) {
    console.error("[outcomes] DECLARATION FAILED: run " + String(runId) + " lead " + lead + ": the run's pipe is unreadable (campaign legKey " + JSON.stringify(legKey ?? null) + "); message_written is not declared");
    return { declared: false, why: "pipe unreadable" };
  }
  const base = (serviceEnvs?.RUNS_SERVICE_URL ?? "").replace(/\\/$/, "");
  const key = serviceEnvs?.RUNS_SERVICE_API_KEY;
  if (!base || !key || !orgId || !runId) {
    console.error("[outcomes] DECLARATION FAILED: run " + String(runId) + " lead " + lead + ": runs-service url/key, org or run id missing");
    return { declared: false, why: "not configured" };
  }
  const subject = { subjectService: "${LEAD_SUBJECT_SERVICE}", subjectId: lead };
  const body = {
    produced: [{ outcomeKey: "${MESSAGE_WRITTEN_OUTCOME_KEY}", ...subject }],
    consumed: fromStep ? [{ outcomeKey: fromStep, ...subject }] : [],
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
  // The run's pipe: its own campaign's leg (tolerated: an unreadable leg declares nothing, logged by the node after).
  const pipe: DAGNode = {
    id: PIPE_OF_RUN_NODE_ID,
    type: "http.call",
    config: { service: "campaign", method: "GET", path: "/campaigns/{id}", tolerateFailure: true },
    retries: 2,
    inputMapping: { "params.id": "$ref:flow_input.campaignId" },
  };
  const node: DAGNode = {
    id: DECLARE_MESSAGE_WRITTEN_NODE_ID,
    type: "script",
    config: { code: DECLARE_MESSAGE_WRITTEN_CODE },
    retries: 0,
    inputMapping: {
      signal: spec.signalRef,
      sentWhen: spec.sentWhen,
      leadId: spec.leadIdRef,
      campaignRead: `$ref:${PIPE_OF_RUN_NODE_ID}.output`,
      serviceEnvs: "$ref:flow_input.serviceEnvs",
      orgId: "$ref:flow_input.orgId",
      runId: "$ref:flow_input.runId",
    },
  };
  return {
    ...dag,
    nodes: [...dag.nodes, pipe, node],
    edges: dag.edges.flatMap((e) =>
      e === out[0]
        ? [{ from: spec.after, to: pipe.id }, { from: pipe.id, to: node.id }, { from: node.id, to: e.to }]
        : [e],
    ),
  };
}

/** True when a stored writer DAG does not declare its written message (seed predicate). */
export function needsMessageWrittenDeclaration(dag: { nodes?: Array<{ id?: string; config?: Record<string, unknown> }> } | null | undefined): boolean {
  const node = (dag?.nodes ?? []).find((n) => n?.id === DECLARE_MESSAGE_WRITTEN_NODE_ID);
  return !node || node.config?.code !== DECLARE_MESSAGE_WRITTEN_CODE;
}
