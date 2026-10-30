import { describe, it, expect } from "vitest";
import { failedStepOf } from "../../src/lib/failed-step.js";
import type { WindmillJob } from "../../src/lib/windmill-client.js";

// INCIDENT 2026-10-30: a branch sub-flow's failure leaves the top flow's result as {"status":"failed"}; the step is
// found by walking the Failure modules down to the leaf (shape read from prod Windmill).
describe("failedStepOf", () => {
  it("walks a branch to the leaf step and reads its error", async () => {
    const jobs: Record<string, WindmillJob> = {
      sub: { id: "sub", running: false, flow_status: { modules: [{ id: "email_generate_materials", type: "Success" }, { id: "email_send", job: "leaf", type: "Failure" }] } },
      leaf: { id: "leaf", running: false, result: { error: { message: "POST email-gateway/orgs/send failed (502): Primeforge 402" } } },
    };
    const top: WindmillJob = { id: "top", running: false, result: { status: "failed" }, flow_status: { modules: [{ id: "fetch_lead", type: "Success" }, { id: "check_lead", job: "sub", type: "Failure" }] } };
    expect(await failedStepOf(top, async (id) => jobs[id]!)).toEqual({ step: "email_send", reason: "POST email-gateway/orgs/send failed (502): Primeforge 402" });
  });

  it("a flow naming no failing module answers nulls, never throws", async () => {
    expect(await failedStepOf({ id: "x", running: false }, async () => { throw new Error("gone"); })).toEqual({ step: null, reason: null });
  });
});
