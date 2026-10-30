/**
 * The STEP a failed workflow run failed at (INCIDENT 2026-10-30, FACTORY-P3): a flow's own result names nothing
 * (`{"status":"failed"}`) when the failure sits inside a branch sub-flow, so the run alone cannot tell a writer step
 * failing from a send step failing on a vendor outage. Walk the Windmill flow status down the `Failure` modules to the
 * leaf step; its id is stored on the run (`workflow_runs.failed_step`, + the leaf's error message) so the script guard
 * judges a switch only on failures at the steps the switch changed (a Primeforge outage at the send step never counts).
 */
import type { WindmillJob } from "./windmill-client.js";

const MAX_DEPTH = 5;

interface FailureModule {
  id?: unknown;
  job?: unknown;
  type?: unknown;
}

function failureModule(job: WindmillJob): FailureModule | null {
  const status = (job.flow_status ?? null) as { modules?: FailureModule[]; failure_module?: FailureModule } | null;
  const failed = (status?.modules ?? []).find((m) => m?.type === "Failure");
  return failed ?? null;
}

function messageOf(job: WindmillJob | null): string | null {
  const r = (job?.result ?? null) as { error?: { message?: unknown } } | string | null;
  if (typeof r === "string") return r.slice(0, 500);
  const m = r?.error?.message;
  return typeof m === "string" ? m.slice(0, 500) : null;
}

/** The leaf step id + its error message, or nulls when the flow names no failing module. Never throws. */
export async function failedStepOf(job: WindmillJob, getJob: (id: string) => Promise<WindmillJob>): Promise<{ step: string | null; reason: string | null }> {
  let current: WindmillJob | null = job;
  let step: string | null = null;
  for (let depth = 0; depth < MAX_DEPTH && current; depth++) {
    const failed = failureModule(current);
    if (!failed || typeof failed.id !== "string") break;
    step = failed.id;
    if (typeof failed.job !== "string") break;
    try {
      current = await getJob(failed.job);
    } catch {
      return { step, reason: null };
    }
  }
  return { step, reason: messageOf(current) };
}
