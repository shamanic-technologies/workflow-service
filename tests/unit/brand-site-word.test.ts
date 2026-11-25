import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { readMaterials } from "../../src/lib/scripts/sandbox.js";
import { ANSWER_REQUESTED, answerTactics } from "../../src/lib/scripts/answer-lead-split.js";
import { buildCompletionSource } from "../../scripts/engine-ports/llm-completion.js";
import { addSiteToSender, addSiteToWriter, senderTacticsWithSite, SITE_MORE_PAGES } from "../../src/lib/scripts/brand-site-word.js";

// BRAND-SITE-WORD-1125: the lead answerer halves as production stores them (sender v17, writer v6). The sender reads the
// brand's own site (AI index + home page) through the Page read Engine and hands it; the writer reads it as the brand's
// published word beside THE FACTS (the site wins) and may ask for more of its pages once. Nothing readable = byte for byte.
const SENDER0 = readFileSync(join(__dirname, "../fixtures/stored-scripts/message_sent__dy_answer_lead.v17.ts.txt"), "utf8");
const WRITER0 = readFileSync(join(__dirname, "../fixtures/stored-scripts/message_written__dy_answer_lead.v6.ts.txt"), "utf8");
const SENDER1 = addSiteToSender(SENDER0);
const WRITER1 = addSiteToWriter(WRITER0);
const COMPLETION = buildCompletionSource();
const NOW = "2026-11-25T15:00:00.000Z";
const WRITE = { decision: "write", channel: "whatsapp", replyTo: "", to: [] as string[], cc: [] as string[], bcc: [] as string[], message: "Usage based, 0% markup.", subject: "", bookSlot: "", bookedMessage: "", nextFollowUpAt: "2026-11-28T16:00:00Z", nextFollowUpWhy: "next look", question: "", reason: "they asked the price", pages: [] as string[] };
const READ = { ...WRITE, decision: "read", message: "", pages: ["https://acme.test/pricing", "https://evil.test/x", "https://www.acme.test/terms", "https://acme.test/llms.txt", "https://blog.acme.test/a", "https://acme.test/b"] };

type Answer = { ok: boolean; data: Record<string, unknown> };
const PAGES: Record<string, string> = {
  "https://acme.test/llms.txt": "# Acme\n\n> Usage based: each action at the vendor's price, 0% markup, from a $10 prepaid balance.\n\n- [Pricing](https://acme.test/pricing)",
  "https://acme.test/": "# Acme home\n\nRevenue made easy.",
  "https://acme.test/pricing": "# Pricing\n\n$10 prepaid.",
  "https://www.acme.test/terms": "# Terms",
  "https://blog.acme.test/a": "# Blog post",
};

function doors(drafts: Array<Record<string, unknown>>, extra: Record<string, (a: Record<string, unknown>) => Answer> = {}): Record<string, (a: Record<string, unknown>) => Answer> {
  let n = 0;
  return {
    "lead.followup.claim": () => ({ ok: true, data: { found: true, followup: { id: "row-1", email: null, phone: "+15551234567", leadId: "lead-1", dueAt: NOW } } }),
    "lead.followup_date.read": () => ({ ok: true, data: { owed: { kind: "owed", reasons: [] } } }),
    "lead.detail": () => ({ ok: true, data: { leadDetail: { lead: { firstName: "Vadym", leadId: "lead-1", timezone: "Europe/Kyiv" } } } }),
    "crm.person.thread": () => ({ ok: true, data: { items: [{ at: "2026-11-25T14:00:00Z", kind: "message", direction: "inbound", channel: "whatsapp", text: "how much does it cost? monthly fee?" }] } }),
    "instantly.conversation": () => ({ ok: false, data: { status: 404, error: "none" } }),
    "crm.whatsapp.reach": () => ({ ok: true, data: { reachable: true, persona: { name: "Sophie", role: "AI assistant" } } }),
    "brand.profile": () => ({ ok: true, data: { brand: { name: "Acme", url: "https://acme.test", salesRepPhone: "+15550000000" } } }),
    "brand.offer.economics": () => ({ ok: true, data: { name: "Meetings", bookingUrl: "https://book.test/acme" } }),
    "brand.offer.answers": () => ({ ok: true, data: { answers: [] } }),
    "brand.offer.fields": () => ({ ok: true, data: { fields: { riskReversal: { provenance: "confirmed", value: "The platform is free" } } } }),
    "brand.sales_rep": () => ({ ok: false, data: { status: 404, error: "no sales rep" } }),
    "voice.read": () => ({ ok: true, data: { content: "OUR VOICE" } }),
    "booking.slots": () => ({ ok: true, data: { slots: [], timezone: "UTC" } }),
    "llm.complete": () => ({ ok: true, data: { json: drafts[Math.min(n++, drafts.length - 1)] } }),
    "crm.whatsapp.send": () => ({ ok: true, data: { status: "sent" } }),
    "lead.followup_date.set": () => ({ ok: true, data: {} }),
    "lead.followup.record": () => ({ ok: true, data: {} }),
    ...extra,
  };
}

const REQUEST = { now: NOW, brandIds: ["brand-1"], campaignId: "camp-1", offerId: "offer-1", brief: "Answer leads.", goal: null, trigger: { leadId: "lead-1", eventId: "ev-1", person: { phone: "+15551234567" }, item: { kind: "reply" } } };
const spec = (tactics: Record<string, unknown>) => ({ subject: "lead-1", brand: "brand-1", day: 0, tactics, request: REQUEST });
type Call = { script: string; name: string; args: Record<string, unknown> };

/** The pair, the sender asking the Page read Engine and the writer, the writer asking the completion. */
async function runPair(SENDER: string, WRITER: string, drafts: Array<Record<string, unknown>>, pages: Record<string, string> = PAGES, extra = {}) {
  const calls: Call[] = [];
  const reads: string[] = [];
  const handed: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  const answers = doors(drafts, extra);
  const vendor = (script: string) => (name: string, a: Record<string, unknown>): { v: Answer } => {
    calls.push({ script, name, args: a });
    const door = answers[name];
    if (!door) throw new Error(`no door ${name}`);
    return { v: door(a) };
  };
  const completion = async (request: Record<string, unknown>) => {
    requests.push(request);
    return runScript(COMPLETION, { subject: null, brand: "brand-1", day: 0, tactics: { llm: { provider: "zai", model: "glm-flash", name: "GLM Flash" } }, request }, async (op, args) => (op === "vendor" ? vendor("completion")(String(args[0]), args[1] as Record<string, unknown>) : { stop: op }));
  };
  const writer = async (units: Record<string, { content: Record<string, unknown> }>) => {
    handed.push(JSON.parse(JSON.stringify(units[ANSWER_REQUESTED]!.content)));
    let asked: Record<string, unknown> | null = null;
    return runScript(WRITER, { subject: "lead-1", brand: "brand-1", day: 0, tactics: answerTactics({}).writer, request: null }, async (op, args) => {
      if (op === "vendor") return vendor("writer")(String(args[0]), args[1] as Record<string, unknown>);
      if (op === "ask") {
        asked = args[0] as Record<string, unknown>;
        return { v: null };
      }
      if (op === "get" && args[0] === ANSWER_REQUESTED) return { v: { id: "u", outcome: ANSWER_REQUESTED, subject: "", ageDays: 0, content: units[ANSWER_REQUESTED]!.content } };
      if (op === "get" && args[0] === "llm_completion") {
        const done = await completion((asked!.request ?? {}) as Record<string, unknown>);
        if (done.kind !== "done") return { stop: JSON.stringify(done) };
        return { v: { id: "c", outcome: "llm_completion", subject: "lead-1", ageDays: 0, content: done.result!.content } };
      }
      return { stop: `unexpected ${op}` };
    });
  };
  let askedSender: Record<string, unknown> | null = null;
  const tactics = senderTacticsWithSite(answerTactics({ asks: ["booking_call"], relationships: "pure_prospect", recorded_by: "sender" }).sender);
  const out = await runScript(SENDER, spec(tactics), async (op, args) => {
    if (op === "storage.claim" || op === "storage.set") return { v: null };
    if (op === "vendor") return vendor("sender")(String(args[0]), args[1] as Record<string, unknown>);
    if (op === "ask") {
      askedSender = args[0] as Record<string, unknown>;
      return { v: null };
    }
    if (op === "get" && args[0] === "page_read") {
      const url = String((askedSender!.request as Record<string, unknown>).url);
      expect((askedSender!.request as Record<string, unknown>).maxAgeDays).toBe(1);
      reads.push(url);
      const text = pages[url];
      if (text === undefined) return { v: { id: "p", outcome: "page_read", subject: "", ageDays: 0, content: null, unmade: "page_not_read: 404" } };
      // One page fresh (a Unit), the others a read already held (an answer).
      const page = { cached: url.endsWith("/"), requestId: "r", result: { url, rawMarkdown: text } };
      return { v: url.endsWith("/") ? { id: "p", outcome: "page_read", subject: "", ageDays: 0, content: null, unmade: "stored_read: held", decided: "done", answer: page } : { id: "p", outcome: "page_read", subject: "r", ageDays: 0, content: page } };
    }
    if (op === "get" && args[0] === "message_written") {
      const w = await writer(askedSender!.units as Record<string, { content: Record<string, unknown> }>);
      if (w.kind !== "done") return { stop: JSON.stringify(w) };
      const r = w.result!;
      return { v: r.content ? { id: "w", outcome: "message_written", subject: "lead-1", ageDays: 0, content: r.content } : { id: "w", outcome: "message_written", subject: "", ageDays: 0, content: null, unmade: r.unmade, decided: r.decided, answer: r.answer } };
    }
    return { stop: `unexpected ${op} ${String(args[0])}` };
  });
  return { out, calls, reads, handed, requests };
}

const sent = (calls: Call[]) => calls.filter((c) => c.name === "crm.whatsapp.send");

describe("BRAND-SITE-WORD-1125", () => {
  it("both edited halves are valid scripts; the sender asks the Page read Engine; edits apply once", async () => {
    await validateSource(SENDER1);
    expect((await validateSource(WRITER1)).vendors).toEqual((await validateSource(WRITER0)).vendors);
    expect(readMaterials(SENDER1)).toContain("page_read");
    expect(senderTacticsWithSite({ asks: ["booking_call", "message_written"] }).asks).toEqual(["booking_call", "message_written", "page_read"]);
    expect(() => addSiteToSender(SENDER1)).toThrow(/already/);
    expect(() => addSiteToWriter(WRITER1)).toThrow(/already/);
    expect(WRITER1).not.toMatch(/0% markup|prepaid|\$10/);
  });

  it("nothing readable on the site: the writer gets the very same prompt and schema, the same doors as stored", async () => {
    const before = await runPair(SENDER0, WRITER0, [WRITE], {});
    const after = await runPair(SENDER1, WRITER1, [WRITE], {});
    expect(after.out.kind).toBe("done");
    expect(after.reads).toEqual(["https://acme.test/llms.txt", "https://acme.test/"]);
    expect(after.handed[0]!.site).toBeUndefined();
    expect(after.requests).toEqual(before.requests);
    const strip = (c: Call[]) => c.map((x) => ({ name: x.name, args: x.args }));
    expect(strip(after.calls)).toEqual(strip(before.calls));
  });

  it("a writer handed no site (an older sender, a recorded case) asks byte for byte what the stored writer asks", async () => {
    const before = await runPair(SENDER0, WRITER0, [WRITE]);
    const after = await runPair(SENDER0, WRITER1, [WRITE]);
    expect(after.requests).toEqual(before.requests);
  });

  it("the site read: the writer reads it as the brand's word beside THE FACTS, the site winning, and may read more", async () => {
    const r = await runPair(SENDER1, WRITER1, [WRITE]);
    expect(r.out.kind).toBe("done");
    const site = r.handed[0]!.site as { origin: string; pages: Array<{ url: string; text?: string }>; readMore: boolean };
    expect(site.origin).toBe("https://acme.test");
    expect(site.readMore).toBe(true);
    const req = r.requests[0]!;
    expect(String(req.message)).toContain("THE BRAND'S OWN WEBSITE (https://acme.test, each page as it reads today: the brand's current public word):\nPAGE https://acme.test/llms.txt:\n# Acme");
    expect(String(req.message)).toContain("0% markup, from a $10 prepaid balance");
    expect(String(req.message)).toContain("THE FACTS (stated to us earlier; where the website above speaks of the same thing, its words replace these):\n- riskReversal: The platform is free");
    expect(String(req.message).indexOf("THE BRAND'S OWN WEBSITE")).toBeLessThan(String(req.message).indexOf("THE FACTS"));
    expect(String(req.systemPrompt)).toContain("say it the way the website says it");
    expect(String(req.systemPrompt)).toContain("set decision to read");
    expect(String(req.systemPrompt)).not.toContain("THE FACTS are what the brand stated. Never invent");
    const schema = req.responseSchema as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(schema.properties.decision!.enum).toContain("read");
    expect(schema.required).toContain("pages");
    expect(sent(r.calls)).toHaveLength(1);
  });

  it("the writer asks for pages: the sender reads only the brand's own (at most 3, none twice) and asks it once more, without read", async () => {
    const r = await runPair(SENDER1, WRITER1, [READ, WRITE]);
    expect(r.out.kind).toBe("done");
    expect(r.reads).toEqual(["https://acme.test/llms.txt", "https://acme.test/", "https://acme.test/pricing", "https://www.acme.test/terms", "https://blog.acme.test/a"]);
    expect(SITE_MORE_PAGES).toBe(3);
    expect(r.handed).toHaveLength(2);
    const second = r.requests[1]!;
    expect(String(second.message)).toContain("PAGE https://acme.test/pricing:\n# Pricing\n\n$10 prepaid.");
    expect(String(second.systemPrompt)).not.toContain("set decision to read");
    const schema = second.responseSchema as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(schema.properties.decision!.enum).not.toContain("read");
    expect(schema.required).not.toContain("pages");
    expect(sent(r.calls)).toHaveLength(1);
  });

  it("a writer that asks to read again after its pages were read fails loud, nothing sent", async () => {
    const r = await runPair(SENDER1, WRITER1, [READ, READ]);
    expect(r.out.kind).not.toBe("done");
    expect(sent(r.calls)).toHaveLength(0);
  });
});
