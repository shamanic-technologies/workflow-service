/**
 * MIGRATE-1105 S4: prove a port on the old workflow's real runs, locally, before storing it.
 *
 *   npx tsx scripts/engine-ports/prove-port.ts sql <port>            -> the read-only Windmill SELECT (run it on the box)
 *   npx tsx scripts/engine-ports/prove-port.ts prove <port> <rows.json> -> replays every case, writes .context/ports/<port>.json
 *
 * Cases come from `caseFromFlow` (windmill-cases.ts, S0 shape). What a run stated at its end is mapped onto what the
 * Engine runner reads off a script (engine-runner.ts `endRunBodyOf`), so a case expects exactly what the runner would
 * state again: idle (`noWorkAvailable`) = the script made nothing; `personNotAdmitted {reason}` = unmade
 * `person_not_admitted: <reason>`; `delivery` refused = unmade `<code>...`; a normal run = the Unit it made. The JSON
 * written holds real data: it stays in `.context/` (gitignored) and goes to `script_cases`, never to git.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { caseFromFlow, doorFor, windmillCasesSql, type RecordedFlow, type RecordedStep } from "../../src/lib/scripts/windmill-cases.js";
import { replayAll, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { buildThreadsPostSource, THREADS_POST_DYNASTY, THREADS_POST_OUTCOME, THREADS_POST_TACTICS } from "./threads-post.js";
import { buildEmailSendingSource, EMAIL_SENDING_DYNASTY, EMAIL_SENDING_OUTCOME, EMAIL_SENDING_TACTICS } from "./email-sending.js";
import { AI_LEAD_PROPOSAL_DYNASTY, AI_LEAD_PROPOSAL_OUTCOME, AI_LEAD_PROPOSAL_TACTICS, buildAiLeadProposalSource } from "./ai-lead-proposal.js";
import { buildFounderHelloSource, FOUNDER_HELLO_DYNASTY, FOUNDER_HELLO_OUTCOME, FOUNDER_HELLO_TACTICS } from "./founder-hello.js";
import {
  AI_INSTANT_CALL_DYNASTY,
  AI_INSTANT_CALL_EMAIL_ONLY_DYNASTY,
  AI_INSTANT_CALL_EMAIL_ONLY_PORT_DESCRIPTION,
  AI_INSTANT_CALL_OUTCOME,
  AI_INSTANT_CALL_PORT_DESCRIPTION,
  AI_INSTANT_CALL_TACTICS,
  buildAiInstantCallSource,
  NO_REP_UNMADE,
} from "./ai-instant-call.js";
import { NO_SALES_REP_PHONE_REASON } from "./ai-instant-call-steps.js";

interface Port {
  outcome: string;
  dynasty: string;
  tactics: Record<string, unknown>;
  /** The step the old campaigns start from ("start" = proactive). */
  fromOutcome: string;
  /** Text only an older step version carried (before a converter change): such a run is excluded, named. */
  staleMarkers?: string[];
  /** The old step whose result `now` was the run's clock (else the flow's start). */
  nowFromStep?: string;
  /** Windmill flow paths of the old workflow (`f/workflows/<org>/<slug>`). */
  flows: string;
  build(): string;
  description: string;
  /**
   * Steps of the old run whose work the Engine runner does now (the lead it consumed, read off its campaign): dropped
   * from the case before it is read, named here, never matched by a call the script would not need.
   */
  runnerSteps?: string[];
  /** Only the runs of these old workflow dynasties (`flow_input.workflowSlug` = `<dynasty>[-vN]`); absent = every run of `flows`. */
  dynasties?: string[];
  /** A run that ended `success` with no Unit, read as the `unmade` the script states (the stop row's reason). */
  unmadeWhenStopped?: Record<string, string>;
}

export const PORTS: Record<string, Port> = {
  "threads-post": {
    outcome: THREADS_POST_OUTCOME,
    dynasty: THREADS_POST_DYNASTY,
    tactics: THREADS_POST_TACTICS,
    fromOutcome: "start",
    nowFromStep: "plan_run",
    // Before ONE-BRIEF-1105 (2026-11-05) the brief rode the writer's context under this header; now it is body.brief.
    staleMarkers: ["THE BRAND'S INSTRUCTION FOR THESE THREADS"],
    flows: "threads_post_maasym_v5",
    build: buildThreadsPostSource,
    description: "Publishes one Threads thread (a main post and two or three replies) on the brand's next Pro (AI) Threads account, at least an hour after its last one, during the day, written from the brand's own facts. Ported from the Threads posts workflow.",
  },
  "email-sending": {
    outcome: EMAIL_SENDING_OUTCOME,
    dynasty: EMAIL_SENDING_DYNASTY,
    tactics: EMAIL_SENDING_TACTICS,
    fromOutcome: "start",
    flows: "email_sending_%",
    build: buildEmailSendingSource,
    description: "Sends the email a client pushed through the API, exactly as written, to the person it names, from our inboxes. Ported from the Email Sending workflow.",
  },
  "ai-lead-proposal": {
    outcome: AI_LEAD_PROPOSAL_OUTCOME,
    dynasty: AI_LEAD_PROPOSAL_DYNASTY,
    tactics: AI_LEAD_PROPOSAL_TACTICS,
    fromOutcome: "start",
    flows: "ai_lead_proposal_%",
    build: buildAiLeadProposalSource,
    description: "When a lead of the brand wants to do business, asks the brand's Copilot to tell the brand's team (who they are, what they wrote, one proposal); sends nothing to the person. Leads only. Ported from the AI Lead Proposal workflow.",
  },
  "founder-hello": {
    outcome: FOUNDER_HELLO_OUTCOME,
    dynasty: FOUNDER_HELLO_DYNASTY,
    tactics: FOUNDER_HELLO_TACTICS,
    fromOutcome: "start",
    flows: "founder_hello_%",
    build: buildFounderHelloSource,
    description: "Says hello once on WhatsApp from the founder's line to a person who just set up the product, naming what they set up, then hands them to the assistant line. Ported from the Founder hello workflow.",
  },
  // MIGRATE-1105 S1b: the default copy serves both legs (a positive reply and a form fill ring the rep the same way).
  "ai-instant-call": {
    outcome: AI_INSTANT_CALL_OUTCOME,
    dynasty: AI_INSTANT_CALL_DYNASTY,
    tactics: AI_INSTANT_CALL_TACTICS,
    fromOutcome: "start",
    flows: "ai_instant_call_%",
    build: () => buildAiInstantCallSource(),
    description: AI_INSTANT_CALL_PORT_DESCRIPTION,
    runnerSteps: ["pipe_of_run"],
    unmadeWhenStopped: { [NO_SALES_REP_PHONE_REASON]: NO_REP_UNMADE },
    dynasties: ["ai-instant-call-titawin", "ai-instant-call-belenos"],
  },
  "ai-instant-call-email-replies": {
    outcome: AI_INSTANT_CALL_OUTCOME,
    dynasty: AI_INSTANT_CALL_EMAIL_ONLY_DYNASTY,
    tactics: AI_INSTANT_CALL_TACTICS,
    fromOutcome: "start",
    flows: "ai_instant_call_%",
    build: () => buildAiInstantCallSource({ emailRepliesOnly: true }),
    description: AI_INSTANT_CALL_EMAIL_ONLY_PORT_DESCRIPTION,
    runnerSteps: ["pipe_of_run"],
    unmadeWhenStopped: { [NO_SALES_REP_PHONE_REASON]: NO_REP_UNMADE },
    dynasties: ["ai-instant-call-alsciaukat"],
  },
};

/** What a run stated at its end, as the expectation the Engine runner's reading of a script gives back. */
export function expectFromEnd(c: ReplayCase): ReplayCase["expect"] {
  const end = (c.expect.content as { end?: Record<string, unknown> } | undefined)?.end;
  if (!end) return c.expect;
  if (end.noWorkAvailable === true) return { nothing: true };
  const pna = end.personNotAdmitted as { reason?: unknown } | undefined;
  if (pna) return { fails: `person_not_admitted: ${String(pna.reason ?? "")}` };
  const delivery = end.delivery as { state?: unknown; code?: unknown } | undefined;
  if (delivery?.state === "refused") return { fails: String(delivery.code ?? "") };
  if (end.success === false) return { fails: "" };
  return { content: { end } };
}

async function main() {
  const [cmd, name, file] = process.argv.slice(2);
  const port = PORTS[name ?? ""];
  if (!port) throw new Error(`port: one of ${Object.keys(PORTS).join(", ")}`);
  if (cmd === "sql") {
    process.stdout.write(windmillCasesSql(port.flows, 7, 1000).trim().replace(/\s+/g, " "));
    return;
  }
  if (cmd !== "prove" || !file) throw new Error("usage: sql <port> | prove <port> <rows.json>");
  const rows = JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string; created_at: string; args: Record<string, unknown>; status: string; steps: RecordedStep[] }>;
  const cases: ReplayCase[] = [];
  const excluded = new Map<string, number>();
  for (const r of rows) {
    const slug = String((r.args as { workflowSlug?: unknown }).workflowSlug ?? "");
    if (port.dynasties && !port.dynasties.some((d) => slug === d || new RegExp(`^${d}-v\\d+$`).test(slug))) continue;
    // The gate refused the run (Windmill `skipped` after `/gate-check` allowed false): the runner's chassis, not the script.
    if (r.status === "skipped") {
      excluded.set("gate refused the run (chassis)", (excluded.get("gate refused the run (chassis)") ?? 0) + 1);
      continue;
    }
    // A branch container step records no runnable path: never a call.
    r.steps = (r.steps ?? []).map((st) => ({ ...st, runnablePath: st.runnablePath ?? "" }));
    if (port.runnerSteps) r.steps = r.steps.filter((st) => !port.runnerSteps!.includes(st.stepId));
    const flow: RecordedFlow = { id: r.id, createdAt: r.created_at, args: r.args ?? {}, failed: r.status !== "success", error: null };
    if (flow.failed) {
      const failedStep = [...(r.steps ?? [])].reverse().find((s) => s.status === "failure");
      const err = (failedStep?.result as { error?: { message?: string } } | null)?.error?.message ?? "";
      flow.error = err;
    }
    const out = caseFromFlow(flow, r.steps ?? [], { fromOutcome: port.fromOutcome });
    if ("excluded" in out) {
      excluded.set(out.excluded, (excluded.get(out.excluded) ?? 0) + 1);
      continue;
    }
    // A run that died on a call: the record keeps the call with its failing answer, so the script dies on it too.
    const lastFailure = flow.failed ? [...(r.steps ?? [])].reverse().find((s) => s.status === "failure") : undefined;
    const failedCall = lastFailure?.runnablePath.endsWith("nodes/http_call") ? lastFailure : undefined;
    const door = failedCall ? doorFor(String(failedCall.args.service ?? ""), String(failedCall.args.method ?? ""), String(failedCall.args.path ?? "")) : null;
    if (failedCall && door) out.case.calls.push({ name: door, answer: { ok: false, data: { error: flow.error ?? "failed", status: null, code: null, body: {} } } });
    // A run of the same version under an OLDER step text (a converter injection since changed) proves nothing about
    // the code stored now: excluded with its reason, never matched by bending the port.
    const stale = (port.staleMarkers ?? []).find((m) => JSON.stringify(out.case.calls).includes(m));
    if (stale) {
      excluded.set(`ran an older step text ("${stale}")`, (excluded.get(`ran an older step text ("${stale}")`) ?? 0) + 1);
      continue;
    }
    if (port.nowFromStep) {
      const clock = (r.steps.find((st) => st.stepId === port.nowFromStep)?.result as { now?: unknown } | null)?.now;
      if (typeof clock === "string") out.case.request = { ...(out.case.request ?? {}), now: clock };
    }
    let expect = expectFromEnd(out.case);
    const stopped = [...out.case.calls].reverse().find((c) => c.name === "lead.followup.record");
    const stopReason = String(((stopped?.args as { body?: { reason?: unknown } } | undefined)?.body?.reason) ?? "");
    if (port.unmadeWhenStopped?.[stopReason] && expect.content) expect = { fails: port.unmadeWhenStopped[stopReason]! };
    cases.push({ ...out.case, expect });
  }
  const source = port.build();
  const summary = await replayAll(source, cases);
  console.log(`${name}: ${summary.matches}/${summary.cases} cases replay; excluded ${[...excluded].map(([k, n]) => `${n} x ${k}`).join("; ") || "none"}`);
  for (const f of summary.failures.slice(0, 8)) console.log(`  ${f.id}: ${f.diffs.slice(0, 3).join(" || ").slice(0, 600)}`);
  mkdirSync(".context/ports", { recursive: true });
  writeFileSync(`.context/ports/${name}.json`, JSON.stringify({ outcome: port.outcome, dynasty: port.dynasty, tactics: port.tactics, description: port.description, code: source, cases, matches: summary.matches }));
}

if (process.argv[1]?.endsWith("prove-port.ts")) main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
