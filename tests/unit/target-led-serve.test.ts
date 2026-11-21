import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { addTargetLedServe, targetLedServeTactics } from "../../src/lib/scripts/target-led-serve.js";

// TARGET-LED-SERVE-1121: the cold email senders (byte for byte as production stores them) take the person of a
// channel-less campaign from its Lead found Engine, served by name; a funnel campaign is served as before.
const STORED = {
  signed: readFileSync(join(__dirname, "../fixtures/stored-scripts/email_sent__dy_cold_email_signed_sender_client_brand.v9.ts.txt"), "utf8"),
  port: readFileSync(join(__dirname, "../fixtures/stored-scripts/email_sent__dy_cold_email.v13.ts.txt"), "utf8"),
};

type Call = { name: string; args: Record<string, any> };
const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const now = "2026-11-21T19:00:00.000Z";

function harness(found: unknown) {
  const calls: Call[] = [];
  const asks: Array<{ outcome: string; request: any }> = [];
  let pending: any = null;
  const bridge: Bridge = (op, args) => {
    if (op === "vendor") {
      const name = String(args[0]);
      const a = (args[1] ?? {}) as Record<string, any>;
      calls.push({ name, args: a });
      if (name === "lead.serve") return { v: ok({ found: true, lead: { leadId: a.namedLead?.leadId ?? "buyer-1", email: "pat@fund.vc", data: { firstName: "Pat", organization: { name: "Fund" } } } }) };
      if (name === "crm.person.thread") return { v: { ok: false, data: { status: 404, error: "no thread" } } };
      if (name === "brand.profile") return { v: ok({ brand: { name: "distribute.you" } }) };
      if (name === "brand.extract_fields") return { v: ok({ fields: {} }) };
      if (name === "content.generate") return { v: ok({ id: "g1", subject: "Hello", sequence: [{ step: 1, bodyHtml: "<p>Hi</p>" }] }) };
      if (name === "email.send") return { v: ok({ success: true }) };
      return { stop: `unexpected call ${name}` };
    }
    if (op === "ask") {
      pending = args[0];
      return { v: null };
    }
    if (op === "get") {
      const outcome = String(args[0]);
      asks.push({ outcome, request: pending });
      pending = null;
      if (outcome === "lead_found") return { v: found };
      if (outcome === "message_written") return { v: { content: { existing: false, generation: { body: {}, units: {} } }, run: { id: "w1" } } };
      return { v: { content: { answer: { json: { signature: "Anna\nAcme" } } } } };
    }
    return { stop: `${String(op)} asked` };
  };
  return { bridge, calls, asks };
}

const madeLead = { id: "r9:lead_found", outcome: "lead_found", subject: "inv-7", ageDays: 0, content: { leadId: "inv-7", email: "pat@fund.vc" }, run: { runId: "r9" } };
const request = (featureSlug: string | null | undefined) => ({ now, brief: "Reach equity investors.", brandIds: ["brand-1"], campaignId: "c1", offerId: "o1", ...(featureSlug === undefined ? {} : { featureSlug }) });

for (const [name, stored] of Object.entries(STORED)) {
  describe(`${name}: the edit`, () => {
    const next = addTargetLedServe(stored);
    it("valid, reads Lead found, keeps every other stored line", async () => {
      const [after, before] = [await validateSource(next), await validateSource(stored)];
      expect(after.vendors).toEqual(before.vendors);
      expect(new Set(after.materials)).toEqual(new Set([...before.materials, "lead_found"]));
      const lines = new Set(next.split("\n"));
      const changed = stored.split("\n").filter((l) => !lines.has(l));
      expect(changed).toEqual(['  const serve = ctx.vendor.call("lead.serve", { ...(tactics.serve ?? {}), ...(named ? { namedLead: named } : {}) });']);
      expect(() => addTargetLedServe(next)).toThrow(/already/);
    });

    it("a channel-less campaign: the person its Lead found Engine found, served by name, no own serve tactic", async () => {
      const h = harness(madeLead);
      const out: any = await runScript(next, { subject: null, brand: "b", day: 0, tactics: { serve: { excludeEmailedWithin: "never" } }, request: request(null) }, h.bridge);
      expect(out.error).toBeUndefined();
      expect(h.asks[0]).toMatchObject({ outcome: "lead_found", request: { units: {} } });
      expect(h.calls.find((c) => c.name === "lead.serve")!.args).toEqual({ namedLead: { leadId: "inv-7", triggerEventId: "lead_found:r9" } });
      expect(h.calls.some((c) => c.name === "email.send")).toBe(true);
    });

    it("a channel-less campaign whose Lead found finds nobody: nothing made with its reason, never the buyers' serve", async () => {
      for (const [why, again] of [["audience_exhausted", false], ["serve_timed_out", true]] as const) {
        const h = harness({ id: "x", outcome: "lead_found", subject: "", ageDays: 0, content: null, unmade: why, run: null });
        const out: any = await runScript(next, { subject: null, brand: "b", day: 0, tactics: {}, request: request(null) }, h.bridge);
        expect(out.result).toEqual(again ? { unmade: why, again: true } : { unmade: why });
        expect(h.calls.some((c) => c.name === "lead.serve")).toBe(false);
      }
    });

    it("a funnel campaign, or a recorded request naming no channel at all: the very same calls as the stored code", async () => {
      for (const fs of ["sales-cold-email-outreach", undefined]) {
        const a = harness(madeLead);
        const b = harness(madeLead);
        await runScript(next, { subject: null, brand: "b", day: 0, tactics: {}, request: request(fs) }, a.bridge);
        await runScript(stored, { subject: null, brand: "b", day: 0, tactics: {}, request: request(fs) }, b.bridge);
        expect(a.calls).toEqual(b.calls);
        expect(a.asks.some((x) => x.outcome === "lead_found")).toBe(false);
      }
    });
  });
}

describe("the tactics", () => {
  it("asks gains Lead found once", () => {
    expect(targetLedServeTactics({ asks: ["message_written", "llm_completion"], signedBy: "x" })).toEqual({ asks: ["message_written", "llm_completion", "lead_found"], signedBy: "x" });
    expect(targetLedServeTactics({ asks: ["lead_found"] })).toEqual({ asks: ["lead_found"] });
  });
});
