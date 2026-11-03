/**
 * THE CALENDAR ANCHOR every writer reads (MB-TIME-CONTEXT-1103, owner 2026-11-03: « dans le context donne la date en
 * format avec max dinfo. Il faut aussi que la TZ du lead soit donnée, si disponible, ou à defaut ses infos de
 * localisation if any (la sienne, celle de sa boite, etc) »). Thomas wrote on a MONDAY "suggest a time early next
 * week"; the prompt only said "Today is 2026-11-02" (no weekday, no hour, no zone) and the times proposed fell in the
 * SAME week. The model is given the facts (weekday, full date, hour, their zone with its UTC offset, and UTC), never
 * a rule per phrase ("next week" = X): it does the calendar reading itself.
 *
 * Script text, appended after `main` in a Windmill rawscript (function declarations hoist). Never include it twice
 * in one script: `LOCAL_TIME_FN` (right-moment.ts) already carries it.
 *
 *  - `validTimeZone(tz)`: the IANA name when the runtime knows it, else null (a bad name is a clue, never a zone).
 *  - `fullDateTime(at, tz)`: "Monday, November 2, 2026, 2:35 PM America/New_York (UTC-05:00)", or
 *    "Monday, November 2, 2026, 19:35 UTC" with no zone.
 *  - `stampAt(iso, tz)`: the same for a message's time (null when the time is not a date).
 *  - `nowLines(nowIso, clues)`: the NOW lines. `clues`: `{timezone, places: [{label, value}], phone}`. A known zone
 *    = their local now + UTC now. Unknown = said in words, UTC now, every location we hold, never a silent UTC.
 */
export const TIME_CONTEXT_FN = `
function validTimeZone(tz) {
  if (typeof tz !== "string" || tz.trim() === "") return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() }).format(new Date(0));
    return tz.trim();
  } catch {
    return null;
  }
}
function utcOffsetOf(at, tz) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at)) {
    parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  const minutes = Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
  const abs = Math.abs(minutes);
  return "UTC" + (minutes < 0 ? "-" : "+") + String(Math.floor(abs / 60)).padStart(2, "0") + ":" + String(abs % 60).padStart(2, "0");
}
function fullDateTime(at, tz) {
  const zone = validTimeZone(tz);
  const day = (z) => new Intl.DateTimeFormat("en-US", { timeZone: z, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(at);
  if (!zone) {
    const hm = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
    return day("UTC") + ", " + hm + " UTC";
  }
  const hm = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true }).format(at);
  return day(zone) + ", " + hm + " " + zone + " (" + utcOffsetOf(at, zone) + ")";
}
function stampAt(iso, tz) {
  const at = new Date(String(iso ?? ""));
  return Number.isFinite(at.getTime()) ? fullDateTime(at, tz) : null;
}
function nowLines(nowIso, clues) {
  const parsed = new Date(String(nowIso ?? ""));
  const at = Number.isFinite(parsed.getTime()) ? parsed : new Date();
  const zone = validTimeZone(clues?.timezone);
  if (zone) {
    return ["Now, where they are: " + fullDateTime(at, zone) + ". In UTC: " + fullDateTime(at, null) + "."];
  }
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const held = [
    ...(Array.isArray(clues?.places) ? clues.places : []).filter((p) => s(p?.value)).map((p) => p.label + ": " + s(p.value)),
    s(clues?.timezone) ? "timezone as written (not a zone we can read): " + s(clues.timezone) : null,
    s(clues?.phone) ? "phone: " + s(clues.phone) : null,
  ].filter(Boolean);
  return [
    "Now, in UTC: " + fullDateTime(at, null) + ".",
    "Their timezone is unknown: nothing we hold states it.",
    held.length
      ? "Where they may be, from what we hold: " + held.join("; ") + ". Work out their likely timezone from these, and write any day or time you give them in it, naming the zone. Never assume UTC."
      : "Nothing we hold says where they are (no city, no company location, no phone). Judge it from the hours they write at in the conversation, and name the zone of any time you give them. Never assume UTC.",
  ];
}
`.trim();
