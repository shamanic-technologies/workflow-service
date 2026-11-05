/**
 * MIGRATE-1105 S1: real production cases for a script that takes over from an old workflow, read from what that
 * workflow's runs recorded. Windmill keeps every step of a run for 7 days (`v2_job` args + `v2_job_completed`
 * result): each call step's request and answer IS a vendor call, stated in the door vocabulary a script uses
 * (`SERVICE_DOOR_VENDORS` run doors, `llm.complete`). Generic over every workflow: no slug, step id or outcome here.
 *
 * What a case holds (gtm-factory `ReplayCase`), in the shape the Engine runner hands a script (engine-runner.ts):
 * `request` = the campaign's start answer + the pushed `trigger` + `now` (the run's start: a script reads its clock
 * there, never `Date.now()`); `units` = the trigger as a Unit of the run's `fromOutcome` (none on a proactive run);
 * every call in order with its request and answer; what the run stated at its end (`expect.content.end` = the
 * end-run body, or `fails` with its error). The campaign chassis (gate, start, end) is the runner's, never a script
 * call. Script steps are the old code itself, not vendor calls. A converter-injected `workflowSlug` in a recorded
 * body is dropped: a script holds none.
 *
 * A run is EXCLUDED with its reason, never guessed: a call no door serves (named, so the door can be added), a step
 * the record cut (still running, no result), a run with no end statement.
 */
import { LLM_COMPLETE, SERVICE_DOOR_VENDORS, VOICE_READ, VOICE_SKILL_SLUG } from "./vendors.js";
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
  runnablePath: string | null;
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

/** A service door (not a run door) a recorded request reached, by its producer, method and path. */
function plainDoorFor(service: string, method: string, path: string): string | null {
  for (const [name, d] of Object.entries(SERVICE_DOOR_VENDORS)) if (!d.asRun && d.service === service && d.method === method && d.path === path) return name;
  return null;
}

const SCRIPT_RUN_PATH = "/orgs/scripts/run";

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

/** What a failed run is matched on: its error, else the thrown step's own message (Windmill may record no flow error). */
function failureText(flowError: string | null | undefined, thrown: string | null): string {
  const e = String(flowError ?? "").trim();
  const useful = e && e !== "failure" ? e : thrown ?? e;
  // The door's refusal is the step's message after its `METHOD service/path failed (status): ` prefix.
  const m = /failed \(\d+\): (.*)$/s.exec(useful);
  return (m ? m[1]! : useful).slice(0, 120);
}

/** The serviceEnvs (keys) are never copied into a case. */
function withoutSecrets(args: Record<string, unknown>): Record<string, unknown> {
  const { serviceEnvs: _drop, ...rest } = args;
  return rest;
}

export type FlowCase = { case: ReplayCase; routes: string[] } | { excluded: string };

/** One recorded run -> one case, or the reason it cannot be one. */
export function caseFromFlow(flow: RecordedFlow, steps: RecordedStep[], opts: { fromOutcome?: string; endAsRunner?: boolean } = {}): FlowCase {
  const calls: RecordedCall[] = [];
  const asks: Record<string, unknown>[] = [];
  const asked: Record<string, Record<string, unknown>> = {};
  const routes: string[] = [];
  let campaignRun: Record<string, unknown> | null = null;
  let end: Record<string, unknown> | null = null;
  let thrownMessage: string | null = null;
  for (const step of steps) {
    if (!(step.runnablePath ?? "").endsWith("nodes/http_call")) continue; // an inline script step has no path
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
    // A thrown call ends the run: it is recorded as the door's refusal (the script turns it into the same failure, stated
    // by `fails`), and nothing after it ran.
    const thrown = step.status !== "success";
    const thrownAnswer = (): RecordedCall["answer"] => {
      const e = plain(result) && plain(result.error) ? result.error : {};
      thrownMessage = String(e.message ?? (plain(result) ? result.error : "") ?? "failed").slice(0, 500);
      return { ok: false, data: { error: thrownMessage } };
    };
    // Our one voice, read live (`voice.read` answers its content and version, nothing else).
    if (service === "chat" && method === "GET" && path === "/internal/skills/{slug}" && plain(step.args.params) && step.args.params.slug === VOICE_SKILL_SLUG) {
      const r = plain(result) ? result : {};
      routes.push(VOICE_READ);
      calls.push({ name: VOICE_READ, answer: { ok: true, data: { content: r.content ?? null, version: typeof r.version === "number" ? r.version : null } } });
      continue;
    }
    // A stored script the old run called as a step (`POST /orgs/scripts/run`) is another Engine the script ASKS for
    // its Unit (`ctx.ask(request)` then `ctx.get(<outcome>)`): the Request recorded, the Unit = that run's answer.
    if (service === "workflow" && method === "POST" && path === SCRIPT_RUN_PATH && plain(step.args.body) && typeof step.args.body.outcome === "string") {
      if (thrown) return { excluded: "an asked Engine's script failed" };
      const { outcome, dynasty: _d, version: _v, ...request } = step.args.body;
      asks.push(request);
      asked[outcome as string] = plain(result) ? result : {};
      continue;
    }
    const plainDoor = plainDoorFor(service, method, path);
    if (plainDoor) {
      // A service door (not a run door): its fields are the request's body (or query), answered with the body.
      const fields = plain(method === "GET" ? step.args.query : step.args.body) ? ((method === "GET" ? step.args.query : step.args.body) as Record<string, unknown>) : {};
      const { workflowSlug: _slug, ...args } = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null));
      routes.push(plainDoor);
      calls.push({ name: plainDoor, args, answer: thrown ? thrownAnswer() : { ok: true, data: plain(result) ? result : {} } });
      if (thrown) break;
      continue;
    }
    const name = doorFor(service, method, path);
    if (!name) return { excluded: `calls ${service} ${method} ${path}, which no door serves` };
    routes.push(name);
    if (name === LLM_COMPLETE) {
      const { workflowSlug: _slug, ...body } = plain(step.args.body) ? step.args.body : {};
      const r = plain(result) ? result : {};
      if (thrown) {
        calls.push({ name, args: body, answer: thrownAnswer() });
        break;
      }
      calls.push({ name, args: body, answer: { ok: true, data: { content: r.content ?? null, json: r.json ?? null, model: r.model ?? null, tokensInput: r.tokensInput ?? null, tokensOutput: r.tokensOutput ?? null } } });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const f of REQUEST_FIELDS) {
      const v = step.args[f];
      if (v !== undefined && v !== null && !(plain(v) && Object.keys(v).length === 0 && f !== "body")) args[f] = v;
    }
    if (method === "GET") delete args.body;
    for (const f of ["body", "query"] as const) {
      const v = args[f];
      if (plain(v) && "workflowSlug" in v) {
        const { workflowSlug: _slug, ...rest } = v;
        args[f] = rest;
      }
    }
    // The run the producer files under, stated in the body by the old step: the door fills it with the script's run.
    const runField = (SERVICE_DOOR_VENDORS[name] as { runIdInBody?: string }).runIdInBody;
    if (runField && plain(args.body) && runField in args.body) {
      const { [runField]: _run, ...rest } = args.body;
      args.body = rest;
    }
    // Path parameters in the door's names (the old step may have named them otherwise), by position.
    if (plain(args.params)) {
      const doorNames = [...(SERVICE_DOOR_VENDORS[name]!.path.matchAll(/\{(\w+)\}/g))].map((m) => m[1]!);
      const stepNames = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
      const params = args.params;
      if (doorNames.length === stepNames.length && stepNames.some((n, i) => n !== doorNames[i])) {
        args.params = Object.fromEntries(stepNames.map((n, i) => [doorNames[i]!, params[n]]));
      }
    }
    if (thrown) {
      calls.push({ name, args, answer: thrownAnswer() });
      break;
    }
    // A run recorded before ONE-BRIEF-1105 named the campaign's text `instruction`: its request is not today's.
    if (plain(args.body) && "instruction" in args.body) return { excluded: "recorded under the retired campaign `instruction` (ONE-BRIEF-1105)" };
    const r = plain(result) ? result : {};
    const tolerated = r.ok === false && !("skipped" in r && r.notCalled === true) && typeof r.status === "number";
    calls.push({ name, args, answer: tolerated ? failedAnswer(r) : { ok: true, data: r } });
  }
  if (!flow.failed && end === null) return { excluded: "the run states no end" };
  const input = withoutSecrets(flow.args);
  const trigger = plain(input.trigger) ? input.trigger : null;
  const units: ReplayCase["units"] = { ...(trigger && opts.fromOutcome && opts.fromOutcome !== "start" ? { [opts.fromOutcome]: trigger } : {}), ...asked };
  // `runId`: the run's own id (the old flow's runs-service run), as the Engine runner states the script's run.
  const request = {
    ...(typeof input.campaignId === "string" ? { campaignId: input.campaignId } : {}),
    ...(campaignRun ?? {}),
    trigger,
    now: new Date(flow.createdAt).toISOString(),
    ...(typeof input.runId === "string" ? { runId: input.runId } : {}),
  };
  const subject = trigger && typeof trigger.leadId === "string" ? trigger.leadId : null;
  // `endAsRunner`: the run is matched by the END the Engine runner would state for the script's result (replay.ts).
  const ended = opts.endAsRunner ? { end: end! } : { content: { end: end! } };
  return {
    case: { id: flow.id, units, ...(subject ? { subject } : {}), request, ...(asks.length ? { asks } : {}), calls, expect: flow.failed ? { fails: failureText(flow.error, thrownMessage) } : ended },
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
  SELECT j.id, j.created_at, j.args, c.status, c.result #>> '{error,message}' AS error
  FROM v2_job j JOIN v2_job_completed c ON c.id = j.id
  WHERE j.kind = 'flow' AND j.runnable_path LIKE 'f/workflows/%/${slugLike}' AND j.created_at > now() - interval '${d} days'
  ORDER BY j.created_at DESC LIMIT ${n}
), tree AS (
  SELECT f.id AS flow_id, j.id, j.created_at FROM flows f JOIN v2_job j ON j.parent_job = f.id
  UNION ALL
  SELECT t.flow_id, j.id, j.created_at FROM tree t JOIN v2_job j ON j.parent_job = t.id
)
SELECT coalesce(json_agg(r ORDER BY r.created_at), '[]') FROM (
  SELECT f.id, f.created_at, f.args - 'serviceEnvs' AS args, f.status::text AS status, f.error,
    (SELECT coalesce(json_agg(json_build_object('stepId', j.flow_step_id, 'runnablePath', j.runnable_path, 'args', j.args - 'serviceEnvs',
       'status', c.status::text, 'result', c.result) ORDER BY t.created_at), '[]')
     FROM tree t JOIN v2_job j ON j.id = t.id LEFT JOIN v2_job_completed c ON c.id = j.id WHERE t.flow_id = f.id) AS steps
  FROM flows f
) r`;
}
