import { describe, expect, it } from "vitest";
import { callVendor, NOT_YET_MAX_SECONDS, type VendorDeps } from "../../src/lib/scripts/vendors.js";

/**
 * THREAD-OF-EMAILED-PERSON-1126 (crm-service v0.133.0): a person-thread read that finds nobody answers 404 with
 * `thread.status`: `none` = this person has no thread with the brand (a first email is right), `not_known_yet` = an email
 * of the brand to that address exists that the index has not joined yet (nothing may be written now). The door asks
 * again while it is `not_known_yet`, then answers no answer at all (an unreadable thread: every script writes nothing).
 */
const RUN = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "script-run", "x-brand-id": "brand-1" };
const ctx = { headers: RUN, tactics: {} };
const notYet = (retryAfterSeconds?: number) => ({ status: 404, body: { error: "person not found", thread: { status: "not_known_yet", ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}), indexBuiltAt: "2026-11-26T12:00:00Z", checks: [] } } });
const none = { status: 404, body: { error: "person not found", thread: { status: "none", indexBuiltAt: "2026-11-26T12:00:00Z", checks: [] } } };

function door(answers: Array<{ status: number; body: Record<string, unknown> }>) {
  let asked = 0;
  const slept: number[] = [];
  const deps = {
    async serviceDoor() {
      const a = answers[Math.min(asked, answers.length - 1)]!;
      asked++;
      return a;
    },
    async sleep(ms: number) {
      slept.push(ms);
    },
  } as unknown as VendorDeps;
  return { deps, slept, asked: () => asked };
}
const read = (deps: VendorDeps) => callVendor("crm.person.thread", { query: { brandId: "brand-1", personKey: "email:a@b.co" } }, ctx, deps);

describe("crm.person.thread tells « no thread » from « not known yet »", () => {
  it("none: passed on as it came, asked once (the script writes a first email)", async () => {
    const d = door([none]);
    const a = await read(d.deps);
    expect(a.ok).toBe(false);
    expect((a.data as { status: number }).status).toBe(404);
    expect(d.asked()).toBe(1);
  });

  it("a recorded 404 stating no thread field: unchanged", async () => {
    const d = door([{ status: 404, body: { error: "person not found" } }]);
    const a = await read(d.deps);
    expect((a.data as { status: number }).status).toBe(404);
    expect(d.asked()).toBe(1);
  });

  it("not_known_yet then found: asked again after the stated seconds, the thread is read", async () => {
    const d = door([notYet(15), { status: 200, body: { items: [{ kind: "message" }] } }]);
    const a = await read(d.deps);
    expect(a.ok).toBe(true);
    expect(d.slept).toEqual([15_000]);
  });

  it("not_known_yet then none: the positive none is passed on", async () => {
    const d = door([notYet(5), none]);
    const a = await read(d.deps);
    expect((a.data as { status: number }).status).toBe(404);
    expect(d.asked()).toBe(2);
  });

  it("still not_known_yet after the bound: no answer (no status), named, nothing read as nobody", async () => {
    const d = door([notYet(60)]);
    const a = await read(d.deps);
    expect(a.ok).toBe(false);
    expect((a.data as { status?: number }).status).toBeUndefined();
    expect(String((a.data as { error: string }).error)).toContain("not_known_yet");
    expect(d.slept.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(NOT_YET_MAX_SECONDS * 1000);
  });

  it("no stated retry: 10 s between asks; a stated 0 or 900 is held to 1-60 s", async () => {
    const d = door([notYet(), notYet(900), notYet(0), none]);
    await read(d.deps);
    expect(d.slept).toEqual([10_000, 60_000, 1_000]);
  });
});
