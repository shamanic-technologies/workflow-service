import type { WindmillJob } from "./windmill-client.js";

/**
 * What a `/jobs_u/get` answer means for the run that dispatched the job.
 *
 * Windmill answers with one of two shapes, discriminated by `type`
 * (verified against prod 2026-09-29):
 *   - `QueuedJob`    — carries `running` (false while WAITING for a worker,
 *                      true once picked up) and NO `success`.
 *   - `CompletedJob` — carries `success` and NO `running` key at all.
 *
 * Only a `CompletedJob` is terminal. Keying on `!job.running` alone reads a job
 * still waiting in the queue as finished-without-success, i.e. FAILED — which
 * under any queue backlog fails the run seconds after dispatch, releases its
 * per-campaign lock, and lets a second run start beside the real one.
 */
export type WindmillJobState =
  | { state: "queued" }
  | { state: "running" }
  | { state: "completed"; success: boolean };

export function windmillJobState(job: WindmillJob): WindmillJobState {
  if (job.type === "CompletedJob") {
    if (typeof job.success !== "boolean") {
      throw new Error(
        `Windmill job ${job.id} is a CompletedJob without a boolean "success" (got ${JSON.stringify(job.success)}); refusing to guess its outcome`,
      );
    }
    return { state: "completed", success: job.success };
  }
  if (job.type === "QueuedJob") {
    return job.running ? { state: "running" } : { state: "queued" };
  }
  throw new Error(
    `Windmill job ${job.id} has unknown type ${JSON.stringify(job.type)}; expected "QueuedJob" or "CompletedJob"`,
  );
}
