import { describe, it, expect } from "vitest";
import { replayCase, type RecordedCall } from "../../src/lib/scripts/replay.js";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { callVendor, type VendorDeps } from "../../src/lib/scripts/vendors.js";
import { buildAiInstantCallSource, NO_REP_UNMADE } from "../../scripts/engine-ports/ai-instant-call.js";

// MIGRATE-1105 S1b: the rep call (AI Instant Call workflow) as a stored script, proven on its real runs by
// `prove-port.ts prove ai-instant-call` (22/22 + 7/7 on 2026-11-06). These pin the branches the 7 days of runs never hit.
const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const trigger = { eventId: "ev-1", leadId: "lead-1", person: { email: "Ana@Clinic.test", name: "Ana" }, item: { channel: "email", replyText: "Yes", priorMessages: [] } };
const claim = { found: true, followup: { id: "row-1", email: "ana@clinic.test", phone: null, leadId: "lead-1", brandId: "brand-1" } };
const request = { campaignId: "camp-1", trigger };
const reads = (rep: string | null): RecordedCall[] => [
  { name: "lead.detail", args: { params: { id: "row-1" }, query: { campaignId: "camp-1" } }, answer: ok({ leadDetail: { lead: { firstName: "Ana", lastName: "Diaz" } } }) },
  { name: "brand.profile", args: { params: { id: "brand-1" } }, answer: ok({ brand: { name: "Doc Dinners" } }) },
  { name: "brand.sales_rep", args: { params: { brandId: "brand-1" } }, answer: ok({ salesRepPhone: rep }) },
];
const CALL_BODY = {
  to: "+15550001111",
  reply: { name: "Ana Diaz", firstName: "Ana", lastName: "Diaz", message: "Yes" },
  brandName: "Doc Dinners",
  brandId: "brand-1",
  campaignId: "camp-1",
  idempotencyKey: "ai-instant-call:event:ev-1",
};
const DELIVERED = { content: { end: { success: true, stopCampaign: false, delivery: { state: "delivered" } } } };

describe("the rep call port", () => {
  const src = buildAiInstantCallSource();

  it("is a valid script that needs no material (the occurrence rides the request)", async () => {
    await expect(validateSource(src)).resolves.toMatchObject({ materials: [] });
    await expect(validateSource(buildAiInstantCallSource({ emailRepliesOnly: true }))).resolves.toMatchObject({ materials: [] });
  });

  it("claims, rings the rep (the door files the call under the script's run), then stops the row", async () => {
    const r = await replayCase(src, {
      id: "rung",
      units: {},
      request,
      calls: [
        { name: "lead.followup.claim", args: { params: { campaignId: "camp-1" } }, answer: ok(claim) },
        ...reads("+15550001111"),
        { name: "twilio.call.place", args: { body: CALL_BODY }, answer: ok({ callId: "call-1" }) },
        { name: "lead.followup.record", args: { params: { id: "row-1" }, body: { kind: "stopped", reason: "instant_call_placed" } }, answer: ok({}) },
      ],
      expect: DELIVERED,
    });
    expect(r.diffs).toEqual([]);
  });

  it("asked with the asker's claimed row: claims nothing and stops no row (the asker owns it)", async () => {
    const r = await replayCase(src, {
      id: "asked",
      units: {},
      request: { ...request, claimed: claim },
      calls: [...reads("+15550001111"), { name: "twilio.call.place", args: { body: CALL_BODY }, answer: ok({}) }],
      expect: DELIVERED,
    });
    expect(r.diffs).toEqual([]);
    const noRep = await replayCase(src, { id: "asked-no-rep", units: {}, request: { ...request, claimed: claim }, calls: reads(null), expect: { fails: NO_REP_UNMADE } });
    expect(noRep.diffs).toEqual([]);
  });

  it("no rep phone rings nobody: the row stopped, unmade no_sales_rep_phone", async () => {
    const r = await replayCase(src, {
      id: "no-rep",
      units: {},
      request,
      calls: [
        { name: "lead.followup.claim", answer: ok(claim) },
        ...reads(null),
        { name: "lead.followup.record", args: { params: { id: "row-1" }, body: { kind: "stopped", reason: "no_sales_rep_phone" } }, answer: ok({}) },
      ],
      expect: { fails: NO_REP_UNMADE },
    });
    expect(r.diffs).toEqual([]);
  });

  it("a claimed person the occurrence does not name fails the run (redelivered); no occurrence claims nobody", async () => {
    const other = await replayCase(src, {
      id: "other",
      units: {},
      request,
      calls: [{ name: "lead.followup.claim", answer: ok({ found: true, followup: { ...claim.followup, email: "bob@else.test" } }) }, ...reads("+15550001111")],
      expect: { fails: "does not name" },
    });
    expect(other.diffs).toEqual([]);
    const idle = await replayCase(src, { id: "idle", units: {}, request: { campaignId: "camp-1", trigger: null }, calls: [], expect: { nothing: true } });
    expect(idle.diffs).toEqual([]);
  });

  it("the email-only copy rings nobody on a WhatsApp reply: not admitted (final), the row stopped", async () => {
    const r = await replayCase(buildAiInstantCallSource({ emailRepliesOnly: true }), {
      id: "wa",
      units: {},
      request: { campaignId: "camp-1", trigger: { ...trigger, item: { ...trigger.item, channel: "whatsapp" } } },
      calls: [
        { name: "lead.followup.claim", answer: ok(claim) },
        ...reads("+15550001111"),
        { name: "lead.followup.record", args: { params: { id: "row-1" }, body: { kind: "stopped", reason: "reply_not_by_email" } }, answer: ok({}) },
      ],
      expect: { fails: "person_not_admitted: reply_not_by_email" },
    });
    expect(r.diffs).toEqual([]);
  });
});

describe("a run door that files under the script's run in its body (twilio parentRunId)", () => {
  it("fills the field with the script's run, and refuses a script that states it", async () => {
    const seen: unknown[] = [];
    const deps = {
      async serviceDoor(_s: string, _m: string, _p: string, body: unknown) {
        seen.push(body);
        return { status: 201, body: { callId: "c" } };
      },
    } as unknown as VendorDeps;
    const ctx = { headers: { "x-org-id": "org-1", "x-run-id": "script-run" }, tactics: {} };
    expect((await callVendor("twilio.call.place", { body: { to: "+1" } }, ctx, deps)).ok).toBe(true);
    expect(seen).toEqual([{ to: "+1", parentRunId: "script-run" }]);
    expect((await callVendor("twilio.call.place", { body: { to: "+1", parentRunId: "x" } }, ctx, deps)).ok).toBe(false);
  });
});
