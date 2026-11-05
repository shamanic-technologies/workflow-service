/**
 * The open times of an offer's public booking page (Calendly, Google appointment schedule, GoHighLevel), read with no
 * credential. Moved out of the AI Meeting Booking workflow (deleted, MIGRATE-1105 S1b): the answering script reads it
 * through its `booking.slots` vendor (`scripts/vendors.ts`), the same code the old answering step ran.
 */
/**
 * How far ahead of today the booking page is read for availability.
 *
 * Measured 2026-09-30 against the four booking pages the fleet's offers carry
 * (two Calendly, one Google appointment schedule, one GoHighLevel): all four
 * answer a 28-day range, and GoHighLevel's free-slots call 404s at 35. A page
 * whose own booking window is shorter simply returns fewer days.
 */
export const SLOT_LOOKAHEAD_DAYS = 28;

/**
 * How many candidate slots are handed to the model per DAY, and in total. The
 * model picks two.
 *
 * The candidates are SPREAD across the days of the range rather than taken
 * earliest-first. Earliest-first is what stranded a prospect who wrote "I can't
 * till next week": the first six open slots of that calendar were all on the
 * next day, so the model had nothing next week to offer and escalated a
 * scheduling preference as an unanswerable question (Doc Dinners, 2026-09-28).
 * With a few slots on every open day, whatever window the prospect names can be
 * served from the list.
 */
export const SLOTS_PER_DAY = 3;
export const SLOT_CANDIDATES = 60;

/**
 * Reads the offer's booking page and returns slots ALREADY
 * CONVERTED to the prospect's own timezone.
 *
 * Three providers are read, because those are the three the fleet's brands
 * actually use. All three are PUBLIC, UNAUTHENTICATED and UNDOCUMENTED — the
 * same calls a browser makes when a human opens the booking page — and all
 * three will break one day without notice.
 *
 * - CALENDLY: one call resolves the event type behind the public URL, a second
 *   reads a date range. Passing the IANA timezone is what converts.
 * - GOHIGHLEVEL: the booking link sits on the CLIENT'S OWN DOMAIN, so a
 *   hostname test cannot identify it. The page is fetched and sniffed for
 *   `leadconnectorhq` plus the calendar id in its inlined payload, then
 *   `backend.leadconnectorhq.com/calendars/<id>/free-slots` answers one key per
 *   day, already converted to the timezone passed. `duration` is deliberately
 *   NOT sent: measured 2026-09-22 against the live calendar, omitting it
 *   returns the identical slots because the vendor applies the calendar's own
 *   duration server-side — so there is nothing to read off the page and nothing
 *   to hardcode.
 * - GOOGLE APPOINTMENT SCHEDULES: three calls (resolve the schedule id off the
 *   page, list the service definitions, list the slots) against a
 *   protobuf-JSON RPC with a public API key inlined in Google's own page.
 *   ⚠️ Unlike the other two this takes NO timezone and answers raw epoch
 *   SECONDS, so the conversion into the prospect's IANA zone is OURS — it is
 *   the only date arithmetic in this node.
 *
 * Every failure here is a DEGRADATION and never an exception: the prospect
 * still gets an answer carrying the plain booking link, and the reason is
 * logged loudly and returned so the prompt can tell the model what it has. Each
 * reason names its own case, so "this host is not one we read" is legible apart
 * from "the page could not be fetched", "the slots call failed" and "the range
 * held nothing". A host that is none of the three still degrades rather than
 * guessing. Calendly's official API cannot serve this — it needs the customer's
 * own OAuth and a paid plan — and Cal.com / HubSpot / SavvyCal are deliberately
 * not read: no brand in the fleet uses one.
 */
export const READ_BOOKING_SLOTS_TEMPLATE = `
export async function main(bookingUrl, timezone) {
  const tz = typeof timezone === "string" && timezone.trim() ? timezone.trim() : "UTC";
  const days = LOOKAHEAD_DAYS;
  const perDay = SLOTS_PER_DAY;
  const want = MAX_SLOTS;

  const degraded = (reason) => {
    console.error("[ai-meeting-booking] no slots read from the booking page: " + reason +
      " (bookingUrl=" + String(bookingUrl) + ", timezone=" + tz + ")");
    return { bookingUrl: bookingUrl ?? null, timezone: tz, slots: [], degraded: true, degradedReason: reason };
  };
  /**
   * Keeps a few slots on EVERY open day instead of the earliest ones overall,
   * so a prospect who names a window ("next week", "after the 15th", "Thursday
   * afternoon") finds times inside it. Every slot string is already in the
   * prospect's own timezone with its offset, so its first ten characters are
   * the prospect's local date and characters 11-12 their local hour. Within a
   * day, slots in working hours (08:00-17:59 local) are preferred, and the kept
   * ones are spaced out across the day rather than bunched at its start.
   */
  const spreadAcrossDays = (all) => {
    const byDay = new Map();
    for (const s of [...new Set(all)].sort()) {
      const day = s.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(s);
    }
    const kept = [];
    for (const [, list] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const working = list.filter((s) => {
        const hour = Number(s.slice(11, 13));
        return hour >= 8 && hour < 18;
      });
      const pool = working.length > 0 ? working : list;
      if (pool.length <= perDay) {
        kept.push(...pool);
      } else {
        const picks = new Set();
        for (let i = 0; i < perDay; i++) {
          picks.add(Math.round((i * (pool.length - 1)) / (perDay - 1 || 1)));
        }
        for (const i of [...picks].sort((a, b) => a - b)) kept.push(pool[i]);
      }
      if (kept.length >= want) break;
    }
    return kept.slice(0, want);
  };
  // calendarId: the GoHighLevel calendar the slots were read on (AUTO-BOOK-1103: a booking page on the client's own
  // domain names none in its URL, so the booking names the one read here). Null for the other providers.
  const ok = (slots, calendarId = null) => ({ bookingUrl, timezone: tz, slots: spreadAcrossDays(slots), degraded: false, degradedReason: null, calendarId });

  const BROWSER_UA = "Mozilla/5.0 (compatible; distribute-ai-meeting-booking/1.0)";
  const GOOGLE_API_KEY = "AIzaSyA7GKm43l8WNxlLTjsldq9z9n80CL6KW4U";
  const GOOGLE_RPC = "https://calendar-pa.clients6.google.com/$rpc/google.internal.calendar.v1.AppointmentBookingService/";

  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + days * 86400000);
  const ymd = (d) => d.toISOString().split("T")[0];
  const errText = (err) => (err instanceof Error ? err.message : String(err));

  /**
   * Google answers raw epoch seconds with no timezone, so this is where the
   * conversion happens. Intl gives the wall-clock parts AND the zone's offset
   * for that instant (so DST is handled), which assembles into the same
   * offset-carrying ISO string Calendly and GoHighLevel return directly.
   */
  const toOffsetIso = (epochSeconds, zone) => {
    const at = new Date(epochSeconds * 1000);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      timeZoneName: "longOffset",
    }).formatToParts(at);
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
    let hour = get("hour");
    if (hour === "24") hour = "00";
    let offset = "+00:00";
    const m = /GMT([+-])(\\d{1,2})(?::(\\d{2}))?/.exec(get("timeZoneName"));
    if (m) offset = m[1] + String(m[2]).padStart(2, "0") + ":" + (m[3] || "00");
    return get("year") + "-" + get("month") + "-" + get("day") +
      "T" + hour + ":" + get("minute") + ":" + get("second") + offset;
  };

  const readCalendly = async (parsed) => {
    const segments = parsed.pathname.split("/").filter(Boolean);
    let lookupQuery;
    if (segments[0] === "d" && segments[1]) {
      // Short form: calendly.com/d/xxx-xxx-xxx
      lookupQuery = "event_type_uuid=" + encodeURIComponent(segments[1]);
    } else if (segments.length >= 2) {
      // Long form: calendly.com/<user>/<event>
      lookupQuery = "event_type_slug=" + encodeURIComponent(segments[1]) +
        "&profile_slug=" + encodeURIComponent(segments[0]);
    } else {
      return degraded("booking_url_not_an_event_page");
    }

    let uuid;
    try {
      const res = await fetch("https://calendly.com/api/booking/event_types/lookup?" + lookupQuery, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return degraded("event_type_lookup_http_" + res.status);
      const body = await res.json();
      uuid = body?.uuid ?? body?.id ?? body?.event_type?.uuid ?? body?.event_type?.id;
    } catch (err) {
      return degraded("event_type_lookup_failed: " + errText(err));
    }
    if (!uuid) return degraded("event_type_lookup_returned_no_uuid");

    let payload;
    try {
      const res = await fetch(
        "https://calendly.com/api/booking/event_types/" + encodeURIComponent(uuid) +
          "/calendar/range?timezone=" + encodeURIComponent(tz) +
          "&diagnostics=false&range_start=" + ymd(startDate) + "&range_end=" + ymd(endDate),
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) },
      );
      if (!res.ok) return degraded("calendar_range_http_" + res.status);
      payload = await res.json();
    } catch (err) {
      return degraded("calendar_range_failed: " + errText(err));
    }

    const slots = [];
    for (const day of payload?.days ?? []) {
      for (const spot of day?.spots ?? []) {
        if (spot?.status !== "available" || typeof spot?.start_time !== "string") continue;
        slots.push(spot.start_time);
      }
    }

    if (slots.length === 0) return degraded("no_available_spots_in_range");
    return ok(slots);
  };

  const readGoogle = async (parsed) => {
    // calendar.google.com/calendar/appointments/<scheduleId>= states it; the
    // short calendar.app.google/<id> link has to be followed to find it.
    let scheduleId = null;
    const direct = /\\/calendar\\/appointments\\/([A-Za-z0-9_-]+=*)/.exec(parsed.pathname);
    if (direct) scheduleId = direct[1];

    if (!scheduleId) {
      let html;
      try {
        const res = await fetch(parsed.toString(), {
          redirect: "follow",
          headers: { "user-agent": BROWSER_UA },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return degraded("google_page_fetch_http_" + res.status);
        html = await res.text();
      } catch (err) {
        return degraded("google_page_fetch_failed: " + errText(err));
      }
      const found = /\\/calendar\\/appointments\\/([A-Za-z0-9_-]+=*)/.exec(html);
      if (!found) return degraded("google_schedule_id_not_found");
      scheduleId = found[1];
    }

    const rpc = async (method, body) => {
      const res = await fetch(GOOGLE_RPC + method, {
        method: "POST",
        headers: {
          "content-type": "application/json+protobuf",
          "x-goog-api-key": GOOGLE_API_KEY,
          origin: "https://calendar.google.com",
          referer: "https://calendar.google.com/",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      return res;
    };

    let serviceId = null;
    try {
      const res = await rpc("ListAppointmentServiceDefinitions", [null, scheduleId]);
      if (!res.ok) return degraded("google_service_definitions_http_" + res.status);
      const body = await res.json();
      // Positional protobuf-JSON: the service id is the 7th field of the first
      // definition. Nothing names it, so it is read by position.
      const definition = body?.[0]?.[0];
      const candidate = definition?.[6];
      if (typeof candidate === "string" && candidate) serviceId = candidate;
    } catch (err) {
      return degraded("google_service_definitions_failed: " + errText(err));
    }
    if (!serviceId) return degraded("google_service_definitions_returned_no_service");

    let body;
    try {
      const res = await rpc("ListAvailableSlots", [
        null, null, serviceId, null,
        [[Math.floor(startDate.getTime() / 1000)], [Math.floor(endDate.getTime() / 1000)]],
      ]);
      if (!res.ok) return degraded("google_slots_http_" + res.status);
      body = await res.json();
    } catch (err) {
      return degraded("google_slots_failed: " + errText(err));
    }

    const slots = [];
    for (const entry of body?.[0] ?? []) {
      // Each slot is [[["<epochSeconds>"], <durationMinutes>]].
      const seconds = Number(entry?.[0]?.[0]?.[0]);
      if (!Number.isFinite(seconds) || seconds <= 0) continue;
      let iso;
      try {
        iso = toOffsetIso(seconds, tz);
      } catch (err) {
        return degraded("google_timezone_conversion_failed: " + errText(err));
      }
      slots.push(iso);
    }

    if (slots.length === 0) return degraded("google_no_slots_in_range");
    return ok(slots);
  };

  const readGoHighLevel = async (parsed) => {
    let html;
    try {
      const res = await fetch(parsed.toString(), {
        redirect: "follow",
        headers: { "user-agent": BROWSER_UA },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return degraded("booking_page_fetch_http_" + res.status);
      html = await res.text();
    } catch (err) {
      return degraded("booking_page_fetch_failed: " + errText(err));
    }

    if (!/leadconnectorhq/i.test(html)) return degraded("unsupported_provider");

    // The page payload is a flattened array of indices, so the calendar id is
    // not adjacent to its own key. Take the ids that appear after the first
    // mention of one, in page order, and let the vendor say which is real: a
    // wrong id answers 404, so nothing here is guessed at.
    const keyAt = html.search(/calendarId/i);
    const window = keyAt >= 0 ? html.slice(keyAt, keyAt + 4000) : html;
    const candidates = [];
    for (const m of window.matchAll(/"([A-Za-z0-9]{20})"/g)) {
      if (!candidates.includes(m[1])) candidates.push(m[1]);
      if (candidates.length >= 3) break;
    }
    if (candidates.length === 0) return degraded("gohighlevel_calendar_id_not_found");

    // duration is omitted on purpose: the vendor applies the calendar's own.
    const query = "?startDate=" + startDate.getTime() + "&endDate=" + endDate.getTime() +
      "&timezone=" + encodeURIComponent(tz) + "&sendSeatsPerSlot=false";

    let payload = null;
    let readOn = null;
    let lastStatus = null;
    let lastError = null;
    for (const calendarId of candidates) {
      try {
        const res = await fetch(
          "https://backend.leadconnectorhq.com/calendars/" + encodeURIComponent(calendarId) + "/free-slots" + query,
          { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) },
        );
        lastStatus = res.status;
        if (!res.ok) continue;
        payload = await res.json();
        readOn = calendarId;
        break;
      } catch (err) {
        lastError = errText(err);
      }
    }
    if (!payload) {
      if (lastError) return degraded("gohighlevel_free_slots_failed: " + lastError);
      return degraded("gohighlevel_free_slots_http_" + String(lastStatus));
    }

    const slots = [];
    // One key per day, plus a sibling traceId that is not a day.
    for (const key of Object.keys(payload).sort()) {
      const day = payload[key];
      if (!day || typeof day !== "object" || !Array.isArray(day.slots)) continue;
      for (const slot of day.slots) {
        if (typeof slot !== "string" || !slot) continue;
        slots.push(slot);
      }
    }

    if (slots.length === 0) return degraded("gohighlevel_no_slots_in_range");
    return ok(slots, readOn);
  };

  if (typeof bookingUrl !== "string" || !bookingUrl.trim()) return degraded("no_booking_url");

  let parsed;
  try {
    parsed = new URL(bookingUrl.trim());
  } catch {
    return degraded("booking_url_unparseable");
  }
  const host = parsed.hostname.toLowerCase();

  try {
    if (/(^|\\.)calendly\\.com$/.test(host)) return await readCalendly(parsed);
    if (host === "calendar.app.google" || host === "calendar.google.com") return await readGoogle(parsed);
    // GoHighLevel booking pages live on the client's own domain, so the page
    // itself is the only thing that can identify one. Anything else degrades.
    return await readGoHighLevel(parsed);
  } catch (err) {
    return degraded("unexpected_error: " + errText(err));
  }
}
`.trim();

/**
 * The booking-slots script with its three bounds inlined.
 *
 * They are inlined rather than passed through `inputMapping` because a Windmill
 * input transform carries the value it is given, and a DAG's inputMapping states
 * strings — a lookahead handed over as `"14"` would silently fall through the
 * script's own number check and take a default nobody chose.
 */
export function readBookingSlotsCode(): string {
  return READ_BOOKING_SLOTS_TEMPLATE
    .replace("LOOKAHEAD_DAYS", String(SLOT_LOOKAHEAD_DAYS))
    .replace("SLOTS_PER_DAY", String(SLOTS_PER_DAY))
    .replace("MAX_SLOTS", String(SLOT_CANDIDATES));
}
