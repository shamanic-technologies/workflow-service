import { describe, it, expect } from "vitest";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { runScript, validateSource } from "../../src/lib/scripts/sandbox.js";
import { answererV9ToProactive, answererV8ToLeadClaim, answererWithGoalAndLeadClaim, buildMeetingPathSource, BOOK_MEETING, EVENT_CLAIM_BLOCK_V8, CLAIM_ANCHOR, LEAD_CLAIM_BLOCK, MEETING_REMINDER } from "../../scripts/engine-ports/meeting-paths.js";

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
    // A proactive tick (no occurrence) asks the answerer too, with the goal: it serves the brand's next due lead itself.
    const proactive: ReplayCase = {
      id: "proactive",
      units: { message_sent: { decision: "write", channel: "email" } },
      request: { now: request.now, campaignId: "camp-1" },
      tactics: BOOK_MEETING.tactics,
      calls: [],
      asks: [{ units: {}, request: { now: request.now, campaignId: "camp-1", goal: BOOK_MEETING.tactics.goal }, recordedBy: "sender" }],
      expect: { content: { answered: { decision: "write", channel: "email" } } },
    };
    expect((await replayCase(src, proactive)).diffs).toEqual([]);
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
    "  const now = req.now;",
    "  const campaignId = req.campaignId;",
    "  const named = { email: null, phone: null, leadId: trigger.leadId };",
    "  const claim = must('lead.followup.claim', {});",
    "  const row = claim.followup;",
    "  const voice = { content: 'VOICE' }; const personaBlock = []; const K = { GAME: ['GAME'] }; const mediumLines = ['EMAIL'];",
    "  const system = [voice.content].concat(personaBlock, K.GAME, mediumLines, [s(req.brief) ? 'BRIEF ' + req.brief : '']).filter(Boolean).join('\\n\\n');",
    "  return { content: { system: system } };",
    "}",
  ].join("\n");
  const upgraded = answererWithGoalAndLeadClaim(stored);
  const claimed = { found: true, followup: { id: "row-1", leadId: "lead-1" } };
  const spec = (req: Record<string, unknown>) => ({ subject: null, brand: "b", day: 0, tactics: {}, request: req });
  const storeBridge = (store: Map<string, unknown>, calls: Array<[string, unknown]>) => (op: string, args: unknown[]) => {
    const k = `${String(args[0])}|${String(args[1])}`;
    if (op === "storage.claim") {
      if (!store.has(k)) store.set(k, args[2]);
      return { v: store.get(k) };
    }
    if (op === "storage.set") {
      store.set(k, args[2]);
      return { v: null };
    }
    if (op === "vendor") calls.push([String(args[0]), args[1]]);
    return { v: op === "vendor" ? { ok: true, data: claimed } : null };
  };

  it("refuses a stored code whose anchors moved, or that already claims; v8 (event claim) becomes the lead claim", () => {
    expect(() => answererWithGoalAndLeadClaim(stored.replace("const row = claim.followup;", "const row = claim.row;"))).toThrow(/found 0 times/);
    expect(() => answererWithGoalAndLeadClaim(upgraded)).toThrow(/already claims/);
    const v8 = upgraded.replace(LEAD_CLAIM_BLOCK, () => EVENT_CLAIM_BLOCK_V8);
    expect(v8).toContain('"answered_events"');
    expect(answererV8ToLeadClaim(v8)).toBe(upgraded);
    expect(upgraded.indexOf(CLAIM_ANCHOR)).toBeGreaterThan(0);
  });

  it("no goal = the prompt byte for byte; a goal = one section after the game", async () => {
    const same = await runScript(stored, spec(request), storeBridge(new Map(), []));
    const without = await runScript(upgraded, spec(request), storeBridge(new Map(), []));
    expect(without).toEqual(same);
    const withGoal = await runScript(upgraded, spec({ ...request, goal: "A booked meeting." }), storeBridge(new Map(), []));
    expect(withGoal).toMatchObject({ kind: "done", result: { content: { system: "VOICE\n\nGAME\n\nWHAT THIS ANSWER WORKS TOWARD (the campaign's Target):\nA booked meeting.\n\nEMAIL" } } });
  });

  it("one lead, two campaigns, two different events: the second sends nothing and stops only its own row; after the window it takes over", async () => {
    const store = new Map<string, unknown>();
    const first = await runScript(upgraded, spec({ ...request, campaignId: "camp-1", trigger: { ...trigger, eventId: "evt-reply" } }), storeBridge(store, []));
    expect(first).toMatchObject({ kind: "done", result: { content: {} } });
    const calls: Array<[string, unknown]> = [];
    const second = await runScript(upgraded, spec({ ...request, now: "2026-11-13T10:05:00.000Z", campaignId: "camp-2", trigger: { ...trigger, eventId: "evt-lead-event" } }), storeBridge(store, calls));
    expect(second).toMatchObject({ kind: "done", result: { unmade: "answered_elsewhere: campaign camp-1 answers this lead", decided: "done" } });
    expect(calls).toEqual([
      ["lead.followup.claim", {}],
      ["lead.followup.record", { params: { id: "row-1" }, body: { kind: "stopped", reason: "answered_by_another_campaign" } }],
    ]);
    // The owner answering again keeps its claim fresh; another campaign 31 minutes after the last answer takes over.
    const later = await runScript(upgraded, spec({ ...request, now: "2026-11-13T10:40:00.000Z", campaignId: "camp-2" }), storeBridge(store, []));
    expect(later).toMatchObject({ kind: "done", result: { content: {} } });
    expect(store.get("answering_leads|lead-1")).toEqual({ campaignId: "camp-2", at: "2026-11-13T10:40:00.000Z" });
  });
});

describe("the answerer's proactive tick (dy_answer_lead v10)", () => {
  const stored = [
    "let ctx_ = null;",
    "function door(name, args) { return ctx_.vendor.call(name, args); }",
    "function must(name, args) { const a = door(name, args); if (!a.ok) throw new Error(name); return a.data; }",
    "function s(v) { return typeof v === 'string' && v.trim() !== '' ? v.trim() : null; }",
    "export default function run(ctx) {",
    "  ctx_ = ctx;",
    "  const req = ctx.request || {};",
    '  const trigger = req.trigger && typeof req.trigger === "object" ? req.trigger : null;',
    '  if (!trigger) return { unmade: "no_occurrence" };',
    "  const brandId = s(req.brandId);",
    "  const campaignId = s(req.campaignId);",
    '  if (!brandId || !campaignId) throw new Error("the run names no brand or campaign");',
    "  const p = trigger.person || {};",
    "  const claim = must('lead.followup.claim', { person: { email: s(p.email), phone: s(p.phone), leadId: s(trigger.leadId) } });",
    "  return { content: { claimed: claim.followup.id, kind: trigger.item && trigger.item.kind } };",
    "}",
  ].join("\n");
  const v10 = answererV9ToProactive(stored);
  const run = (req: Record<string, unknown>, answers: Record<string, unknown>) => {
    const calls: Array<[string, unknown]> = [];
    const out = runScript(v10, { subject: null, brand: "b", day: 0, tactics: {}, request: req }, (op, args) => {
      if (op !== "vendor") return { v: null };
      calls.push([String(args[0]), args[1]]);
      return { v: answers[String(args[0])] };
    });
    return out.then((o) => ({ o, calls }));
  };

  it("serves only a due lead its brand holds, then claims that person like an occurrence's", async () => {
    const { o, calls } = await run({ brandId: "b1", campaignId: "c1" }, {
      "lead.serve": { ok: true, data: { found: true, lead: { leadId: "lead-9", email: "kevin+due@hidistribute.com", leadCampaignId: "lc-9" } } },
      "lead.followup.claim": { ok: true, data: { found: true, followup: { id: "row-9" } } },
    });
    expect(o).toMatchObject({ kind: "done", result: { content: { claimed: "row-9", kind: "follow_up_due" } } });
    expect(calls).toEqual([
      ["lead.serve", { dueFollowupOnly: true }],
      ["lead.followup.claim", { person: { email: "kevin+due@hidistribute.com", phone: null, leadId: "lead-9" } }],
    ]);
  });

  it("nobody due = idle; an occurrence run never serves", async () => {
    const none = await run({ brandId: "b1", campaignId: "c1" }, { "lead.serve": { ok: true, data: { found: false, reason: "lead_followup_none_due" } } });
    expect(none.o).toMatchObject({ kind: "done", result: { unmade: "nobody_due: lead_followup_none_due", decided: "idle" } });
    const occ = await run({ brandId: "b1", campaignId: "c1", trigger: { leadId: "lead-1", person: { email: "a@b.co" }, item: { kind: "reply" } } }, { "lead.followup.claim": { ok: true, data: { found: true, followup: { id: "row-1" } } } });
    expect(occ.calls.map((c) => c[0])).toEqual(["lead.followup.claim"]);
    expect(() => answererV9ToProactive(v10)).toThrow(/already serves/);
  });
});
