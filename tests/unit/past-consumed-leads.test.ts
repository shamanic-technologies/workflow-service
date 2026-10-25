import { describe, it, expect } from "vitest";
import { pastConsumedLeadBatches, pastConsumedLeadRuns } from "../../src/lib/past-consumed-leads.js";

/** LEAD-STATES-1024-MEETING-WRITES: past runs state the lead they acted on, as the live node does. */
const L = "11111111-1111-4111-8111-111111111111";
const M = "22222222-2222-4222-8222-222222222222";

describe("past runs state the lead they acted on", () => {
  it("a past run that wrote nothing for lead L (a 'not now') consumes its pipe's input on L, dated at its start, nothing produced", () => {
    const { runs, skipped } = pastConsumedLeadRuns([{ featureSlug: "ai-meeting-booking", runId: "AAAA", legKey: "conversation_to_meeting_booked", leadIds: [L] }]);
    expect(skipped).toEqual([]);
    expect(runs).toEqual([
      { runId: "aaaa", occurredAt: "run_started_at", produced: [], consumed: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: L }] },
    ]);
  });

  it("the key is each run's own leg; several claimed leads are each consumed once", () => {
    const { runs } = pastConsumedLeadRuns([
      { featureSlug: "ai-meeting-booking", runId: "b", legKey: "form_submitted_to_meeting_booked", leadIds: [L, L.toUpperCase()] },
      { featureSlug: "ai-meeting-booking", runId: "c", legKey: "lead_found_to_conversation", leadIds: [M, L] },
    ]);
    expect(runs.map((r) => r.consumed.map((o) => `${o.outcomeKey}:${o.subjectId}`))).toEqual([
      [`form_submitted:${L}`],
      [`lead_found:${L}`, `lead_found:${M}`],
    ]);
  });

  it("never guesses: no claim, an unreadable leg or a Start leg are skipped and counted", () => {
    const { runs, skipped } = pastConsumedLeadRuns([
      { featureSlug: "ai-meeting-booking", runId: "d", legKey: "conversation_to_meeting_booked", leadIds: [] },
      { featureSlug: "ai-meeting-booking", runId: "e", legKey: "conversation_to_meeting_booked", leadIds: ["not-a-uuid"] },
      { featureSlug: "ai-meeting-booking", runId: "f", legKey: null, leadIds: [L] },
      { featureSlug: "ai-meeting-booking", runId: "g", legKey: "start_to_lead_found", leadIds: [L] },
    ]);
    expect(runs).toEqual([]);
    expect(skipped).toEqual([
      { runId: "d", why: "no lead claimed" },
      { runId: "e", why: "no lead claimed" },
      { runId: "f", why: "pipe unreadable" },
      { runId: "g", why: "start leg" },
    ]);
  });

  it("only the workflows whose live DAG states the lead are back-filled", () => {
    const { runs, skipped } = pastConsumedLeadRuns([
      { featureSlug: "ai-follow-up-email", runId: "h", legKey: "lead_found_to_conversation", leadIds: [L] },
      { featureSlug: "ai-instant-call", runId: "i", legKey: "conversation_to_booking_call", leadIds: [L] },
      { featureSlug: "ai-lead-proposal", runId: "j", legKey: "conversation_to_meeting_booked", leadIds: [L] },
      { featureSlug: null, runId: "k", legKey: "conversation_to_meeting_booked", leadIds: [L] },
    ]);
    expect(runs.map((r) => r.runId)).toEqual(["h", "i"]);
    expect(skipped.map((s) => s.why)).toEqual(["not a lead-declaring workflow", "not a lead-declaring workflow"]);
  });

  it("a run stated twice is refused; batches hold at most 500 runs", () => {
    expect(() => pastConsumedLeadRuns([{ featureSlug: "ai-meeting-booking", runId: "x", legKey: "conversation_to_meeting_booked", leadIds: [L] }, { featureSlug: "ai-meeting-booking", runId: "X", legKey: "conversation_to_meeting_booked", leadIds: [L] }])).toThrow(/twice/);
    const rows = Array.from({ length: 501 }, (_, i) => ({ featureSlug: "ai-meeting-booking", runId: `r${String(i).padStart(4, "0")}`, legKey: "conversation_to_meeting_booked", leadIds: [L] }));
    expect(pastConsumedLeadBatches(rows).batches.map((b) => b.runs.length)).toEqual([500, 1]);
  });
});
