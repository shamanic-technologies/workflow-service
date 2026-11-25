import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { addFollowUpTargetLed, followUpTargetLedTactics } from "../../src/lib/scripts/follow-up-target-led.js";

// PLAN-RECURSIVE-PER-ENGINE-1124-WF3 B2: the lead follow-up sender, byte for byte as production stores it (v13), takes
// its person from its Lead found Engine on a campaign launched on its Target alone; every other run is unchanged.
const STORED = readFileSync(join(__dirname, "../fixtures/stored-scripts/follow-up-target-led/lead_interested__dy_follow_up_due.v13.ts.txt"), "utf8");
const NEXT = addFollowUpTargetLed(STORED);
const now = "2026-11-25T12:00:00.000Z";

function harness(found: unknown) {
  const serves: unknown[] = [];
  const asks: string[] = [];
  const bridge: Bridge = (op, args) => {
    if (op === "vendor" && args[0] === "lead.serve") {
      serves.push(args[1]);
      return { stop: "served (the test ends here)" };
    }
    if (op === "ask") return { v: null };
    if (op === "get") {
      asks.push(String(args[0]));
      return { v: found };
    }
    return { stop: `${String(op)} ${String(args[0])}` };
  };
  return { bridge, serves, asks };
}
const madeLead = { id: "u1", outcome: "lead_found", subject: "lead-7", ageDays: 0, content: { leadId: "lead-7", email: "ana@clinic.com" }, run: { runId: "r9" } };
const req = (extra: Record<string, unknown>) => ({ now, campaignId: "c1", brandIds: ["b1"], offerId: "o1", runId: "run-1", ...extra });
const run = (code: string, request: Record<string, unknown>, found: unknown = madeLead) => {
  const h = harness(found);
  return runScript(code, { subject: null, brand: "b1", day: 0, tactics: {}, request }, h.bridge).then((out) => ({ out, ...h }));
};

describe("lead_interested/dy_follow_up_due: Target-led serve", () => {
  it("changes only the serve line, reads Lead found, and refuses a second edit", async () => {
    const before = new Set(STORED.split("\n"));
    const added = NEXT.split("\n").filter((l) => !before.has(l));
    const removed = STORED.split("\n").filter((l) => !new Set(NEXT.split("\n")).has(l));
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain('callStep(ctx, "lead.serve"');
    expect(added.some((l) => l.includes("namedLead: TARGET_LED ??"))).toBe(true);
    const [b, a] = [await validateSource(STORED), await validateSource(NEXT)];
    expect(new Set(a.materials)).toEqual(new Set([...b.materials, "lead_found"]));
    expect(a.vendors).toEqual(b.vendors);
    expect(() => addFollowUpTargetLed(NEXT)).toThrow(/already/);
    expect(followUpTargetLedTactics({ asks: ["message_written"], recorded_by: "sender" })).toEqual({ asks: ["message_written", "lead_found"], recorded_by: "sender" });
   }, 30_000);

  it("a Target run: the person its Lead found Engine found, served by name", async () => {
    const r = await run(NEXT, req({ featureSlug: null }));
    expect(r.asks).toEqual(["lead_found"]);
    expect(r.serves).toEqual([{ namedLead: { leadId: "lead-7", triggerEventId: "lead_found:r9" } }]);
  });

  it("a Target run whose Lead found finds nobody: nothing made with its reason, never its own serve", async () => {
    for (const [why, again] of [["lead_followup_none_due", false], ["serve_timed_out", true]] as const) {
      const r = await run(NEXT, req({ featureSlug: null }), { id: "x", outcome: "lead_found", subject: "", ageDays: 0, content: null, unmade: why, run: null });
      expect(r.serves).toEqual([]);
      expect(r.out).toEqual({ kind: "done", result: again ? { unmade: why, again: true } : { unmade: why } });
    }
  });

  it("a run with a channel, and an occurrence naming its person, serve exactly as the stored version", async () => {
    for (const request of [req({ featureSlug: "ai-follow-up-email" }), req({ featureSlug: null, trigger: { leadId: "lead-9", eventId: "ev-1" } }), req({})]) {
      const [before, after] = [await run(STORED, request), await run(NEXT, request)];
      expect(after.asks).toEqual([]);
      expect(after.serves).toEqual(before.serves);
      expect(after.out).toEqual(before.out);
    }
  });
});
