import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIME_CONTEXT_FN } from "../../src/lib/time-context.js";

/**
 * MB-TIME-CONTEXT-1103 (owner 2026-11-03): Thomas wrote on MONDAY 2026-11-02 at 14:34 New York time "suggest a time
 * early next week" and got two times in the SAME week; the writer read only "Today is 2026-11-02". Every writer now
 * reads NOW in full (weekday, date, hour, their zone with its offset, and UTC), every message dated in their zone,
 * and an unknown zone said in words with every location we hold, never a silent UTC.
 */

const helpers = new Function(TIME_CONTEXT_FN + "\nreturn { nowLines, stampAt, fullDateTime, validTimeZone };")() as {
  nowLines: (nowIso: string, clues: Record<string, unknown>) => string[];
  stampAt: (iso: string, tz: string | null) => string | null;
  validTimeZone: (tz: unknown) => string | null;
};

describe("the time context every writer reads (MB-TIME-CONTEXT-1103)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T19:35:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

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
});
