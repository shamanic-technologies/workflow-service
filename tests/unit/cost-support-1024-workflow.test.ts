import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DECLARE_BOOKING_CALL_CODE,
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

describe("the booking_call declaration script (ai-instant-call, now its stored script's runner declares)", () => {
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
