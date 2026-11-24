import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMAIL_MEDIUM, WHATSAPP_MEDIUM, rightMomentStrategy } from "../../src/lib/right-moment.js";
import {
  OUR_MESSAGE_LAST_EDITS,
  OUR_MESSAGE_LAST_MARKER,
  OUR_MESSAGE_LAST_WRITERS,
  carriesStoredRightMoment,
  ourMessageLastCase,
  ourMessageLastSource,
} from "../../src/lib/scripts/our-message-last.js";
import { splitFollowUp } from "../../src/lib/scripts/follow-up-split.js";
import { splitCopilotWriter } from "../../src/lib/scripts/copilot-writer-split.js";

/**
 * LEAD-EVENT-FOUNDER-HELLO-DOUBLE-1124: THE RIGHT MOMENT keys on the thread's last message, in the source and in every
 * stored writer (anchored edits of the stored code, nothing else moved).
 */
const fixture = (name: string): string => readFileSync(join(__dirname, "../fixtures", name), "utf8");

const OLD_NOT = "someone on our side already wrote to them after their last message";

// The stored writers: the lead answer writer as stored (v4, v5), the three others cut from the stored unsplit scripts
// by the same split that made them (their prompt step moved verbatim).
const WRITERS: Record<string, string> = {
  "message_written/dy_answer_lead v5": fixture("stored-scripts/message_written__dy_answer_lead.v5.ts.txt"),
  "message_written/dy_answer_lead v4": fixture("stored-scripts/message_written__dy_answer_lead.v4.ts.txt"),
  "message_written/dy_follow_up_due": splitFollowUp(fixture("follow-up-due-stored-v8.js")).writer,
  "message_written/dy_client_check_in": splitCopilotWriter(fixture("client-check-in-stored-v3.js"), "dy_client_check_in").writer,
  "message_written/dy_brand_team": splitCopilotWriter(fixture("brand-team-stored-v3.js"), "dy_brand_team").writer,
};

// The senders as stored after the split: the prompt step is still defined in them, never called.
const SENDERS: Record<string, string> = {
  "lead_interested/dy_follow_up_due v12": fixture("follow-up-due-stored-v12.js"),
  "paid_client/dy_client_check_in v5": fixture("client-check-in-stored-v5.js"),
  "paid_client/dy_brand_team v5": fixture("brand-team-stored-v5.js"),
};

describe("THE RIGHT MOMENT keys on the thread's last message", () => {
  for (const [name, m] of [["email", EMAIL_MEDIUM], ["WhatsApp", WHATSAPP_MEDIUM]] as const) {
    it(`${name}: both clauses are stated on the thread's last message, two-sided`, () => {
      const [head, not, is, tail, ...rest] = rightMomentStrategy(m).split("\n");
      expect(rest).toEqual([]);
      expect(head.startsWith("THE RIGHT MOMENT. ")).toBe(true);
      expect(tail).toBe("later is never the end: the person stays followed up at the date you choose.");
      expect(not).not.toContain(OLD_NOT);
      expect(not).toContain("It is NOT the right moment when the last message in THE THREAD is ours and they have not answered it");
      expect(not).toContain("our founder, our assistant, another campaign");
      expect(not).toContain("counts exactly like an " + m.automated);
      expect(not).toContain("A fact that happened before our last message (their signup, a step they have not taken yet) was already known when we wrote it: it is never a reason to write on top of it.");
      expect(not).toContain("Then set decision to later: nothing is sent, " + m.emptyFields);
      // The same three ways out on both sides: theirs is last / they acted since / enough time passed.
      expect(not).toContain("unless they did something after it that calls for an answer or enough time passed since it for a new, useful follow-up");
      expect(is).toContain("their message is the last one and nobody on our side answered it");
      expect(is).toContain("when they did something after our last message that calls for an answer");
      expect(is).toContain("or when enough time passed since our last message for a new, useful follow-up");
      expect(is).toContain("Then set decision to write: " + m.whereItGoes);
    });
  }

  it("the text holds no dash, quote, backslash: a line reads the same in a script source, a prompt and a case", () => {
    for (const e of OUR_MESSAGE_LAST_EDITS) {
      for (const text of [e.from, e.to]) expect(text).not.toMatch(/[—–"\\\n]/);
      expect(e.from).not.toBe(e.to);
      expect(e.why.length).toBeGreaterThan(10);
    }
    expect(OUR_MESSAGE_LAST_EDITS).toHaveLength(4);
  });

  it("the edits turn the stored lines into exactly the lines the source states now", () => {
    for (const m of [EMAIL_MEDIUM, WHATSAPP_MEDIUM]) {
      const now = rightMomentStrategy(m);
      const lines = now.split("\n");
      const before = now.split("\n").map((l) => OUR_MESSAGE_LAST_EDITS.find((e) => e.to === l)?.from ?? l).join("\n");
      expect(before).not.toBe(now);
      expect(before.split("\n")[0]).toBe(lines[0]);
      expect(before.split("\n")[3]).toBe(lines[3]);
      // Each stored script holds the text JSON-encoded: the encoded old text becomes the encoded new one.
      expect(ourMessageLastSourceOf(JSON.stringify(before), m === EMAIL_MEDIUM ? 0 : 2)).toBe(JSON.stringify(now));
    }
  });

  for (const [name, stored] of Object.entries(WRITERS)) {
    it(`${name}: upgraded by the edits, both media, nothing else moved`, () => {
      expect(carriesStoredRightMoment(stored)).toBe(true);
      expect(stored.split(OLD_NOT).length - 1).toBe(2);
      const next = ourMessageLastSource(stored);
      expect(next).not.toContain(OLD_NOT);
      expect(next.split(OUR_MESSAGE_LAST_MARKER).length - 1).toBe(2);
      for (const m of [EMAIL_MEDIUM, WHATSAPP_MEDIUM]) {
        // The whole game, as the source states it today, is in the upgraded code once (JSON-encoded, as stored).
        expect(next.split(JSON.stringify(rightMomentStrategy(m)).slice(1, -1)).length - 1).toBe(1);
      }
      // Nothing but the four lines moved: undoing the edits gives the stored code back, byte for byte.
      let back = next;
      for (const e of OUR_MESSAGE_LAST_EDITS) {
        expect(back.split(e.to).length - 1).toBe(1);
        back = back.replace(e.to, () => e.from);
      }
      expect(back).toBe(stored);
      expect(next.split("\n").length).toBe(stored.split("\n").length);
      // An upgraded version is never upgraded twice.
      expect(() => ourMessageLastSource(next)).toThrow(/already keys THE RIGHT MOMENT/);
    });
  }

  it("a moved anchor generates nothing", () => {
    const stored = WRITERS["message_written/dy_answer_lead v5"];
    const moved = stored.replace("counts exactly like an automated email", "counts like an automated email");
    expect(() => ourMessageLastSource(moved)).toThrow(/found 0.*nothing generated/);
    expect(() => ourMessageLastSource("export default function run(ctx) { return null; }")).toThrow(/nothing generated/);
    const twice = stored + "\n// " + OUR_MESSAGE_LAST_EDITS[0].from;
    expect(() => ourMessageLastSource(twice)).toThrow(/found 2.*nothing generated/);
  });

  for (const [name, stored] of Object.entries(SENDERS)) {
    it(`${name}: the text it still holds is dead (its prompt step is defined, never called)`, () => {
      expect(carriesStoredRightMoment(stored)).toBe(true);
      expect(stored.match(/step_compose(?![_A-Za-z0-9])/g)).toHaveLength(1);
      expect(stored).toContain("const step_compose = (function () {");
      expect(stored).not.toMatch(/step_compose\(/);
    });
  }

  it("the store names the four writers, each by its exact dynasty", () => {
    expect([...OUR_MESSAGE_LAST_WRITERS]).toEqual(["dy_answer_lead", "dy_follow_up_due", "dy_client_check_in", "dy_brand_team"]);
  });

  it("a recorded case is restated where its prompt held the lines, its answers untouched", () => {
    const prompt = ["GAME", rightMomentStrategyBefore(WHATSAPP_MEDIUM), "END"].join("\n\n");
    const c = { id: "c1", calls: [{ door: "chat.copilot.lead_turn", request: { systemPrompt: prompt, message: "THE THREAD" }, answer: { json: { decision: "later" } } }], expect: { unmade: "later" } };
    const r = ourMessageLastCase(c);
    if (!("case" in r)) throw new Error("excluded");
    expect(r.case.calls[0].request.systemPrompt).toBe(["GAME", rightMomentStrategy(WHATSAPP_MEDIUM), "END"].join("\n\n"));
    expect(r.case.calls[0].answer).toEqual(c.calls[0].answer);
    expect(r.case.expect).toEqual(c.expect);
    expect(ourMessageLastCase(r.case)).toEqual({ excluded: "already restated" });
    const idle = { id: "c2", calls: [], expect: null };
    expect(ourMessageLastCase(idle)).toEqual({ case: idle });
  });
});

/** The game as stored before the change, rebuilt from today's text by undoing the edits. */
function rightMomentStrategyBefore(m: typeof EMAIL_MEDIUM): string {
  return rightMomentStrategy(m)
    .split("\n")
    .map((l) => OUR_MESSAGE_LAST_EDITS.find((e) => e.to === l)?.from ?? l)
    .join("\n");
}

/** One medium's two edits (from index `at`) applied to an encoded text. */
function ourMessageLastSourceOf(encoded: string, at: number): string {
  let out = encoded;
  for (const e of OUR_MESSAGE_LAST_EDITS.slice(at, at + 2)) {
    expect(out.split(e.from).length - 1).toBe(1);
    out = out.replace(e.from, () => e.to);
  }
  return out;
}
