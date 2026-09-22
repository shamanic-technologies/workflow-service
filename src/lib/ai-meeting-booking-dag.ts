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
 * nobody for its first two weeks: WHICH CAMPAIGN holds the person. A funnel is
 * several LEGS and campaign-service mints one campaign per leg, so the prospect
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
 * and the offer/funnel read keep naming the campaign this run was DISPATCHED
 * for: money belongs to the leg that spends it.
 *
 * There is deliberately NO fallback to this run's own campaign when there is no
 * predecessor. That is precisely the behaviour that claimed nobody and 404'd,
 * and making it the fallback would hide the failure a second time. A run with
 * no predecessor ends on its own named branch, having sent nothing.
 *
 * A RUN THAT SENDS NOTHING IS NOT A FAILED RUN. Two of the branches below end
 * cleanly with the prospect never hearing from us, and in both cases that is
 * the correct outcome rather than a degradation:
 *
 *  - The model says it CANNOT answer what they asked. Its schema used to
 *    REQUIRE a reply body, so the only move left to it was a deflection back to
 *    the call, and the follow-up ladder then did it again on the next rung —
 *    the prospect gets pestered and a question a person could have answered in
 *    one line never reaches one. `answerable: false` is now a first-class
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
 * this funnel — the one that actually holds the prospect, the thread and the
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

/** How far ahead of today the booking page is read for availability. */
export const SLOT_LOOKAHEAD_DAYS = 14;

/** How many candidate slots are handed to the model, which then picks two. */
export const SLOT_CANDIDATES = 6;

/**
 * Reads the brand's booking page for this funnel and returns slots ALREADY
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
  const want = MAX_SLOTS;

  const degraded = (reason) => {
    console.error("[ai-meeting-booking] no slots read from the booking page: " + reason +
      " (bookingUrl=" + String(bookingUrl) + ", timezone=" + tz + ")");
    return { bookingUrl: bookingUrl ?? null, timezone: tz, slots: [], degraded: true, degradedReason: reason };
  };
  const ok = (slots) => ({ bookingUrl, timezone: tz, slots, degraded: false, degradedReason: null });

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
        if (slots.length >= want) break;
      }
      if (slots.length >= want) break;
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
      if (slots.length >= want) break;
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
        if (slots.length >= want) break;
      }
      if (slots.length >= want) break;
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
 * The booking-slots script with its two bounds inlined.
 *
 * They are inlined rather than passed through `inputMapping` because a Windmill
 * input transform carries the value it is given, and a DAG's inputMapping states
 * strings — a lookahead handed over as `"14"` would silently fall through the
 * script's own number check and take a default nobody chose.
 */
export function readBookingSlotsCode(): string {
  return READ_BOOKING_SLOTS_TEMPLATE
    .replace("LOOKAHEAD_DAYS", String(SLOT_LOOKAHEAD_DAYS))
    .replace("MAX_SLOTS", String(SLOT_CANDIDATES));
}

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
export async function main(followup, leadDetail, conversation, priorGeneration, booking, offerFunnels, funnelKey, brand, currentDate) {
  const person = leadDetail?.leadDetail?.lead ?? {};
  const timezone = booking?.timezone ?? "UTC";

  const messages = conversation?.conversation?.messages ?? [];
  const transcript = messages.map((m) => {
    const who = m?.direction === "inbound" ? "PROSPECT" : "US";
    const when = m?.at ? " (" + m.at + ")" : "";
    return who + when + ":\\n" + String(m?.text ?? "").trim();
  }).join("\\n\\n---\\n\\n");

  const funnel = (offerFunnels?.funnels ?? []).find((f) => f?.funnelKey === funnelKey) ?? null;

  const priorSubject = priorGeneration?.generation?.subject ?? null;
  const followupCount = Number(followup?.followup?.followupCount ?? 0);

  // The interval grows: 3d, 7d, 21d, 60d, then 180d for every one after that.
  const ladder = [3, 7, 21, 60, 180];
  const ladderDays = ladder[Math.min(followupCount, ladder.length - 1)];
  const ladderNextDueAt = new Date(Date.now() + ladderDays * 86400000).toISOString();

  const slotLines = (booking?.slots ?? []).map((s) => "- " + s).join("\\n");

  const bookingSection = booking?.degraded
    ? (booking?.bookingUrl
        ? "The booking page could not be read (" + booking.degradedReason + "). Do NOT invent times. Give them the booking link and let them pick: " + booking.bookingUrl
        : "This brand has no booking link for this funnel (" + booking.degradedReason + "). Do NOT invent times and do NOT invent a link. Ask them which times suit them and say you will send an invite.")
    : "Availability, already converted to the prospect's own timezone (" + timezone + "). Propose EXACTLY TWO of these, written out in plain words, and give the link so they can pick another if neither works: " + booking.bookingUrl + "\\n" + slotLines;

  const message = [
    "Today is " + (currentDate ?? new Date().toISOString().split("T")[0]) + ".",
    "",
    "You are answering one prospect who replied to " + (brand?.brand?.name ?? "our client") + "'s outreach and showed interest.",
    "",
    "WHO THEY ARE",
    "Name: " + [person.firstName, person.lastName].filter(Boolean).join(" "),
    "Title: " + (person.currentTitle ?? ""),
    "Company: " + (person.organization?.name ?? ""),
    "Timezone: " + timezone,
    "",
    "WHAT WE SELL THEM",
    "Funnel: " + (funnel?.name ?? funnelKey ?? ""),
    "",
    "THE CONVERSATION SO FAR, oldest first" + (priorSubject ? " (thread subject: " + priorSubject + ")" : ""),
    transcript || "(no messages on record)",
    "",
    "WHAT YOU MUST DO",
    "1. ANSWER THE QUESTION THEY ASKED. Read their last message and reply to what is in it. A reply that ignores what they wrote is worse than no reply at all.",
    "2. Then propose the meeting.",
    "",
    "WHEN YOU CANNOT ANSWER",
    "Everything you may state is above. If answering what they asked would mean inventing something that is not there — a price, a number of seats, a spec, a reference, a commitment to a date nobody here has made — then you cannot answer it.",
    "In that case set answerable to false and write nothing: no reply, no holding message, and above all no deflection back to the call. A person will take this thread over and answer them properly, and pushing the meeting again instead is exactly what makes us look like a machine.",
    "Set answerable to true only when you can actually answer what they asked from what is in front of you.",
    "Either way, return question: what they asked, in their own words. It is what the person taking over reads.",
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
    "Write only the words the prospect reads, as HTML. No signature — the mailbox that answers appends its own.",
    "No subject line: this goes into the thread they already have.",
    "Short. Plain. The way one person writes to another.",
  ].join("\\n");

  const systemPrompt = [
    "You answer one prospect at a time, in an email thread that is already running.",
    "You are the person who has been writing to them. You are not a bot and you do not say you are one.",
    "You answer what they asked before you ask for anything.",
    "You never invent availability, prices, names, or facts that are not in front of you.",
    "When you cannot answer from what is in front of you, you say so and hand over, rather than deflecting back to the meeting.",
  ].join(" ");

  return { message, systemPrompt, ladderNextDueAt, timezone };
}
`.trim();

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
    throw new Error("[ai-meeting-booking] the model said the question was answerable but returned no reply body; refusing to send an empty answer");
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
 * `answerable` is the whole point of the shape. Until it existed, `replyHtml`
 * was REQUIRED, so a prospect who asked something the brand facts do not
 * contain — a price, a spec, a reference, a date nobody has committed to — got
 * the only thing a required reply body leaves the model: a deflection back to
 * the call. The follow-up ladder then did it again on the next rung. So the two
 * writing fields are deliberately NOT required: the model may decline, and
 * declining is a first-class answer rather than a failure to produce one.
 *
 * `question` is required on BOTH paths, because it is what a human picking the
 * thread up actually needs, and `POST /orgs/replies/escalate` refuses an empty
 * one. A bare "gave up" is not actionable.
 */
export const REPLY_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answerable: {
      type: "boolean",
      description:
        "True only if you can answer what they asked from the facts in front of you. " +
        "False if answering would mean inventing something — a price, a spec, a reference, " +
        "a commitment nobody here has made. A person takes the thread over from there.",
    },
    question: {
      type: "string",
      description:
        "What they asked, in their own words — the question you answered, or the one you could not.",
    },
    replyHtml: {
      type: "string",
      description:
        "The answer the prospect reads, as HTML. No signature, no subject. " +
        "Omit it entirely when answerable is false: the prospect hears nothing until a human writes.",
    },
    nextDueAt: {
      type: "string",
      description:
        "ISO-8601 timestamp of when the next follow-up is owed. Omit it when answerable is false — " +
        "nothing was sent and the schedule is being emptied, not advanced.",
    },
  },
  required: ["answerable", "question"],
} as const;

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
      // Which campaign ran the PRECEDING leg of this funnel — the one holding
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
      // Which offer and funnel this campaign sells — the campaign row states both.
      {
        id: "campaign-detail",
        type: "http.call",
        config: { service: "campaign", method: "GET", path: "/campaigns/{id}" },
        inputMapping: { "params.id": "$ref:flow_input.campaignId" },
      },
      // The booking link is per FUNNEL, not per brand: a brand selling several
      // funnels has a different one for each.
      {
        id: "offer-funnels",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/internal/offers/{offerId}/sales-funnels" },
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
          bookingUrl: "$ref:pick-booking-url.output.bookingUrl",
          timezone: "$ref:lead-detail.output.leadDetail.lead.timezone",
        },
      },
      {
        id: "pick-booking-url",
        type: "script",
        config: {
          code: `
export async function main(offerFunnels, funnelKey) {
  const funnels = offerFunnels?.funnels ?? [];
  const funnel = funnels.find((f) => f?.funnelKey === funnelKey) ?? null;
  if (!funnel) {
    console.error("[ai-meeting-booking] this campaign's funnel (" + String(funnelKey) +
      ") is not among the offer's active funnels; the prospect still gets an answer, without slots");
  }
  return { bookingUrl: funnel?.bookingUrl ?? null, funnelName: funnel?.name ?? null };
}
`.trim(),
        },
        inputMapping: {
          offerFunnels: "$ref:offer-funnels.output",
          funnelKey: "$ref:campaign-detail.output.campaign.funnelKey",
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
          offerFunnels: "$ref:offer-funnels.output",
          funnelKey: "$ref:campaign-detail.output.campaign.funnelKey",
          brand: "$ref:brand-profile.output",
          currentDate: "$ref:flow_input.currentDate",
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
          "body.question": "$ref:draft-reply.output.json.question",
        },
      },
      {
        id: "resolve-next-due",
        type: "script",
        config: { code: RESOLVE_NEXT_DUE_CODE },
        retries: 0,
        inputMapping: {
          draft: "$ref:draft-reply.output",
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
          "body.body_html": "$ref:draft-reply.output.json.replyHtml",
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
      { from: "campaign-detail", to: "offer-funnels" },
      { from: "offer-funnels", to: "pick-booking-url" },
      { from: "pick-booking-url", to: "brand-profile" },
      { from: "brand-profile", to: "lead-detail" },
      { from: "lead-detail", to: "booking-slots" },
      { from: "booking-slots", to: "conversation" },
      { from: "conversation", to: "prior-generation" },
      { from: "prior-generation", to: "compose-prompt" },
      { from: "compose-prompt", to: "draft-reply" },
      { from: "draft-reply", to: "check-answerable" },
      // The convergence edge. `claim-followup` sits OUTSIDE `check-claim`'s
      // branch body, so `check-answerable` is not absorbed into it and is
      // emitted as a top-level sibling branchone — which is the only place a
      // condition node actually does anything.
      { from: "claim-followup", to: "check-answerable" },
      {
        from: "check-answerable",
        to: "resolve-next-due",
        condition: "results['draft-reply']?.json?.answerable == true",
      },
      {
        from: "check-answerable",
        to: "escalate-unanswerable",
        condition: "results['draft-reply']?.json?.answerable == false",
      },
      { from: "escalate-unanswerable", to: "end-run-escalated" },
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
        condition: "results['classify-send']?.outcome == 'sent'",
      },
      {
        from: "check-sent",
        to: "end-run-human-took-over",
        condition: "results['classify-send']?.outcome == 'human_took_over'",
      },
      { from: "record-followup", to: "end-run" },
    ],
    onError: "end-run-error",
  };
}
