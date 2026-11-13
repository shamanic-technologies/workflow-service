import { describe, it, expect } from "vitest";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { runScript, validateSource } from "../../src/lib/scripts/sandbox.js";
import { answererWithGoalAndEventClaim, buildMeetingPathSource, BOOK_MEETING, MEETING_REMINDER } from "../../scripts/engine-ports/meeting-paths.js";

// SCRIPT-VALUE-RATING-1113-WF1: the Meeting booked and Meeting attended paths write nothing themselves; they ask the
// answerer (Message sent) for the ONE answer, handing it the run's Request plus their goal.
const src = buildMeetingPathSource();
const trigger = { eventId: "evt-1", leadId: "lead-1", person: { email: "kevin+meeting@hidistribute.com" }, sourceTriggerId: "lead_event" };
const request = { now: "2026-11-13T10:00:00.000Z", campaignId: "camp-1", brandId: "brand-1", trigger };

describe("the meeting path scripts", () => {
  it("are one valid code asking Message sent, told apart only by their goal; neither names a model, template or outcome", async () => {
    const read = await validateSource(src);
    expect(read.materials).toEqual(["message_sent"]);
    expect(read.vendors).toEqual([]);
    for (const s of [BOOK_MEETING, MEETING_REMINDER]) {
      expect(s.tactics.asks).toEqual(["message_sent"]);
      expect(s.tactics).not.toHaveProperty("channel");
      expect(typeof s.tactics.goal).toBe("string");
      expect(s.tactics).not.toHaveProperty("llm");
      expect(s.tactics).not.toHaveProperty("template");
      expect(s.description).not.toMatch(/[—–]/);
    }
    expect(BOOK_MEETING.outcome).toBe("meeting_booked");
    expect(MEETING_REMINDER.outcome).toBe("meeting_attended");
    expect(src).not.toMatch(/meeting_booked|meeting_attended|claude|haiku|opus|sonnet/i);
  });

  it("asks the answerer with the run's Request plus its goal, and answers what it answered", async () => {
    for (const s of [BOOK_MEETING, MEETING_REMINDER]) {
      const c: ReplayCase = {
        id: s.dynasty,
        units: { message_sent: { decision: "write", channel: "email" } },
        request,
        tactics: s.tactics,
        calls: [],
        asks: [{ units: {}, request: { ...request, goal: s.tactics.goal }, recordedBy: "sender" }],
        expect: { content: { answered: { decision: "write", channel: "email" } } },
      };
      expect((await replayCase(src, c)).diffs).toEqual([]);
    }
  });

  it("forwards the answerer's unmade and decision word for word; no occurrence asks nothing; no goal throws", async () => {
    // A child that made no Unit is read back with its reason at the top (script-runner: content null, unmade, decided).
    const out = await runScript(src, { subject: null, brand: "b", day: 0, tactics: MEETING_REMINDER.tactics, request }, (op) =>
      op === "get" ? { v: { id: "u", outcome: "message_sent", subject: "", ageDays: 0, content: null, unmade: "later: reminder the day before", decided: "done" } } : { v: null },
    );
    expect(out).toMatchObject({ kind: "done", result: { unmade: "later: reminder the day before", decided: "done" } });
    const none: ReplayCase = { id: "none", units: {}, request: { now: request.now }, tactics: BOOK_MEETING.tactics, calls: [], asks: [], expect: { fails: "no_occurrence" } };
    expect((await replayCase(src, none)).diffs).toEqual([]);
    const noGoal: ReplayCase = { id: "nogoal", units: {}, request, tactics: { ...BOOK_MEETING.tactics, goal: "" }, calls: [], expect: { fails: "states no goal" } };
    expect((await replayCase(src, noGoal)).diffs).toEqual([]);
  });
});

describe("the answerer upgrade (dy_answer_lead)", () => {
  const stored = [
    "let ctx_ = null;",
    "function s(v) { return typeof v === 'string' && v.trim() !== '' ? v.trim() : null; }",
    "function must(name, args) { const a = ctx_.vendor.call(name, args); if (!a.ok) throw new Error(name); return a.data; }",
    "export default function run(ctx) {",
    "  ctx_ = ctx;",
    "  const req = ctx.request || {};",
    "  const trigger = req.trigger;",
    "  const campaignId = req.campaignId;",
    "  const claim = must('lead.followup.claim', {});",
    "  const row = claim.followup;",
    "  const voice = { content: 'VOICE' }; const personaBlock = []; const K = { GAME: ['GAME'] }; const mediumLines = ['EMAIL'];",
    "  const system = [voice.content].concat(personaBlock, K.GAME, mediumLines, [s(req.brief) ? 'BRIEF ' + req.brief : '']).filter(Boolean).join('\\n\\n');",
    "  return { content: { system: system } };",
    "}",
  ].join("\n");
  const upgraded = answererWithGoalAndEventClaim(stored);
  const claimed = { found: true, followup: { id: "row-1" } };

  it("refuses a stored code whose anchors moved, or that already claims", () => {
    expect(() => answererWithGoalAndEventClaim(stored.replace("const row = claim.followup;", "const row = claim.row;"))).toThrow(/found 0 times/);
    expect(() => answererWithGoalAndEventClaim(upgraded)).toThrow(/already claims/);
  });

  it("no goal = the prompt byte for byte; a goal = one section after the game", async () => {
    const same = await runScript(stored, { subject: null, brand: "b", day: 0, tactics: {}, request }, (op) => ({ v: op === "vendor" ? { ok: true, data: claimed } : null }));
    const without = await runScript(upgraded, { subject: null, brand: "b", day: 0, tactics: {}, request }, (op) => ({ v: op === "vendor" ? { ok: true, data: claimed } : op === "storage.claim" ? { campaignId: "camp-1" } : null }));
    expect(without).toEqual(same);
    const withGoal = await runScript(upgraded, { subject: null, brand: "b", day: 0, tactics: {}, request: { ...request, goal: "A booked meeting." } }, (op) => ({
      v: op === "vendor" ? { ok: true, data: claimed } : op === "storage.claim" ? { campaignId: "camp-1" } : null,
    }));
    expect(withGoal).toMatchObject({ kind: "done", result: { content: { system: "VOICE\n\nGAME\n\nWHAT THIS ANSWER WORKS TOWARD (the campaign's Target):\nA booked meeting.\n\nEMAIL" } } });
  });

  it("a second campaign answering the same event sends nothing and closes only its own queue row", async () => {
    const calls: Array<[string, unknown]> = [];
    const out = await runScript(upgraded, { subject: null, brand: "b", day: 0, tactics: {}, request: { ...request, campaignId: "camp-2" } }, (op, args) => {
      if (op === "storage.claim") return { v: { campaignId: "camp-1" } };
      if (op === "vendor") calls.push([String(args[0]), args[1]]);
      return { v: op === "vendor" ? { ok: true, data: claimed } : null };
    });
    expect(out).toMatchObject({ kind: "done", result: { unmade: "answered_elsewhere: campaign camp-1 answers this event", decided: "done" } });
    expect(calls).toEqual([
      ["lead.followup.claim", {}],
      ["lead.followup.record", { params: { id: "row-1" }, body: { kind: "stopped", reason: "answered_by_another_campaign" } }],
    ]);
  });
});
