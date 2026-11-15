import { describe, it, expect } from "vitest";
import { runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { readersOfHanded } from "../../src/lib/scripts/engine.js";
import {
  buildIntroAnswerSource,
  buildIntroFirstEmailSource,
  buildIntroPathSource,
  INTRO_ANSWER,
  INTRO_CLIENT_TO_LEAD,
  INTRO_FIRST_EMAILS,
  INTRO_LEAD_TO_LEAD,
  INTRO_MATERIAL,
  INTRO_OPEN,
  INTRO_PATH,
} from "../../scripts/engine-ports/intro.js";

// INTRO-BOARDY-1114: the intro path, the three first emails and the intro conversation, run in the real sandbox.
const now = "2026-11-14T10:00:00.000Z";
const brief = "Build TRUST by offering intros. We stand on both sides.";
const baseRequest = { now, brief, brandIds: ["brand-1"], campaignId: "camp-intro", offerId: "offer-1" };

type Call = { name: string; args: Record<string, unknown> };
type Handler = (name: string, args: Record<string, any>) => { ok: boolean; data: Record<string, unknown> } | undefined;

/** A sandbox bridge: doors answered by `handler`, storage in memory (pre-loadable), asks answered by `asked`. */
function harness(handler: Handler, opts: { storage?: Record<string, unknown>; asked?: (outcome: string, request: any) => unknown; units?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const asks: Array<{ outcome: string; request: any }> = [];
  const store = new Map<string, unknown>(Object.entries(opts.storage ?? {}));
  let pending: any = null;
  const bridge: Bridge = (op, args) => {
    if (op === "vendor") {
      const name = String(args[0]);
      const a = (args[1] ?? {}) as Record<string, any>;
      calls.push({ name, args: a });
      const answer = handler(name, a);
      if (!answer) return { stop: `unexpected call ${name} ${JSON.stringify(a).slice(0, 200)}` };
      return { v: answer };
    }
    if (op === "ask") {
      pending = args[0];
      return { v: null };
    }
    if (op === "get") {
      const outcome = String(args[0]);
      if (opts.units && outcome in opts.units) return { v: { id: "u", outcome, subject: "", ageDays: 0, content: opts.units[outcome] } };
      if (!pending) return { stop: `get ${outcome} with nothing asked` };
      asks.push({ outcome, request: pending });
      const r = pending;
      pending = null;
      return { v: opts.asked ? opts.asked(outcome, r) : { content: { ok: true } } };
    }
    const key = `${String(args[0])}\u0000${String(args[1])}`;
    if (op === "storage.get") return { v: store.get(key) ?? null };
    if (op === "storage.set") {
      store.set(key, args[2]);
      return { v: null };
    }
    if (op === "storage.claim") {
      if (!store.has(key)) store.set(key, args[2] ?? null);
      return { v: store.get(key) ?? null };
    }
    return { stop: `${String(op)} asked` };
  };
  return { bridge, calls, asks, store };
}

const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const llmPick = (args: Record<string, any>) => ok(args.place === "research" ? { provider: "anthropic", model: "sonnet" } : { provider: "anthropic", model: "opus" });

function lead(id: string, first: string, company: string, domain: string) {
  return { leadId: id, email: `${first.toLowerCase()}@${domain}`, data: { firstName: first, lastName: "Doe", currentTitle: "Founder", organization: { name: company, websiteUrl: `https://${domain}`, estimatedNumEmployees: 40, industry: "Logistics" } } };
}

const research = (who: string) =>
  ok({ json: { sells: `${who} software`, sellsTo: "40-person companies", facts: [{ fact: `${who} doubled clients this year`, url: `https://${who}.com/news` }], looksFor: ["faster onboarding"], canBring: ["onboarding expertise"] } });

describe("the intro scripts", () => {
  it("read the material only the path hands, so no other campaign's run ever holds them as candidates", async () => {
    for (const src of [buildIntroFirstEmailSource(), buildIntroAnswerSource()]) {
      expect((await validateSource(src)).materials).toEqual([INTRO_MATERIAL]);
    }
    // The path reads only what it asks for (its tactic `asks`), never a material a run must hold.
    expect((await validateSource(buildIntroPathSource())).materials.sort()).toEqual([...INTRO_PATH.tactics.asks].sort());
    expect(INTRO_PATH.tactics.asks).toEqual(["email_sent", "message_sent"]);
    // The path hands intro_requested: of the email writers, only the intro ones read it.
    const writers = [
      { dynasty: "dy_cold_email", materials: ["message_written"] },
      { dynasty: "dy_intro_open", materials: [INTRO_MATERIAL] },
      { dynasty: "dy_intro_lead_to_lead", materials: [INTRO_MATERIAL] },
    ];
    expect(readersOfHanded(writers, [INTRO_MATERIAL]).map((w) => w.dynasty)).toEqual(["dy_intro_open", "dy_intro_lead_to_lead"]);
    expect(INTRO_FIRST_EMAILS.map((d) => d.tactics.intro)).toEqual(["lead_to_lead", "open", "client_to_lead"]);
    for (const d of [...INTRO_FIRST_EMAILS, INTRO_ANSWER, INTRO_PATH]) expect(d.description).not.toMatch(/[–—]/);
  });

  describe("the path", () => {
    const path = buildIntroPathSource();

    it("on a campaign whose brief asks for no intros: a tick does nothing, a Lead event gets the usual answer", async () => {
      const h = harness((name) => (name === "jev.noul" ? ok({ probabilities: { asks: 0.04 } }) : undefined), { asked: () => ({ content: { decision: "write" } }) });
      const tick = await runScript(path, { subject: null, brand: "b", day: 0, tactics: INTRO_PATH.tactics, request: { ...baseRequest, brief: "Cold email pitching the offer only." } }, h.bridge);
      expect(tick).toEqual({ kind: "done", result: null });
      const evt = await runScript(path, { subject: null, brand: "b", day: 0, tactics: INTRO_PATH.tactics, request: { ...baseRequest, brief: "Cold email pitching the offer only.", trigger: { leadId: "l1", person: { email: "a@b.com" } } } }, h.bridge);
      expect(evt).toEqual({ kind: "done", result: { content: { answered: { decision: "write" } } } });
      expect(h.asks).toEqual([{ outcome: "message_sent", request: { units: {}, request: expect.objectContaining({ trigger: expect.anything() }), recordedBy: "sender" } }]);
      // Judged once per brief: the second run read the kept verdict.
      expect(h.calls.filter((c) => c.name === "jev.noul")).toHaveLength(1);
    });

    it("on an intro campaign: a tick asks for the first email, then records it for the conversation", async () => {
      const h = harness((name) => (name === "jev.noul" ? ok({ probabilities: { asks: 0.96 } }) : undefined), {
        asked: (outcome) => (outcome === "email_sent" ? { content: { kind: "open", reader: { email: "r@x.com" } } } : { unmade: "recorded: ok", decided: "done" }),
      });
      const out = await runScript(path, { subject: null, brand: "b", day: 0, tactics: INTRO_PATH.tactics, request: baseRequest }, h.bridge);
      expect(out).toEqual({ kind: "done", result: { content: { intro: { kind: "open", reader: { email: "r@x.com" } }, recorded: "recorded: ok" } } });
      expect(h.asks.map((a) => [a.outcome, a.request.units])).toEqual([
        ["email_sent", { [INTRO_MATERIAL]: { content: { step: "first_email" } } }],
        ["message_sent", { [INTRO_MATERIAL]: { content: { step: "record", sent: { kind: "open", reader: { email: "r@x.com" } } } } }],
      ]);
    });

    it("forwards a first email that made nothing (no fit yet = ask again soon)", async () => {
      const h = harness((name) => (name === "jev.noul" ? ok({ probabilities: { asks: 0.96 } }) : undefined), { asked: () => ({ unmade: "no_fit: none", run: { again: true } }) });
      const out = await runScript(path, { subject: null, brand: "b", day: 0, tactics: INTRO_PATH.tactics, request: baseRequest }, h.bridge);
      expect(out).toEqual({ kind: "done", result: { unmade: "no_fit: none", again: true } });
    });
  });

  describe("the first email", () => {
    const first = buildIntroFirstEmailSource();
    const units = { [INTRO_MATERIAL]: { step: "first_email" } };

    function doors(over: Partial<Record<string, (a: any) => any>> = {}) {
      let served = 0;
      const people = [lead("l-sarah", "Sarah", "Corvia", "corvia.com"), lead("l-tom", "Tom", "Lonestar Freight", "lonestarfreight.com"), lead("l-ann", "Ann", "Acme", "acme.com")];
      let llm = 0;
      const handler: Handler = (name, a) => {
        if (over[name]) return over[name]!(a);
        if (name === "brand.profile") return ok({ brand: { name: "Distribute.you", url: "https://distribute.you" } });
        if (name === "lead.serve") return served < people.length ? ok({ found: true, lead: people[served++] }) : ok({ found: false, reason: "audience_exhausted" });
        if (name === "crm.person.thread") return { ok: false, data: { status: 404, error: "no thread" } };
        if (name === "scraping.page") return ok({ result: { rawMarkdown: "We cut Corvia's onboarding from four weeks to six days." } });
        if (name === "llm.pick") return llmPick(a);
        if (name === "voice.read") return ok({ content: "Short plain words." });
        if (name === "llm.complete") {
          llm++;
          if (a.webSearch) return research(String(a.message).includes("Sarah") ? "corvia" : "lonestar");
          if (String(a.systemPrompt).startsWith("You are an AI superconnector")) return ok({ json: { pick: 0, forReader: "Tom has the onboarding problem Sarah solves", forThem: "Sarah cut onboarding to six days" } });
          return ok({ json: { subject: "Tom Doe, Lonestar Freight", body: "Hi Sarah,\n\nTom runs operations at Lonestar Freight — 40 people.\n\nWant the intro?\n\nCheers," } });
        }
        if (name === "email.send") return ok({ success: true, messageId: "m1" });
        return undefined;
      };
      return { handler, llmCount: () => llm };
    }

    it("lead to lead: serves the reader, researches both, picks the one good for both, writes with no money and sends", async () => {
      const d = doors();
      const h = harness(d.handler, { units });
      const out = await runScript(first, { subject: null, brand: "b", day: 0, tactics: INTRO_LEAD_TO_LEAD.tactics, request: baseRequest }, h.bridge);
      expect(out.kind).toBe("done");
      const result = (out as any).result;
      expect(result.subject).toEqual({ service: "lead-service", id: "l-sarah" });
      expect(result.content.counterpart).toMatchObject({ email: "tom@lonestarfreight.com", name: "Tom Doe", company: "Lonestar Freight" });
      const send = h.calls.find((c) => c.name === "email.send")!.args.body as any;
      expect(send).toMatchObject({ to: "sarah@corvia.com", leadId: "l-sarah", campaignId: "camp-intro", subject: "Tom Doe, Lonestar Freight", signature: { text: "Sophie" }, idempotencyKey: "intro:lead_to_lead:l-sarah" });
      // No dash reaches the reader.
      expect(send.sequence[0].bodyText).not.toMatch(/[–—]/);
      // Every research call grounds on the web; the writer reads facts on both people, the brief and our voice.
      const writer = h.calls.filter((c) => c.name === "llm.complete").pop()!.args as any;
      expect(writer.systemPrompt).toContain("NO MONEY, NO PITCH");
      expect(writer.systemPrompt).toContain(brief);
      expect(writer.message).toContain("THE OTHER PERSON");
      expect(writer.message).toContain("https://lonestar.com/news");
      // The proposed person leaves the candidates; the unpicked one is kept.
      const pool = h.store.get("intro_pool\u0000people") as any[];
      expect(pool.map((p) => p.email)).toEqual(["ann@acme.com"]);
    });

    it("lead to lead: no candidate good for both = nobody hears a name, the reader is kept, the next reader soon", async () => {
      const d = doors({
        "llm.complete": (a) => (a.webSearch ? research("x") : ok({ json: { pick: -1, forReader: "", forThem: "" } })),
      });
      const h = harness(d.handler, { units });
      const out = await runScript(first, { subject: null, brand: "b", day: 0, tactics: INTRO_LEAD_TO_LEAD.tactics, request: baseRequest }, h.bridge);
      expect((out as any).result).toEqual({ unmade: "no_fit: no candidate is good for both sides (2 looked at)", again: true });
      expect(h.calls.some((c) => c.name === "email.send")).toBe(false);
      expect((h.store.get("intro_pool\u0000people") as any[]).map((p) => p.email)).toEqual(["sarah@corvia.com", "ann@acme.com", "tom@lonestarfreight.com"]);
    });

    it("open: names nobody and asks who they want to meet", async () => {
      const d = doors();
      const h = harness(d.handler, { units });
      const out = await runScript(first, { subject: null, brand: "b", day: 0, tactics: INTRO_OPEN.tactics, request: baseRequest }, h.bridge);
      expect((out as any).result.content.counterpart).toBeNull();
      expect(h.calls.filter((c) => c.name === "lead.serve")).toHaveLength(1);
      expect((h.calls.filter((c) => c.name === "llm.complete").pop()!.args as any).systemPrompt).toContain("Name no other person");
    });

    it("client to lead: a brand stating no sales rep introduces nobody, before any spend", async () => {
      const d = doors({ "brand.sales_rep": () => ok({ salesRepEmail: null, salesRepPhone: null, salesRepFirstName: null, salesRepRole: null }) });
      const h = harness(d.handler, { units });
      const out = await runScript(first, { subject: null, brand: "b", day: 0, tactics: INTRO_CLIENT_TO_LEAD.tactics, request: baseRequest }, h.bridge);
      expect((out as any).result).toEqual({ unmade: "no_brand_person: the brand states no sales rep to introduce" });
      expect(h.calls.map((c) => c.name)).toEqual(["brand.profile", "brand.sales_rep"]);
    });

    it("a dry run writes and sends nothing, a person the brand already talks with is skipped", async () => {
      const d = doors();
      const h = harness(d.handler, { units });
      const out = await runScript(first, { subject: null, brand: "b", day: 0, tactics: INTRO_OPEN.tactics, request: { ...baseRequest, dryRun: true } }, h.bridge);
      expect((out as any).result.content.dryRun).toBe(true);
      expect(h.calls.some((c) => c.name === "email.send")).toBe(false);
      const talked = doors({ "crm.person.thread": () => ok({ items: [{ kind: "message", direction: "inbound", text: "hi" }] }) });
      const h2 = harness(talked.handler, { units });
      const out2 = await runScript(first, { subject: null, brand: "b", day: 0, tactics: INTRO_OPEN.tactics, request: baseRequest }, h2.bridge);
      expect((out2 as any).result.unmade).toMatch(/^already_in_conversation/);
    });
  });

  describe("the intro conversation", () => {
    const answer = buildIntroAnswerSource();
    const sarah = "sarah@corvia.com";
    const tom = "tom@lonestarfreight.com";
    const sent = {
      kind: "lead_to_lead",
      subject: "Tom Doe, Lonestar Freight",
      reader: { leadId: "l-sarah", email: sarah, name: "Sarah Doe", firstName: "Sarah", company: "Corvia" },
      counterpart: { leadId: "l-tom", email: tom, name: "Tom Doe", company: "Lonestar Freight", forReader: "a", forThem: "b" },
    };

    function doors(decision: Record<string, unknown>) {
      const handler: Handler = (name, a) => {
        if (name === "lead.followup.claim") return ok({ found: true, followup: { id: "row-1", leadId: a.body.person.leadId ?? "l-x", email: a.body.person.email } });
        if (name === "crm.person.thread") return { ok: false, data: { status: 404, error: "none" } };
        if (name === "instantly.conversation") return ok({ conversation: { threads: [{ campaignId: "inst-1" }], messages: [{ at: "2026-11-14T09:00:00Z", direction: "inbound", text: "Yes please!", messageId: "<m1@x>" }] } });
        if (name === "brand.profile") return ok({ brand: { name: "Distribute.you" } });
        if (name === "brand.offer.answers") return ok({ answers: [{ question: "Price?", answer: "Each intro billed at cost." }] });
        if (name === "brand.offer.economics") return ok({ name: "Distribute.you", bookingUrl: null });
        if (name === "brand.offer.fields") return ok({ fields: { riskReversal: { provenance: "confirmed", value: "The platform is free." }, draft: { provenance: "suggested", value: "not confirmed" } } });
        if (name === "voice.read") return ok({ content: "Short plain words." });
        if (name === "llm.pick") return llmPick(a);
        if (name === "llm.complete") return ok({ json: { replyText: "", readerText: "", otherSubject: "", otherText: "", introText: "", goalText: "", wanted: "", nextFollowUpAt: "2026-11-21T10:00:00Z", why: "test", ...decision } });
        if (name === "instantly.reply.send" || name === "email.send") return ok({ success: true });
        if (name === "lead.followup_date.set" || name === "lead.followup.record") return ok({});
        return undefined;
      };
      return handler;
    }
    const event = (email: string, leadId: string) => ({ ...baseRequest, trigger: { eventId: "evt-1", leadId, person: { email } } });
    const unitsOf = (step: Record<string, unknown>) => ({ [INTRO_MATERIAL]: step });

    it("records the first email and holds the lead for this campaign", async () => {
      const h = harness(doors({}), { units: unitsOf({ step: "record", sent }) });
      const out = await runScript(answer, { subject: null, brand: "b", day: 0, tactics: INTRO_ANSWER.tactics, request: baseRequest }, h.bridge);
      expect((out as any).result).toEqual({ unmade: `recorded: the intro to ${sarah} is kept for its conversation`, decided: "done" });
      expect(h.store.get(`intro_people\u0000${sarah}`)).toMatchObject({ role: "reader", state: "proposed", pending: { email: tom, state: "proposed" }, declined: false });
      expect(h.store.get("answering_leads\u0000l-sarah")).toMatchObject({ campaignId: "camp-intro", holdUntil: "2027-01-13T10:00:00.000Z", conversation: "intro" });
      expect(h.calls).toEqual([]);
    });

    it("a person of no intro thread is not this conversation's (nothing claimed, nothing spent)", async () => {
      const h = harness(doors({}), { units: unitsOf({ step: "answer" }) });
      const out = await runScript(answer, { subject: null, brand: "b", day: 0, tactics: INTRO_ANSWER.tactics, request: event("nobody@x.com", "l-n") }, h.bridge);
      expect((out as any).result).toMatchObject({ decided: "idle" });
      expect(h.calls).toEqual([]);
    });

    it("a) b) c) the reader says yes: we ask the other person; the other says yes: one email to both, then the goal question", async () => {
      // a/b: the reader confirms: thanks in their thread + a NEW email to Tom (double opt-in).
      const h = harness(doors({ action: "ask_other", replyText: "Great, asking Tom now.", otherSubject: "Sarah Doe, Corvia", otherText: "Hi Tom,\n\nSarah cut Corvia's onboarding to six days. Want the intro?" }), {
        units: unitsOf({ step: "answer" }),
        storage: {},
      });
      await runScript(answer, { subject: null, brand: "b", day: 0, tactics: INTRO_ANSWER.tactics, request: baseRequest }, harness(doors({}), { units: unitsOf({ step: "record", sent }) }).bridge);
      // Pre-load what the record step stores.
      const rec = harness(doors({}), { units: unitsOf({ step: "record", sent }) });
      await runScript(answer, { subject: null, brand: "b", day: 0, tactics: INTRO_ANSWER.tactics, request: baseRequest }, rec.bridge);
      for (const [k, v] of rec.store) h.store.set(k, v);
      const out = await runScript(answer, { subject: null, brand: "b", day: 0, tactics: INTRO_ANSWER.tactics, request: event(sarah, "l-sarah") }, h.bridge);
      expect((out as any).result.content).toEqual({ action: "ask_other", asked: tom, sent: true });
      const writer = h.calls.find((c) => c.name === "llm.complete")!.args as any;
      expect(writer.responseSchema.properties.action.enum).toContain("ask_other");
      expect(writer.responseSchema.properties.action.enum).not.toContain("introduce");
      expect(h.calls.find((c) => c.name === "instantly.reply.send")!.args.body).toMatchObject({ email: sarah, in_reply_to: "<m1@x>", sent_by: "automation" });
      expect(h.calls.find((c) => c.name === "email.send")!.args.body).toMatchObject({ to: tom, leadId: "l-tom", subject: "Sarah Doe, Corvia", campaignId: "camp-intro", idempotencyKey: `intro-ask:${tom}:${sarah}` });
      expect(h.store.get(`intro_people\u0000${tom}`)).toMatchObject({ role: "counterpart", state: "asked", reader: { email: sarah } });
      expect(h.store.get("answering_leads\u0000l-tom")).toMatchObject({ campaignId: "camp-intro", conversation: "intro" });

      // c: Tom says yes: ONE email to both (Sarah in To, Tom in Cc), then the goal question to Sarah alone.
      const h2 = harness(doors({ action: "introduce", introText: "<p>Sarah, meet Tom.</p><p>Tom, meet Sarah.</p>", goalText: "Would you like more people like Tom in front of you?" }), { units: unitsOf({ step: "answer" }) });
      for (const [k, v] of h.store) h2.store.set(k, v);
      const out2 = await runScript(answer, { subject: null, brand: "b", day: 0, tactics: INTRO_ANSWER.tactics, request: event(tom, "l-tom") }, h2.bridge);
      expect((out2 as any).result.content).toEqual({ action: "introduce", reader: sarah, other: tom, goalAsked: true });
      const replies = h2.calls.filter((c) => c.name === "instantly.reply.send").map((c) => c.args.body as any);
      expect(replies.map((r) => [r.email, r.to, r.cc])).toEqual([
        [sarah, [sarah], [tom]],
        [sarah, [sarah], undefined],
      ]);
      // A writer mirroring the thread's HTML is sent as clean paragraphs, never escaped tags.
      expect(replies[0].body_html).toBe("<p>Sarah, meet Tom.</p><p>Tom, meet Sarah.</p>");
      expect(h2.store.get(`intro_people\u0000${sarah}`)).toMatchObject({ state: "goal_asked", introductions: 1, goalAsked: true });
      // The price is open only through THE OFFER, never in the intro: the writer reads it from the offer's own facts.
      const offerMessage = (h2.calls.find((c) => c.name === "llm.complete")!.args as any).message;
      expect(offerMessage).toContain("Each intro billed at cost.");
      expect(offerMessage).toContain("riskReversal: The platform is free.");
      expect(offerMessage).not.toContain("not confirmed");
    });

    it("d) a reader who declines is never offered an intro again, even when they ask", async () => {
      const h = harness(doors({ action: "decline_intros", replyText: "Thank you, I will keep you posted on Tom." }), { units: unitsOf({ step: "answer" }) });
      const rec = harness(doors({}), { units: unitsOf({ step: "record", sent }) });
      await runScript(answer, { subject: null, brand: "b", day: 0, tactics: INTRO_ANSWER.tactics, request: baseRequest }, rec.bridge);
      for (const [k, v] of rec.store) h.store.set(k, v);
      await runScript(answer, { subject: null, brand: "b", day: 0, tactics: INTRO_ANSWER.tactics, request: event(sarah, "l-sarah") }, h.bridge);
      expect(h.store.get(`intro_people\u0000${sarah}`)).toMatchObject({ declined: true });
      // Next time they write: neither find nor ask_other nor decline is open, only a plain reply.
      const h2 = harness(doors({ action: "reply", replyText: "Happy to help with anything else." }), { units: unitsOf({ step: "answer" }) });
      for (const [k, v] of h.store) h2.store.set(k, v);
      await runScript(answer, { subject: null, brand: "b", day: 0, tactics: INTRO_ANSWER.tactics, request: event(sarah, "l-sarah") }, h2.bridge);
      const actions = (h2.calls.find((c) => c.name === "llm.complete")!.args as any).responseSchema.properties.action.enum;
      expect(actions).not.toContain("find");
      expect(actions).not.toContain("decline_intros");
      // A writer that picks a closed action anyway fails the run: nothing is sent.
      const h3 = harness(doors({ action: "find", wanted: "a CFO" }), { units: unitsOf({ step: "answer" }) });
      for (const [k, v] of h.store) h3.store.set(k, v);
      const out3 = await runScript(answer, { subject: null, brand: "b", day: 0, tactics: INTRO_ANSWER.tactics, request: event(sarah, "l-sarah") }, h3.bridge);
      expect(out3.kind).toBe("error");
      expect(h3.calls.some((c) => c.name === "lead.serve" || c.name === "instantly.reply.send")).toBe(false);
    });
  });
});

import { LEAD_CLAIM_BLOCK } from "../../scripts/engine-ports/meeting-paths.js";
import { answererRespectsHold } from "../../scripts/engine-ports/intro.js";

describe("the answerer respects an intro hold (upgrade of dy_answer_lead*)", () => {
  // The answerer's claim block as stored (meeting-paths.ts is its source), inside a minimal run.
  const stored = [
    "export default function run(ctx) {",
    "  const s = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);",
    "  const must = (n, a) => { const r = ctx.vendor.call(n, a); if (!r.ok) throw new Error(n); return r.data; };",
    "  const now = ctx.request.now; const campaignId = ctx.request.campaignId; const named = { leadId: 'l-1' };",
    "  const row = { id: 'row-1', leadId: 'l-1' };",
    LEAD_CLAIM_BLOCK,
    "  return { content: { answered: true } };",
    "}",
  ].join("\n");
  const upgraded = answererRespectsHold(stored);
  const at = "2026-11-14T10:00:00.000Z";
  async function runWith(code: string, note: unknown, now: string) {
    const h = harness((name) => (name === "lead.followup.record" ? ok({}) : undefined), { storage: note ? { "answering_leads\u0000l-1": note } : {} });
    const out = await runScript(code, { subject: null, brand: "b", day: 0, tactics: {}, request: { now, campaignId: "camp-other" } }, h.bridge);
    return (out as any).result;
  }

  it("changes nothing for a note with no hold (before = after)", async () => {
    for (const [note, now] of [
      [null, at],
      [{ campaignId: "camp-intro", at }, "2026-11-14T10:10:00.000Z"],
      [{ campaignId: "camp-intro", at }, "2026-11-14T11:00:00.000Z"],
      [{ campaignId: "camp-other", at }, "2026-11-14T10:10:00.000Z"],
    ] as const) {
      expect(await runWith(upgraded, note, now)).toEqual(await runWith(stored, note, now));
    }
  });

  it("steps aside while another campaign holds the lead for its intro conversation, takes over once the hold ends", async () => {
    const note = { campaignId: "camp-intro", at, holdUntil: "2027-01-13T10:00:00.000Z", conversation: "intro" };
    expect(await runWith(stored, note, "2026-11-20T10:00:00.000Z")).toEqual({ content: { answered: true } });
    expect(await runWith(upgraded, note, "2026-11-20T10:00:00.000Z")).toEqual({ unmade: "answered_elsewhere: campaign camp-intro answers this lead", decided: "done" });
    expect(await runWith(upgraded, note, "2027-01-14T10:00:00.000Z")).toEqual({ content: { answered: true } });
  });
});
