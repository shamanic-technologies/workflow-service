import { describe, expect, it } from "vitest";
import { leadInWhatsappKey, pastRunBatches, pastRunEvidence } from "../../src/lib/past-run-outcomes.js";

const RUN_A = "aaaaaaaa-0000-4000-8000-000000000001";
const RUN_B = "aaaaaaaa-0000-4000-8000-000000000002";
const RUN_COLD = "aaaaaaaa-0000-4000-8000-000000000003";
const RUN_IDLE = "aaaaaaaa-0000-4000-8000-000000000004";
const LEAD_1 = "bbbbbbbb-0000-4000-8000-000000000001";
const LEAD_2 = "bbbbbbbb-0000-4000-8000-000000000002";
const LEAD_3 = "bbbbbbbb-0000-4000-8000-000000000003";
const CHILD_WA = "cccccccc-0000-4000-8000-000000000001";
const CHILD_WA_ALERT = "cccccccc-0000-4000-8000-000000000002";

const base = () => ({
  runFeatures: new Map([
    [RUN_A, "ai-follow-up-email"],
    [RUN_B, "cold-whatsapp-outreach"],
    [RUN_COLD, "sales-cold-email-outreach"],
    [RUN_IDLE, "ai-meeting-booking"],
  ]),
  childParents: new Map([
    [CHILD_WA, RUN_B],
    [CHILD_WA_ALERT, RUN_IDLE],
  ]),
  childOutcomes: [
    { parentRunId: RUN_A, direction: "produced", outcomeKey: "message_sent", subjectService: "lead-service", subjectId: LEAD_1 },
    { parentRunId: RUN_A, direction: "consumed", outcomeKey: "message_written", subjectService: "lead-service", subjectId: LEAD_1 },
    // A cold email's send: content-generation's run to declare, never this one.
    { parentRunId: RUN_COLD, direction: "produced", outcomeKey: "message_sent", subjectService: "lead-service", subjectId: LEAD_3 },
  ],
  followupActions: [
    { runId: RUN_IDLE, leadId: LEAD_3, action: "claimed" },
    { runId: RUN_B, leadId: LEAD_2, action: "claimed" },
  ],
  whatsappSends: [
    { runId: CHILD_WA, status: "sent", idempotencyKey: `cold-whatsapp-outreach:event:${"d".repeat(8)}` },
    { runId: CHILD_WA_ALERT, status: "sent", idempotencyKey: "ai-meeting-booking:event:x:rep-alert" },
  ],
});

describe("past-run outcomes (COST-BACKFILL-1023-WORKFLOW)", () => {
  it("names a message written for each chat-writer run whose send left a record, and only those", () => {
    const { declarations, unnamed } = pastRunEvidence(base());
    expect(declarations).toEqual([
      { runId: RUN_A, featureSlug: "ai-follow-up-email", leadIds: [LEAD_1] },
      // the WhatsApp key names no lead: the ONE lead the run claimed
      { runId: RUN_B, featureSlug: "cold-whatsapp-outreach", leadIds: [LEAD_2] },
    ]);
    expect(unnamed).toEqual([]);
  });

  it("never declares a run that claimed someone but sent nothing, nor a rep alert, nor a cold-email run", () => {
    const ids = pastRunEvidence(base()).declarations.map((d) => d.runId);
    expect(ids).not.toContain(RUN_IDLE);
    expect(ids).not.toContain(RUN_COLD);
  });

  it("an acted follow-up is a sent reply", () => {
    const input = base();
    input.followupActions.push({ runId: RUN_IDLE, leadId: LEAD_3, action: "acted" });
    expect(pastRunEvidence(input).declarations.find((d) => d.runId === RUN_IDLE)?.leadIds).toEqual([LEAD_3]);
  });

  it("a WhatsApp send whose person cannot be named is reported, never guessed", () => {
    const input = base();
    input.followupActions.push({ runId: RUN_B, leadId: LEAD_1, action: "claimed" });
    const { declarations, unnamed } = pastRunEvidence(input);
    expect(declarations.map((d) => d.runId)).toEqual([RUN_A]);
    expect(unnamed).toEqual([{ runId: RUN_B, idempotencyKey: `cold-whatsapp-outreach:event:${"d".repeat(8)}` }]);
  });

  it("reads the lead a writer's WhatsApp key names", () => {
    expect(leadInWhatsappKey(`cold-whatsapp-outreach:camp:${LEAD_1}:1`)).toBe(LEAD_1);
    expect(leadInWhatsappKey(`follow-up:camp:row:${LEAD_2}`)).toBe(LEAD_2);
    expect(leadInWhatsappKey(`cold-whatsapp-outreach:event:${LEAD_1}`)).toBeNull();
    expect(leadInWhatsappKey("cold-whatsapp-outreach:camp:not-a-uuid:1")).toBeNull();
  });

  it("builds batch bodies dated at the run start: message_written produced, lead_found consumed, same lead", () => {
    const [batch] = pastRunBatches([{ runId: RUN_A, featureSlug: "ai-follow-up-email", leadIds: [LEAD_1, LEAD_2] }]);
    expect(batch.runs).toEqual([
      {
        runId: RUN_A,
        occurredAt: "run_started_at",
        produced: [
          { outcomeKey: "message_written", subjectService: "lead-service", subjectId: LEAD_1 },
          { outcomeKey: "message_written", subjectService: "lead-service", subjectId: LEAD_2 },
        ],
        consumed: [
          { outcomeKey: "lead_found", subjectService: "lead-service", subjectId: LEAD_1 },
          { outcomeKey: "lead_found", subjectService: "lead-service", subjectId: LEAD_2 },
        ],
      },
    ]);
  });

  it("splits at 500 runs and at 1000 occurrences", () => {
    const decl = (i: number) => ({
      runId: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
      featureSlug: "ai-meeting-booking",
      leadIds: [LEAD_1],
    });
    const batches = pastRunBatches(Array.from({ length: 1201 }, (_, i) => decl(i)));
    // 2 occurrences per run: 1000 occurrences = 500 runs per call
    expect(batches.map((b) => b.runs.length)).toEqual([500, 500, 201]);
    for (const b of batches) {
      expect(b.runs.reduce((n, r) => n + r.produced.length + r.consumed.length, 0)).toBeLessThanOrEqual(1000);
    }
  });

  it("refuses a cold-email run, a run stated twice and a run naming no lead", () => {
    expect(() => pastRunBatches([{ runId: RUN_COLD, featureSlug: "sales-cold-email-outreach", leadIds: [LEAD_1] }])).toThrow(/not a chat writer/);
    expect(() =>
      pastRunBatches([
        { runId: RUN_A, featureSlug: "ai-follow-up-email", leadIds: [LEAD_1] },
        { runId: RUN_A, featureSlug: "ai-follow-up-email", leadIds: [LEAD_2] },
      ]),
    ).toThrow(/stated twice/);
    expect(() => pastRunBatches([{ runId: RUN_A, featureSlug: "ai-follow-up-email", leadIds: [] }])).toThrow(/no valid lead/);
  });
});
