import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readMaterials, runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { SCRIPT_VENDORS } from "../../src/lib/scripts/vendors.js";
import {
  EMAIL_FOUND_READ,
  FLEET_VERDICT_WINDOW_DAYS,
  SEND_CHECK_DOOR,
  VERIFY_BEFORE_WRITE_SENDERS,
  VERIFY_DOOR,
  addVerifyBeforeWrite,
  restateCaseForVerifyBeforeWrite,
  verifyBeforeWriteTactics,
  type SenderCase,
} from "../../src/lib/scripts/verify-before-write.js";

// VERIFY-BEFORE-WRITE-1124: the cold email senders (byte for byte as production stores them, 2026-11-24) look at the
// address before they ask their writer. The two ports' recorded cases are restated and replayed in production's
// container by scripts/prove-verify-before-write.mjs (cases never go to git).
const fixture = (f: string) => readFileSync(join(__dirname, "../fixtures/stored-scripts", f), "utf8");
const STORED: Record<string, string> = {
  "dy_cold_email v14 (= dy_cold_email_site v10)": fixture("email_sent__dy_cold_email.v14.ts.txt"),
  "dy_cold_email_signed_client_person v10 (= signed_sender_client_brand v10)": fixture("email_sent__dy_cold_email_signed_client_person.v10.ts.txt"),
};

type Call = { name: string; args: Record<string, any> };
const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const now = "2026-11-24T10:00:00.000Z";
const ADDRESS = "Pat@Clinic.example";
const unit = (over: Record<string, unknown>) => ({
  verificationId: "v-1",
  email: "pat@clinic.example",
  verdict: "valid",
  decisive: true,
  deliverable: true,
  step: "first",
  verifier: "bounceverify",
  verifiedAt: "2026-11-12T00:00:00.000Z",
  ageDays: 12,
  source: "enrich",
  subject: { subjectService: "lead-service", subjectId: "lead-77", declared: true },
  ...over,
});
const refusal409 = { ok: false, data: { error: "Email not verified", status: 409, code: "email_not_verified", body: { code: "email_not_verified", verdict: "invalid", verifiedAt: "2026-11-20T00:00:00.000Z" } } };

interface World {
  /** What the Provider read answers (default: nothing held). */
  units?: unknown[];
  read?: unknown;
  /** What apollo's verifying door answers. */
  verify?: unknown;
  /** What the send's own check answers. */
  check?: unknown;
  send?: unknown;
  trigger?: Record<string, unknown>;
}

function harness(w: World) {
  const calls: Call[] = [];
  const asks: string[] = [];
  const consumed: unknown[] = [];
  const order: string[] = [];
  const bridge: Bridge = (op, args) => {
    if (op === "get" && args.length > 1) {
      order.push(`read:${String(args[0])}`);
      calls.push({ name: `provider:${String(args[0])}`, args: (args[1] ?? {}) as Record<string, any> });
      return { v: w.read ?? ok({ units: w.units ?? [], nextBefore: null, hasMore: false }) };
    }
    if (op === "vendor") {
      const name = String(args[0]);
      order.push(name);
      const a = (args[1] ?? {}) as Record<string, any>;
      calls.push({ name, args: a });
      if (name === "lead.serve") return { v: ok({ found: true, lead: { leadId: "lead-77", email: ADDRESS, data: { firstName: "Pat", organization: { name: "Clinic" } } } }) };
      if (name === "crm.person.thread") return { v: { ok: false, data: { status: 404, error: "no thread" } } };
      if (name === "brand.profile") return { v: ok({ brand: { name: "Acme" } }) };
      if (name === "brand.extract_fields") return { v: ok({ fields: {} }) };
      if (name === "content.generate") return { v: ok({ id: "g1", subject: "Hello", sequence: [{ step: 1, bodyHtml: "<p>Hi</p>" }] }) };
      if (name === "email.send") return { v: w.send ?? ok({ success: true }) };
      if (name === VERIFY_DOOR && w.verify) return { v: w.verify };
      if (name === SEND_CHECK_DOOR && w.check) return { v: w.check };
      return { stop: `unexpected call ${name}` };
    }
    if (op === "ask") return { v: null };
    if (op === "get") {
      const outcome = String(args[0]);
      asks.push(outcome);
      order.push(`ask:${outcome}`);
      if (outcome === "message_written") return { v: { content: { existing: false, generation: { body: {}, units: {} } }, run: { id: "w1" } } };
      return { v: { content: { answer: { json: { signature: "Anna\nAcme" } } } } };
    }
    if (op === "consume") {
      consumed.push(args);
      return { v: null };
    }
    return { stop: `${String(op)} asked` };
  };
  return { bridge, calls, asks, consumed, order, world: w };
}

const request = (w: World) => ({ now, brandIds: ["brand-1"], campaignId: "c1", offerId: "o1", featureSlug: "sales-cold-email-outreach", ...(w.trigger ? { trigger: w.trigger } : {}) });
async function run(code: string, w: World, tactics: Record<string, unknown> = { verdictMaxAgeDays: 30 }) {
  const h = harness(w);
  const out: any = await runScript(code, { subject: null, brand: "b", day: 0, tactics, request: request(w) }, h.bridge);
  return { ...h, out };
}
const sent = { content: { leadId: "lead-77", emailGenerationId: "g1", sent: true }, subject: { service: "lead-service", id: "lead-77" } };

describe.each(Object.keys(STORED))("%s", (name) => {
  const stored = STORED[name]!;
  const next = addVerifyBeforeWrite(stored);

  it("the edit only adds: every stored line kept, a valid source, the same materials, doors the catalogue allows", async () => {
    const lines = next.split("\n");
    let at = 0;
    for (const l of stored.split("\n")) {
      at = lines.indexOf(l, at);
      expect(at, l).toBeGreaterThanOrEqual(0);
      at++;
    }
    const [after, before] = [await validateSource(next), await validateSource(stored)];
    expect(readMaterials(next)).toEqual(readMaterials(stored));
    expect(after.vendors).toEqual([...before.vendors, VERIFY_DOOR, SEND_CHECK_DOOR]);
    for (const door of [VERIFY_DOOR, SEND_CHECK_DOOR]) expect((SCRIPT_VENDORS as readonly string[]).includes(door)).toBe(true);
    expect(next.indexOf("refusedBeforeWriting(ctx")).toBeLessThan(next.indexOf('ctx.vendor.call("crm.person.thread"'));
    expect(() => addVerifyBeforeWrite(next)).toThrow(/already/);
  });

  it("no tactic stated: the very same calls, asks and result as the stored code (no read, no verification)", async () => {
    for (const w of [{}, { send: { ok: false, data: { error: "x", status: 409, code: "recent_brand_contact" } } }] as World[]) {
      const a = await run(next, w, {});
      const b = await run(stored, w, {});
      expect(a.calls).toEqual(b.calls);
      expect(a.asks).toEqual(b.asks);
      expect(a.out).toEqual(b.out);
      expect(a.consumed).toEqual([]);
      expect(a.calls.some((c) => c.name === EMAIL_FOUND_READ || c.name === VERIFY_DOOR || c.name === SEND_CHECK_DOOR)).toBe(false);
    }
  });

  it("a deliverable verdict in the window: read with the Script's window, consumed on apollo's subject, writer asked, send unchanged", async () => {
    const a = await run(next, { units: [unit({})] });
    const b = await run(stored, {}, {});
    expect(a.out.result).toEqual(sent);
    const read = a.calls.find((c) => c.name === EMAIL_FOUND_READ)!;
    expect(read.args).toEqual({ route: "listEmailFoundUnits", query: { emails: "pat@clinic.example", decisive: "true", since: "2026-10-25T10:00:00.000Z", limit: 1 } });
    expect(a.consumed).toEqual([["email_checked", { service: "lead-service", id: "lead-77" }]]);
    expect(a.calls.filter((c) => c.name !== EMAIL_FOUND_READ)).toEqual(b.calls);
    expect(a.asks).toEqual(b.asks);
    expect(a.order.indexOf("read:email_found")).toBe(a.order.indexOf("lead.serve") + 1);
  });

  it("a held Unit naming no subject: nothing consumed, the run goes on", async () => {
    const a = await run(next, { units: [unit({ subject: null })] });
    expect(a.out.result).toEqual(sent);
    expect(a.consumed).toEqual([]);
  });

  it("an undeliverable verdict in the window: the send's own door refuses, the run ends on its code before any writer", async () => {
    const a = await run(next, { units: [unit({ verdict: "invalid", deliverable: false })], check: refusal409 });
    expect(a.out.result).toEqual({ unmade: "email_not_verified", again: true });
    expect(a.calls.map((c) => c.name)).toEqual(["lead.serve", EMAIL_FOUND_READ, SEND_CHECK_DOOR]);
    expect(a.calls[2]!.args).toEqual({ body: { type: "broadcast", to: ADDRESS } });
    expect(a.asks).toEqual([]);
    expect(a.consumed).toEqual([]);
    // What the stored code answered when its SEND refused that address on the verdict: the very same result.
    const b = await run(stored, { send: refusal409 }, {});
    expect(a.out.result).toEqual(b.out.result);
  });

  it("a person named by an occurrence, refused: unmade with the code, never `again` (as the send's refusal)", async () => {
    const trigger = { leadId: "lead-77", eventId: "ev-1" };
    const a = await run(next, { trigger, units: [unit({ verdict: "risky", deliverable: false })], check: refusal409 });
    const b = await run(stored, { trigger, send: refusal409 }, {});
    expect(a.out.result).toEqual({ unmade: "email_not_verified" });
    expect(a.out.result).toEqual(b.out.result);
  });

  it("a decisive catch_all the send's door passes: the run goes on and writes (who is written to does not change)", async () => {
    const a = await run(next, { units: [unit({ verdict: "catch_all", deliverable: false, step: "second" })], check: ok({ sendable: true, transport: "instantly", to: ADDRESS, verdict: "catch_all", reused: true, verifiedAt: null }) });
    expect(a.out.result).toEqual(sent);
    expect(a.asks).toContain("message_written");
    expect(a.consumed).toEqual([["email_checked", { service: "lead-service", id: "lead-77" }]]);
  });

  it("no decisive verdict in the window: a new one asked on the run with the window, then both branches", async () => {
    const fresh = (verdict: string) => ok({ results: [{ email: "pat@clinic.example", verdict, deliverable: verdict === "valid", verifier: "bounceverify", verificationId: "v-9", verifiedAt: now, reused: false }] });
    const good = await run(next, { verify: fresh("valid") }, { verdictMaxAgeDays: 12 });
    expect(good.out.result).toEqual(sent);
    expect(good.calls.find((c) => c.name === EMAIL_FOUND_READ)!.args.query.since).toBe("2026-11-12T10:00:00.000Z");
    expect(good.calls.find((c) => c.name === VERIFY_DOOR)!.args).toEqual({ body: { emails: ["pat@clinic.example"], maxVerdictAgeDays: 12, source: "sender-before-write" } });
    expect(good.consumed).toEqual([]);
    expect(good.order.indexOf(VERIFY_DOOR)).toBeLessThan(good.order.indexOf("ask:message_written"));

    const bad = await run(next, { verify: fresh("invalid"), check: refusal409 }, { verdictMaxAgeDays: 12 });
    expect(bad.out.result).toEqual({ unmade: "email_not_verified", again: true });
    expect(bad.calls.map((c) => c.name)).toEqual(["lead.serve", EMAIL_FOUND_READ, VERIFY_DOOR, SEND_CHECK_DOOR]);
    expect(bad.asks).toEqual([]);
  });

  it("fails loud: an unreadable Provider, a verification that cannot be had, a check that cannot answer, a bad window", async () => {
    const down = { ok: false, data: { error: "apollo-service answered 502", status: 502, code: null, body: {} } };
    expect((await run(next, { read: down })).out).toMatchObject({ kind: "error", message: expect.stringContaining("email_found (read)") });
    expect((await run(next, { verify: { ok: false, data: { error: "Insufficient credits", status: 402, code: "insufficient_credits", body: {} } } })).out).toMatchObject({ kind: "error", message: expect.stringContaining("apollo.email.verifications: Insufficient credits") });
    expect((await run(next, { units: [unit({ verdict: "invalid", deliverable: false })], check: down })).out).toMatchObject({ kind: "error", message: expect.stringContaining("email.send_check") });
    expect((await run(next, {}, { verdictMaxAgeDays: "30" })).out).toMatchObject({ kind: "error", message: expect.stringContaining("verdictMaxAgeDays") });
    for (const r of [await run(next, { read: down }), await run(next, {}, { verdictMaxAgeDays: -1 })]) expect(r.asks).toEqual([]);
  });

  describe("a recorded case restated", () => {
    const tactics = verifyBeforeWriteTactics({});
    const base = { request: request({}), units: { message_written: { existing: false, generation: { body: {}, units: {} } }, llm_completion: { answer: { json: { signature: "Anna" } } } } };
    const answers = async (w: World) => {
      const h = await run(stored, w, {});
      // content.generate's request holds the writer's run, which a replayed Unit does not carry: recorded without it.
      return h.calls.map((c) => ({ name: c.name, ...(c.name === "content.generate" ? {} : { args: c.args }), answer: JSON.parse(JSON.stringify(replyOf(h, c))) }));
    };
    // The answer each recorded call got, as the harness gave it.
    const replyOf = (h: ReturnType<typeof harness>, c: Call) => {
      const w = h.world;
      if (c.name === "lead.serve") return ok({ found: true, lead: { leadId: "lead-77", email: ADDRESS, data: { firstName: "Pat", organization: { name: "Clinic" } } } });
      if (c.name === "crm.person.thread") return { ok: false, data: { status: 404, error: "no thread" } };
      if (c.name === "brand.profile") return ok({ brand: { name: "Acme" } });
      if (c.name === "brand.extract_fields") return ok({ fields: {} });
      if (c.name === "content.generate") return ok({ id: "g1", subject: "Hello", sequence: [{ step: 1, bodyHtml: "<p>Hi</p>" }] });
      return w.send ?? ok({ success: true });
    };
    const replays = async (c: SenderCase) => replayCase(next, { ...c, tactics: { ...tactics, ...(c.tactics ?? {}) } } as unknown as ReplayCase);

    it("nobody served: the case stands as recorded and replays", async () => {
      const c: SenderCase = { id: "empty", ...base, calls: [{ name: "lead.serve", args: {}, answer: ok({ found: false, reason: "source_stock_empty" }) }], expect: { end: { success: true, stopCampaign: false, noWorkAvailable: true } } };
      const r = await restateCaseForVerifyBeforeWrite(next, c, tactics, runScript as never);
      expect(r).toEqual({ kind: "unchanged", case: c });
      expect(await replays(c)).toMatchObject({ match: true });
    });

    it("its send went out: the read answers the verdict the door accepted, every recorded call kept, and it replays", async () => {
      const c: SenderCase = { id: "sent", ...base, calls: await answers({}), expect: { end: { success: true, stopCampaign: false } } };
      expect(await replays(c)).toMatchObject({ match: false });
      const r = await restateCaseForVerifyBeforeWrite(next, c, tactics, runScript as never);
      if (r.kind !== "sent") throw new Error(JSON.stringify(r));
      expect(r.case.calls.map((x) => x.name)).toEqual(["lead.serve", EMAIL_FOUND_READ, ...c.calls.slice(1).map((x) => x.name)]);
      expect(r.case.calls[1]).toMatchObject({ args: { query: { emails: "pat@clinic.example" } }, answer: { ok: true, data: { units: [{ verdict: "valid", decisive: true, deliverable: true, subject: null }] } } });
      expect(r.case.calls.filter((x) => x.name !== EMAIL_FOUND_READ)).toEqual(c.calls);
      expect(await replays(r.case)).toEqual({ id: "sent", match: true, diffs: [] });
    });

    it("its send was refused on the verdict: the read, the door's own refusal, nothing after, the same end", async () => {
      const c: SenderCase = { id: "refused", ...base, asks: [], calls: await answers({ send: refusal409 }), expect: { end: { success: true, stopCampaign: false } } };
      const r = await restateCaseForVerifyBeforeWrite(next, c, tactics, runScript as never);
      if (r.kind !== "refused") throw new Error(JSON.stringify(r));
      expect(r.case.calls.map((x) => x.name)).toEqual(["lead.serve", EMAIL_FOUND_READ, SEND_CHECK_DOOR]);
      expect(r.case.calls[1]!.answer.data).toMatchObject({ units: [{ verdict: "invalid", deliverable: false, verifiedAt: "2026-11-20T00:00:00.000Z" }] });
      expect(r.case.calls[2]!.answer).toEqual(refusal409);
      expect(r.case.asks).toEqual([]);
      expect(await replays(r.case)).toEqual({ id: "refused", match: true, diffs: [] });
    });

    it("a verdict the record does not hold: excluded with its reason, never invented", async () => {
      const other = { ok: false, data: { error: "x", status: 409, code: "recent_brand_contact" } };
      const refusedElse: SenderCase = { id: "else", ...base, calls: await answers({ send: other }), expect: {} };
      expect(await restateCaseForVerifyBeforeWrite(next, refusedElse, tactics, runScript as never)).toMatchObject({ kind: "excluded", reason: expect.stringContaining("recent_brand_contact") });
      const noSend: SenderCase = { id: "nosend", ...base, calls: (await answers({})).slice(0, 3), expect: {} };
      expect(await restateCaseForVerifyBeforeWrite(next, noSend, tactics, runScript as never)).toMatchObject({ kind: "excluded", reason: expect.stringContaining("holds no send") });
    });
  });
});

it("refuses a code whose anchor moved", () => {
  expect(() => addVerifyBeforeWrite("export default function run() {}")).toThrow(/nowhere/);
});

it("the tactics: the window stated as data, today's fleet rule, a stated one kept", () => {
  expect(FLEET_VERDICT_WINDOW_DAYS).toBe(30);
  expect(verifyBeforeWriteTactics({ asks: ["message_written"] })).toEqual({ asks: ["message_written"], verdictMaxAgeDays: 30 });
  expect(verifyBeforeWriteTactics({ verdictMaxAgeDays: 7 })).toEqual({ verdictMaxAgeDays: 7 });
});

// The ACTIVE stored code of the four senders, fetched read-only into .context/vbw (gitignored; CI holds none).
describe("the anchors on production's active code", () => {
  const dir = join(__dirname, "../../.context/vbw");
  for (const { dynasty } of VERIFY_BEFORE_WRITE_SENDERS) {
    const file = join(dir, `${dynasty}.ts.txt`);
    it.skipIf(!existsSync(file))(`${dynasty} (skipped when .context/vbw holds no fetched code)`, async () => {
      const next = addVerifyBeforeWrite(readFileSync(file, "utf8"));
      await expect(validateSource(next)).resolves.toBeDefined();
    });
  }
});
