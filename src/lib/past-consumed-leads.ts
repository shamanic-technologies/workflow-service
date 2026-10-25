/**
 * LEAD-STATES-1024-MEETING-WRITES (owner 2026-10-24: « compter seulement les coûts engagés avant que cet événement
 * arrive »): the past workflow runs that acted on a lead state it, after the fact, exactly as the live
 * `declare-consumed-lead` node does today (`message-written-outcome.ts`): consumed = the occurrence the run's PIPE
 * starts from (its campaign's leg `<from>_to_<to>`), on the lead it acted on, on the workflow's own `execute-workflow`
 * run, dated at the run's start. Nothing produced (a run that wrote stated its `message_written` already; a run that
 * wrote nothing produced nothing): runs-service routes the spend to that lead's next state.
 *
 * Which lead a past run acted on is read from the record the run left: lead-service `followup_actions` rows with
 * `action = 'claimed'` and `run_id` = this run (the claim hands the run its lead). Never guessed: a run with no claim
 * row, or no readable leg, is skipped and counted; a Start leg has no input occurrence. A run whose declaration was
 * voided whole refuses any new one (runs-service, final), and a support-marked run declares nothing: the export leaves
 * both out. Only the workflows whose live DAG carries the node (`CONSUMED_LEAD_FEATURES`) are back-filled; another
 * feature's run (Copilot proposals are support, cold WhatsApp / cold email are content-generation's) is skipped.
 */
import { legFromStep } from "./message-written-outcome.js";
import { batchOutcomeRuns, type OutcomesBatchRun } from "./past-run-outcomes.js";

/** The features whose live DAG carries `declare-consumed-lead` (`withConsumedLeadDeclaration` callers). */
export const CONSUMED_LEAD_FEATURES = new Set(["ai-meeting-booking", "ai-follow-up-email", "ai-instant-call"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PastActedRun {
  /** The execute-workflow run (runs-service id). */
  runId: string;
  /** The run's feature (runs-service `runs.feature_slug`): only the live node's workflows are back-filled. */
  featureSlug: string | null;
  /** Its campaign's leg (campaign-service `campaigns.leg_key`), null when the run carries no campaign. */
  legKey: string | null;
  /** The leads lead-service handed this run (`followup_actions` claimed rows). */
  leadIds: string[];
}

export interface PastConsumedLeads {
  runs: OutcomesBatchRun[];
  skipped: Array<{ runId: string; why: "not a lead-declaring workflow" | "no lead claimed" | "pipe unreadable" | "start leg" }>;
}

export function pastConsumedLeadRuns(rows: PastActedRun[]): PastConsumedLeads {
  const runs: OutcomesBatchRun[] = [];
  const skipped: PastConsumedLeads["skipped"] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const runId = r.runId.toLowerCase();
    if (seen.has(runId)) throw new Error(`past consumed leads: run ${runId} stated twice`);
    seen.add(runId);
    if (!CONSUMED_LEAD_FEATURES.has(r.featureSlug ?? "")) {
      skipped.push({ runId, why: "not a lead-declaring workflow" });
      continue;
    }
    const leads = [...new Set(r.leadIds.map((l) => l.trim().toLowerCase()).filter((l) => UUID_RE.test(l)))].sort();
    if (leads.length === 0) {
      skipped.push({ runId, why: "no lead claimed" });
      continue;
    }
    const from = legFromStep(r.legKey);
    if (from === undefined) {
      skipped.push({ runId, why: "pipe unreadable" });
      continue;
    }
    if (from === null) {
      skipped.push({ runId, why: "start leg" });
      continue;
    }
    runs.push({
      runId,
      occurredAt: "run_started_at",
      produced: [],
      consumed: leads.map((subjectId) => ({ outcomeKey: from, subjectService: "lead-service", subjectId })),
    });
  }
  runs.sort((a, b) => (a.runId < b.runId ? -1 : 1));
  return { runs, skipped };
}

/** runs-service `POST /v1/platform-runs/outcomes/batch` bodies (≤ 500 runs, ≤ 1000 occurrences per call). */
export function pastConsumedLeadBatches(rows: PastActedRun[]): { batches: Array<{ runs: OutcomesBatchRun[] }>; skipped: PastConsumedLeads["skipped"] } {
  const { runs, skipped } = pastConsumedLeadRuns(rows);
  return { batches: batchOutcomeRuns(runs), skipped };
}
