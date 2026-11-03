import { describe, it, expect } from "vitest";
import { COMPOSE_FOLLOW_UP_CODE, NEW_FACT_STRATEGY, READ_STATE_CODE } from "../../src/lib/follow-up-dag.js";
import { COMPOSE_CLIENT_CHECK_IN_CODE } from "../../src/lib/client-check-in-dag.js";
import { LEADS_ONLY_AUDIENCE, buildLeadFollowUpLeadsOnlyDag } from "../../src/lib/lead-follow-up-leads-dag.js";

/**
 * MEETING-REMINDER-1103 (owner 2026-11-03): a Lead event run answering a new fact decides the lead's ONE next date
 * itself, from the whole timeline; a date stated before the fact never defers it. Replay of Thomas (Doc Dinners): he
 * booked a meeting on 2026-11-03 16:31 UTC for 2026-11-04 18:00 UTC; the meeting-booking campaign had stated a look for
 * 2026-11-24 at 16:17.
 */
function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

const NOW = "2026-11-03T17:55:00.000Z";
const trigger = {
  eventId: "99891c95-0756-4448-97fd-8973e18c76d8",
  leadId: "lead-thomas",
  triggerId: "lead_event",
  sourceTriggerId: "meeting_booked",
  person: { name: "Thomas Example", email: "thomas@example.com", phone: null },
  item: {
    bookedAt: "2026-11-03T16:31:16Z",
    calendar: "Free Event Marketing Consultation",
    timezone: "America/New_York",
    meetingStartsAt: "2026-11-04T18:00:00Z",
    meetingEndsAt: "2026-11-04T18:30:00Z",
  },
};

describe("a Lead event answering a booked meeting (Thomas replay)", () => {
  it("the date another campaign stated before the booking does not hold them: the writer runs", async () => {
    const person = { ok: true, entry: "claimed", rowId: "row-lead-event", email: "thomas@example.com", brandId: "b", dueAt: NOW, answersOccurrence: true };
    const state = {
      followupDate: { nextFollowupAt: "2026-11-24T16:17:10.516Z", basis: "acted" },
      queued: { any: true, emailSequence: false, inDueStock: false, followups: [
        { leadCampaignId: "row-meeting-booking", campaignId: "c-mb", dueAt: "2026-11-24T16:17:10.516Z", claimedAt: null },
        { leadCampaignId: "row-cold-email", campaignId: "c-cold", dueAt: "2026-11-24T16:17:10.516Z", claimedAt: null },
      ] },
      owed: { kind: "owed", owed: true, retryAfter: null, reason: null, reasons: [], relationshipTags: [] },
    };
    expect(await loadMain(READ_STATE_CODE)(person, state, NOW)).toMatchObject({ proceed: true, skip: false });
  });

  it("a genuinely queued email sequence step still waits (no regression)", async () => {
    const person = { ok: true, entry: "claimed", rowId: "row-1", email: "thomas@example.com", brandId: "b" };
    const state = {
      followupDate: { nextFollowupAt: NOW, basis: "default" },
      queued: { any: true, emailSequence: true, inDueStock: false, followups: [] },
      owed: { kind: "owed", owed: true, retryAfter: null, reason: null, reasons: [], relationshipTags: [] },
    };
    expect(await loadMain(READ_STATE_CODE)(person, state, NOW)).toMatchObject({ proceed: false, kind: "queued" });
  });

  it("the leads writer sees the meeting's own record and the strategy: a reminder before it, never after", async () => {
    const compose = LEADS_ONLY_AUDIENCE.composeCode;
    expect(compose).not.toBe(COMPOSE_FOLLOW_UP_CODE);
    const out = await loadMain(compose)(
      { email: "thomas@example.com", timezone: "America/New_York", lead: { firstName: "Thomas" } },
      { channel: "email", email: "thomas@example.com", skipModel: false, why: "email" },
      { name: "Event marketing" },
      { brand: { name: "Doc Dinners" } },
      { exact: [], neverGive: [] },
      { lines: [], ourMessages: 3 },
      undefined,
      "",
      { skip: true },
      { skip: true },
      trigger,
      NOW,
      NOW.slice(0, 10),
      { lines: ["Prospect"], threadLines: ["2026-11-03 | Thomas: Can you do Wednesday at 1 PM?"], strategy: "WHO" },
    );
    expect(out.message).toContain("WHAT THE EVENT CARRIES");
    expect(out.message).toContain("2026-11-04T18:00:00Z");
    expect(out.message).toContain("America/New_York");
    expect(out.systemPrompt).toContain(NEW_FACT_STRATEGY);
  });

  it("the strategy is a prompt line for every follow-up writer, dash-free, with no branch on the event", () => {
    expect(NEW_FACT_STRATEGY).not.toMatch(/[–—]/);
    expect(NEW_FACT_STRATEGY).toContain("before the meeting starts");
    expect(COMPOSE_FOLLOW_UP_CODE).toContain(JSON.stringify(NEW_FACT_STRATEGY));
    expect(COMPOSE_CLIENT_CHECK_IN_CODE).toContain(JSON.stringify(NEW_FACT_STRATEGY));
    const code = JSON.stringify(buildLeadFollowUpLeadsOnlyDag({ readFigures: false }));
    expect(code).not.toMatch(/=== ?\\?"meeting_booked/);
    expect(code).not.toContain("SAME_FACT_WINDOW");
  });
});
