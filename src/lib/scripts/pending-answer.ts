/**
 * SOLO-PLAN-1125 (owner 2026-11-25): a script survives a SLOW LLM. A founder on « Claude subscription » has every LLM
 * call of their campaigns answered by their own Claude, which picks the work up about once an hour (chat-service
 * LOCAL-CLAUDE queue). chat-service then answers a call it cannot answer yet with a NAMED state carrying the job that
 * will hold the answer (`{code, jobId, retryable}`), never a vendor fallback.
 *
 * Nothing here knows WHO answers: any LLM door (chat-service `/complete`, `/orgs/judgments`, their platform twins, a
 * chat service door) that names a pending job is read the same way, for every org and every model (no per-org or
 * per-model branch). An org whose calls are answered at once never sees a pending answer: its runs are byte for byte
 * what they were.
 *
 * What a run does with it: when the run can be resumed (an Engine run, or a script asked by one: the same wait hook
 * HUMAN-VALIDATED-1124 hands down), the script WAITS (`waiting`, no worker held) and its wait row keeps the job ids, each
 * under the place of the call in the run (`<ask path><vendor>#<n>`). The campaign's next dispatch once due resumes the
 * script from its start; the same call, at the same place, names its job (`x-llm-job-id`) so chat-service answers THAT
 * job (its answer, or still pending) instead of queueing a new one. A run nothing can resume reads the refusal as
 * before.
 */
import type { VendorAnswer } from "./replay.js";

/** The named states of an LLM answer that is not there yet (chat-service LOCAL-CLAUDE). */
export const PENDING_ANSWER_CODES: ReadonlySet<string> = new Set(["local_runner_waiting", "local_runner_timeout", "answer_pending"]);
/** The header naming the job a resumed call reattaches to (chat-service answers that job, never a new one). */
export const PENDING_ANSWER_JOB_HEADER = "x-llm-job-id";
/** How long a run waits before it looks again, when the producer states no `retryAfterSeconds`. */
export const PENDING_ANSWER_RECHECK_MINUTES = 10;
/** Past this, a job still unanswered is read as the refusal it is (the script decides, as before). */
export const PENDING_ANSWER_MAX_HOURS = 24;

/** One call waiting on its answer: its place in the run, the job holding the answer, since when it waits. */
export interface PendingAnswer {
  key: string;
  jobId: string;
  since: string;
}

/** What a producer said about an answer not there yet. */
export interface PendingSignal {
  jobId: string;
  code: string;
  retryAfterSeconds: number | null;
}

/** Thrown by a production LLM door when its answer is not there yet (read by the vendor into `data.pending`). */
export class AnswerPendingError extends Error {
  constructor(readonly signal: PendingSignal, message: string) {
    super(message);
    this.name = "AnswerPendingError";
  }
}

/**
 * PURE: whether a producer's answer names an answer still to come. A named code + a job id + not `retryable: false`,
 * on a non-2xx, or a 202 stating `status: "pending"` + a job id.
 */
export function pendingOf(status: number, body: unknown): PendingSignal | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const jobId = typeof b.jobId === "string" && b.jobId.trim() ? b.jobId.trim() : null;
  if (!jobId) return null;
  const retry = typeof b.retryAfterSeconds === "number" && Number.isFinite(b.retryAfterSeconds) && b.retryAfterSeconds > 0 ? b.retryAfterSeconds : null;
  if (status === 202 && b.status === "pending") return { jobId, code: typeof b.code === "string" ? b.code : "answer_pending", retryAfterSeconds: retry };
  if (status >= 200 && status < 300) return null;
  if (typeof b.code !== "string" || !PENDING_ANSWER_CODES.has(b.code) || b.retryable === false) return null;
  return { jobId, code: b.code, retryAfterSeconds: retry };
}

/** PURE: the pending signal a vendor answer carries, if any. */
export function pendingInAnswer(answer: VendorAnswer): PendingSignal | null {
  if (answer.ok) return null;
  const p = (answer.data as Record<string, unknown>).pending as Partial<PendingSignal> | undefined;
  if (!p || typeof p.jobId !== "string" || !p.jobId) return null;
  return { jobId: p.jobId, code: typeof p.code === "string" ? p.code : "answer_pending", retryAfterSeconds: typeof p.retryAfterSeconds === "number" ? p.retryAfterSeconds : null };
}

/** PURE: the refusal a vendor answers for a pending answer (the script reads it as a refusal when it cannot wait). */
export function pendingRefusal(e: AnswerPendingError): VendorAnswer {
  return { ok: false, data: { error: e.message, code: e.signal.code, pending: e.signal } };
}

/** PURE: the days a run waits before it looks again. */
export function recheckDays(signal: PendingSignal): number {
  const seconds = signal.retryAfterSeconds ?? PENDING_ANSWER_RECHECK_MINUTES * 60;
  return Math.min(86_400, Math.max(60, seconds)) / 86_400;
}

/** PURE: whether a call that has waited since `since` may wait again at `now`. */
export function mayStillWait(since: string | undefined, now: Date): boolean {
  if (!since) return true;
  const t = Date.parse(since);
  return !Number.isFinite(t) || now.getTime() - t < PENDING_ANSWER_MAX_HOURS * 3_600_000;
}

/** PURE: the pending answers a wait keeps: the ones it resumed with, the new ones replacing any at the same place. */
export function mergePending(resumed: PendingAnswer[] | null | undefined, added: PendingAnswer[]): PendingAnswer[] {
  const byKey = new Map((resumed ?? []).map((p) => [p.key, p]));
  for (const p of added) byKey.set(p.key, p);
  return [...byKey.values()];
}

/** PURE: the stored list, read back (a row written by hand or by an older version reads as none). */
export function storedPending(v: unknown): PendingAnswer[] {
  if (!Array.isArray(v)) return [];
  return v.filter((p): p is PendingAnswer => !!p && typeof p === "object" && typeof (p as PendingAnswer).key === "string" && typeof (p as PendingAnswer).jobId === "string" && typeof (p as PendingAnswer).since === "string");
}
