import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { addColdSenderThread, addColdSenderEnvelope, ENVELOPE_LINE, restateCaseForColdSenderThread } from "../../src/lib/scripts/cold-sender-thread.js";

// PERSON-ALREADY-EMAILED-1125: the four live cold email senders, byte for byte as production stores them, send a
// person the brand already emailed as a follow-up in their thread (`followUp: true`), and a new person as before.
const DIR = join(__dirname, "../fixtures/stored-scripts/cold-sender-thread");
const TACTICS = JSON.parse(readFileSync(join(DIR, "tactics.json"), "utf8")) as Record<string, Record<string, unknown>>;
const SENDERS: Record<string, string> = {
  dy_cold_email: "email_sent__dy_cold_email.v15.ts.txt",
  dy_cold_email_site: "email_sent__dy_cold_email_site.v11.ts.txt",
  dy_cold_email_signed_client_person: "email_sent__dy_cold_email_signed_client_person.v12.ts.txt",
  dy_cold_email_signed_sender_client_brand: "email_sent__dy_cold_email_signed_sender_client_brand.v12.ts.txt",
};

const now = "2026-11-25T16:56:00.000Z";
const LEAD_ID = "41cc56f6-d1c3-4643-9e87-d5805ad85698";
const EMAIL = "christine.mcginn@alphaocg.com";
const servedLead = {
  leadId: LEAD_ID,
  email: EMAIL,
  data: { firstName: "Christine", lastName: "McGinn", currentTitle: "Owner", organization: { name: "Alpha Omega" } },
  brandIds: ["brand-1"],
  buyingSignal: null,
  qualification: { domain: "alphaocg.com", checks: [] },
};
// Christine's thread as instantly-service recorded it (three cold emails, kevin@maildistribute.com, no answer).
const DUE_THREAD = {
  items: [
    { kind: "message", source: "instantly", channel: "email", direction: "outbound", at: "2026-07-29T13:04:56.000Z", subject: "Alpha Omega client acquisition bottlenecks", text: "Christine, how does Alpha Omega find new clients today?" },
    { kind: "message", source: "instantly", channel: "email", direction: "outbound", at: "2026-08-04T13:02:58.000Z", subject: "Re: Alpha Omega client acquisition bottlenecks", text: "Christine, a quick follow-up." },
    { kind: "message", source: "instantly", channel: "email", direction: "outbound", at: "2026-08-11T13:10:25.000Z", subject: "Re: Alpha Omega client acquisition bottlenecks", text: "Last note from me." },
  ],
  sources: [{ source: "instantly", status: "ok" }],
  factFeed: { settled: true },
};
// A thread holding only their own message (they wrote to us, we never emailed): not a follow-up of ours.
const INBOUND_ONLY = { ...DUE_THREAD, items: [{ kind: "message", source: "gmail", channel: "email", direction: "inbound", at: "2026-11-01T10:00:00.000Z", subject: "Question", text: "Hi, how much is it?" }] };

type Call = { name: string; args: unknown };
function harness(thread: unknown) {
  const calls: Call[] = [];
  const asks: Array<{ outcome: string; request: unknown }> = [];
  const storage = new Map<string, unknown>();
  let pending: unknown = null;
  const ok = (data: unknown) => ({ v: { ok: true, data } });
  const bridge: Bridge = (op, args) => {
    if (op === "vendor") {
      const name = String(args[0]);
      const a = (args[1] ?? {}) as Record<string, any>;
      calls.push({ name, args: a });
      if (name === "lead.serve") return ok({ found: true, lead: servedLead });
      if (name === "crm.person.thread") return thread ? ok(thread) : { v: { ok: false, data: { status: 404, error: "no thread" } } };
      if (name === "apollo.email.verifications") return ok({ results: [{ email: EMAIL, verdict: "valid", deliverable: true }] });
      if (name === "brand.profile") return ok({ brand: { name: "Distribute", clickDestinationUrl: "https://docdinners.com" } });
      if (name === "brand.extract_fields") return ok({ fields: { valueProposition: { value: "Patient dinners" } } });
      if (name === "jev.noul") return ok({ probabilities: { asks: 0.1 } });
      if (name === "content.generate") return ok({ id: "gen-1", subject: "s", sequence: [{ step: 1, bodyHtml: "<p>b</p>" }] });
      if (name === "email.send") return ok({ success: true });
      return { stop: `unexpected call ${name}` };
    }
    if (op === "ask") {
      pending = args[0];
      return { v: null };
    }
    if (op === "get" && args.length > 1) {
      calls.push({ name: `provider:${String(args[0])}`, args: args[1] });
      return ok({ units: [] });
    }
    if (op === "get") {
      const outcome = String(args[0]);
      asks.push({ outcome, request: pending });
      pending = null;
      if (outcome === "lead_found") return { v: { id: "u1", outcome, subject: LEAD_ID, ageDays: 0, content: { leadId: LEAD_ID, email: EMAIL }, run: { runId: "04480f20-df47-46f1-8576-eb2c9bd1530c" } } };
      if (outcome === "message_written") return { v: { content: { existing: false, generation: { body: {}, units: {} } }, run: { id: "w1" } } };
      if (outcome === "judgment_made") return { v: { content: { answers: { asks: { noul: 0.1 } } } } };
      if (outcome === "llm_completion") return { v: { content: { answer: { json: { signature: "Ana\nDoc Dinners" } } } } };
      return { stop: `unexpected get ${outcome}` };
    }
    if (op === "consume") return { v: null };
    if (op === "storage.get") return { v: storage.get(`${args[0]}:${args[1]}`) ?? null };
    if (op === "storage.set") {
      storage.set(`${args[0]}:${args[1]}`, args[2]);
      return { v: null };
    }
    return { stop: `${String(op)} asked` };
  };
  return { bridge, calls, asks };
}

const request = { now, brief: "Send cold emails to agency owners.", brandIds: ["brand-1"], campaignId: "a41a17f8-af0f-498f-8cd4-8e3b6abb1a21", offerId: "o1", featureSlug: "sales-cold-email-outreach" };

async function run(code: string, dynasty: string, thread: unknown) {
  const h = harness(thread);
  const out = await runScript(code, { subject: null, brand: "brand-1", day: 0, tactics: TACTICS[dynasty], request }, h.bridge);
  expect(out.kind).toBe("done");
  return { h, out, send: h.calls.find((c) => c.name === "email.send")!.args as any };
}

for (const [dynasty, file] of Object.entries(SENDERS)) {
  const STORED = readFileSync(join(DIR, file), "utf8");
  const NEXT = addColdSenderThread(STORED);
  describe(`${dynasty} (live): a person the brand already emailed gets the email in their thread`, () => {
    it("changes only the send body, reads nothing new, and refuses a second edit", async () => {
      const [b, a] = [await validateSource(STORED), await validateSource(NEXT)];
      expect(a.materials).toEqual(b.materials);
      expect(a.vendors).toEqual(b.vendors);
      expect(() => addColdSenderThread(NEXT)).toThrow(/already/);
    }, 30_000);

    it("Christine (three cold emails from us, no answer): the send continues her thread", async () => {
      const before = await run(STORED, dynasty, DUE_THREAD);
      const after = await run(NEXT, dynasty, DUE_THREAD);
      expect(before.send.body.followUp).toBeUndefined();
      expect(after.send.body).toEqual({ ...before.send.body, followUp: true });
      // Every other call, and the writer's request, are unchanged.
      expect(after.h.calls.filter((c) => c.name !== "email.send")).toEqual(before.h.calls.filter((c) => c.name !== "email.send"));
      expect(after.h.asks).toEqual(before.h.asks);
    });

    for (const [who, thread] of [["a new person (no thread)", null], ["a person who only wrote to us", INBOUND_ONLY]] as const) {
      it(`${who}: byte for byte as before`, async () => {
        const [before, after] = [await run(STORED, dynasty, thread), await run(NEXT, dynasty, thread)];
        expect(after.h.calls).toEqual(before.h.calls);
        expect(after.out).toEqual(before.out);
      });
    }

    it("a follow-up refused because their sequence is still queued ends as a normal run, nothing sent", async () => {
      const h = harness(DUE_THREAD);
      const inner = h.bridge;
      const bridge: Bridge = (op, args) => (op === "vendor" && args[0] === "email.send" ? { v: { ok: false, data: { status: 409, code: "brand_sequence_queued", error: "queued" } } } : inner(op, args));
      const out = await runScript(NEXT, { subject: null, brand: "brand-1", day: 0, tactics: TACTICS[dynasty], request }, bridge);
      expect(out).toEqual({ kind: "done", result: { unmade: "brand_sequence_queued", again: true } });
    });
  });
}

describe("restateCaseForColdSenderThread", () => {
  const send = { name: "email.send", args: { body: { to: EMAIL, subject: "s" } }, answer: { ok: true, data: { success: true } } };
  const read = (thread: unknown) => ({ name: "crm.person.thread", args: {}, answer: thread ? { ok: true, data: thread as Record<string, unknown> } : { ok: false, data: { status: 404 } } });
  it("a recorded thread holding our email: the recorded send continues it, nothing else moves", () => {
    const c = { id: "c1", calls: [read(DUE_THREAD), send] };
    const r = restateCaseForColdSenderThread(c);
    expect(r.changed).toBe(true);
    expect(r.case.calls[1].args).toEqual({ body: { to: EMAIL, subject: "s", followUp: true } });
    expect(r.case.calls[0]).toEqual(c.calls[0]);
    expect(c.calls[1].args).toEqual({ body: { to: EMAIL, subject: "s" } });
  });
  it("no thread, or only their own message: as recorded", () => {
    for (const t of [null, INBOUND_ONLY]) {
      const c = { id: "c2", calls: [read(t), send] };
      expect(restateCaseForColdSenderThread(c)).toEqual({ case: c, changed: false });
    }
  });
});

for (const [dynasty, file] of Object.entries(SENDERS)) {
  const THREADED = addColdSenderThread(readFileSync(join(DIR, file), "utf8"));
  const NEXT = addColdSenderEnvelope(THREADED);
  describe(`${dynasty}: the writer is told the envelope it writes in`, () => {
    it("Christine (our emails in her thread): her relationship lines end on the envelope line, nothing else moves", async () => {
      const [before, after] = [await run(THREADED, dynasty, DUE_THREAD), await run(NEXT, dynasty, DUE_THREAD)];
      const rel = (h: any) => h.asks.find((a: any) => a.outcome === "message_written").request.units.generation_request.content.body.variables.leadRelationship;
      expect(rel(after.h).lines).toEqual([...rel(before.h).lines, ENVELOPE_LINE]);
      expect(after.h.calls).toEqual(before.h.calls);
      expect(() => addColdSenderEnvelope(NEXT)).toThrow(/already/);
    });
    for (const [who, thread] of [["a new person", null], ["a person who only wrote to us", INBOUND_ONLY]] as const) {
      it(`${who}: byte for byte`, async () => {
        const [before, after] = [await run(THREADED, dynasty, thread), await run(NEXT, dynasty, thread)];
        expect(after.h.asks).toEqual(before.h.asks);
        expect(after.h.calls).toEqual(before.h.calls);
      });
    }
  });
}
