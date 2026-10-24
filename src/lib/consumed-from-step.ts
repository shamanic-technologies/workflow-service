/**
 * LEDGER-HISTORY-1024 (doctrine, cost-accounting skill: a run consumes the occurrence its PIPE starts from, the leg's
 * `from` step; never an invented `lead_found`): the past message-writer runs declared `lead_found` as their input on
 * every pipe (COST-BACKFILL-1023 and the live node until LEDGER-HISTORY-1024). On a pipe that starts elsewhere
 * (`conversation_to_meeting_booked`, `form_submitted_to_*`, `signup_to_*`, `start_to_*`) that input is wrong.
 *
 * runs-service takes a declaration back only WHOLE (`/outcomes/void`, final on that run), and re-declares on a new
 * run. So each wrong run is voided and its same `message_written` re-declared on a spend-free CORRECTION run (a child
 * of it, same org / campaign / workflow / brand tags, `outcome-correction` task, idempotency key per voided run),
 * dated at the original declaration, consuming the leg's `from` step on the same lead (nothing on a Start leg). The
 * voided run's spend, no longer anchored, is that pipe's loss on that day: runs-service pools it onto the same
 * workflow and campaign's occurrences of the day, the correction's included.
 */
import { LEAD_FOUND_OUTCOME_KEY, legFromStep, MESSAGE_WRITTEN_OUTCOME_KEY } from "./message-written-outcome.js";

export interface WrittenRunRow {
  runId: string;
  legKey: string | null;
  /** The lead the declaration named (produced message_written / consumed lead_found subject). */
  leadId: string;
  declaredAt: string;
}

export interface Correction {
  runId: string;
  leadId: string;
  declaredAt: string;
  fromStep: string | null;
}

/** The runs whose consumed `lead_found` is not their pipe's input, with what they consume instead. */
export function correctionsFor(rows: WrittenRunRow[]): { corrections: Correction[]; unreadable: WrittenRunRow[] } {
  const corrections: Correction[] = [];
  const unreadable: WrittenRunRow[] = [];
  for (const r of rows) {
    const from = legFromStep(r.legKey);
    if (from === undefined) {
      unreadable.push(r);
      continue;
    }
    if (from === LEAD_FOUND_OUTCOME_KEY) continue;
    corrections.push({ runId: r.runId, leadId: r.leadId, declaredAt: r.declaredAt, fromStep: from });
  }
  return { corrections, unreadable };
}

/** The correction run's declaration body (spend-free run: dated at the original declaration). */
export function correctionDeclaration(c: Correction) {
  const subject = { subjectService: "lead-service", subjectId: c.leadId };
  return {
    occurredAt: c.declaredAt,
    produced: [{ outcomeKey: MESSAGE_WRITTEN_OUTCOME_KEY, ...subject }],
    consumed: c.fromStep ? [{ outcomeKey: c.fromStep, ...subject }] : [],
  };
}

export const correctionIdempotencyKey = (runId: string) => `workflow:outcome-correction:${runId}`;
