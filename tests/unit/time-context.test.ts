import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIME_CONTEXT_FN } from "../../src/lib/time-context.js";
import { COMPOSE_REPLY_PROMPT_CODE, buildAiMeetingBookingDag, needsTimeContext } from "../../src/lib/ai-meeting-booking-dag.js";
import { COMPOSE_ANSWER_PROMPT_CODE } from "../../src/lib/form-meeting-booking-dag.js";

/**
 * MB-TIME-CONTEXT-1103 (owner 2026-11-03): Thomas wrote on MONDAY 2026-11-02 at 14:34 New York time "suggest a time
 * early next week" and got two times in the SAME week; the writer read only "Today is 2026-11-02". Every writer now
 * reads NOW in full (weekday, date, hour, their zone with its offset, and UTC), every message dated in their zone,
 * and an unknown zone said in words with every location we hold, never a silent UTC.
 */

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, unknown>> {
  const body = code.replace(/^export async function main/, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, unknown>>;
}
const helpers = new Function(TIME_CONTEXT_FN + "\nreturn { nowLines, stampAt, fullDateTime, validTimeZone };")() as {
  nowLines: (nowIso: string, clues: Record<string, unknown>) => string[];
  stampAt: (iso: string, tz: string | null) => string | null;
  validTimeZone: (tz: unknown) => string | null;
};

const WHO = { lines: ["Not known to the brand."], threadLines: [], strategy: "WHO" };
const INSIDER = { stance: "insider", evidence: "I'm Sam at Doc Dinners." };
const thomasThread = {
  success: true,
  conversation: {
    transport: "instantly",
    messageCount: 2,
    messages: [
      { direction: "outbound", at: "2026-10-28T15:00:00Z", text: "Would a quick call to see if Doc Dinners fits your practice make sense?" },
      { direction: "inbound", at: "2026-11-02T19:34:00Z", text: "Yes, please suggest a time early next week to connect" },
    ],
  },
};
const offer = { offerId: "offer-1", name: "Doc Dinners", bookingUrl: "https://book.example.com/doc" };
const brand = { brand: { name: "Doc Dinners" } };

const compose = (lead: Record<string, unknown>, booking: Record<string, unknown>) =>
  loadMain(COMPOSE_REPLY_PROMPT_CODE)(
    { followup: { id: "row-1", leadId: "lead-1", followupCount: 0 } },
    { leadDetail: { lead } },
    thomasThread,
    null,
    booking,
    offer,
    brand,
    "2026-11-02",
    undefined,
    INSIDER,
    "none",
    undefined,
    WHO,
  );

describe("the meeting-booking writer reads the calendar in full (MB-TIME-CONTEXT-1103)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T19:35:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("Thomas: NOW in his zone and UTC, his message dated, the week of Nov 9 written out on each slot", async () => {
    const out = await compose(
      { firstName: "Thomas", timezone: "America/New_York" },
      { timezone: "America/New_York", degraded: false, bookingUrl: offer.bookingUrl, slots: ["2026-11-03T10:00:00-05:00", "2026-11-10T10:00:00-05:00"] },
    );
    const message = out.message as string;
    expect(message).not.toContain("Today is 2026-11-02");
    expect(message).toContain(
      "Now, where they are: Monday, November 2, 2026, 2:35 PM America/New_York (UTC-05:00). In UTC: Monday, November 2, 2026, 19:35 UTC.",
    );
    expect(message).toContain(
      "PROSPECT (their last message) (Monday, November 2, 2026, 2:34 PM America/New_York (UTC-05:00)):\nYes, please suggest a time early next week",
    );
    expect(message).toContain("US (Wednesday, October 28, 2026, 11:00 AM America/New_York (UTC-04:00)):");
    expect(message).toContain("- Tuesday, November 10, 2026, 10:00 AM America/New_York (UTC-05:00) (2026-11-10T10:00:00-05:00)");
    expect(message).toContain("Timezone: America/New_York");
    expect(message).toContain("already converted to the prospect's own timezone (America/New_York)");
    expect(message).not.toMatch(/[–—]/);
  });

  it("a lead with no timezone: said unknown, every location we hold listed, the UTC slots labelled UTC", async () => {
    const out = await compose(
      { firstName: "Thomas", city: "Wilton", state: "Connecticut", country: "United States", organization: { name: "Wilton Chiro", city: "Norwalk", country: "United States" } },
      { timezone: "UTC", degraded: false, bookingUrl: offer.bookingUrl, slots: ["2026-11-10T15:00:00+00:00"] },
    );
    const message = out.message as string;
    expect(message).toContain("Now, in UTC: Monday, November 2, 2026, 19:35 UTC.");
    expect(message).toContain("Their timezone is unknown: nothing we hold states it.");
    expect(message).toContain(
      "Where they may be, from what we hold: their own location: Wilton, Connecticut, United States; their company's headquarters: Norwalk, United States.",
    );
    expect(message).toContain("Never assume UTC.");
    expect(message).toContain("Timezone: unknown (not stated anywhere we hold)");
    expect(message).toContain("in UTC, because their timezone is unknown (see NOW)");
    expect(message).toContain("- Tuesday, November 10, 2026, 15:00 UTC (2026-11-10T15:00:00+00:00)");
    expect(message).not.toContain("UTC-");
  });

  it("nothing held at all: says so, never a silent UTC", () => {
    const lines = helpers.nowLines("2026-11-02T19:35:00Z", {});
    expect(lines[1]).toBe("Their timezone is unknown: nothing we hold states it.");
    expect(lines[2]).toContain("Nothing we hold says where they are");
    expect(lines[2]).toContain("Never assume UTC.");
  });

  it("a zone the runtime cannot read is a clue, never a zone; a bad message time is no stamp", () => {
    expect(helpers.validTimeZone("Eastern")).toBeNull();
    expect(helpers.nowLines("2026-11-02T19:35:00Z", { timezone: "Eastern" }).join("\n")).toContain("timezone as written (not a zone we can read): Eastern");
    expect(helpers.stampAt("not a date", "America/New_York")).toBeNull();
    expect(helpers.stampAt("2026-07-01T12:00:00Z", "Asia/Kolkata")).toBe("Wednesday, July 1, 2026, 5:30 PM Asia/Kolkata (UTC+05:30)");
  });

  it("the form responder reads NOW in full in the person's zone too", async () => {
    const out = await loadMain(COMPOSE_ANSWER_PROMPT_CODE)(
      { email: "t@example.com", fullName: "Thomas", form: null },
      offer,
      brand,
      {},
      { exact: [], neverGive: [] },
      "2026-11-02",
      WHO,
      { leadDetail: { lead: { timezone: "America/New_York" } } },
    );
    expect(out.message as string).toContain("NOW:\nNow, where they are: Monday, November 2, 2026, 2:35 PM America/New_York (UTC-05:00).");
  });

  it("the seed upgrades a stored DAG still reading a bare date, and leaves the current one alone", () => {
    const dag = buildAiMeetingBookingDag({ provider: "google", model: "pro" });
    expect(needsTimeContext(dag)).toBe(false);
    const old = JSON.parse(JSON.stringify(dag)) as typeof dag;
    const node = old.nodes.find((n) => n.id === "compose-prompt")!;
    node.config = { ...node.config, code: String(node.config?.code).replace('"NOW",', '"Today is " + currentDate,') };
    expect(needsTimeContext(old)).toBe(true);
    expect(needsTimeContext({ nodes: [] })).toBe(false);
  });
});
