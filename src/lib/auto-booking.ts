/**
 * AUTO-BOOK-1103 (owner 2026-11-03): a prospect whose last message picks one of the times we offered
 * (« Can you do Wednesday at 1 PM? ») gets the meeting BOOKED for them on the brand's calendar, then one
 * confirmation in their thread, instead of the times again.
 *
 * Who picks: the writer (`bookSlot` + `bookedReplyHtml` beside its usual `replyHtml`, trusted, never
 * re-judged). Who books: crm-service, through the brand's OWN calendar connection (GoHighLevel today): a
 * public booking page cannot be submitted by a machine (captcha, 429; measured 2026-11-03), and the
 * credential is crm-service's. Whether the slot is still open is the calendar's truth, read there.
 *
 * Every refusal (no connection, a connection without write access, a taken slot, a page that is not a
 * calendar of the brand) is NAMED by crm-service and read here as "not booked": the reply they get is
 * `replyHtml`, exactly today's, and the refusal is logged verbatim. Never "booked" unless crm-service says so.
 * A transport or 5xx failure fails the run BEFORE anything is sent (redelivered with the same key, and the
 * booking key is the occurrence's: a redelivery never books twice and gets the first booking back).
 */

import { OCCURRENCE_SEND_KEY_FN } from "./occurrence-send-key.js";

/**
 * crm-service's booking door (crm-service #246): 200 `status: booked` once GoHighLevel confirmed the
 * appointment; 422 a NAMED refusal (`code`), nothing booked; 409 `booking_in_progress` and 502
 * `booking_failed` = not settled, retried with the same key. `tolerateFailure` so the 422 can be READ;
 * BOOKING_OUTCOME re-throws everything that is not a 422 with a code.
 */
export const CRM_BOOKING_CALL = {
  service: "crm",
  method: "POST",
  path: "/orgs/gohighlevel/bookings",
  tolerateFailure: true,
} as const;

/** True when the run must not book: decides before any call, so a run with no pick asks nobody. */
export const PLAN_BOOKING_CODE = `
export async function main(draft, booking, followup, leadDetail, trigger) {
  const json = draft?.json ?? {};
  const pick = typeof json.bookSlot === "string" ? json.bookSlot.trim() : "";
  const none = (why) => ({ skip: true, why, body: null });
  if (json.decision !== "answer" || pick === "") return none("no time picked");
  const slots = Array.isArray(booking?.slots) ? booking.slots : [];
  // The booking is irreversible: only a slot the page itself served is ever booked, as it stands.
  if (!slots.includes(pick)) {
    console.error("[ai-meeting-booking] the writer picked " + JSON.stringify(pick) + ", which is not a slot the booking page served; nothing booked, the usual answer is sent");
    return none("picked slot not offered");
  }
  const confirmation = typeof json.bookedReplyHtml === "string" ? json.bookedReplyHtml.trim() : "";
  if (confirmation === "") {
    console.error("[ai-meeting-booking] the writer picked " + pick + " but wrote no booked confirmation; nothing booked, the usual answer is sent");
    return none("no booked confirmation");
  }
  const email = typeof followup?.email === "string" && followup.email.trim() !== "" ? followup.email.trim() : null;
  if (email === null) return none("no email for the invite");
  const lead = leadDetail?.leadDetail?.lead ?? {};
  const text = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const person = {
    email,
    ...(text(lead.firstName) ? { firstName: text(lead.firstName) } : {}),
    ...(text(lead.lastName) ? { lastName: text(lead.lastName) } : {}),
    ...(text(lead.phone) ?? text(followup?.phone) ? { phone: text(lead.phone) ?? text(followup?.phone) } : {}),
  };
  return {
    skip: false,
    why: "they picked " + pick,
    body: {
      brandId: followup.brandId,
      idempotencyKey: sendKey("ai-meeting-booking", followup, trigger) + ":book",
      ...(typeof booking.bookingUrl === "string" && booking.bookingUrl.trim() !== "" ? { bookingPageUrl: booking.bookingUrl.trim() } : {}),
      // The calendar the slots were read on: a page on the client's own domain names none in its URL.
      ...(typeof booking.calendarId === "string" && booking.calendarId !== "" ? { calendarId: booking.calendarId } : {}),
      startTime: pick,
      person,
    },
  };
}

SEND_KEY_FN
`.trim().replace("SEND_KEY_FN", OCCURRENCE_SEND_KEY_FN);

/**
 * What the run sends: the booked confirmation when crm-service booked, else the writer's usual answer. A
 * named refusal is an outcome (logged verbatim), a failure with no name is a fault (thrown, nothing sent).
 */
export const BOOKING_OUTCOME_CODE = `
export async function main(plan, result, draft) {
  const usual = { booked: false, replyHtml: draft?.json?.replyHtml, draft };
  if (plan?.skip !== false) return { ...usual, why: plan?.why ?? "no booking asked" };
  if (result?.ok === false) {
    let body = null;
    try { body = JSON.parse(String(result.error ?? "")); } catch { body = null; }
    const code = typeof body?.code === "string" ? body.code : null;
    // Only a 422 is a settled "not booked". A 409 (the same key is being booked right now) or a 502 may still
    // become a booking: sending the usual answer then would offer times for a meeting that lands.
    if (code !== null && Number(result.status) === 422) {
      const words = body?.vendorError ?? body?.error ?? null;
      console.error("[ai-meeting-booking] NOT BOOKED " + plan.body.startTime + " for " + plan.body.person.email + ": " + code +
        " (" + String(words ?? "") + "); the usual answer is sent");
      return { ...usual, why: "refused " + code, refusal: { code, message: words } };
    }
    throw new Error("[ai-meeting-booking] the booking call failed (" + String(result.status) + "): " + String(result.error ?? "").slice(0, 500));
  }
  if (result?.status !== "booked" || typeof result?.appointmentId !== "string" || result.appointmentId === "") {
    throw new Error("[ai-meeting-booking] the booking call answered neither booked nor a named refusal: " + JSON.stringify(result).slice(0, 500));
  }
  const confirmation = String(draft?.json?.bookedReplyHtml ?? "");
  console.log("[ai-meeting-booking] BOOKED " + plan.body.startTime + " for " + plan.body.person.email + " (appointment " +
    result.appointmentId + (result.duplicate ? ", booked by an earlier attempt" : "") + "); sending the confirmation");
  return {
    booked: true,
    replyHtml: confirmation,
    draft: { ...draft, json: { ...draft.json, replyHtml: confirmation } },
    why: "booked " + plan.body.startTime,
    booking: result,
  };
}
`.trim();
