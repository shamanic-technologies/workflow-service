import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { addFounderHelloClaimReason } from "../../src/lib/scripts/founder-hello-claim.js";
import { endRunBodyOf } from "../../src/lib/scripts/engine-runner.js";

// MON-WA-FOUNDER-HELLO-1126: the live founder hello sender (v7, byte for byte as production stores it). Prod 2026-11-26:
// Shakeeb's claim was held by a run a deploy killed; the redelivery found nobody and the script FAILED (red).
const STORED = readFileSync(join(__dirname, "../fixtures/stored-scripts/founder-hello-claim/whatsapp_message_sent__dy_founder_hello.v7.ts.txt"), "utf8");
const NEXT = addFounderHelloClaimReason(STORED);

const request = {
  now: "2026-11-26T04:21:00.000Z",
  campaignId: "a90ca71a-40c7-4a07-8131-39cc564bc841",
  brandIds: ["f4d73dab-1f9d-49b2-b16e-63ecde76a5eb"],
  trigger: { eventId: "a519126c-e9ac-4887-bd2e-a4fb3bfb2de6", leadId: "f7c6bddc-2a6e-49e4-882a-3d1152cffa0f", person: { email: "shakeeb@writebros.ai" }, item: {} },
};

function harness(claim: unknown) {
  const calls: string[] = [];
  const bridge: Bridge = (op, args) => {
    if (op === "vendor") {
      const name = String(args[0]);
      calls.push(name);
      if (name === "lead.followup.claim") return { v: { ok: true, data: claim } };
      return { stop: `unexpected call ${name}` };
    }
    return { stop: `${String(op)} asked` };
  };
  return { bridge, calls };
}

async function run(code: string, claim: unknown) {
  const h = harness(claim);
  const out = await runScript(code, { subject: null, brand: request.brandIds[0], day: 0, tactics: { recorded_by: "crm", asks: ["message_written"] }, request }, h.bridge);
  return { out, calls: h.calls };
}

describe("founder hello: a claim that finds nobody ends on lead-service's reason", () => {
  it("reads nothing new and refuses a second edit", async () => {
    const [b, a] = [await validateSource(STORED), await validateSource(NEXT)];
    expect(a.materials).toEqual(b.materials);
    expect(a.vendors).toEqual(b.vendors);
    expect(() => addFounderHelloClaimReason(NEXT)).toThrow(/already/);
  }, 30_000);

  it("all_claimed (another run's lease holds the row): before = failed run, after = asked again, no refusal stated", async () => {
    const claim = { found: false, reason: "all_claimed" };
    const before = await run(STORED, claim);
    expect(before.out.kind).toBe("error");
    const after = await run(NEXT, claim);
    expect(after.calls).toEqual(["lead.followup.claim"]);
    expect(after.out.kind).toBe("done");
    const result = (after.out as { result: any }).result;
    expect(result.again).toBe(true);
    expect(String(result.unmade)).toMatch(/^all_claimed: /);
    // On an occurrence: redelivered, nothing said about the person.
    expect(endRunBodyOf({ status: "unmade", error: result.unmade, again: true }, true)).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
  }, 30_000);

  it("nothing_due (the person's one next date is ahead): idle, redelivered", async () => {
    const after = await run(NEXT, { found: false, reason: "nothing_due" });
    expect(after.out.kind).toBe("done");
    const result = (after.out as { result: any }).result;
    expect(result.decided).toBe("idle");
    expect(String(result.unmade)).toMatch(/^nothing_due: /);
    expect(endRunBodyOf({ status: "unmade", error: result.unmade, decided: "idle" }, true)).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
  }, 30_000);

  it("no reason stated: still a failure, naming it", async () => {
    const after = await run(NEXT, { found: false });
    expect(after.out.kind).toBe("error");
    expect((after.out as { message: string }).message).toMatch(/nobody could be claimed \(no reason\)/);
  }, 30_000);
});
