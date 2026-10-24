/**
 * COST-BACKFILL-1023-WORKFLOW (owner 2026-10-23: « chaque service peut rétro-engineerer pour estimer tous les coûts du
 * passé pour être à 100 % now »): the chat-writer workflow runs that ran BEFORE `declare-message-written` existed
 * (COST-ACCOUNTING-1023-P1) declare, after the fact, the message they wrote.
 *
 * Same facts as the live node (`message-written-outcome.ts`): produced `message_written`, consumed `lead_found`, both on
 * the person's lead in lead-service, on the workflow's own `execute-workflow` run; only when the message WENT OUT. The
 * past runs left no result in this service (`workflow_runs.result` holds a status, Windmill keeps jobs 7 days), so
 * "went out" is read from the records the send itself left, keyed on this run:
 *   - a child run of it declared `message_sent` on a lead (instantly-service, the email it sent);
 *   - lead-service recorded an `acted` follow-up on it (`followup_actions.run_id`, the reply was sent);
 *   - crm-service stored a `sent` WhatsApp send on a child run of it (`whatsapp_sends.run_id`) under a writer's key
 *     (never a rep alert: that one tells the brand's rep, it is not a message to the person).
 * The lead is the one that record names (the send's subject, the acted row's lead, the lead id inside the WhatsApp
 * idempotency key), else the ONE lead this run claimed; anything else is skipped and counted, never guessed.
 *
 * Cold-email workflow runs are content-generation-service's to declare (it holds the email rows: message_written on the
 * parent execute-workflow run of each past generation), so this refuses them. Runs that wrote and sent nothing (a later,
 * an escalation, a refusal) declare nothing: a failure is never an outcome, their spend stays "produced none".
 */
import { LEAD_FOUND_OUTCOME_KEY, LEAD_SUBJECT_SERVICE, MESSAGE_WRITTEN_OUTCOME_KEY } from "./message-written-outcome.js";

/** The features whose DAG itself writes the message through chat-service (the live node's callers). */
export const PAST_CHAT_WRITER_FEATURES = new Set(["ai-meeting-booking", "ai-follow-up-email", "cold-whatsapp-outreach"]);

/** WhatsApp idempotency-key prefixes of a message written TO the person (crm-service `whatsapp_sends`). */
const WRITER_WHATSAPP_PREFIXES = new Set(["cold-whatsapp-outreach", "follow-up", "ai-meeting-booking", "form-meeting-booking"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OUTCOMES_BATCH_MAX_RUNS = 500;
export const OUTCOMES_BATCH_MAX_OCCURRENCES = 1000;

export interface PastRunEvidenceInput {
  /** workflow-service `workflow_runs`: runs-service run id -> feature slug. */
  runFeatures: Map<string, string>;
  /** runs-service child runs of the workflow runs: child id -> parent (workflow) run id. */
  childParents: Map<string, string>;
  /** runs-service occurrences declared on child runs of the workflow runs. */
  childOutcomes: Array<{ parentRunId: string; direction: string; outcomeKey: string; subjectService: string; subjectId: string }>;
  /** lead-service `followup_actions` stated on the workflow runs. */
  followupActions: Array<{ runId: string; leadId: string; action: string }>;
  /** crm-service `whatsapp_sends` stored on child runs of the workflow runs. */
  whatsappSends: Array<{ runId: string; status: string; idempotencyKey: string }>;
}

export interface PastRunDeclaration {
  runId: string;
  featureSlug: string;
  leadIds: string[];
}

export interface PastRunEvidence {
  declarations: PastRunDeclaration[];
  /** WhatsApp sends whose person could not be named (no lead in the key, not exactly one claimed lead). */
  unnamed: Array<{ runId: string; idempotencyKey: string }>;
}

/** The lead a writer's WhatsApp idempotency key names, if any. */
export function leadInWhatsappKey(key: string): string | null {
  const parts = key.split(":");
  // `follow-up:<campaign>:<row>:<run>` / `follow-up:event:<event>` name no lead (the 4th segment is the RUN: reading it
  // as the lead declared a run as its own person, LEDGER-HISTORY-1024); the send's own message_sent names it instead.
  if (parts[0] === "follow-up") return null;
  const candidate = parts[1] === "event" ? undefined : parts[2];
  return candidate && UUID_RE.test(candidate) ? candidate.toLowerCase() : null;
}

/** Reads what each past chat-writer run sent, and to whom. */
export function pastRunEvidence(input: PastRunEvidenceInput): PastRunEvidence {
  const sent = new Map<string, Set<string>>();
  const claimed = new Map<string, Set<string>>();
  const unnamed: PastRunEvidence["unnamed"] = [];
  const add = (runId: string, leadId: string) => {
    if (!PAST_CHAT_WRITER_FEATURES.has(input.runFeatures.get(runId) ?? "")) return;
    if (!sent.has(runId)) sent.set(runId, new Set());
    sent.get(runId)!.add(leadId.toLowerCase());
  };

  for (const a of input.followupActions) {
    if (a.action === "claimed") {
      if (!claimed.has(a.runId)) claimed.set(a.runId, new Set());
      claimed.get(a.runId)!.add(a.leadId.toLowerCase());
    } else if (a.action === "acted") add(a.runId, a.leadId);
  }
  for (const o of input.childOutcomes) {
    if (o.direction === "produced" && o.outcomeKey === "message_sent" && o.subjectService === LEAD_SUBJECT_SERVICE) {
      add(o.parentRunId, o.subjectId);
    }
  }
  for (const w of input.whatsappSends) {
    if (w.status !== "sent") continue;
    const prefix = w.idempotencyKey.split(":")[0];
    if (!WRITER_WHATSAPP_PREFIXES.has(prefix) || w.idempotencyKey.endsWith(":rep-alert")) continue;
    const runId = input.childParents.get(w.runId);
    if (!runId) continue;
    const onlyClaimed = claimed.get(runId);
    const lead = leadInWhatsappKey(w.idempotencyKey) ?? (onlyClaimed?.size === 1 ? [...onlyClaimed][0] : null);
    if (!lead) {
      if (PAST_CHAT_WRITER_FEATURES.has(input.runFeatures.get(runId) ?? "")) unnamed.push({ runId, idempotencyKey: w.idempotencyKey });
      continue;
    }
    add(runId, lead);
  }

  const declarations = [...sent.entries()]
    .map(([runId, leads]) => ({ runId: runId.toLowerCase(), featureSlug: input.runFeatures.get(runId)!, leadIds: [...leads].sort() }))
    .sort((a, b) => (a.runId < b.runId ? -1 : 1));
  return { declarations, unnamed };
}

export interface OutcomesBatchRun {
  runId: string;
  occurredAt: "run_started_at";
  produced: Array<{ outcomeKey: string; subjectService: string; subjectId: string }>;
  consumed: Array<{ outcomeKey: string; subjectService: string; subjectId: string }>;
}

/**
 * runs-service `POST /v1/platform-runs/outcomes/batch` bodies: one key produced per run, each run once, at most 500 runs
 * and 1000 occurrences per call, dated at the run's own start (the backfill semantics: as if declared on time).
 */
export function pastRunBatches(declarations: PastRunDeclaration[]): Array<{ runs: OutcomesBatchRun[] }> {
  const seen = new Set<string>();
  const runs: OutcomesBatchRun[] = declarations.map((d) => {
    if (!PAST_CHAT_WRITER_FEATURES.has(d.featureSlug)) {
      throw new Error(`past-run outcomes: run ${d.runId} is a ${d.featureSlug} run, not a chat writer's`);
    }
    if (seen.has(d.runId)) throw new Error(`past-run outcomes: run ${d.runId} stated twice`);
    seen.add(d.runId);
    if (d.leadIds.length === 0 || d.leadIds.some((l) => !UUID_RE.test(l))) {
      throw new Error(`past-run outcomes: run ${d.runId} names no valid lead id`);
    }
    const subjects = d.leadIds.map((subjectId) => ({ subjectService: LEAD_SUBJECT_SERVICE, subjectId }));
    return {
      runId: d.runId,
      occurredAt: "run_started_at",
      produced: subjects.map((s) => ({ outcomeKey: MESSAGE_WRITTEN_OUTCOME_KEY, ...s })),
      consumed: subjects.map((s) => ({ outcomeKey: LEAD_FOUND_OUTCOME_KEY, ...s })),
    };
  });

  return batchOutcomeRuns(runs);
}

/** Splits backfill runs into batch bodies: at most 500 runs and 1000 occurrences per call, each run once. */
export function batchOutcomeRuns(runs: OutcomesBatchRun[]): Array<{ runs: OutcomesBatchRun[] }> {
  const ids = new Set<string>();
  for (const r of runs) {
    if (ids.has(r.runId)) throw new Error(`past-run outcomes: run ${r.runId} stated twice`);
    ids.add(r.runId);
    if (new Set(r.produced.map((o) => o.outcomeKey)).size > 1) {
      throw new Error(`past-run outcomes: run ${r.runId} produces several outcome keys (one run = one produced key)`);
    }
  }
  const batches: Array<{ runs: OutcomesBatchRun[] }> = [];
  let current: OutcomesBatchRun[] = [];
  let occurrences = 0;
  for (const run of runs) {
    const n = run.produced.length + run.consumed.length;
    if (n > OUTCOMES_BATCH_MAX_OCCURRENCES) throw new Error(`past-run outcomes: run ${run.runId} states ${n} occurrences`);
    if (current.length === OUTCOMES_BATCH_MAX_RUNS || occurrences + n > OUTCOMES_BATCH_MAX_OCCURRENCES) {
      batches.push({ runs: current });
      current = [];
      occurrences = 0;
    }
    current.push(run);
    occurrences += n;
  }
  if (current.length > 0) batches.push({ runs: current });
  return batches;
}
