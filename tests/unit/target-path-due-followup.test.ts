import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScript, type Bridge } from "../../src/lib/scripts/sandbox.js";

// PLAN-RECURSIVE-PER-ENGINE-1124-WF3 piece A: a campaign run as ONE unit on its Target reaches a cold email sender
// through « Cold email to a new lead » (dy_first_email_path -> email_sent). lead-service serves the brand's people
// due a follow-up FIRST on both paths (its pullNext `source=followup-due`, then fresh people), and the person reaches
// the SAME sender script the funnel's per-pipe cold email unit runs. This pins, on the four live senders byte for byte
// as production stores them, that from the serve on the Target path hands the writer exactly what the per-pipe path
// hands it: the person's whole thread with our earlier emails (a person due a follow-up), or none (a new person). The
// writer decides from that thread (trusted, never a rule here): the per-pipe writer answered 1,922 due people in the 7
// days to 2026-11-25, 1,055 of them under a « Re: <our earlier subject> » subject.
const DIR = join(__dirname, "../fixtures/stored-scripts");
const TACTICS = JSON.parse(readFileSync(join(DIR, "email_sent__cold_senders.tactics.json"), "utf8")) as Record<string, Record<string, unknown>>;
const SENDERS: Record<string, string> = {
  dy_cold_email: "email_sent__dy_cold_email.v15.ts.txt",
  dy_cold_email_site: "email_sent__dy_cold_email_site.v11.ts.txt",
  dy_cold_email_signed_client_person: "email_sent__dy_cold_email_signed_client_person.v11.ts.txt",
  dy_cold_email_signed_sender_client_brand: "email_sent__dy_cold_email_signed_sender_client_brand.v11.ts.txt",
};

const now = "2026-11-25T11:02:29.000Z";
const LEAD_ID = "1e14a26c-1f17-49ee-8283-5dda258e012e";
const EMAIL = "drmolina@dentalarts.net";
const servedLead = {
  leadId: LEAD_ID,
  email: EMAIL,
  data: { firstName: "Ana", lastName: "Molina", currentTitle: "Owner", organization: { name: "Dental Arts of Hackensack" } },
  brandIds: ["brand-1"],
  buyingSignal: null,
  qualification: { domain: "dentalarts.net", checks: [] },
};
// Our two earlier cold emails, as crm-service's Unibox thread serves them (no answer from them).
const DUE_THREAD = {
  items: [
    { kind: "message", source: "instantly", channel: "email", direction: "outbound", at: "2026-09-28T19:05:00.000Z", subject: "Dental Arts of Hackensack calls", text: "Hi Ana, how many calls from new patients go unanswered at the front desk?" },
    { kind: "message", source: "instantly", channel: "email", direction: "outbound", at: "2026-10-05T19:05:00.000Z", subject: "Re: Dental Arts of Hackensack calls", text: "Ana, a quick follow-up on missed calls." },
  ],
  sources: [{ source: "instantly", status: "ok" }],
  factFeed: { settled: true },
};

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
      if (name === "brand.profile") return ok({ brand: { name: "Doc Dinners", clickDestinationUrl: "https://docdinners.com" } });
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

const base = { now, brief: "Send cold emails to dental practice owners.", brandIds: ["brand-1"], campaignId: "a41a17f8-af0f-498f-8cd4-8e3b6abb1a21", offerId: "o1" };
const PER_PIPE = { ...base, featureSlug: "sales-cold-email-outreach" };
const TARGET = { ...base, featureSlug: null };

async function run(dynasty: string, request: Record<string, unknown>, thread: unknown) {
  const h = harness(thread);
  const out = await runScript(readFileSync(join(DIR, SENDERS[dynasty]), "utf8"), { subject: null, brand: "brand-1", day: 0, tactics: TACTICS[dynasty], request }, h.bridge);
  expect(out.kind).toBe("done");
  const fromServe = h.calls.slice(h.calls.findIndex((c) => c.name === "lead.serve") + 1);
  const writerAsk = h.asks.find((a) => a.outcome === "message_written")!.request as any;
  return { h, fromServe, writerAsk, out };
}

for (const dynasty of Object.keys(SENDERS)) {
  describe(`${dynasty} (live): the Target path gives a served person what the per-pipe path gives`, () => {
    for (const [who, thread] of [["a person due a follow-up", DUE_THREAD], ["a new person", null]] as const) {
      it(`${who}: every call from the serve on and the writer's request are the same on both paths`, async () => {
        const pipe = await run(dynasty, PER_PIPE, thread);
        const target = await run(dynasty, TARGET, thread);
        // Only the serve differs: the Target path names the person its Lead found Engine served.
        expect(target.h.calls.find((c) => c.name === "lead.serve")!.args).toEqual({ namedLead: { leadId: LEAD_ID, triggerEventId: "lead_found:04480f20-df47-46f1-8576-eb2c9bd1530c" } });
        expect(target.fromServe).toEqual(pipe.fromServe);
        expect(target.writerAsk).toEqual(pipe.writerAsk);
        expect(target.out).toEqual(pipe.out);
      });
    }

    it("the writer reads our earlier emails for a person due a follow-up, and no thread for a new person", async () => {
      const due = (await run(dynasty, TARGET, DUE_THREAD)).writerAsk.units.generation_request.content.body.variables.leadRelationship;
      expect(due.hasThread).toBe(true);
      expect(due.threadLines.join("\n")).toContain("US [automated cold email]: [Dental Arts of Hackensack calls]");
      expect(due.strategy).toContain("Never a cold introduction");
      const fresh = (await run(dynasty, TARGET, null)).writerAsk.units.generation_request.content.body.variables.leadRelationship;
      expect(fresh.hasThread).toBe(false);
      expect(fresh.threadLines).toEqual([]);
    });
  });
}
