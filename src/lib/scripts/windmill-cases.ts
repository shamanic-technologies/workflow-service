/**
 * MIGRATE-1105 S1: real production cases for a script that takes over from an old workflow, read from what that
 * workflow's runs recorded. Windmill keeps every step of a run for 7 days (`v2_job` args + `v2_job_completed`
 * result): each call step's request and answer IS a vendor call, stated in the door vocabulary a script uses
 * (`SERVICE_DOOR_VENDORS` run doors, `llm.complete`). Generic over every workflow: no slug, step id or outcome here.
 *
 * What a case holds (gtm-factory `ReplayCase`): the run's inputs (`lead_event`: what the run was asked to do; the
 * campaign's start answer as `campaign_run`), every call in order with its request and answer, and what the run
 * stated at its end (`expect.content.end` = the end-run body, or `fails` with its error). The campaign chassis
 * (gate, start, end) is the runner's, never a script call. Script steps are the old code itself, not vendor calls.
 *
 * A run is EXCLUDED with its reason, never guessed: a call no door serves (named, so the door can be added), a step
 * the record cut (still running, no result), a run with no end statement.
 */
import { LLM_COMPLETE, SERVICE_DOOR_VENDORS } from "./vendors.js";
import type { RecordedCall, ReplayCase } from "./replay.js";

export interface RecordedFlow {
  id: string;
  createdAt: string;
  /** The flow's own input (`flow_input`). */
  args: Record<string, unknown>;
  /** Whether Windmill ended it failed, and its error. */
  failed: boolean;
  error?: string | null;
}

export interface RecordedStep {
  stepId: string;
  /** `f/nodes/http_call` for a call step; a workflow path for a script or branch step. */
  runnablePath: string;
  args: Record<string, unknown>;
  status: string | null;
  result: unknown;
}

/** Fields of a call step's args that describe the request (everything else is identity the run already holds). */
const REQUEST_FIELDS = ["params", "query", "body", "omitHeaders", "pollWhile"] as const;
const CHASSIS = new Set(["/gate-check", "/start-run", "/end-run"]);

/** The door a recorded request reached, by its producer, method and path template. */
export function doorFor(service: string, method: string, path: string): string | null {
  if (service === "chat" && method === "POST" && path === "/complete") return LLM_COMPLETE;
  for (const [name, d] of Object.entries(SERVICE_DOOR_VENDORS)) {
    if (d.asRun && d.service === service && d.method === method && d.path.replace(/\{\w+\}/g, "{}") === path.replace(/\{\w+\}/g, "{}")) return name;
  }
  return null;
}

function plain(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A tolerated failure the old step returned (`{ok: false, status, error}`), as the door answers it. */
function failedAnswer(result: Record<string, unknown>): RecordedCall["answer"] {
  const text = typeof result.error === "string" ? result.error : "";
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text);
    if (plain(parsed)) body = parsed;
  } catch {
    body = { error: text.slice(0, 300) };
  }
  const code = typeof body.code === "string" ? body.code : plain(body.details) && typeof body.details.code === "string" ? body.details.code : (typeof result.code === "string" ? result.code : null);
  return { ok: false, data: { error: String(body.error ?? `answered ${String(result.status)}`), status: result.status ?? null, code, body } };
}

/** The serviceEnvs (keys) are never copied into a case. */
function withoutSecrets(args: Record<string, unknown>): Record<string, unknown> {
  const { serviceEnvs: _drop, ...rest } = args;
  return rest;
}

export type FlowCase = { case: ReplayCase; routes: string[] } | { excluded: string };

/** One recorded run -> one case, or the reason it cannot be one. */
export function caseFromFlow(flow: RecordedFlow, steps: RecordedStep[]): FlowCase {
  const calls: RecordedCall[] = [];
  const routes: string[] = [];
  let campaignRun: Record<string, unknown> | null = null;
  let end: Record<string, unknown> | null = null;
  for (const step of steps) {
    if (!step.runnablePath.endsWith("nodes/http_call")) continue;
    if (step.status === null) return { excluded: "a step still running when it was read" };
    const service = String(step.args.service ?? "");
    const method = String(step.args.method ?? "");
    const path = String(step.args.path ?? "");
    if (step.args.skip === true) continue;
    const result = step.result;
    if (service === "campaign" && CHASSIS.has(path)) {
      if (path === "/start-run" && plain(result)) campaignRun = result;
      if (path === "/end-run") end = plain(step.args.body) ? step.args.body : {};
      continue;
    }
    if (step.status !== "success") continue; // a thrown call: the run's failure, stated by `fails`
    const name = doorFor(service, method, path);
    if (!name) return { excluded: `calls ${service} ${method} ${path}, which no door serves` };
    routes.push(name);
    if (name === LLM_COMPLETE) {
      const body = plain(step.args.body) ? step.args.body : {};
      const r = plain(result) ? result : {};
      calls.push({ name, args: body, answer: { ok: true, data: { content: r.content ?? null, json: r.json ?? null, model: r.model ?? null, tokensInput: r.tokensInput ?? null, tokensOutput: r.tokensOutput ?? null } } });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const f of REQUEST_FIELDS) {
      const v = step.args[f];
      if (v !== undefined && v !== null && !(plain(v) && Object.keys(v).length === 0 && f !== "body")) args[f] = v;
    }
    if (method === "GET") delete args.body;
    const r = plain(result) ? result : {};
    const tolerated = r.ok === false && !("skipped" in r && r.notCalled === true) && typeof r.status === "number";
    calls.push({ name, args, answer: tolerated ? failedAnswer(r) : { ok: true, data: r } });
  }
  if (!flow.failed && end === null) return { excluded: "the run states no end" };
  const units: ReplayCase["units"] = { lead_event: withoutSecrets(flow.args) };
  if (campaignRun) units.campaign_run = campaignRun;
  return {
    case: { id: flow.id, units, calls, expect: flow.failed ? { fails: String(flow.error ?? "").slice(0, 120) } : { content: { end: end! } } },
    routes,
  };
}

/** The read-only SELECT over the Windmill database: the last `days` of runs of the flows whose path names `slugLike`. */
export function windmillCasesSql(slugLike: string, days: number, max: number): string {
  if (!/^[a-z0-9_%]+$/.test(slugLike)) throw new Error("slugLike: lowercase letters, digits, _ and % only");
  const d = Math.max(1, Math.min(7, Math.floor(days)));
  const n = Math.max(1, Math.min(2000, Math.floor(max)));
  return `
WITH RECURSIVE flows AS (
  SELECT j.id, j.created_at, j.args, c.status
  FROM v2_job j JOIN v2_job_completed c ON c.id = j.id
  WHERE j.kind = 'flow' AND j.runnable_path LIKE 'f/workflows/%/${slugLike}' AND j.created_at > now() - interval '${d} days'
  ORDER BY j.created_at DESC LIMIT ${n}
), tree AS (
  SELECT f.id AS flow_id, j.id, j.created_at FROM flows f JOIN v2_job j ON j.parent_job = f.id
  UNION ALL
  SELECT t.flow_id, j.id, j.created_at FROM tree t JOIN v2_job j ON j.parent_job = t.id
)
SELECT coalesce(json_agg(r ORDER BY r.created_at), '[]') FROM (
  SELECT f.id, f.created_at, f.args - 'serviceEnvs' AS args, f.status::text AS status,
    (SELECT coalesce(json_agg(json_build_object('stepId', j.flow_step_id, 'runnablePath', j.runnable_path, 'args', j.args - 'serviceEnvs',
       'status', c.status::text, 'result', c.result) ORDER BY t.created_at), '[]')
     FROM tree t JOIN v2_job j ON j.id = t.id LEFT JOIN v2_job_completed c ON c.id = j.id WHERE t.flow_id = f.id) AS steps
  FROM flows f
) r`;
}
