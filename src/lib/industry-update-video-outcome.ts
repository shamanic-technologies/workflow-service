/**
 * LEDGER-HISTORY-1024 (owner 2026-10-24: every outcome this service produces is declared, today and in the past): the
 * Social post pipe (`social-post|start_to_industry_update_video`) states on runs-service's ledger the outcome its leg
 * produces, ONE `industry_update_video`, once the bulletin is out: its first post (X) is published.
 *
 * The declaring run is the workflow's own `execute-workflow` run (`flow_input.runId`), like `message_written`
 * (`message-written-outcome.ts`): the picks and the writing (chat-service), the judgments (Jev), the news scan and the
 * render are its children and declare nothing, so the whole bulletin's spend lands on the video. The subject is the
 * video itself, content-generation's `industry_debrief_videos` row (`render-start.output.id`). Consumed: nothing (a
 * Start leg). The two posts are one video: X and LinkedIn are the same occurrence.
 *
 * A run that published nothing (an idle day, a thin day, a dry run, a failed render) never reaches the node and
 * declares nothing. Never fails or slows the run: retries transport / 5xx / 429 three times, then logs
 * `DECLARATION FAILED` and returns. A replay of the same run is `already_recorded` at runs-service.
 */
import type { DAG, DAGNode } from "./dag-validator.js";

export const DECLARE_INDUSTRY_UPDATE_VIDEO_NODE_ID = "declare-industry-update-video";
export const INDUSTRY_UPDATE_VIDEO_OUTCOME_KEY = "industry_update_video";
export const VIDEO_SUBJECT_SERVICE = "content-generation";
/** The node after which the bulletin is out (the X post is published). */
export const INDUSTRY_UPDATE_VIDEO_DECLARED_AFTER = "wait-x";

/** `main(videoId, serviceEnvs, orgId, runId)`. Never throws. */
export const DECLARE_INDUSTRY_UPDATE_VIDEO_CODE = `
export async function main(videoId, serviceEnvs, orgId, runId) {
  const video = typeof videoId === "string" && videoId.trim() ? videoId.trim() : null;
  if (!video) {
    console.error("[outcomes] DECLARATION MISSING: run " + String(runId) + " published a bulletin but its video carries no id; ${INDUSTRY_UPDATE_VIDEO_OUTCOME_KEY} is not declared");
    return { declared: false, why: "no video id" };
  }
  const base = (serviceEnvs?.RUNS_SERVICE_URL ?? "").replace(/\\/$/, "");
  const key = serviceEnvs?.RUNS_SERVICE_API_KEY;
  if (!base || !key || !orgId || !runId) {
    console.error("[outcomes] DECLARATION FAILED: run " + String(runId) + " video " + video + ": runs-service url/key, org or run id missing");
    return { declared: false, why: "not configured" };
  }
  const body = { produced: [{ outcomeKey: "${INDUSTRY_UPDATE_VIDEO_OUTCOME_KEY}", subjectService: "${VIDEO_SUBJECT_SERVICE}", subjectId: video }] };
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
      if (res.ok) return { declared: true, status: res.status, videoId: video };
      last = res.status + " " + text;
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (attempt < waits.length) await new Promise((r) => setTimeout(r, waits[attempt]));
  }
  console.error("[outcomes] DECLARATION FAILED: run " + String(runId) + " video " + video + " ${INDUSTRY_UPDATE_VIDEO_OUTCOME_KEY}: " + last);
  return { declared: false, why: "runs-service refused or unreachable", error: last };
}
`.trim();

/** Splices the declaration right after `wait-x`, on its one outgoing edge. */
export function withIndustryUpdateVideoDeclaration(dag: DAG): DAG {
  const after = INDUSTRY_UPDATE_VIDEO_DECLARED_AFTER;
  const out = dag.edges.filter((e) => e.from === after);
  if (out.length !== 1 || out[0].condition) {
    throw new Error(`industry-update-video: ${after} must have exactly one unconditional outgoing edge to splice after`);
  }
  if (dag.nodes.some((n) => n.id === DECLARE_INDUSTRY_UPDATE_VIDEO_NODE_ID)) {
    throw new Error("industry-update-video: the DAG already declares its video");
  }
  const node: DAGNode = {
    id: DECLARE_INDUSTRY_UPDATE_VIDEO_NODE_ID,
    type: "script",
    config: { code: DECLARE_INDUSTRY_UPDATE_VIDEO_CODE },
    retries: 0,
    inputMapping: {
      videoId: "$ref:render-start.output.id",
      serviceEnvs: "$ref:flow_input.serviceEnvs",
      orgId: "$ref:flow_input.orgId",
      runId: "$ref:flow_input.runId",
    },
  };
  return {
    ...dag,
    nodes: [...dag.nodes, node],
    edges: dag.edges.flatMap((e) => (e === out[0] ? [{ from: after, to: node.id }, { from: node.id, to: e.to }] : [e])),
  };
}
