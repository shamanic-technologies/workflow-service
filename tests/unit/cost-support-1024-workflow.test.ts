import { describe, it, expect, vi, afterEach } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { validateDAG } from "../../src/lib/dag-validator.js";
import {
  buildAiMeetingBookingDag,
  needsEscalationHandOver,
  PLAN_HAND_OVER_CODE,
} from "../../src/lib/ai-meeting-booking-dag.js";
import { buildOfferDocumentReplyDag } from "../../src/lib/offer-document-reply-dag.js";
import { buildAiInstantCallDag } from "../../src/lib/ai-instant-call-dag.js";
import {
  DECLARE_BOOKING_CALL_CODE,
  DECLARE_BOOKING_CALL_NODE_ID,
  needsBookingCallDeclaration,
} from "../../src/lib/booking-call-outcome.js";

/**
 * COST-SUPPORT-1024-WORKFLOW. Measured in prod before this change (runs-service, execute-workflow runs started
 * 2026-10-23 15:00 -> 2026-10-24 10:30 UTC, after the message_written seeds): $5.10 of spend under workflow runs with no
 * outcome; $3.69 of it was ai-meeting-booking-torcular claiming and escalating the SAME prospect every hour (17 runs:
 * 9 escalations answered `already_escalated`, 8 refused by the funnel budget cap after the reads), because an email
 * escalation never handed over a row on the campaign's own queue. Over 7 days ai-instant-call left $2.86 of twilio
 * calls undeclared (no outcome on the call's run nor on ours).
 */
function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

describe("ai-meeting-booking: an escalated row is never left due (ESCALATION-HANDOVER-1024)", () => {
  const plan = loadMain(PLAN_HAND_OVER_CODE);
  const email = { replyChannel: "email" };

  it("hands over a row on this campaign's own queue even when the escalation stopped a row", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await plan(email, { queue: "own", followup: { id: "r1" } }, { escalation: { followupsStopped: true } })).toMatchObject({ skip: false });
  });

  it("hands over when the escalation stopped nothing (already_escalated: the hourly loop of 2026-10-23)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const already = { success: true, escalation: { handoff: "already_escalated", followupsStopped: false } };
    expect(await plan(email, { queue: "own", followup: { id: "215bcdc9" } }, already)).toMatchObject({ skip: false });
    expect(await plan(email, { queue: "predecessor", followup: { id: "r2" } }, already)).toMatchObject({ skip: false });
  });

  it("leaves a predecessor row the escalation handed over itself (unchanged behaviour)", async () => {
    expect(await plan(email, { queue: "predecessor", followup: { id: "r3" } }, { escalation: { followupsStopped: true } })).toMatchObject({ skip: true });
  });

  it("any chat thread is handed here, as before", async () => {
    expect(await plan({ replyChannel: "whatsapp" }, { queue: "own" }, { ok: false, skipped: true, notCalled: true })).toMatchObject({ skip: false });
  });

  for (const [name, dag] of [
    ["parent", buildAiMeetingBookingDag({ provider: "google", model: "pro" })],
    ["offer-document copy", buildOfferDocumentReplyDag({ provider: "google", model: "pro" })],
  ] as const) {
    it(`${name}: escalate -> plan-hand-over -> hand-over, hand-over skips on the plan`, () => {
      expect(validateDAG(dag).errors).toEqual([]);
      expect(() => dagToOpenFlow(dag, `esc-${name.replace(/ /g, "-")}`)).not.toThrow();
      expect(dag.edges).toContainEqual({ from: "escalate-unanswerable", to: "plan-hand-over" });
      expect(dag.edges).toContainEqual({ from: "plan-hand-over", to: "hand-over" });
      expect(dag.edges.some((e) => e.from === "escalate-unanswerable" && e.to === "hand-over")).toBe(false);
      const hand = dag.nodes.find((n) => n.id === "hand-over")!;
      expect(hand.inputMapping?.skip).toBe("$ref:plan-hand-over.output.skip");
      expect(needsEscalationHandOver(dag)).toBe(false);
    });
  }

  it("the seed predicate flags a stored DAG without the step", () => {
    const dag = buildAiMeetingBookingDag({ provider: "google", model: "pro" });
    expect(needsEscalationHandOver({ nodes: dag.nodes.filter((n) => n.id !== "plan-hand-over") })).toBe(true);
    expect(needsEscalationHandOver({ nodes: [{ id: "draft" }] })).toBe(false);
  });
});

describe("ai-instant-call declares booking_call once the call is placed", () => {
  for (const [name, dag] of [
    ["default", buildAiInstantCallDag()],
    ["email-only copy", buildAiInstantCallDag({ emailRepliesOnly: true })],
  ] as const) {
    it(`${name}: one declaration after the call is recorded, before the end-run`, () => {
      expect(validateDAG(dag).errors).toEqual([]);
      expect(() => dagToOpenFlow(dag, `bc-${name.replace(/ /g, "-")}`)).not.toThrow();
      const nodes = dag.nodes.filter((n) => n.id === DECLARE_BOOKING_CALL_NODE_ID);
      expect(nodes).toHaveLength(1);
      expect(dag.edges).toContainEqual({ from: "ring-rep", to: "record-called" });
      expect(dag.edges).toContainEqual({ from: "record-called", to: DECLARE_BOOKING_CALL_NODE_ID });
      expect(dag.edges).toContainEqual({ from: DECLARE_BOOKING_CALL_NODE_ID, to: "end-run" });
      expect(nodes[0].inputMapping).toMatchObject({
        placed: "$ref:resolve-call.output.ok",
        occasion: "$ref:resolve-call.output.occasion",
        leadId: "$ref:claim-followup.output.followup.leadId",
        runId: "$ref:flow_input.runId",
      });
      expect(needsBookingCallDeclaration(dag)).toBe(false);
    });
  }

  describe("the declaration script", () => {
    const main = loadMain(DECLARE_BOOKING_CALL_CODE);
    const envs = { RUNS_SERVICE_URL: "http://runs/", RUNS_SERVICE_API_KEY: "k" };
    afterEach(() => vi.unstubAllGlobals());

    it("a reply call: booking_call produced, the positive reply consumed, on the lead, on the workflow run", async () => {
      const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
      vi.stubGlobal("fetch", fetchMock);
      expect(await main(true, null, "lead-1", envs, "org-1", "run-1")).toMatchObject({ declared: true, consumed: "conversation" });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://runs/v1/runs/run-1/outcomes");
      expect(JSON.parse(String(init.body))).toEqual({
        produced: [{ outcomeKey: "booking_call", subjectService: "lead-service", subjectId: "lead-1" }],
        consumed: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "lead-1" }],
      });
    });

    it("a form call consumes form_submitted", async () => {
      const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
      vi.stubGlobal("fetch", fetchMock);
      await main(true, { type: "form", formName: "Contact" }, "lead-1", envs, "org-1", "run-1");
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body)).consumed[0].outcomeKey).toBe("form_submitted");
    });

    it("no call placed or no lead id: nothing declared", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      expect((await main(false, null, "lead-1", envs, "org-1", "run-1")).declared).toBe(false);
      expect(await main(true, null, null, envs, "org-1", "run-1")).toMatchObject({ declared: false, why: "no lead id" });
      expect(fetchMock).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it("never throws: a 5xx is retried then logged", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
      vi.stubGlobal("fetch", fetchMock);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const p = main(true, null, "lead-1", envs, "org-1", "run-1");
      await vi.runAllTimersAsync();
      expect(await p).toMatchObject({ declared: false });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(err.mock.calls.at(-1)?.[0]).toContain("DECLARATION FAILED");
      err.mockRestore();
      vi.useRealTimers();
    });
  });
});
