import { describe, it, expect, vi } from "vitest";
import { BOOKING_OUTCOME_CODE, CRM_BOOKING_CALL, PLAN_BOOKING_CODE } from "../../src/lib/auto-booking.js";
import {
  buildAiMeetingBookingDag,
  needsAutoBooking,
  readBookingSlotsCode,
  REPLY_RESPONSE_SCHEMA,
} from "../../src/lib/ai-meeting-booking-dag.js";
import { buildOfferDocumentReplyDag } from "../../src/lib/offer-document-reply-dag.js";

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

const SLOT = "2026-11-04T13:00:00-05:00";
const booking = {
  bookingUrl: "https://web.example.com/appointment-booking-page",
  timezone: "America/New_York",
  slots: ["2026-11-03T09:00:00-05:00", SLOT],
  degraded: false,
  calendarId: "5JgGFt1MsJ6FLvMZLt6t",
};
const followup = { id: "row-1", email: "pat@staff-test.example", brandId: "brand-1", dueAt: "2026-11-03T10:00:00.000Z" };
const leadDetail = { leadDetail: { lead: { firstName: "Pat", lastName: "Staff" } } };
const trigger = { eventId: "evt-1", person: { email: "Pat@staff-test.example" } };
const picked = {
  json: {
    decision: "answer",
    replyHtml: "<p>Wednesday at 1 PM works, lock it in here: https://web.example.com/appointment-booking-page</p>",
    bookSlot: SLOT,
    bookedReplyHtml: "<p>Booked for Wednesday, November 4 at 1:00 PM Eastern. The invite is in your inbox.</p>",
  },
};

describe("AUTO-BOOK-1103: a prospect who picks one of our times is booked, then confirmed", () => {
  const plan = loadMain(PLAN_BOOKING_CODE);
  const outcome = loadMain(BOOKING_OUTCOME_CODE);

  it("asks crm-service to book exactly the picked slot, on the calendar the slots were read on, keyed on the occurrence", async () => {
    const p = await plan(picked, booking, followup, leadDetail, trigger);
    expect(p.skip).toBe(false);
    expect(p.body).toEqual({
      brandId: "brand-1",
      idempotencyKey: "ai-meeting-booking:event:evt-1:book",
      bookingPageUrl: booking.bookingUrl,
      calendarId: booking.calendarId,
      startTime: SLOT,
      person: { email: "pat@staff-test.example", firstName: "Pat", lastName: "Staff" },
    });
    expect(CRM_BOOKING_CALL).toMatchObject({ service: "crm", method: "POST", path: "/orgs/gohighlevel/bookings", tolerateFailure: true });
  });

  it("asks nobody when there is no pick, a pick the page never served, no confirmation, or no email", async () => {
    const cases: Array<[unknown, unknown]> = [
      [{ json: { ...picked.json, bookSlot: undefined } }, followup],
      [{ json: { ...picked.json, bookSlot: "2026-11-04T15:00:00-05:00" } }, followup],
      [{ json: { ...picked.json, bookedReplyHtml: "" } }, followup],
      [{ json: { ...picked.json, decision: "escalate" } }, followup],
      [picked, { ...followup, email: null, phone: "+15555550100" }],
    ];
    for (const [draft, f] of cases) {
      const p = await plan(draft, booking, f, leadDetail, trigger);
      expect(p.skip).toBe(true);
      expect(p.body).toBeNull();
    }
  });

  it("sends the booked confirmation only when crm-service answered booked", async () => {
    const p = await plan(picked, booking, followup, leadDetail, trigger);
    const o = await outcome(p, { status: "booked", appointmentId: "appt-1", duplicate: false }, picked);
    expect(o.booked).toBe(true);
    expect(o.replyHtml).toBe(picked.json.bookedReplyHtml);
    expect(o.draft.json.replyHtml).toBe(picked.json.bookedReplyHtml);
  });

  it("a named refusal (422) sends today's answer and logs the reason verbatim; nothing claims booked", async () => {
    const p = await plan(picked, booking, followup, leadDetail, trigger);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = { ok: false, status: 422, error: JSON.stringify({ type: "refused", status: "refused", code: "no_write_access", error: "x", vendorError: "The token is not authorized for this scope." }) };
    const o = await outcome(p, refusal, picked);
    expect(o.booked).toBe(false);
    expect(o.replyHtml).toBe(picked.json.replyHtml);
    expect(o.refusal).toEqual({ code: "no_write_access", message: "The token is not authorized for this scope." });
    expect(String(err.mock.calls[0]?.[0])).toContain("NOT BOOKED");
    err.mockRestore();
  });

  it("a booking that may still land (409 in progress, 502, transport) fails the run before anything is sent", async () => {
    const p = await plan(picked, booking, followup, leadDetail, trigger);
    for (const r of [
      { ok: false, status: 409, error: JSON.stringify({ code: "booking_in_progress", error: "busy" }) },
      { ok: false, status: 502, error: JSON.stringify({ code: "booking_failed", error: "429" }) },
      { ok: false, status: 0, error: "fetch failed" },
      { status: "something-else" },
    ]) {
      await expect(outcome(p, r, picked)).rejects.toThrow();
    }
  });

  it("no booking asked = the usual answer, untouched", async () => {
    const o = await outcome({ skip: true, why: "no time picked" }, { ok: false, skipped: true, notCalled: true }, picked);
    expect(o).toMatchObject({ booked: false, replyHtml: picked.json.replyHtml });
  });

  it("the writer is told to pick and confirm, and its schema carries both fields", () => {
    expect(REPLY_RESPONSE_SCHEMA.properties.bookSlot.type).toBe("string");
    expect(REPLY_RESPONSE_SCHEMA.properties.bookedReplyHtml.type).toBe("string");
    expect(REPLY_RESPONSE_SCHEMA.required).not.toContain("bookSlot");
  });
});

describe("AUTO-BOOK-1103: the reply DAG books before it sends", () => {
  const dag = buildAiMeetingBookingDag({ provider: "google", model: "pro" });
  const node = (id: string) => dag.nodes.find((n) => n.id === id);

  it("sits between the next-due resolution and the send, and the send reads what the booking decided", () => {
    const edges = dag.edges.map((e) => `${e.from}->${e.to}`);
    expect(edges).toContain("resolve-next-due->plan-booking");
    expect(edges).toContain("plan-booking->book-slot");
    expect(edges).toContain("book-slot->booking-outcome");
    expect(edges).toContain("booking-outcome->finalize-reply");
    expect(node("send-reply")?.inputMapping?.["body.body_html"]).toBe("$ref:booking-outcome.output.replyHtml");
    expect(node("finalize-reply")?.inputMapping?.draft).toBe("$ref:booking-outcome.output.draft");
    expect(node("book-slot")?.inputMapping?.skip).toBe("$ref:plan-booking.output.skip");
  });

  it("a booked run stops their follow-ups like a booking they told us about; an unbooked answer is recorded as today", () => {
    const toStop = dag.edges.find((e) => e.from === "check-sent" && e.to === "stop-followups-booked");
    const toRecord = dag.edges.find((e) => e.from === "check-sent" && e.to === "record-followup");
    expect(toStop?.condition).toContain("results['booking-outcome']?.booked == true");
    expect(toRecord?.condition).toContain("results['booking-outcome']?.booked != true");
  });

  it("the slot read hands over the GoHighLevel calendar it read on", () => {
    expect(readBookingSlotsCode()).toContain("ok(slots, readOn)");
  });

  it("the seed calls a DAG without the booking step stale, the current one current; the document copy books too", () => {
    expect(needsAutoBooking(dag)).toBe(false);
    expect(needsAutoBooking({ nodes: dag.nodes.filter((n) => n.id !== "book-slot") })).toBe(true);
    expect(needsAutoBooking({ nodes: dag.nodes.map((n) => (n.id === "booking-slots" ? { ...n, config: { code: "old" } } : n)) })).toBe(true);
    const copy = buildOfferDocumentReplyDag({ provider: "anthropic", model: "opus" } as never);
    expect(copy.nodes.some((n) => n.id === "book-slot")).toBe(true);
  });
});
