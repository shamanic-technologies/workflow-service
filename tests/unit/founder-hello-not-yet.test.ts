import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { addFounderHelloClaimReason } from "../../src/lib/scripts/founder-hello-claim.js";
import { addFounderHelloNotYet } from "../../src/lib/scripts/founder-hello-not-yet.js";
import { endRunBodyOf } from "../../src/lib/scripts/engine-runner.js";

// HELLO-LATE-1126: the live founder hello sender is v8 = v7 + the claim edits (byte for byte as production stores it).
// Prod 2026-11-25, Elias Biondo gave his number at 15:10, before any account: the thread read 404'd, then the writer threw
// « no onboarding record » twice; each FAILED run pushed the redelivery further (2, 10, 30 min) and the hello left at
// 15:53 for an account created at 15:23:34.
const V7 = readFileSync(join(__dirname, "../fixtures/stored-scripts/founder-hello-claim/whatsapp_message_sent__dy_founder_hello.v7.ts.txt"), "utf8");
const STORED = addFounderHelloClaimReason(V7);
const NEXT = addFounderHelloNotYet(STORED);

const PHONE = "+5511978399280";
const request = {
  now: "2026-11-25T15:12:00.000Z",
  campaignId: "a90ca71a-40c7-4a07-8131-39cc564bc841",
  brandIds: ["f4d73dab-1f9d-49b2-b16e-63ecde76a5eb"],
  trigger: { eventId: "283cb26b-6c0b-4227-b2e9-8bf6f90bdc3b", leadId: "ff6948c6-0000-4000-8000-000000000000", person: { name: "Elias Biondo", phone: PHONE }, item: { kind: "phone_given", phone: PHONE, firstName: "Elias" } },
};
const claim = { found: true, followup: { id: "row-1", leadId: "ff6948c6-0000-4000-8000-000000000000", email: null, phone: PHONE, brandId: request.brandIds[0] } };
const RECORD = { kind: "event", source: "onboarding", event: { step: "onboarding_record" }, text: "Brand: Trilo (trilo.app)\nOffer: Trilo", at: "2026-11-25T15:23:34.000Z" };

type Thread = { status: number } | { items: unknown[]; sources: unknown[] };
function harness(thread: Thread) {
  const calls: string[] = [];
  const bridge: Bridge = (op, args) => {
    if (op !== "vendor") return { stop: `${String(op)} asked` };
    const name = String(args[0]);
    calls.push(name);
    if (name === "lead.followup.claim") return { v: { ok: true, data: claim } };
    if (name === "crm.whatsapp.sent") return { v: { ok: true, data: { sends: [] } } };
    if (name === "crm.person.thread") {
      if ("status" in thread) return { v: { ok: false, data: { status: thread.status, error: `no person holds phone:${PHONE.slice(1)} (index built in background)` } } };
      return { v: { ok: true, data: thread } };
    }
    if (name === "crm.team.membership") return { v: { ok: true, data: { staff: false, ownTeam: false, matches: [] } } };
    if (name === "crm.whatsapp.reach") return { v: { ok: true, data: { reachable: true, persona: null, fromAccount: "+33600000000" } } };
    return { stop: `unexpected call ${name}` };
  };
  return { bridge, calls };
}
async function run(code: string, thread: Thread) {
  const h = harness(thread);
  const out = await runScript(code, { subject: null, brand: request.brandIds[0], day: 0, tactics: { recorded_by: "crm", asks: ["message_written"] }, request }, h.bridge);
  return { out, calls: h.calls };
}
const OCCURRENCE_AGAIN = { success: true, stopCampaign: false, noWorkAvailable: true };

describe("founder hello: a person not set up YET is asked again, never a failed run (HELLO-LATE-1126)", () => {
  it("reads nothing new and refuses a second edit", async () => {
    const [b, a] = [await validateSource(STORED), await validateSource(NEXT)];
    expect(a.materials).toEqual(b.materials);
    expect(a.vendors).toEqual(b.vendors);
    expect(() => addFounderHelloNotYet(NEXT)).toThrow(/already/);
  }, 30_000);

  it("15:10, crm-service holds no thread for the number yet (404): before = failed run, after = asked again", async () => {
    const before = await run(STORED, { status: 404 });
    expect(before.out.kind).toBe("error");
    const after = await run(NEXT, { status: 404 });
    expect(after.calls).toEqual(["lead.followup.claim", "crm.whatsapp.sent", "crm.person.thread"]);
    expect(after.out.kind).toBe("done");
    const result = (after.out as { result: any }).result;
    expect(result.again).toBe(true);
    expect(String(result.unmade)).toMatch(/^not_set_up_yet: crm-service holds no thread/);
    expect(endRunBodyOf({ status: "unmade", error: result.unmade, again: true }, true)).toEqual(OCCURRENCE_AGAIN);
  }, 30_000);

  it("any other thread failure still fails loud", async () => {
    const after = await run(NEXT, { status: 502 });
    expect(after.out.kind).toBe("error");
    expect((after.out as { message: string }).message).toMatch(/crm.person.thread failed \(502\)/);
  }, 30_000);

  it("15:12 / 15:23, admitted and reachable but no onboarding record yet: asked again, no writer asked, nothing sent", async () => {
    const after = await run(NEXT, { items: [], sources: [{ source: "onboarding", status: "ok" }] });
    expect(after.calls).toEqual(["lead.followup.claim", "crm.whatsapp.sent", "crm.person.thread", "crm.team.membership", "crm.whatsapp.reach"]);
    expect(after.out.kind).toBe("done");
    const result = (after.out as { result: any }).result;
    expect(result.again).toBe(true);
    expect(String(result.unmade)).toMatch(/^not_set_up_yet: no onboarding record on \+5511978399280's thread yet/);
    expect(endRunBodyOf({ status: "unmade", error: result.unmade, again: true }, true)).toEqual(OCCURRENCE_AGAIN);
  }, 30_000);

  it("the record source FAILED: not a 'not yet', the run goes on to the writer, whose loud refusal stays", async () => {
    const after = await run(NEXT, { items: [], sources: [{ source: "onboarding", status: "failed", error: "client-service 500" }] });
    expect(after.calls.at(-1)).toBe("brand.profile");
  }, 30_000);

  it("15:25, the record is on the thread: the run goes on exactly as before (next read = the brand)", async () => {
    const [before, after] = [await run(STORED, { items: [RECORD], sources: [] }), await run(NEXT, { items: [RECORD], sources: [] })];
    expect(after.calls).toEqual(before.calls);
    expect(after.calls.at(-1)).toBe("brand.profile");
  }, 30_000);
});
