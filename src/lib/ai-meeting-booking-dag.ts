/**
 * The DAG of the `ai-meeting-booking` channel.
 *
 * One run answers EXACTLY ONE prospect who is owed a message on this campaign:
 * it claims them, reads what they wrote and what we already sent, drafts an
 * answer to the question they actually asked, offers two concrete slots taken
 * from the brand's booking page in the prospect's own timezone, sends it as a
 * reply in their existing thread, and only THEN records what it did and when
 * the next follow-up is owed.
 *
 * Three things this DAG deliberately does NOT do, because another service
 * already owns them:
 *
 *  - It does not decide WHO to answer, in what order, or when to stop. That is
 *    lead-service's follow-up queue: `POST /orgs/campaigns/{predecessorCampaignId}/followups/claim-next`
 *    hands out at most one person, exactly once, oldest-due-first, with an
 *    atomic claim — so two concurrent runs can never answer the same person.
 *  - It does not resolve WHICH MAILBOX answers. instantly-service reads that
 *    off the mailbox that originally contacted the prospect; a caller-supplied
 *    from-address is exactly the failure `POST /orgs/replies` exists to prevent.
 *  - It does not compute the next due date by a fixed ladder. The date is
 *    chosen per lead, because a prospect who writes "recontact me in January"
 *    must be honoured; lead-service stores it rather than deriving it.
 *
 * ONE MORE THING IT DOES NOT OWN, and it is the reason this workflow answered
 * nobody for its first two weeks: WHICH CAMPAIGN holds the person. An offer is
 * sold over several LEGS and campaign-service mints one campaign per leg, so the prospect
 * this run must answer replied to the PREVIOUS leg — the cold email — and the
 * person, the thread and the record of what we owe them are all filed under
 * THAT campaign. Asking this workflow's own campaign for them finds nobody,
 * every run, forever, and "nobody due" is indistinguishable from there being
 * nothing to do, which is why it went unnoticed.
 *
 * So the flow RESOLVES the preceding leg's campaign itself, before it claims
 * anyone: `GET /internal/campaigns/{campaignId}/predecessor` states it, or
 * NAMES why there is none. It is resolved by the flow rather than handed to it
 * because most runs are scheduled and have no trigger to hand anything over.
 * Every lead-facing hop — the claim, the lead read, the conversation read, the
 * reply — then names the PREDECESSOR's campaign. The gate, the run accounting
 * and the offer read keep naming the campaign this run was DISPATCHED
 * for: money belongs to the leg that spends it.
 *
 * There is deliberately NO fallback to this run's own campaign when there is no
 * predecessor. That is precisely the behaviour that claimed nobody and 404'd,
 * and making it the fallback would hide the failure a second time. A run with
 * no predecessor ends on its own named branch, having sent nothing.
 *
 * A RUN THAT SENDS NOTHING IS NOT A FAILED RUN. Three of the branches below end
 * cleanly with the prospect never hearing from us, and in every case that is
 * the correct outcome rather than a degradation:
 *
 *  - The model says NO REPLY IS OWED. Their last message declined, asked us to
 *    stop, said it was sent in error, or said goodbye without asking anything. Until this outcome existed the model had two exits,
 *    "answer" and "escalate", and a refusal is neither — so it escalated, and the
 *    agency was told a prospect "asked something we cannot answer" about a
 *    message that asked nothing (run 84278834, 2026-09-28). Now the flow sends
 *    nothing, escalates nothing, and states `kind: "stopped"` on the person's
 *    follow-up schedule in lead-service (reason `no_reply_owed`), so the ladder
 *    does not claim them again. A stop is not a tombstone: if they write again,
 *    whoever observes that reply re-schedules them. Which messages are owed a
 *    reply is the model's judgement — no keyword list decides it.
 *  - The model says it CANNOT answer what they asked. Its schema used to
 *    REQUIRE a reply body, so the only move left to it was a deflection back to
 *    the call, and the follow-up ladder then did it again on the next rung —
 *    the prospect gets pestered and a question a person could have answered in
 *    one line never reaches one. `decision: "escalate"` is a first-class
 *    answer: the flow sends the prospect nothing and calls
 *    `POST /orgs/replies/escalate`, which forwards the exchange to the agency
 *    inbox NAMING THE QUESTION IN THE PROSPECT'S OWN WORDS and stops the ladder
 *    itself. No follow-up is recorded: nothing was sent, and the schedule is
 *    being emptied rather than advanced. Whether a question is answerable is a
 *    judgement about what the brand facts contain, so it is the model's and
 *    there is deliberately no keyword or regex pre-filter anywhere here.
 *  - instantly-service refuses the send with `409 human_took_over`, because a
 *    PERSON has answered the thread since the prospect last wrote. We stood
 *    down; the run ends clean, again recording no follow-up. Every reply this
 *    flow sends declares `sent_by: "automation"` so that gate can see it.
 *
 * ONE REPLY THAT ENDS THE CONVERSATION RATHER THAN MOVING IT. A prospect who
 * writes that they booked, scheduled or moved the meeting is owed a short
 * confirmation and nothing else: `decision: "confirm_booking"`. The model
 * thanks them, confirms the time in their words if they gave one, and asks for
 * nothing. It rides the SAME send as an answer (same takeover gate, same
 * `sent_by`), and only after the send lands are their follow-ups STOPPED
 * (reason `booking_confirmed`) instead of advanced — there is nothing left to
 * follow up on. Before this outcome existed the prompt filed "thanks" under the
 * goodbyes, so "Scheduled a call for Friday! Thank you" got silence
 * (Doc Dinners, 2026-09-28). Whether a message confirms a booking is the
 * model's judgement, like every other exit.
 *
 * AN ANSWER IS BUILT FROM FACTS, IN THREE FIXED STEPS — never a tool loop.
 * (1) The model lists what their last message asks (`list-questions`). (2)
 * brand-service is read once for the answers: what the CUSTOMER stated (offer
 * answers, confirmed offer and brand user-fields) is EXACT; what extract-fields
 * reads off the brand's site (one field per question, plus how the offer works)
 * is INTERPRETED. `gather-facts` tags and logs every fact with that provenance
 * and an id (E1.., I1..); an operator PLACEHOLDER answer is withheld, never a
 * fact. (3) The draft answers only from those facts, speaking as the team that
 * runs the offer (first person, never "our site says"), and cites per question
 * the fact ids it used; `ground-draft` turns any answer that cites no real fact
 * into an escalation naming exactly the unanswered question(s), so the client is
 * asked rather than the prospect told something invented or hedged. Either a
 * fact is solid enough to state as our own, or its question escalates: there is
 * no hedged middle. Everything downstream reads `ground-draft`, never the raw
 * draft.
 *
 * SOME THREADS ARE A GAME. When step 1 reads that the outreach which opened
 * the thread is one with a playbook (`PLAYBOOKS`), the draft is given that
 * game's STRATEGY (`ACQUISITION_QUESTIONS_PLAYBOOK`) and adapts it; it may then
 * answer "who are you" from the playbook (source `playbook`) and thank-and-stop
 * a prospect who already has the problem solved (`close_with_thanks`).
 *
 * The single stated degradation: if the booking page cannot be read, the reply
 * still goes out with the plain booking link and no slots, logged loudly.
 * Everything else fails loud and lands on the error branch — including every
 * OTHER 409 from the send (`no_reply_to_thread`, `sending_account_unresolved`,
 * `mailbox_credential_unavailable`), which is why the takeover is told apart by
 * its CODE and never by its status.
 */

import type { DAG } from "./dag-validator.js";

/**
 * The instantly-service read of the conversation being answered.
 *
 * instantly-service owns this contract — these three constants are read off its
 * DEPLOYED OpenAPI spec (the API registry mirrors it), never guessed, because
 * `validateWorkflowEndpoints` resolves the live spec on every write path and a
 * path that does not exist there is a 400 at creation time.
 */
export const CONVERSATION_READ = {
  service: "instantly",
  method: "GET",
  path: "/orgs/conversations",
} as const;

/**
 * The campaign-service read that states which campaign ran the PRECEDING leg of
 * this offer — the one that actually holds the prospect, the thread and the
 * debt.
 *
 * Service api-key, no org headers. `predecessor` is null exactly when `absence`
 * is non-null, and `absence` names the reason (`entry_leg`,
 * `no_campaign_for_preceding_leg`, `campaign_states_no_*`). "There is none" and
 * "it could not be worked out" are deliberately different answers on that
 * endpoint: the second is a 409 or a 502, which fails this node loud and lands
 * on the error branch rather than being mistaken for an empty queue.
 */
export const PREDECESSOR_READ = {
  service: "campaign",
  method: "GET",
  path: "/internal/campaigns/{campaignId}/predecessor",
} as const;

/**
 * The campaign every LEAD-FACING hop names. Not `flow_input.campaignId` — that
 * is the campaign this run was dispatched for, which is the leg that PAYS, not
 * the leg that holds the person.
 */
export const PREDECESSOR_CAMPAIGN_REF =
  "$ref:predecessor-campaign.output.predecessor.campaignId";

/**
 * States, in the log, that this campaign has no preceding leg to answer on.
 *
 * `/end-run` carries no reason field, so this is where the reason is said. The
 * run then ends as a FAILURE (`success: false`) rather than as "nobody due":
 * a campaign that cannot resolve its predecessor is misconfigured, not idle,
 * and reporting it as idle is exactly how this went unnoticed for two weeks.
 * It never stops the campaign — that is the customer's statement, not ours.
 */
export const NAME_MISSING_PREDECESSOR_CODE = `
export async function main(predecessorRead, campaignId) {
  const absence = predecessorRead?.absence ?? "unknown";
  console.error("[ai-meeting-booking] campaign " + String(campaignId) +
    " has no preceding leg to answer on (absence=" + absence +
    "); nobody was claimed and nothing was sent");
  return { absence, campaignId: campaignId ?? null };
}
`.trim();

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
  const ok = (slots) => ({ bookingUrl, timezone: tz, slots: spreadAcrossDays(slots), degraded: false, degradedReason: null });

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
    return ok(slots);
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

/**
 * STEP 1 OF ANSWERING: list what the prospect asked, before anything is looked up.
 *
 * The owner's design is a FIXED three-step workflow, never a tool loop: (1) the
 * model reads their last message and lists each question as a short item,
 * (2) brand-service is read for the answers in one pass, (3) the reply is drafted
 * with only what was found. This script builds the message for step 1. Which
 * sentences are questions is the model's reading — no keyword list decides it.
 *
 * Timing ("can we talk Thursday?") is deliberately NOT listed: the booking
 * section already answers it, and a scheduling preference must never become an
 * "unanswered question" that escalates.
 *
 * The same read also names WHO WE SAID WE WERE in this thread (`identity`). The
 * sequences that open these threads are written by different prompts, and they
 * do not agree: some write as the client ("I'm with [Client]"), some as an
 * outside representative ("I work with Doc Dinners", signed by the agency), and
 * some never name the client at all. The reply must keep the identity the
 * prospect was already given, so the emails we sent are the ground truth: the
 * model reads them, no keyword list does. A thread it cannot tell is `unclear`,
 * and nothing is sent on it.
 */
export const COMPOSE_QUESTIONS_PROMPT_CODE = `
export async function main(conversation, offer, brand) {
  const messages = conversation?.conversation?.messages ?? [];
  const transcript = messages.map((m) => {
    const who = m?.direction === "inbound" ? "PROSPECT" : "US";
    return who + ":\\n" + String(m?.text ?? "").trim();
  }).join("\\n\\n---\\n\\n");

  const message = [
    "Below is an email thread between us and a prospect" + (offer?.name ? " about \\"" + offer.name + "\\"" : "") + ".",
    "",
    transcript || "(no messages on record)",
    "",
    "Read the prospect's LAST message only. List every question they ask, and every request for information they make about what we sell",
    "(\\"send me more information on how it works\\" is a request for information: list it as \\"How does it work?\\").",
    "Write each as one short question, close to their own words. One item per distinct thing they want to know.",
    "Do NOT list: when they can meet or any scheduling, a refusal, a request to stop, a thank-you, a goodbye, or a statement that asks nothing.",
    "If they ask nothing, return an empty list.",
    "",
    "Then read the messages WE sent (marked US), signatures included, and say how they presented the sender relative to our client" +
      (brand?.brand?.name ? ", " + brand.brand.name : "") + ". Return identity.stance:",
    "- insider: the sender writes AS our client, as part of it (\\"I'm with [client]\\", \\"I'm [name] at [client]\\", \\"our company\\" meaning the client).",
    "- external: the sender works with or represents our client from outside it (\\"I work with [client]\\", \\"I represent these folks\\", an agency signature).",
    "- blind: our messages never name our client at all.",
    "- unclear: there is no message from us on record, or our messages name the client but give no way to tell which of the above, or contradict each other.",
    "Put in identity.evidence the words from our messages that decided it, quoted exactly (empty for unclear when there are none).",
    "",
    "Last, say which outreach opened this thread, from the messages WE sent. Return playbook:",
    "- acquisition_questions: our messages introduced us as working on customer (or patient) acquisition for businesses like theirs, and asked them what they would charge per person if we sent them a group of people for one specific service, and/or what happens today when someone calls them while they are busy (voicemail, a receptionist, an AI).",
    "- none: anything else.",
  ].join("\\n");

  const systemPrompt = "You read one email and list the questions in it, and you say how our side of the thread presented itself and which outreach opened it. You never answer the questions and you never invent one.";
  return { message, systemPrompt };
}
`.trim();

/** The identities a thread can have given the prospect; see COMPOSE_QUESTIONS_PROMPT_CODE. */
export const STANCES = ["insider", "external", "blind", "unclear"] as const;

/**
 * The outreach that opened the thread, when it is one the reply has to PLAY
 * rather than merely continue. Read off the messages we sent by the step-1
 * model, like the identity: the sequences are LLM-written per lead, so no
 * phrase or template id names them reliably, and the thread is what the
 * prospect actually read. `none` is every thread today but those below.
 */
export const PLAYBOOKS = ["acquisition_questions", "none"] as const;

/** What the step-1 model returns: the questions, and who we said we were. */
export const QUESTIONS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      description: "Each question or request for information in their last message, as one short question. Empty when they ask nothing.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string", description: "One short question, close to their own words." },
        },
        required: ["question"],
      },
    },
    identity: {
      type: "object",
      additionalProperties: false,
      description: "How the messages we sent presented the sender relative to our client.",
      properties: {
        stance: { type: "string", enum: [...STANCES] },
        evidence: { type: "string", description: "The words from our messages that decided it, quoted exactly." },
      },
      required: ["stance", "evidence"],
    },
    playbook: {
      type: "string",
      enum: [...PLAYBOOKS],
      description: "Which outreach opened this thread, read off the messages we sent.",
    },
  },
  required: ["questions", "identity", "playbook"],
} as const;

/**
 * The brand-service extraction key for "how the offer works", read on every
 * run. It is cached by brand-service for 30 days per brand, so it costs a
 * scrape once a month, and it is what an "how does it work?" request needs.
 * It also keeps `fields` non-empty when the prospect asked nothing, so the
 * extraction call needs no conditional branch of its own.
 */
export const OFFER_OVERVIEW_KEY = "offerHowItWorks";

/**
 * Turns the listed questions into ONE extract-fields request: the overview,
 * plus one field per question whose description IS the question. brand-service
 * then reads the brand's own site for each. `mode: "extract"` is stated in the
 * node config and must stay: it returns "Unknown" when the site is silent,
 * where `suggest` would WRITE a plausible answer — an invented fact.
 */
export const PLAN_LOOKUPS_CODE = `
export async function main(listed, offer) {
  const raw = listed?.json?.questions;
  if (!Array.isArray(raw)) {
    throw new Error("[ai-meeting-booking] the question-listing step returned no questions array; refusing to draft without knowing what they asked");
  }
  const questions = raw
    .map((q) => String(q?.question ?? "").trim())
    .filter((q) => q.length > 0)
    .slice(0, 10)
    .map((question, i) => ({ key: "q" + (i + 1), question }));

  const stance = listed?.json?.identity?.stance;
  if (!STANCES_LIST.includes(stance)) {
    throw new Error("[ai-meeting-booking] the question-listing step named no identity stance (" + JSON.stringify(stance) +
      "); refusing to draft without knowing who we told them we are");
  }
  const identity = { stance, evidence: String(listed.json.identity.evidence ?? "") };
  console.log("[ai-meeting-booking] identity given to the prospect in this thread: " + JSON.stringify(identity));

  const playbook = listed?.json?.playbook;
  if (!PLAYBOOKS_LIST.includes(playbook)) {
    throw new Error("[ai-meeting-booking] the question-listing step named no playbook (" + JSON.stringify(playbook) +
      "); refusing to draft without knowing which outreach opened the thread");
  }
  console.log("[ai-meeting-booking] outreach that opened this thread: " + playbook);

  const about = offer?.name ? "\\"" + offer.name + "\\"" : "what the brand sells";
  const fields = [
    {
      key: "OVERVIEW_KEY",
      description: "How " + about + " works, as the brand's own website describes it: what the customer gets, the steps, who it is for. " +
        "Use only what the site says. If the site does not describe it, return Unknown.",
    },
    ...questions.map((q) => ({
      key: q.key,
      description: "The answer the brand's own website gives to this question a prospect asked about " + about + ": \\"" + q.question + "\\". " +
        "Use only what the site says, as close to its wording as possible. If the site does not answer it, return Unknown.",
    })),
  ];
  return { questions, fields, identity, playbook };
}
`.trim()
  .replace("OVERVIEW_KEY", OFFER_OVERVIEW_KEY)
  .replace("STANCES_LIST", JSON.stringify(STANCES))
  .replace("PLAYBOOKS_LIST", JSON.stringify(PLAYBOOKS));

/**
 * STEP 2's assembly: every fact brand-service holds that could answer them,
 * each tagged with its PROVENANCE, so a person auditing the run can see why a
 * fact was said.
 *
 *  - `exact` — what the CUSTOMER stated: the offer's answers (question/answer
 *    pairs), and the offer's and brand's user-fields whose provenance is
 *    `confirmed`. The model may state these as fact.
 *  - `interpreted` — what was READ OFF the brand's site: the extraction for each
 *    question and for the overview, and user-fields still `suggested` (an
 *    auto-extract prefill nobody confirmed). They only fill gaps the exact
 *    facts leave, and only when solid enough to state as our own.
 *
 * Every fact gets an id (E1.. exact, I1.. interpreted) that the draft cites and
 * `ground-draft` checks.
 *
 * Empty values ("Unknown", "", [], null) are dropped, never shown as a blank:
 * "the site says nothing" is a missing fact, not a fact.
 *
 * An operator PLACEHOLDER is no answer either. brand-service serves offer
 * answers as bare `{question, answer}` pairs with no status or provenance, and
 * Doc Dinners' "How much is it?" / "What is included?" hold
 * "PLACEHOLDER — not a real answer, do not quote this to anyone...". Filed as an
 * EXACT fact, a price question would be answered from it. With no field to read,
 * the literal marker (a value opening with the word PLACEHOLDER) is matched, on
 * every source; the pair is WITHHELD — never in the prompt as a fact, listed only
 * as a thing our client has not answered yet, so a question it would have covered
 * escalates. A per-answer status on brand-service's answers read would make this
 * match unnecessary.
 */
export const GATHER_FACTS_CODE = `
export async function main(plan, offerAnswers, offerFields, brandFields, extracted) {
  const isEmpty = (v) => {
    if (v === null || v === undefined) return true;
    if (typeof v === "string") return v.trim() === "" || /^unknown$/i.test(v.trim());
    if (Array.isArray(v)) return v.length === 0 || v.every(isEmpty);
    if (typeof v === "object") return Object.keys(v).length === 0;
    return false;
  };
  const isPlaceholder = (v) => typeof v === "string" && /^\\s*placeholder\\b/i.test(v);
  const render = (v) => {
    if (typeof v === "string") return v.trim();
    if (Array.isArray(v)) return v.filter((x) => !isEmpty(x)).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("; ");
    return JSON.stringify(v);
  };

  const exact = [];
  const interpreted = [];
  const withheld = [];
  const addExact = (f) => exact.push({ id: "E" + (exact.length + 1), ...f });
  const addInterpreted = (f) => interpreted.push({ id: "I" + (interpreted.length + 1), ...f });

  for (const a of offerAnswers?.answers ?? []) {
    if (isEmpty(a?.question) || isEmpty(a?.answer)) continue;
    if (isPlaceholder(a.answer)) {
      withheld.push({ source: "offer-answers", label: String(a.question).trim() });
      continue;
    }
    addExact({ source: "offer-answers", label: String(a.question).trim(), value: String(a.answer).trim() });
  }

  const seenConfirmed = new Set();
  for (const [scope, read] of [["offer-user-fields", offerFields], ["brand-user-fields", brandFields]]) {
    for (const [key, field] of Object.entries(read?.fields ?? {})) {
      if (isEmpty(field?.value)) continue;
      const value = render(field.value);
      if (isPlaceholder(value)) {
        withheld.push({ source: scope, label: key });
        continue;
      }
      if (field?.provenance === "confirmed") {
        if (seenConfirmed.has(key + "::" + value)) continue;
        seenConfirmed.add(key + "::" + value);
        addExact({ source: scope, label: key, value });
      } else if (scope === "offer-user-fields") {
        // The suggested prefill is brand-wide and identical on both reads;
        // listing it once is enough.
        addInterpreted({ source: "site-prefill", label: key, value });
      }
    }
  }

  const extractedFields = extracted?.fields ?? {};
  const overview = extractedFields["OVERVIEW_KEY"]?.value;
  if (!isEmpty(overview) && !isPlaceholder(render(overview))) {
    addInterpreted({ source: "site-extraction", label: "how the offer works", value: render(overview) });
  }

  const questions = (plan?.questions ?? []).map((q) => {
    const v = extractedFields[q.key]?.value;
    const siteAnswer = isEmpty(v) || isPlaceholder(render(v)) ? null : render(v);
    if (siteAnswer) addInterpreted({ source: "site-extraction", label: q.question, value: siteAnswer, questionKey: q.key });
    return { key: q.key, question: q.question, siteAnswer };
  });

  const facts = { questions, exact, interpreted, withheld };
  if (withheld.length) {
    console.error("[ai-meeting-booking] withheld operator PLACEHOLDER answer(s), not facts: " + JSON.stringify(withheld));
  }
  console.log("[ai-meeting-booking] facts gathered for the reply (provenance: exact = stated by the customer, interpreted = read off the site): " + JSON.stringify(facts));
  return facts;
}
`.trim().replace("OVERVIEW_KEY", OFFER_OVERVIEW_KEY);

/**
 * STEP 3's guard: a question the facts do not answer is NEVER answered.
 *
 * The draft states, per listed question, where its answer came from
 * (`exact` | `interpreted` | `booking` | `none`) and the ids of the facts it
 * used. This script holds the model to it with no reading of anyone's text: a
 * question marked `none`, a question the draft did not account for, or an
 * `exact`/`interpreted` answer that cites no existing fact of that kind (a fact
 * the model would not own, a withheld placeholder, an invented id) turns an
 * `answer` into an `escalate` naming exactly those questions, so the client is
 * asked rather than the prospect being told something invented. Every other
 * decision passes through untouched.
 *
 * It also holds the reply to the identity the thread gave the prospect, the two
 * ways a rule can: a thread whose identity is `unclear` never gets a written
 * reply (answer or booking confirmation turn into an escalation), and a `blind`
 * thread never gets one that names the client, the offer, or a domain of theirs
 * (brand domain, site, booking page). The VOICE itself (insider "we" versus
 * external "they") is the prompt's job and is not policed by string matching. Its output keeps the draft's `{ json }`
 * shape, so every node downstream reads it exactly as it read the draft.
 */
export const GROUND_DRAFT_CODE = `
export async function main(draft, facts, identity, offer, brand, playbook) {
  const json = { ...(draft?.json ?? {}) };

  // No em dash or en dash ever reaches a prospect, whatever the model wrote:
  // a dash between two numbers is a hyphen, any other one a comma.
  if (typeof json.replyHtml === "string") {
    const before = json.replyHtml;
    json.replyHtml = before
      .replace(/&(mdash|ndash);|&#(8212|8211|x2014|x2013);/gi, (m) => (/mdash|8212|2014/i.test(m) ? "\\u2014" : "\\u2013"))
      .replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-")
      .replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ");
    if (json.replyHtml !== before) {
      console.error("[ai-meeting-booking] the draft used a dash a prospect must never read; rewritten before anything is sent");
    }
  }
  const writes = json.decision === "answer" || json.decision === "confirm_booking" || json.decision === "close_with_thanks";

  // An identity we could not read off the thread is never guessed at.
  if (writes && identity?.stance === "unclear") {
    const asked = String(json.question ?? "").trim() || "(their last message)";
    console.error("[ai-meeting-booking] our identity in this thread is unclear; nothing is sent and the thread is escalated");
    return {
      json: { decision: "escalate", question: asked, reason: "Our identity in this thread is unclear (insider, external or unnamed), so a person answers in the right voice.", answers: json.answers ?? [] },
      overridden: true,
      audit: [],
    };
  }

  // A blind thread never names the client: a reply that would is not sent.
  if (writes && identity?.stance === "blind") {
    const host = (u) => { try { return new URL(/^https?:/i.test(u) ? u : "https://" + u).hostname.replace(/^www\\./i, ""); } catch (e) { return null; } };
    const b = brand?.brand ?? {};
    const terms = [b.name, offer?.name, host(String(b.domain ?? "")), host(String(b.url ?? "")), host(String(offer?.bookingUrl ?? ""))]
      .filter((t) => typeof t === "string" && t.trim().length > 2);
    const text = String(json.replyHtml ?? "").toLowerCase();
    const leaked = [...new Set(terms.filter((t) => text.includes(t.toLowerCase())))];
    if (leaked.length > 0) {
      const asked = String(json.question ?? "").trim() || "(their last message)";
      console.error("[ai-meeting-booking] the draft names our client in a blind thread (" + leaked.join(", ") + "); nothing is sent and the thread is escalated");
      return {
        json: { decision: "escalate", question: asked, reason: "The draft would have named our client in a thread that never named them: " + leaked.join(", "), answers: json.answers ?? [] },
        overridden: true,
        audit: [],
      };
    }
  }

  const listed = facts?.questions ?? [];
  const ids = {
    exact: new Set((facts?.exact ?? []).map((f) => String(f?.id))),
    interpreted: new Set((facts?.interpreted ?? []).map((f) => String(f?.id))),
  };
  const declared = new Map((Array.isArray(json.answers) ? json.answers : []).map((a) => [String(a?.key), a ?? {}]));

  const audit = listed.map((q) => {
    const a = declared.get(q.key) ?? {};
    let source = String(a.source ?? "none");
    const cited = Array.isArray(a.facts) ? a.facts.map(String) : [];
    // "playbook" answers only exist in a thread that sequence opened (who we
    // are, whether we hold a group of customers): elsewhere it is no source.
    const sources = playbook === "acquisition_questions" ? ["exact", "interpreted", "booking", "playbook"] : ["exact", "interpreted", "booking"];
    if (!sources.includes(source)) source = "none";
    if ((source === "exact" || source === "interpreted") && !cited.some((id) => ids[source].has(id))) source = "none";
    return { key: q.key, question: q.question, source, facts: cited };
  });
  const unanswered = audit.filter((a) => a.source === "none");

  if (json.decision === "answer" && unanswered.length > 0) {
    const asked = unanswered.map((a) => a.question).join(" / ");
    console.error("[ai-meeting-booking] the draft would answer questions no fact covers (" + asked +
      "); nothing is sent and the thread is escalated with those questions");
    const grounded = {
      decision: "escalate",
      question: asked,
      reason: "No fact in brand-service answers: " + asked,
      answers: json.answers ?? [],
    };
    return { json: grounded, overridden: true, audit };
  }

  console.log("[ai-meeting-booking] grounding audit (decision=" + String(json.decision) + "): " + JSON.stringify(audit));
  return { json, overridden: false, audit };
}
`.trim();

/**
 * THE GAME of a thread opened by the acquisition-questions cold sequence
 * (`scripts/fork-acquisition-questions-sequence.mjs`, owner-approved
 * 2026-10-03). That sequence introduces us as a customer acquisition agency and
 * asks two questions; their answers are the pitch. The reply is given the
 * STRATEGY, never a canned reply per case (owner rule: explain the game so the
 * model adapts). Keep it in agreement with the sequence's own text.
 *
 * Two exits it relies on: `close_with_thanks` (they already have the problem
 * solved: one thank-you, then their follow-ups stop) and the `playbook` answer
 * source (who we are, whether we hold a group: answered from this strategy,
 * not from a brand fact, which `ground-draft` accepts only in such a thread).
 */
export const ACQUISITION_QUESTIONS_PLAYBOOK = [
  "This prospect was contacted by a sequence where we introduced ourselves as a customer acquisition agency and asked two things: what they would charge per person if we sent them a group of customers for one specific service, and what happens today when a customer calls them while they are busy (voicemail, receptionist, AI).",
  "The game: their answers are the pitch. Their price tells us what one lost customer costs them. Their phone answer tells us whether they lose customers today. Our client's product recovers exactly those customers. So the customers we \"bring\" are real: they already call, and the product stops them from going to a competitor.",
  "How to play it once they reply:",
  "- An answer to our questions (a price, how their calls are handled) is owed a reply even when it asks nothing back: set decision to answer.",
  "- Turn their own figures into the reason to care (their price x the customers they miss). Never invent a figure they did not give or the facts in front of you do not state.",
  "- If they already have the problem solved (an AI or someone always answers), thank them and stop: set decision to close_with_thanks and write one or two sentences of thanks that ask for nothing.",
  "- If they ask who we are or ask for the group: be straight. We do not hold a group of customers today; the customers we mean are the ones already calling them. Then make the intro offer. A question answered this way takes source playbook in answers.",
  "- Never claim anyone chose, called or visited them. Never imply we will send people we do not have.",
  "- The ask is always light: an intro to the team behind the product, answerable in one line. Until they have said yes to that intro, it REPLACES proposing the meeting: no times, no link. Once they have said yes, propose the meeting as under BOOKING.",
  "- Follow up twice if they go quiet, each time with a new angle, never \"just checking in\".",
] as const;

/** How many follow-ups the acquisition-questions game sends a prospect who went quiet. */
export const PLAYBOOK_QUIET_FOLLOWUPS = 2;

/**
 * Builds the single string the model is asked to answer.
 *
 * chat-service `/complete` takes one flat `message`, so the interpolation has to
 * happen in the flow rather than in an input mapping. Everything the answer
 * depends on is assembled here and nowhere else, which is also what makes the
 * prompt readable in the stored DAG.
 *
 * It also computes `ladderNextDueAt` — the date we would owe them if they said
 * nothing about timing. The model may override it with a date the prospect
 * actually asked for; the ladder is what "grows the interval" means, and there
 * is deliberately no cap on the number of follow-ups.
 */
export const COMPOSE_REPLY_PROMPT_CODE = `
export async function main(followup, leadDetail, conversation, priorGeneration, booking, offer, brand, currentDate, facts, identity, playbook) {
  const person = leadDetail?.leadDetail?.lead ?? {};
  const timezone = booking?.timezone ?? "UTC";

  // WHO WE SAID WE WERE. The voice of the reply follows the identity our own
  // emails already gave the prospect; the facts are owned the same way in
  // every voice, only who "we" is and what may be named change.
  const stance = identity?.stance;
  if (!STANCES_LIST.includes(stance)) {
    throw new Error("[ai-meeting-booking] no identity stance for this thread (" + JSON.stringify(stance) +
      "); refusing to draft without knowing who we told them we are");
  }
  const client = brand?.brand?.name ?? "our client";
  const evidence = identity?.evidence ? " Our own words in this thread: \\"" + identity.evidence + "\\"." : "";
  const voice = {
    insider: [
      "WHO WE ARE TO THEM: in this thread we have written as " + client + " itself." + evidence,
      "Keep that identity. You speak as the team that runs this offer: \\"we\\" is " + client + ". State every fact in the first person, as our own knowledge (\\"we host...\\", \\"each event brings...\\").",
    ],
    external: [
      "WHO WE ARE TO THEM: in this thread we have presented ourselves as working WITH " + client + ", from outside it. We are not " + client + "." + evidence,
      "Keep that identity. Name " + client + " in the third person and state its facts as theirs, plainly, the way someone who works closely with them knows them (\\"" + client + " runs...\\", \\"they handle...\\", \\"each event brings...\\").",
      "\\"I\\" is the person writing. \\"We\\" may only mean the arrangement between us and the prospect (\\"we can set up a quick call\\"), never " + client + " itself: never \\"our system\\", \\"our events\\", \\"our team handles\\", \\"we host\\" for what " + client + " does.",
    ],
    blind: [
      "WHO WE ARE TO THEM: in this thread we have NEVER named our client, on purpose." + evidence,
      "Keep it that way. Never write " + client + ", never write the offer's name (\\"" + String(offer?.name ?? "") + "\\"), never write a website, a domain or a link that would reveal who they are. Refer to them the way our emails did, in the third person (\\"the team I work with\\", \\"they\\"), and restate any fact that names them without the name.",
    ],
    unclear: [
      "WHO WE ARE TO THEM: our messages in this thread do not make clear whether we wrote as " + client + ", for " + client + " from outside, or without naming them.",
      "Do not guess an identity. If a reply is owed, set decision to escalate, put what they asked in question, and say in reason that our identity in the thread is unclear. A person answers them in the right voice.",
    ],
  }[stance];

  // The whole person and company record, one line per field that HOLDS
  // something. An absent field is omitted, never printed as a blank label.
  const present = (v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === "string") return v.trim() !== "";
    if (Array.isArray(v)) return v.some(present);
    return true;
  };
  const show = (v) => (Array.isArray(v) ? v.filter(present).slice(0, 15).join(", ") : String(v).trim());
  const line = (label, v) => (present(v) ? label + ": " + show(v) : null);
  const place = (o) => [o?.city, o?.state, o?.country].filter(present).join(", ");
  const org = person.organization ?? {};
  const pastRoles = (person.employmentHistory ?? [])
    .filter((e) => e && e.current !== true && present(e.title))
    .slice(0, 5)
    .map((e) => e.title + (present(e.organizationName) ? " at " + e.organizationName : "") +
      (present(e.startDate) || present(e.endDate) ? " (" + (e.startDate ?? "?") + " to " + (e.endDate ?? "?") + ")" : ""));
  const personLines = [
    line("Name", [person.firstName, person.lastName].filter(present).join(" ")),
    line("Title", person.currentTitle),
    line("Headline", person.headline),
    line("Seniority", person.seniority),
    line("Departments", person.departments),
    line("Functions", person.functions),
    line("Based in", place(person)),
    line("Timezone", timezone),
    line("Languages", person.businessLanguages),
    line("Earlier roles", pastRoles),
    line("LinkedIn", person.linkedinUrl),
  ].filter(Boolean);
  const companyLines = [
    line("Company", org.name),
    line("Website", org.websiteUrl ?? org.primaryDomain),
    line("Industry", org.industry),
    line("Other industries", org.industries),
    line("About", org.shortDescription ?? org.seoDescription),
    line("Employees", org.estimatedNumEmployees),
    line("Annual revenue (USD)", org.annualRevenue),
    line("Founded", org.foundedYear),
    line("Headquarters", place(org)),
    line("Retail locations", org.retailLocationCount),
    line("Funding", [org.latestFundingStage, org.totalFundingPrinted].filter(present).join(", ")),
    line("Publicly traded", org.publiclyTradedSymbol),
    line("Technologies", org.technologyNames),
    line("Keywords", org.keywords),
  ].filter(Boolean);

  // What brand-service holds that could answer them, split by provenance.
  const asked = facts?.questions ?? [];
  const exactFacts = facts?.exact ?? [];
  const interpretedFacts = facts?.interpreted ?? [];
  const withheldFacts = facts?.withheld ?? [];
  const factLine = (f) => "- " + f.id + " " + f.label + ": " + f.value;
  const factsSection = asked.length === 0 ? [] : [
    "WHAT THEY ASKED (listed from their last message)",
    ...asked.map((q) => "- " + q.key + ": " + q.question),
    "",
    "EXACT FACTS: what our client stated themselves. These are the strongest facts you have.",
    exactFacts.length ? exactFacts.map(factLine).join("\\n") : "(none stated)",
    "",
    "INTERPRETED FACTS: worked out from our client's public material, less certain than the exact facts. Use one only to fill a gap the exact facts leave.",
    interpretedFacts.length ? interpretedFacts.map(factLine).join("\\n") : "(nothing found)",
    "",
    ...(withheldFacts.length ? [
      "NOT ANSWERED BY OUR CLIENT YET: anything they ask about these topics has no answer here and escalates.",
      withheldFacts.map((w) => "- " + w.label).join("\\n"),
      "",
    ] : []),
    "HOW TO ANSWER WHAT THEY ASKED",
    "Answer each listed question ONLY from the facts above (or, for when to meet, from the availability under BOOKING). Do not add anything the facts do not say.",
    "Lead with what our client stated: OPEN your answer with the exact facts that bear on the question (their results, numbers, guarantees, exclusivity), numbers exactly as stated. Interpreted facts come after, only to fill what the exact facts leave open, in a sentence or two of your own words: never paste them as a list.",
    "State every fact in the voice set under WHO WE ARE TO THEM. The facts are what we know, not something we read somewhere: never point to a website, a page, a brochure or to how anyone describes it, and never hedge a fact.",
    "Owning a fact does not license more than it says: no promise, price, guarantee or number our client did not state.",
    "Use a fact only if you would state it plainly as known. If the only fact that would answer a question is one you would not state that way, that question has no answer here.",
    "For EVERY listed question, return it in answers with its key, the source you answered it from (exact, interpreted, booking, or none), and in facts the ids of the facts you used (E1, I2, ...).",
    "If even ONE listed question has no answer in the facts above, set decision to escalate and put exactly the unanswered question(s) in question. Our client is then asked, and the prospect gets a real answer instead of a guess.",
    "",
  ];

  const messages = conversation?.conversation?.messages ?? [];
  const transcript = messages.map((m) => {
    const who = m?.direction === "inbound" ? "PROSPECT" : "US";
    const when = m?.at ? " (" + m.at + ")" : "";
    return who + when + ":\\n" + String(m?.text ?? "").trim();
  }).join("\\n\\n---\\n\\n");

  // What we sell them is the OFFER this campaign was dispatched for. An offer
  // read with no name is a broken row, not a prompt with a blank in it.
  if (!offer?.name) {
    throw new Error("[ai-meeting-booking] the campaign's offer (" + String(offer?.offerId) +
      ") has no name; refusing to answer a prospect without knowing what we sell them");
  }

  const priorSubject = priorGeneration?.generation?.subject ?? null;
  const followupCount = Number(followup?.followup?.followupCount ?? 0);

  // The interval grows: 3d, 7d, 21d, 60d, then 180d for every one after that.
  const ladder = [3, 7, 21, 60, 180];
  const ladderDays = ladder[Math.min(followupCount, ladder.length - 1)];
  const ladderNextDueAt = new Date(Date.now() + ladderDays * 86400000).toISOString();

  // THE GAME, when the outreach that opened this thread is one the reply has
  // to play (see PLAYBOOKS). The strategy is explained, never scripted per
  // case: the model adapts it to what they wrote. How many times we have
  // already written since they last did is counted off the thread, because
  // "follow up twice if they go quiet" is a count of OUR trailing messages.
  if (!PLAYBOOKS_LIST.includes(playbook)) {
    throw new Error("[ai-meeting-booking] no playbook for this thread (" + JSON.stringify(playbook) +
      "); refusing to draft without knowing which outreach opened it");
  }
  let lastInbound = -1;
  messages.forEach((m, i) => { if (m?.direction === "inbound") lastInbound = i; });
  const oursSinceTheyWrote = lastInbound === -1 ? 0 : messages.length - 1 - lastInbound;
  const quietFollowups = Math.max(0, oursSinceTheyWrote - 1);
  const quietLine = oursSinceTheyWrote === 0
    ? "Their message is the last one in the thread: this is our reply to it."
    : quietFollowups >= QUIET_FOLLOWUPS
    ? "The last message in the thread is ours and they have gone quiet. We already replied to them and followed up " + quietFollowups + " times since: that is every follow-up this game allows. Set decision to no_reply_owed and write nothing."
    : "The last message in the thread is ours and they have gone quiet. We already replied to them" + (quietFollowups > 0 ? " and followed up " + quietFollowups + " time(s) since" : "") + ". Write follow-up " + (quietFollowups + 1) + " of " + QUIET_FOLLOWUPS + ": one new angle we have not used yet in this thread, never \\"just checking in\\". Set decision to answer.";
  const gameSection = playbook !== "acquisition_questions" ? [] : [
    "THE GAME THIS THREAD IS IN",
    ...PLAYBOOK_LINES,
    quietLine,
    "",
  ];

  // Each slot is labelled with its weekday so the model can match what the
  // prospect said ("next week", "Thursday afternoon") without doing calendar
  // arithmetic. The date part is already the prospect's local date.
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const slotLines = (booking?.slots ?? []).map((s) => {
    const weekday = WEEKDAYS[new Date(String(s).slice(0, 10) + "T12:00:00Z").getUTCDay()];
    return "- " + (weekday ? weekday + " " : "") + String(s).slice(0, 10) + " " + String(s).slice(11, 16) + " (" + s + ")";
  }).join("\\n");

  // A blind thread never gives the link: a booking page names who runs it.
  const bookingSection = stance === "blind"
    ? (!booking?.degraded
        ? "Availability over the coming weeks, already converted to the prospect's own timezone (" + timezone + "), a few times per open day. Propose EXACTLY TWO of these, written out in plain words. Do NOT give any link (a booking page would reveal who our client is): if neither works, ask which times suit them and say you will send an invite. If they said when they are free, both times MUST fall inside what they said; if none of these does, propose no time and ask which times in their window suit them.\\n" + slotLines
        : "The availability could not be read (" + booking?.degradedReason + "). Do NOT invent times and do NOT give any link (it would reveal who our client is). Ask them which times suit them and say you will send an invite.")
    : booking?.degraded
    ? (booking?.bookingUrl
        ? "The booking page could not be read (" + booking.degradedReason + "). Do NOT invent times. Give them the booking link and let them pick: " + booking.bookingUrl
        : "This offer has no booking link (" + booking.degradedReason + "). Do NOT invent times and do NOT invent a link. Ask them which times suit them and say you will send an invite.")
    : "Availability over the coming weeks, already converted to the prospect's own timezone (" + timezone + "), a few times per open day. Propose EXACTLY TWO of these, written out in plain words, and give the link so they can pick another if neither works: " + booking.bookingUrl + ". If they said when they are free, both times MUST fall inside what they said; if none of these does, propose no time and give them the link to pick one in their window.\\n" + slotLines;

  const message = [
    "Today is " + (currentDate ?? new Date().toISOString().split("T")[0]) + ".",
    "",
    "You are answering one prospect who replied to the outreach we sent for our client, " + client + ", and showed interest.",
    "",
    ...voice,
    "",
    "WHO THEY ARE",
    ...personLines,
    "",
    ...(companyLines.length ? ["THEIR COMPANY", ...companyLines, ""] : []),
    "WHAT WE SELL THEM",
    "Offer: " + offer.name,
    "",
    "THE CONVERSATION SO FAR, oldest first" + (priorSubject ? " (thread subject: " + priorSubject + ")" : ""),
    transcript || "(no messages on record)",
    "",
    ...factsSection,
    ...gameSection,
    "FIRST: IS A REPLY OWED AT ALL",
    "Read their LAST message. Some messages need no answer from us: they declined or said they are not interested, asked us to stop writing, said their earlier message was sent in error, or said goodbye without asking or proposing anything.",
    "Writing back to those, even to propose the meeting, is exactly what makes us look like a machine. Set decision to no_reply_owed and write nothing: nobody hears from us, nobody is alerted, and their follow-ups stop. If they write again later, they come back on their own.",
    "A message that asks something, raises a concern we could address, or leaves the door open (\\"not now, maybe after the summer\\") IS owed a reply.",
    "",
    "WHEN THEY TELL US THE MEETING IS BOOKED",
    "If their last message says they booked, scheduled or moved the meeting, the conversation is done and they are owed one short confirmation. Set decision to confirm_booking and write one or two sentences: thank them, and confirm the day or time in their words if they gave one. Nothing else: no question, no pitch, no times, no link, no request for anything. Their follow-ups stop after it.",
    "",
    "WHEN THEY SAY WHEN THEY ARE FREE",
    "A message about WHEN they can meet (\\"I can't till next week\\", \\"after the 15th\\", \\"Thursday afternoon\\", \\"not until November\\") is a reply owed and one you can always answer: set decision to answer and offer times that fit what they said, from the availability below. If nothing there fits, give them the booking link and ask them to pick a time that suits them. A timing preference is never a reason to escalate.",
    "",
    "WHAT YOU MUST DO WHEN A REPLY IS OWED",
    "1. ANSWER THE QUESTION THEY ASKED. Read their last message and reply to what is in it. A reply that ignores what they wrote is worse than no reply at all.",
    "2. Then propose the meeting.",
    "Set decision to answer.",
    "",
    "WHEN YOU CANNOT ANSWER",
    "Everything you may state is above. If answering what they asked would mean inventing something that is not there (a price, a number of seats, a spec, a reference, a commitment nobody here has made), then you cannot answer it.",
    "In that case set decision to escalate and write nothing: no reply, no holding message, and above all no deflection back to the call. A person will take this thread over and answer them properly, and pushing the meeting again instead is exactly what makes us look like a machine.",
    "Escalate only a real question or request you cannot answer. A refusal, a request to stop, or a goodbye is not a question: that is no_reply_owed, never escalate. When they can meet is not one either: that is answer.",
    "",
    "Whatever you decide, return question: what they asked, in their own words (or, when no reply is owed, what their last message said; when you escalate, exactly the question(s) you could not answer). It is what the person taking over reads. And return reason: one short sentence on why you decided what you did.",
    "",
    "BOOKING",
    bookingSection,
    "",
    "WHEN TO COME BACK",
    "If nothing in their message says anything about timing, the next follow-up is owed on " + ladderNextDueAt + ".",
    "If they DID say something about timing (\\"recontact me in January\\", \\"we decide after the summer\\", \\"call me next week\\"), honour THAT instead and return the date they asked for.",
    "Return it as an ISO-8601 timestamp, strictly after now and no more than one year out.",
    "",
    "HOW TO WRITE IT",
    "Write only the words the prospect reads, as HTML. No signature: the mailbox that answers appends its own.",
    "Never use an em dash or an en dash. Use a comma, a period, a colon or parentheses instead.",
    "No subject line: this goes into the thread they already have.",
    "Short. Plain. The way one person writes to another.",
  ].join("\\n");

  const systemPrompt = [
    "You answer one prospect at a time, in an email thread that is already running.",
    "You are the person who has been writing to them. You are not a bot and you do not say you are one.",
    "You answer what they asked before you ask for anything.",
    "You keep the identity the prospect was already given in this thread, as you are told it, and you state what you know plainly, never as what a website or a page says.",
    "You never invent availability, prices, names, or facts that are not in front of you.",
    "When you cannot answer from what is in front of you, you say so and hand over, rather than deflecting back to the meeting.",
    "When their last message needs no answer (a refusal, a request to stop, a goodbye), you send nothing and hand nothing over.",
    "When they tell you the meeting is booked, you thank them and confirm it in a sentence or two, and ask for nothing.",
    "When you are told which game the thread is in, you play that game.",
  ].join(" ");

  return { message, systemPrompt, ladderNextDueAt, timezone, stance, playbook };
}
`.trim()
  .replace("STANCES_LIST", JSON.stringify(STANCES))
  .replace("PLAYBOOKS_LIST", JSON.stringify(PLAYBOOKS))
  .replace("PLAYBOOK_LINES", JSON.stringify(ACQUISITION_QUESTIONS_PLAYBOOK))
  .replaceAll("QUIET_FOLLOWUPS", String(PLAYBOOK_QUIET_FOLLOWUPS));

/**
 * Bounds the date the model chose against the contract lead-service publishes.
 *
 * This is NOT a fallback for data somebody failed to give us: the model's date
 * is untrusted input, and lead-service answers 400 to a date in the past or
 * further out than a year. That 400 would land AFTER the reply has already been
 * sent, leaving the person answered but with no record and no next due date —
 * their claim would expire and the queue would hand them out to be answered a
 * second time. So an unusable date falls back to the ladder date computed
 * alongside it, loudly, rather than failing the run after the irreversible step.
 */
export const RESOLVE_NEXT_DUE_CODE = `
export async function main(draft, ladderNextDueAt) {
  // This node only runs on the answer path, so a model that said it could
  // answer and then returned nothing to send is a broken contract, not a
  // degradation. It fails here — strictly BEFORE the send — rather than
  // letting an empty body reach the prospect.
  const replyHtml = draft?.json?.replyHtml;
  if (typeof replyHtml !== "string" || replyHtml.trim() === "") {
    throw new Error("[ai-meeting-booking] the model chose to write (" + String(draft?.json?.decision) +
      ") but returned no reply body; refusing to send an empty message");
  }

  // A booking confirmation ends the conversation: after it lands their
  // follow-ups are stopped, not advanced, so there is no next date to resolve.
  if (draft?.json?.decision === "confirm_booking") {
    return { nextDueAt: null, source: "booking_confirmed" };
  }
  // Same for a thank-you to a prospect who already has the problem solved.
  if (draft?.json?.decision === "close_with_thanks") {
    return { nextDueAt: null, source: "closed_with_thanks" };
  }

  const proposed = draft?.json?.nextDueAt;
  const now = Date.now();
  const ceiling = now + 365 * 86400000;
  const parsed = typeof proposed === "string" ? Date.parse(proposed) : NaN;

  if (Number.isFinite(parsed) && parsed > now && parsed <= ceiling) {
    return { nextDueAt: new Date(parsed).toISOString(), source: "prospect_stated" };
  }

  console.error("[ai-meeting-booking] the model's next-due date is unusable (" + JSON.stringify(proposed) +
    "); falling back to the growing interval " + ladderNextDueAt);
  return { nextDueAt: ladderNextDueAt, source: "interval_ladder" };
}
`.trim();

/**
 * Reads what `POST /orgs/replies` actually did, and separates the ONE refusal
 * that is a normal outcome from every other way a send can fail.
 *
 * `409 human_took_over` means a person has answered this thread since the
 * prospect last wrote, so instantly-service refused to let automation speak
 * over them. Nothing was prepared and nothing was sent; retrying would be
 * refused identically. The run ends clean and records NO follow-up — the ladder
 * belongs to whoever took the thread over now.
 *
 * Every other refusal fails LOUD, and that is why this cannot be a condition on
 * the raw status code: a 409 also carries `no_reply_to_thread`,
 * `sending_account_unresolved` and `mailbox_credential_unavailable`, which mean
 * we could not send and the run genuinely failed. Keying the clean end on the
 * status alone would swallow all three.
 *
 * A 202 is a success: the prospect's sending window is shut, so the answer is
 * queued for its next opening. It is sent as far as this run is concerned, and
 * the follow-up is recorded.
 */
export const CLASSIFY_SEND_CODE = `
export async function main(send) {
  if (send?.success === true) {
    return { outcome: "sent", status: send?.status ?? null };
  }

  let code = null;
  try {
    code = JSON.parse(String(send?.error ?? "{}"))?.code ?? null;
  } catch (err) {
    code = null;
  }

  if (send?.status === 409 && code === "human_took_over") {
    console.error("[ai-meeting-booking] a person has already answered this thread since the prospect last wrote; the automated reply was refused and no follow-up is recorded");
    return { outcome: "human_took_over", status: 409 };
  }

  throw new Error("[ai-meeting-booking] the reply could not be sent (" + String(send?.status) +
    " " + String(code) + "): " + String(send?.error));
}
`.trim();

export const FEATURE_SLUG = "ai-meeting-booking";

export interface AiMeetingBookingDagOptions {
  /** chat-service provider, e.g. "google". */
  provider: string;
  /** chat-service model alias, e.g. "pro". */
  model: string;
}

/**
 * The answer the model must return. Strict, because Anthropic rejects a
 * permissive schema and because a missing `nextDueAt` would otherwise only
 * surface after the reply has gone out.
 *
 * `decision` is the whole point of the shape. Until the model could decline, `replyHtml`
 * was REQUIRED, so a prospect who asked something the brand facts do not
 * contain — a price, a spec, a reference, a date nobody has committed to — got
 * the only thing a required reply body leaves the model: a deflection back to
 * the call. The follow-up ladder then did it again on the next rung. So the two
 * writing fields are deliberately NOT required: the model may decline, and
 * declining is a first-class answer rather than a failure to produce one.
 *
 * It has THREE exits, not two. A prospect who declines, asks us to stop, or says
 * goodbye asked nothing, so neither "answer" nor "escalate" is true of them; with
 * two exits the model escalated those, alerting the agency about a question that
 * did not exist. `no_reply_owed` is that third exit. `confirm_booking` is the
 * fourth: they told us the meeting is booked, so they get one short thank-you
 * and their follow-ups stop.
 *
 * `question` is required on EVERY path, because it is what a human picking the
 * thread up actually needs, and `POST /orgs/replies/escalate` refuses an empty
 * one. A bare "gave up" is not actionable. `reason` is required so every run
 * says why it did what it did.
 */
export const REPLY_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: {
      type: "string",
      enum: ["answer", "escalate", "no_reply_owed", "confirm_booking", "close_with_thanks"],
      description:
        "no_reply_owed: their last message needs no answer at all: they declined, asked us to stop, " +
        "said it was sent in error, or closed the exchange without asking anything. Nothing is sent, " +
        "nobody is alerted, their follow-ups stop. " +
        "confirm_booking: they told us they booked, scheduled or moved the meeting. Write one or two " +
        "sentences thanking them and confirming the time if they gave one, asking for nothing; " +
        "their follow-ups stop after it. " +
        "close_with_thanks: only when THE GAME this thread is in tells you to thank them and stop. Write one or two " +
        "sentences of thanks asking for nothing; their follow-ups stop after it. " +
        "answer: you can answer what they wrote from the facts in front of you. " +
        "escalate: they asked a real question you cannot answer without inventing something: a price, " +
        "a spec, a reference, a commitment nobody here has made. A person takes the thread over. " +
        "When they can meet is never a reason to escalate: offer times that fit, or the booking link.",
    },
    question: {
      type: "string",
      description:
        "What they asked, in their own words: the question you answered, or the one you could not. " +
        "When no reply is owed, what their last message said, in their own words.",
    },
    reason: {
      type: "string",
      description: "One short sentence: why you chose this decision.",
    },
    replyHtml: {
      type: "string",
      description:
        "The answer the prospect reads, as HTML. No signature, no subject. " +
        "Only when decision is answer, confirm_booking or close_with_thanks: otherwise omit it, the prospect hears nothing from us.",
    },
    nextDueAt: {
      type: "string",
      description:
        "ISO-8601 timestamp of when the next follow-up is owed. Only when decision is answer; " +
        "otherwise nothing was sent and the schedule is being emptied, not advanced.",
    },
    answers: {
      type: "array",
      description:
        "One entry per listed question (q1, q2, ...): where its answer came from. exact = a fact our client stated; " +
        "interpreted = a fact read off their website; booking = the availability or booking link; " +
        "playbook = answered from THE GAME this thread is in (only when you are told one); " +
        "none = nothing in front of you answers it. Empty when no question was listed.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string", description: "The listed question's key, e.g. q1." },
          source: { type: "string", enum: ["exact", "interpreted", "booking", "playbook", "none"] },
          facts: {
            type: "array",
            description: "The ids of the facts the answer uses (E1, I2, ...). Empty for booking or none.",
            items: { type: "string" },
          },
        },
        required: ["key", "source", "facts"],
      },
    },
  },
  required: ["decision", "question", "reason", "answers"],
} as const;

/** The reason stored on the lead's follow-up schedule when no reply is owed. */
export const NO_REPLY_OWED_REASON = "no_reply_owed";

/** The reason stored on the lead's follow-up schedule once a booking is confirmed. */
export const BOOKING_CONFIRMED_REASON = "booking_confirmed";

/** The reason stored once a prospect who already has the problem solved was thanked. */
export const CLOSED_WITH_THANKS_REASON = "closed_with_thanks";

/**
 * States, in the log, that this run sent nothing because no reply was owed, and
 * why — `/end-run` carries no reason field, so this is where the reason is said.
 */
export const NAME_NO_REPLY_OWED_CODE = `
export async function main(draft, email) {
  const reason = draft?.json?.reason ?? null;
  const said = draft?.json?.question ?? null;
  console.log("[ai-meeting-booking] no reply owed to " + String(email) +
    ": nothing sent, nothing escalated, follow-ups stopped. Their last message: " +
    JSON.stringify(said) + ". Why: " + JSON.stringify(reason));
  return { outcome: "no_reply_owed", reason, said };
}
`.trim();

export function buildAiMeetingBookingDag(opts: AiMeetingBookingDagOptions): DAG {
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/gate-check",
          stopAfterIf: "result.allowed == false",
        },
      },
      {
        id: "start-run",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/start-run" },
      },
      // Which campaign ran the PRECEDING leg of this offer — the one holding
      // the person, the thread and the debt. Resolved here, by the flow, because
      // most runs are scheduled and have nobody to hand it over.
      {
        id: "predecessor-campaign",
        type: "http.call",
        config: {
          service: PREDECESSOR_READ.service,
          method: PREDECESSOR_READ.method,
          path: PREDECESSOR_READ.path,
        },
        retries: 0,
        inputMapping: { "params.campaignId": "$ref:flow_input.campaignId" },
      },
      { id: "check-predecessor", type: "condition" },
      {
        id: "name-missing-predecessor",
        type: "script",
        config: { code: NAME_MISSING_PREDECESSOR_CODE },
        retries: 0,
        inputMapping: {
          predecessorRead: "$ref:predecessor-campaign.output",
          campaignId: "$ref:flow_input.campaignId",
        },
      },
      // At most one person, exactly once, oldest-due-first. The claim is atomic
      // and lives in lead-service; nothing here re-implements it. It names the
      // PREDECESSOR's campaign — the queue is filled, and claimed, per campaign,
      // and the debt was written against the leg that spoke to them.
      {
        id: "claim-followup",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/campaigns/{campaignId}/followups/claim-next",
        },
        retries: 0,
        inputMapping: { "params.campaignId": PREDECESSOR_CAMPAIGN_REF },
      },
      { id: "check-claim", type: "condition" },
      // Which offer this campaign sells — the campaign row states it.
      {
        id: "campaign-detail",
        type: "http.call",
        config: { service: "campaign", method: "GET", path: "/campaigns/{id}" },
        inputMapping: { "params.id": "$ref:flow_input.campaignId" },
      },
      // The offer this campaign sells: its NAME for the prompt and its BOOKING
      // LINK. The link is per offer, not per brand — a brand selling several
      // offers has a different one for each — and brand-service states it on
      // the offer itself.
      {
        id: "offer-economics",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/internal/offers/{offerId}/economics" },
        inputMapping: { "params.offerId": "$ref:campaign-detail.output.campaign.offerId" },
      },
      {
        id: "brand-profile",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/internal/brands/{id}" },
        inputMapping: { "params.id": "$ref:claim-followup.output.followup.brandId" },
      },
      // The person, for their name and their own timezone.
      {
        id: "lead-detail",
        type: "http.call",
        config: { service: "lead", method: "GET", path: "/orgs/leads/{id}" },
        inputMapping: {
          "params.id": "$ref:claim-followup.output.followup.id",
          "query.campaignId": PREDECESSOR_CAMPAIGN_REF,
        },
      },
      // What they wrote, and what we sent them.
      {
        id: "conversation",
        type: "http.call",
        config: {
          service: CONVERSATION_READ.service,
          method: CONVERSATION_READ.method,
          path: CONVERSATION_READ.path,
        },
        inputMapping: {
          "query.campaign_id": PREDECESSOR_CAMPAIGN_REF,
          "query.email": "$ref:claim-followup.output.followup.email",
        },
      },
      {
        id: "prior-generation",
        type: "http.call",
        config: { service: "content-generation", method: "GET", path: "/generations/by-lead/{leadId}" },
        retries: 0,
        inputMapping: { "params.leadId": "$ref:claim-followup.output.followup.leadId" },
      },
      {
        id: "booking-slots",
        type: "script",
        config: { code: readBookingSlotsCode() },
        retries: 0,
        inputMapping: {
          bookingUrl: "$ref:offer-economics.output.bookingUrl",
          timezone: "$ref:lead-detail.output.leadDetail.lead.timezone",
        },
      },
      // STEP 1: what did they ask? The model lists it; nothing here reads
      // their text with a rule.
      {
        id: "compose-questions-prompt",
        type: "script",
        config: { code: COMPOSE_QUESTIONS_PROMPT_CODE },
        retries: 0,
        inputMapping: {
          conversation: "$ref:conversation.output",
          offer: "$ref:offer-economics.output",
          brand: "$ref:brand-profile.output",
        },
      },
      {
        id: "list-questions",
        type: "http.call",
        config: {
          service: "chat",
          method: "POST",
          path: "/complete",
          body: {
            provider: opts.provider,
            model: opts.model,
            responseFormat: "json",
            responseSchema: QUESTIONS_RESPONSE_SCHEMA,
            temperature: 0,
            maxTokens: 800,
          },
        },
        retries: 0,
        inputMapping: {
          "body.message": "$ref:compose-questions-prompt.output.message",
          "body.systemPrompt": "$ref:compose-questions-prompt.output.systemPrompt",
        },
      },
      {
        id: "plan-lookups",
        type: "script",
        config: { code: PLAN_LOOKUPS_CODE },
        retries: 0,
        inputMapping: {
          listed: "$ref:list-questions.output",
          offer: "$ref:offer-economics.output",
        },
      },
      // STEP 2: the answers, from brand-service, in one pass. What the
      // customer STATED first (exact), then what the site says (interpreted).
      {
        id: "offer-answers",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/answers" },
        inputMapping: {
          "params.brandId": "$ref:claim-followup.output.followup.brandId",
          "params.offerId": "$ref:campaign-detail.output.campaign.offerId",
        },
      },
      {
        id: "offer-user-fields",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/user-fields" },
        inputMapping: {
          "params.brandId": "$ref:claim-followup.output.followup.brandId",
          "params.offerId": "$ref:campaign-detail.output.campaign.offerId",
        },
      },
      {
        id: "brand-user-fields",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/user-fields" },
        inputMapping: { "params.brandId": "$ref:claim-followup.output.followup.brandId" },
      },
      // Org-billed extraction, billed by brand-service itself on this run's
      // identity headers. `extract`, never `suggest`: suggest WRITES an answer
      // where the site is silent, which is exactly an invented fact.
      {
        id: "extract-answers",
        type: "http.call",
        config: {
          service: "brand",
          method: "POST",
          path: "/orgs/brands/extract-fields",
          body: { mode: "extract" },
        },
        inputMapping: {
          "headers.x-brand-id": "$ref:claim-followup.output.followup.brandId",
          "body.fields": "$ref:plan-lookups.output.fields",
          "body.offerId": "$ref:campaign-detail.output.campaign.offerId",
        },
      },
      {
        id: "gather-facts",
        type: "script",
        config: { code: GATHER_FACTS_CODE },
        retries: 0,
        inputMapping: {
          plan: "$ref:plan-lookups.output",
          offerAnswers: "$ref:offer-answers.output",
          offerFields: "$ref:offer-user-fields.output",
          brandFields: "$ref:brand-user-fields.output",
          extracted: "$ref:extract-answers.output",
        },
      },
      {
        id: "compose-prompt",
        type: "script",
        config: { code: COMPOSE_REPLY_PROMPT_CODE },
        retries: 0,
        inputMapping: {
          followup: "$ref:claim-followup.output",
          leadDetail: "$ref:lead-detail.output",
          conversation: "$ref:conversation.output",
          priorGeneration: "$ref:prior-generation.output",
          booking: "$ref:booking-slots.output",
          offer: "$ref:offer-economics.output",
          brand: "$ref:brand-profile.output",
          currentDate: "$ref:flow_input.currentDate",
          facts: "$ref:gather-facts.output",
          identity: "$ref:plan-lookups.output.identity",
          playbook: "$ref:plan-lookups.output.playbook",
        },
      },
      // The LLM call goes through chat-service, which owns the model resolution,
      // the provider key AND the cost declaration for this run's spend.
      {
        id: "draft-reply",
        type: "http.call",
        config: {
          service: "chat",
          method: "POST",
          path: "/complete",
          body: {
            provider: opts.provider,
            model: opts.model,
            responseFormat: "json",
            responseSchema: REPLY_RESPONSE_SCHEMA,
            temperature: 0.4,
            maxTokens: 2000,
          },
        },
        retries: 0,
        inputMapping: {
          "body.message": "$ref:compose-prompt.output.message",
          "body.systemPrompt": "$ref:compose-prompt.output.systemPrompt",
        },
      },
      // STEP 3's guard: a listed question no fact covers turns an answer into an
      // escalation naming it. Everything downstream reads THIS, not the draft.
      {
        id: "ground-draft",
        type: "script",
        config: { code: GROUND_DRAFT_CODE },
        retries: 0,
        inputMapping: {
          draft: "$ref:draft-reply.output",
          facts: "$ref:gather-facts.output",
          identity: "$ref:plan-lookups.output.identity",
          offer: "$ref:offer-economics.output",
          brand: "$ref:brand-profile.output",
          playbook: "$ref:plan-lookups.output.playbook",
        },
      },
      // Can the model answer what they asked, or does a person have to? It
      // converges rather than nesting inside `check-claim` (see the edge from
      // `claim-followup` below), because a condition node emitted inside a
      // branch body is built as an ordinary module and silently does nothing.
      { id: "check-answerable", type: "condition" },
      // Nothing is sent. instantly-service forwards the exchange to the agency
      // inbox naming the question, and empties the lead's follow-up schedule
      // itself — so this DAG never touches lead-service on this path, and no
      // follow-up is recorded as acted: nothing was sent, and the schedule is
      // being emptied rather than advanced.
      {
        id: "escalate-unanswerable",
        type: "http.call",
        config: {
          service: "instantly",
          method: "POST",
          path: "/orgs/replies/escalate",
          validateResponse: { field: "success", equals: true },
        },
        retries: 0,
        inputMapping: {
          "body.campaign_id": PREDECESSOR_CAMPAIGN_REF,
          "body.email": "$ref:claim-followup.output.followup.email",
          "body.question": "$ref:ground-draft.output.json.question",
        },
      },
      // No reply is owed: nothing is sent and nothing is escalated. The run says
      // why, then empties the person's follow-up schedule in lead-service so the
      // ladder does not claim them again. A stop is not a tombstone — a fresh
      // reply from them re-schedules them through whoever observes it.
      {
        id: "name-no-reply-owed",
        type: "script",
        config: { code: NAME_NO_REPLY_OWED_CODE },
        retries: 0,
        inputMapping: {
          draft: "$ref:ground-draft.output",
          email: "$ref:claim-followup.output.followup.email",
        },
      },
      {
        id: "stop-followups",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/leads/{id}/followups",
          body: { kind: "stopped", reason: NO_REPLY_OWED_REASON },
        },
        retries: 0,
        inputMapping: { "params.id": "$ref:claim-followup.output.followup.id" },
      },
      {
        id: "resolve-next-due",
        type: "script",
        config: { code: RESOLVE_NEXT_DUE_CODE },
        retries: 0,
        inputMapping: {
          draft: "$ref:ground-draft.output",
          ladderNextDueAt: "$ref:compose-prompt.output.ladderNextDueAt",
        },
      },
      // In their existing thread, from the mailbox that contacted them.
      // instantly-service resolves the sending identity; we never supply it.
      {
        id: "send-reply",
        type: "http.call",
        config: {
          service: "instantly",
          method: "POST",
          path: "/orgs/replies",
          // Declared, not left to default. instantly-service refuses an
          // `automation` reply once a person has answered the thread since the
          // prospect last wrote; an undeclared caller already resolves to
          // automation, and saying so is what keeps this true the day a
          // human-facing surface starts calling the same route.
          body: { sent_by: "automation" },
          validateResponse: { field: "success", equals: true },
          // The takeover refusal is an OUTCOME, not an error: `classify-send`
          // reads it and ends the run clean. Every other refusal is re-thrown
          // there, so nothing is quietened.
          tolerateFailure: true,
        },
        retries: 0,
        inputMapping: {
          "body.campaign_id": PREDECESSOR_CAMPAIGN_REF,
          "body.email": "$ref:claim-followup.output.followup.email",
          "body.body_html": "$ref:ground-draft.output.json.replyHtml",
        },
      },
      {
        id: "classify-send",
        type: "script",
        config: { code: CLASSIFY_SEND_CODE },
        retries: 0,
        inputMapping: { send: "$ref:send-reply.output" },
      },
      // Same convergence trick as `check-answerable`: an edge from `draft-reply`
      // keeps this at the top level instead of nesting it inside that branch.
      { id: "check-sent", type: "condition" },
      // Recorded AFTER the send, never before: the count moves and the next due
      // date is written only once the prospect has actually been answered.
      {
        id: "record-followup",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/leads/{id}/followups",
          body: { kind: "acted" },
        },
        retries: 0,
        inputMapping: {
          "params.id": "$ref:claim-followup.output.followup.id",
          "body.nextDueAt": "$ref:resolve-next-due.output.nextDueAt",
        },
      },
      // They told us the meeting is booked and the confirmation has landed.
      // Nothing is left to follow up on, so the schedule is stopped rather
      // than advanced. Like every stop, not a tombstone.
      {
        id: "stop-followups-booked",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/leads/{id}/followups",
          body: { kind: "stopped", reason: BOOKING_CONFIRMED_REASON },
        },
        retries: 0,
        inputMapping: { "params.id": "$ref:claim-followup.output.followup.id" },
      },
      // They already have the problem solved and the thank-you has landed:
      // nothing left to follow up on, so the schedule is stopped.
      {
        id: "stop-followups-closed",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/leads/{id}/followups",
          body: { kind: "stopped", reason: CLOSED_WITH_THANKS_REASON },
        },
        retries: 0,
        inputMapping: { "params.id": "$ref:claim-followup.output.followup.id" },
      },
      {
        id: "end-run-closed-with-thanks",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: true, stopCampaign: false },
        },
      },
      {
        id: "end-run-booking-confirmed",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: true, stopCampaign: false },
        },
      },
      {
        id: "end-run",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: true, stopCampaign: false },
        },
      },
      // Nobody due right now is not the campaign being finished — the queue
      // fills again as prospects reply and as follow-ups come due. But it is
      // also not an ordinary run: `noWorkAvailable` tells campaign-service the
      // run had nothing to do, so it waits ~10 minutes instead of re-firing on
      // the run cadence. It never stops the campaign and nothing else reads it.
      // The prospect was not answered by us, and that is the right outcome: a
      // human was handed the thread with the question they asked. Nothing was
      // sent and the ladder was stopped by instantly-service, so this is a
      // successful run with no follow-up recorded.
      {
        id: "end-run-escalated",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: true, stopCampaign: false },
        },
      },
      // Their last message needed no answer. Nothing was sent, nothing was
      // escalated, and their follow-ups were stopped: a successful run.
      {
        id: "end-run-no-reply-owed",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: true, stopCampaign: false },
        },
      },
      // A person is already answering this thread. We stood down; nothing was
      // sent, nothing is recorded, and the run is not a failure.
      {
        id: "end-run-human-took-over",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: true, stopCampaign: false },
        },
      },
      {
        id: "end-run-nobody-due",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: true, stopCampaign: false, noWorkAvailable: true },
        },
      },
      // This campaign has no preceding leg, so there is nobody it CAN answer and
      // no thread it could answer into. A failure, not an idle tick: it will not
      // resolve itself by waiting, and calling it idle is what hid it before.
      {
        id: "end-run-no-predecessor",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: false, stopCampaign: false },
        },
      },
      {
        id: "end-run-error",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: false, stopCampaign: false },
        },
      },
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "predecessor-campaign" },
      { from: "predecessor-campaign", to: "check-predecessor" },
      {
        from: "check-predecessor",
        to: "claim-followup",
        condition: "results['predecessor-campaign'].predecessor != null",
      },
      {
        from: "check-predecessor",
        to: "name-missing-predecessor",
        condition: "results['predecessor-campaign'].predecessor == null",
      },
      { from: "name-missing-predecessor", to: "end-run-no-predecessor" },
      { from: "claim-followup", to: "check-claim" },
      // `check-claim` also takes an edge from BEFORE the predecessor branch, so
      // it converges rather than nesting inside it: a condition node is only
      // translated at the level it is emitted, and a condition inside a branch
      // body would be built as an ordinary module and silently do nothing.
      // The `?.` matters for the same reason — on the no-predecessor path the
      // claim never ran, so both arms must read false rather than throw.
      { from: "predecessor-campaign", to: "check-claim" },
      { from: "check-claim", to: "campaign-detail", condition: "results['claim-followup']?.found == true" },
      { from: "check-claim", to: "end-run-nobody-due", condition: "results['claim-followup']?.found == false" },
      { from: "campaign-detail", to: "offer-economics" },
      { from: "offer-economics", to: "brand-profile" },
      { from: "brand-profile", to: "lead-detail" },
      { from: "lead-detail", to: "booking-slots" },
      { from: "booking-slots", to: "conversation" },
      { from: "conversation", to: "prior-generation" },
      { from: "prior-generation", to: "compose-questions-prompt" },
      { from: "compose-questions-prompt", to: "list-questions" },
      { from: "list-questions", to: "plan-lookups" },
      { from: "plan-lookups", to: "offer-answers" },
      { from: "offer-answers", to: "offer-user-fields" },
      { from: "offer-user-fields", to: "brand-user-fields" },
      { from: "brand-user-fields", to: "extract-answers" },
      { from: "extract-answers", to: "gather-facts" },
      { from: "gather-facts", to: "compose-prompt" },
      { from: "compose-prompt", to: "draft-reply" },
      { from: "draft-reply", to: "ground-draft" },
      { from: "ground-draft", to: "check-answerable" },
      // The convergence edge. `claim-followup` sits OUTSIDE `check-claim`'s
      // branch body, so `check-answerable` is not absorbed into it and is
      // emitted as a top-level sibling branchone — which is the only place a
      // condition node actually does anything.
      { from: "claim-followup", to: "check-answerable" },
      {
        from: "check-answerable",
        to: "resolve-next-due",
        condition:
          "results['ground-draft']?.json?.decision == 'answer' || results['ground-draft']?.json?.decision == 'confirm_booking' || results['ground-draft']?.json?.decision == 'close_with_thanks'",
      },
      {
        from: "check-answerable",
        to: "escalate-unanswerable",
        condition: "results['ground-draft']?.json?.decision == 'escalate'",
      },
      {
        from: "check-answerable",
        to: "name-no-reply-owed",
        condition: "results['ground-draft']?.json?.decision == 'no_reply_owed'",
      },
      { from: "escalate-unanswerable", to: "end-run-escalated" },
      { from: "name-no-reply-owed", to: "stop-followups" },
      { from: "stop-followups", to: "end-run-no-reply-owed" },
      { from: "resolve-next-due", to: "send-reply" },
      { from: "send-reply", to: "classify-send" },
      { from: "classify-send", to: "check-sent" },
      // Same convergence edge, one level down: `draft-reply` is outside
      // `check-answerable`'s branch body.
      { from: "draft-reply", to: "check-sent" },
      // Both arms read positive evidence, never the absence of a refusal: on
      // the escalation path `classify-send` never ran, so an "anything but a
      // 409" arm would record a follow-up for a reply that was never sent.
      {
        from: "check-sent",
        to: "record-followup",
        condition:
          "results['classify-send']?.outcome == 'sent' && results['ground-draft']?.json?.decision == 'answer'",
      },
      {
        from: "check-sent",
        to: "stop-followups-booked",
        condition:
          "results['classify-send']?.outcome == 'sent' && results['ground-draft']?.json?.decision == 'confirm_booking'",
      },
      {
        from: "check-sent",
        to: "stop-followups-closed",
        condition:
          "results['classify-send']?.outcome == 'sent' && results['ground-draft']?.json?.decision == 'close_with_thanks'",
      },
      {
        from: "check-sent",
        to: "end-run-human-took-over",
        condition: "results['classify-send']?.outcome == 'human_took_over'",
      },
      { from: "record-followup", to: "end-run" },
      { from: "stop-followups-booked", to: "end-run-booking-confirmed" },
      { from: "stop-followups-closed", to: "end-run-closed-with-thanks" },
    ],
    onError: "end-run-error",
  };
}
