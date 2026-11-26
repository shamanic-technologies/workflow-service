import { describe, it, expect } from "vitest";
import { callVendor, SERVICE_DOOR_VENDORS, type VendorDeps } from "../../src/lib/scripts/vendors.js";

// VERDICT-WINDOW-BY-CALLER-1126: the oldest address verdict a Script accepts is its tactic `verdictMaxAgeDays`, stated
// by the door as email-gateway's `maxVerdictAgeDays` on every email door; a Script stating none sends its body as is.
function world() {
  const seen: unknown[] = [];
  const deps = {
    async serviceDoor(_s: string, _m: string, _p: string, body: unknown) {
      seen.push(body);
      return { status: 200, body: { ok: true } };
    },
  } as unknown as VendorDeps;
  return { seen, deps };
}
const ctx = (tactics: Record<string, unknown>) => ({ headers: { "x-org-id": "org-1", "x-run-id": "script-run" }, tactics });
const SEND = { type: "broadcast", to: "ana@clinic.test", subject: "Hi" };

describe("the address verdict window a Script states", () => {
  for (const door of ["email.send", "email.send_check"]) {
    it(`${door}: the Script's tactic is stated to the producer`, async () => {
      const w = world();
      expect((await callVendor(door, { body: SEND }, ctx({ verdictMaxAgeDays: 30 }), w.deps)).ok).toBe(true);
      expect(w.seen).toEqual([{ ...SEND, maxVerdictAgeDays: 30 }]);
    });

    it(`${door}: a Script stating no window sends its body byte for byte`, async () => {
      const w = world();
      await callVendor(door, { body: SEND }, ctx({}), w.deps);
      await callVendor(door, { body: SEND }, ctx({ verdictMaxAgeDays: null }), w.deps);
      expect(w.seen).toEqual([SEND, SEND]);
    });

    it(`${door}: a window the call itself states wins over the tactic`, async () => {
      const w = world();
      await callVendor(door, { body: { ...SEND, maxVerdictAgeDays: 0 } }, ctx({ verdictMaxAgeDays: 30 }), w.deps);
      expect(w.seen).toEqual([{ ...SEND, maxVerdictAgeDays: 0 }]);
    });
  }

  it("only the doors whose producer verifies an address take the window (a reply in a thread verifies none)", () => {
    const filled = Object.entries(SERVICE_DOOR_VENDORS).filter(([, d]) => "tacticInBody" in d && d.tacticInBody).map(([n]) => n).sort();
    expect(filled).toEqual(["email.send", "email.send_check"]);
  });
});
