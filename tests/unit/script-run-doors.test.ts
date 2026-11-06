import { describe, it, expect } from "vitest";
import { BOOT_WAIT_MAX_MS, callVendor, SERVICE_DOOR_VENDORS, type VendorDeps } from "../../src/lib/scripts/vendors.js";
import { validateSource as readScriptSource } from "../../src/lib/scripts/sandbox.js";

// MIGRATE-1105 S1: a script that answers a lead acts through the producers' own org routes, AS its run.
type Seen = [string, string, string, unknown, Record<string, string>];

function door(answers: Array<{ status: number; body: Record<string, unknown> }>) {
  const seen: Seen[] = [];
  const slept: number[] = [];
  const deps = {
    async serviceDoor(service: string, method: string, path: string, body: unknown, headers: Record<string, string>) {
      seen.push([service, method, path, body, headers]);
      return answers.length > 1 ? answers.shift()! : answers[0]!;
    },
    async sleep(ms: number) {
      slept.push(ms);
    },
  } as unknown as VendorDeps;
  return { seen, slept, deps };
}

const RUN = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "script-run", "x-brand-id": "brand-1", "x-campaign-id": "camp-1" };
const ctx = { headers: RUN, tactics: {} };

describe("run doors (answering a lead)", () => {
  it("fills the path params, sends the query on a read, and answers the producer's whole body", async () => {
    const { seen, deps } = door([{ status: 200, body: { messages: [{ text: "Friday 3:30?" }] } }]);
    const out = await callVendor("crm.person.thread", { query: { personKey: "email:jy@w.com" } }, ctx, deps);
    expect(out).toEqual({ ok: true, data: { messages: [{ text: "Friday 3:30?" }] } });
    const d = door([{ status: 200, body: { nextFollowupAt: null } }]);
    await callVendor("lead.followup_date.set", { params: { id: "lead 1" }, query: { brandId: "b" }, body: { stop: { reason: "booked" } } }, ctx, d.deps);
    expect(seen[0]!.slice(0, 4)).toEqual(["crm", "GET", "/orgs/people/timeline?personKey=email%3Ajy%40w.com", null]);
    expect(d.seen[0]!.slice(0, 4)).toEqual(["lead", "PUT", "/orgs/leads/lead%201/followup-date?brandId=b", { stop: { reason: "booked" } }]);
  });

  it("calls as the script's run: its org, user, brand, campaign; never a caller run", async () => {
    const { seen, deps } = door([{ status: 200, body: {} }]);
    await callVendor("instantly.reply.send", { body: { campaign_id: "c", email: "a@b.co", body_html: "<p>Hi</p>" } }, ctx, deps);
    expect(seen[0]![4]).toEqual(RUN);
    expect(seen[0]![4]["x-caller-run-id"]).toBeUndefined();
  });

  it("a refusal is an answer the script reads, with its named code", async () => {
    const { deps } = door([{ status: 409, body: { error: "a human answered", code: "human_took_over" } }]);
    expect(await callVendor("instantly.reply.send", { body: {} }, ctx, deps)).toEqual({
      ok: false,
      data: { error: "a human answered", status: 409, code: "human_took_over", body: { error: "a human answered", code: "human_took_over" } },
    });
    const nested = door([{ status: 409, body: { error: "x", details: { code: "stated_not_to_brand" } } }]);
    expect((await callVendor("crm.whatsapp.send", { body: {} }, ctx, nested.deps)).data.code).toBe("stated_not_to_brand");
  });

  it("refuses a missing param, a body on a read, an org-less run, and dropping whose run it is", async () => {
    const { seen, deps } = door([{ status: 200, body: {} }]);
    expect((await callVendor("lead.detail", {}, ctx, deps)).data.error).toBe("lead.detail needs params.id");
    expect((await callVendor("lead.detail", { params: { id: "" } }, ctx, deps)).ok).toBe(false);
    expect((await callVendor("lead.detail", { params: { id: "l" }, body: {} }, ctx, deps)).ok).toBe(false);
    expect((await callVendor("lead.detail", { params: { id: "l" } }, { headers: { "x-run-id": "r" }, tactics: {} }, deps)).ok).toBe(false);
    expect((await callVendor("crm.whatsapp.send", { body: {}, omitHeaders: ["x-run-id"] }, ctx, deps)).ok).toBe(false);
    expect(seen).toEqual([]);
  });

  it("drops a header the call states (a rep alert is not the campaign speaking)", async () => {
    const { seen, deps } = door([{ status: 200, body: {} }]);
    await callVendor("crm.whatsapp.send", { body: { phone: "+1" }, omitHeaders: ["x-campaign-id"] }, ctx, deps);
    expect(seen[0]![4]["x-campaign-id"]).toBeUndefined();
    expect(seen[0]![4]["x-org-id"]).toBe("org-1");
  });

  it("a bounded poll asks again while the field holds, then answers the last; throwWhenTimedOut refuses", async () => {
    const pending = { status: 200, body: { status: "pending" } };
    const { seen, slept, deps } = door([pending, pending, { status: 200, body: { status: "found", phone: "+1" } }]);
    const out = await callVendor("apollo.phone.read", { params: { apolloPersonId: "p" }, pollWhile: { field: "status", equals: "pending", intervalSeconds: 5, timeoutSeconds: 90 } }, ctx, deps);
    expect(out).toEqual({ ok: true, data: { status: "found", phone: "+1" } });
    expect(seen).toHaveLength(3);
    expect(slept).toEqual([5000, 5000]);
    const moving = door([{ status: 200, body: { factFeed: { settled: false } } }]);
    const late = await callVendor("crm.person.thread", { query: { personKey: "k" }, pollWhile: { field: "factFeed.settled", equals: false, intervalSeconds: 10, timeoutSeconds: 0, throwWhenTimedOut: true } }, ctx, moving.deps);
    expect(late.ok).toBe(false);
  });

  // MIGRATE-1105 S5: the producer declares the Unit under the outcome of the script's Engine (a re-homed script's fine one).
  it("fills the outcome a producer declares with the script's Engine outcome; a script never names it", async () => {
    const { seen, deps } = door([{ status: 201, body: { postId: "p1" } }]);
    await callVendor("meta.threads.publish", { params: { id: "acc" }, body: { text: "hi" } }, { ...ctx, outcome: "threads_post_published" }, deps);
    expect(seen[0]![3]).toEqual({ text: "hi", outcomeKey: "threads_post_published" });
    await callVendor("meta.threads.publish", { params: { id: "acc" }, body: { text: "hi" } }, ctx, deps);
    expect(seen[1]![3]).toEqual({ text: "hi" });
    expect((await callVendor("meta.threads.publish", { params: { id: "acc" }, body: { text: "hi", outcomeKey: "x" } }, { ...ctx, outcome: "post_published" }, deps)).ok).toBe(false);
  });

  it("every run door names an org route of its producer by a literal path, and a script can name it", async () => {
    for (const [name, d] of Object.entries(SERVICE_DOOR_VENDORS)) {
      if (!d.asRun) continue;
      expect(name).toMatch(/^[a-z-]+\.[a-z_.]+$/);
      expect(d.path.startsWith("/")).toBe(true);
    }
    const read = await readScriptSource(`export default function run(ctx) { ctx.vendor.call("lead.followup_date.read", { params: { id: "l" } }); return null; }`);
    expect(read.vendors).toEqual(["lead.followup_date.read"]);
  });
});

describe("a door whose service is booting (a deploy, INCIDENT 2026-11-06 18:05 UTC)", () => {
  const STARTING = { status: 503, body: { error: "Service starting: database migrations in progress" } };
  it("asks again inside the run until the service answers, on a service door and on a run door", async () => {
    const d = door([STARTING, STARTING, { status: 200, body: { found: false, reason: "source_stock_empty" } }]);
    const serve = await callVendor("lead.serve", {}, { ...ctx, callerRunId: "caller" }, d.deps);
    expect(serve).toEqual({ ok: true, data: { found: false, reason: "source_stock_empty" } });
    expect(d.seen).toHaveLength(3);
    expect(d.slept).toEqual([5000, 5000]);
    const r = door([STARTING, { status: 200, body: { messages: [] } }]);
    expect(await callVendor("crm.person.thread", { query: { personKey: "email:a@b.co" } }, ctx, r.deps)).toEqual({ ok: true, data: { messages: [] } });
    expect(r.seen).toHaveLength(2);
  });

  it("a refused connection (the new container not listening yet) is asked again; any other throw is not", async () => {
    let n = 0;
    const slept: number[] = [];
    const deps = {
      async serviceDoor() {
        n += 1;
        if (n === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
        return { status: 200, body: { ok: 1 } };
      },
      async sleep(ms: number) {
        slept.push(ms);
      },
    } as unknown as VendorDeps;
    expect((await callVendor("lead.serve", {}, { ...ctx, callerRunId: "caller" }, deps)).ok).toBe(true);
    expect(n).toBe(2);
    let m = 0;
    const other = {
      async serviceDoor() {
        m += 1;
        throw new Error("The operation was aborted due to timeout");
      },
      async sleep() {},
    } as unknown as VendorDeps;
    expect(await callVendor("lead.serve", {}, { ...ctx, callerRunId: "caller" }, other)).toMatchObject({ ok: false });
    expect(m).toBe(1);
  });

  it("is bounded: a service that never comes up answers its 503 to the script", async () => {
    const d = door([STARTING]);
    const out = await callVendor("lead.serve", {}, { ...ctx, callerRunId: "caller" }, d.deps);
    expect(out.ok).toBe(false);
    expect(d.slept.reduce((a, b) => a + b, 0)).toBe(BOOT_WAIT_MAX_MS);
    // A 503 that is not a boot (a real outage) is answered at once.
    const down = door([{ status: 503, body: { error: "Service unavailable: database migrations failed" } }]);
    expect((await callVendor("lead.serve", {}, { ...ctx, callerRunId: "caller" }, down.deps)).ok).toBe(false);
    expect(down.seen).toHaveLength(1);
  });
});
