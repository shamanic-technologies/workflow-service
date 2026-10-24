/**
 * LEDGER-HISTORY-1024 (owner 2026-10-24: every run this service ran since inception states, in the ledger, the
 * outcomes it produced and consumed, exactly as a run made today would): the PAST runs of the pipe whose leg
 * outcome this service declares besides the chat writers (`past-run-outcomes.ts`), built from the records each one
 * left, never estimated.
 *
 *  - AI Instant Call (`ai-instant-call`, live node `booking-call-outcome.ts`): a run whose twilio-service call row
 *    (parent_run_id = this run) carries a `call_sid` (Twilio accepted the call = it was PLACED, what the live node keys
 *    on) produced `booking_call` for the lead it claimed (lead-service `followup_actions` `claimed`, exactly one) and
 *    consumed `form_submitted` when the run's trigger item is a form (`answers` / `formName`, the DAG's own shape
 *    read), else `conversation` (the positive reply). A call Twilio refused (no `call_sid`) rang nobody: nothing.
 *  (The Social post pipe declares nothing here: content-generation-service declares `industry_update_video` on its own
 *  render run, the video being its object; a second declaration on the workflow run counted each video twice.)
 *
 * A run whose person cannot be named (no claimed lead, or several) is reported, never guessed. Runs that produced
 * nothing stay runs with no output: a failure is never an outcome.
 */
import { BOOKING_CALL_OUTCOME_KEY, FORM_SUBMITTED_OUTCOME_KEY, POSITIVE_REPLY_OUTCOME_KEY } from "./booking-call-outcome.js";
import { LEAD_SUBJECT_SERVICE } from "./message-written-outcome.js";
import type { OutcomesBatchRun } from "./past-run-outcomes.js";

export const INSTANT_CALL_FEATURE = "ai-instant-call";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PastLegInput {
  /** workflow-service `workflow_runs`: runs-service run id -> feature slug. */
  runFeatures: Map<string, string>;
  /** workflow-service `workflow_runs.inputs->'trigger'->'item'` per run id (absent = none). */
  runTriggerItems: Map<string, unknown>;
  /** lead-service `followup_actions` stated on the workflow runs. */
  followupActions: Array<{ runId: string; leadId: string; action: string }>;
  /** twilio-service `twilio_calls`: the run that asked for the call and whether Twilio accepted it. */
  calls: Array<{ parentRunId: string; callSid: string | null }>;
}

export interface PastLegEvidence {
  runs: OutcomesBatchRun[];
  /** Runs that produced an outcome whose subject cannot be named. */
  unnamed: Array<{ runId: string; featureSlug: string; why: string }>;
}

/** True when a trigger item is a form fill (the instant-call DAG's own shape read). */
export function isFormItem(item: unknown): boolean {
  return !!item && typeof item === "object" && ("answers" in item || "formName" in item);
}

export function pastLegEvidence(input: PastLegInput): PastLegEvidence {
  const feature = (runId: string) => input.runFeatures.get(runId.toLowerCase()) ?? input.runFeatures.get(runId);
  const runs: OutcomesBatchRun[] = [];
  const unnamed: PastLegEvidence["unnamed"] = [];

  const claimed = new Map<string, Set<string>>();
  for (const a of input.followupActions) {
    if (a.action !== "claimed") continue;
    const k = a.runId.toLowerCase();
    if (!claimed.has(k)) claimed.set(k, new Set());
    claimed.get(k)!.add(a.leadId.toLowerCase());
  }

  const placed = new Set<string>();
  for (const c of input.calls) {
    if (c.callSid && feature(c.parentRunId) === INSTANT_CALL_FEATURE) placed.add(c.parentRunId.toLowerCase());
  }
  for (const runId of [...placed].sort()) {
    const leads = claimed.get(runId);
    if (!leads || leads.size !== 1) {
      unnamed.push({ runId, featureSlug: INSTANT_CALL_FEATURE, why: `claimed ${leads?.size ?? 0} leads` });
      continue;
    }
    const subject = { subjectService: LEAD_SUBJECT_SERVICE, subjectId: [...leads][0] };
    const fromKey = isFormItem(input.runTriggerItems.get(runId)) ? FORM_SUBMITTED_OUTCOME_KEY : POSITIVE_REPLY_OUTCOME_KEY;
    runs.push({
      runId,
      occurredAt: "run_started_at",
      produced: [{ outcomeKey: BOOKING_CALL_OUTCOME_KEY, ...subject }],
      consumed: [{ outcomeKey: fromKey, ...subject }],
    });
  }

  for (const r of runs) {
    if (!UUID_RE.test(r.runId) || [...r.produced, ...r.consumed].some((o) => !UUID_RE.test(o.subjectId))) {
      throw new Error(`past-leg outcomes: run ${r.runId} names an invalid id`);
    }
  }
  return { runs, unnamed };
}
