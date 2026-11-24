import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMaterials, runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { SCRIPT_VENDORS } from "../../src/lib/scripts/vendors.js";
import {
  COLD_SENDER_SHAPE,
  EMAIL_FOUND_READ,
  INTRO_FIRST_EMAILS,
  INTRO_FIRST_EMAIL_SHAPE,
  SEND_CHECK_DOOR,
  VERIFY_DOOR,
  addVerifyBeforeWrite,
  verifyBeforeWriteTactics,
} from "../../src/lib/scripts/verify-before-write.js";
import { INTRO_ANSWER_CHECK_DOOR, INTRO_ANSWER_SENDERS, addIntroAnswerCheck, introAnswerCheckTactics } from "../../src/lib/scripts/intro-answer-check-before-write.js";

// INTRO-VERIFY-BEFORE-WRITE-1124: the intro scripts, byte for byte as production stores them (2026-11-24), look at an
// address before they pay to write to it. Production holds no recorded case of these dynasties (script_cases: 0;
// writer_cases: one dy_intro_open run that wrote nothing), so what follows is proven on fakes only.
const fixture = (f: string) => readFileSync(join(__dirname, "../fixtures/stored-scripts", f), "utf8");
// One code for the three first emails (md5 equal in production): dy_intro_open v8 = lead_to_lead v7 = client_to_lead v7.
const FIRST = fixture("email_sent__dy_intro_open.v8.ts.txt");
const ANSWER = fixture("message_sent__dy_intro_answer.v5.ts.txt");

type Call = { name: string; args: Record<string, any> };
const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const now = "2026-11-24T10:00:00.000Z";
const everyLineKept = (stored: string, next: string) => {
  const lines = next.split("\n");
  let at = 0;
  for (const l of stored.split("\n")) {
    at = lines.indexOf(l, at);
    expect(at, l).toBeGreaterThanOrEqual(0);
    at++;
  }
};

describe("the intro first emails look at the reader's address before anything is paid for them", () => {
  const next = addVerifyBeforeWrite(FIRST, INTRO_FIRST_EMAIL_SHAPE);
  const READER = "pat@clinic.example";
  const unit = (over: Record<string, unknown>) => ({ verificationId: "v-1", email: READER, verdict: "valid", decisive: true, deliverable: true, verifiedAt: "2026-11-12T00:00:00.000Z", ageDays: 12, subject: { subjectService: "lead-service", subjectId: "lead-77", declared: true }, ...over });
  const refusal409 = { ok: false, data: { error: "Email not verified", status: 409, code: "email_not_verified", body: { error: "The address is not verified", code: "email_not_verified", verdict: "invalid" } } };
  const persona = { name: "Sophie", says: "an AI specialized in introducing people to clients" };
  const TACTICS = { intro: "open", persona, signature: "Sophie\nAI introductions", sendTag: "intro-email", asks: ["llm_completion"] };

  interface World {
    units?: unknown[];
    verify?: unknown;
    check?: unknown;
    send?: unknown;
    talked?: boolean;
    request?: Record<string, unknown>;
  }
  async function run(code: string, w: World, tactics: Record<string, unknown>) {
    const calls: Call[] = [];
    const order: string[] = [];
    const consumed: unknown[] = [];
    let completions = 0;
    const bridge: Bridge = (op, args) => {
      if (op === "get" && args.length > 1) {
        order.push(`read:${String(args[0])}`);
        calls.push({ name: `provider:${String(args[0])}`, args: (args[1] ?? {}) as Record<string, any> });
        return { v: ok({ units: w.units ?? [], nextBefore: null, hasMore: false }) };
      }
      if (op === "vendor") {
        const name = String(args[0]);
        order.push(name);
        calls.push({ name, args: (args[1] ?? {}) as Record<string, any> });
        if (name === "brand.profile") return { v: ok({ brand: { name: "Acme", url: "https://acme.example" } }) };
        if (name === "lead.serve") return { v: ok({ found: true, lead: { leadId: "lead-77", email: READER, data: { firstName: "Pat", lastName: "Lee", currentTitle: "Owner", organization: { name: "Clinic", primaryDomain: "clinic.example", websiteUrl: "https://clinic.example" } } } }) };
        if (name === "crm.person.thread") return { v: w.talked ? ok({ items: [{ kind: "message" }] }) : { ok: false, data: { status: 404, error: "no thread" } } };
        if (name === "scraping.page") return { v: ok({ result: { rawMarkdown: "# Clinic" } }) };
        if (name === "voice.read") return { v: ok({ content: "plain words" }) };
        if (name === "email.send") return { v: w.send ?? ok({ success: true }) };
        if (name === VERIFY_DOOR && w.verify) return { v: w.verify };
        if (name === SEND_CHECK_DOOR && w.check) return { v: w.check };
        return { stop: `unexpected call ${name}` };
      }
      if (op === "ask") {
        order.push("ask:llm_completion");
        return { v: null };
      }
      if (op === "get") {
        const outcome = String(args[0]);
        if (outcome === "intro_requested") return { v: { content: {} } };
        completions++;
        return { v: { content: { answer: { json: { sells: "care", sellsTo: "patients", facts: [], looksFor: [], canBring: [], subject: "Hello Pat", body: "Who would you like to meet?" } }, llm: {} } } };
      }
      if (op === "consume") {
        consumed.push(args);
        return { v: null };
      }
      if (op.startsWith("storage.")) return { v: null };
      return { stop: `${String(op)} asked` };
    };
    const out: any = await runScript(code, { subject: null, brand: "b", day: 0, tactics, request: { now, brandIds: ["brand-1"], campaignId: "c1", ...(w.request ?? {}) } }, bridge);
    return { out, calls, order, consumed, completions: () => completions };
  }
  const WINDOW = { ...TACTICS, verdictMaxAgeDays: 30 };

  it("the edit only adds: every stored line kept, a valid source, the same materials, the cold senders' own doors and helper", async () => {
    everyLineKept(FIRST, next);
    const [after, before] = [await validateSource(next), await validateSource(FIRST)];
    expect(readMaterials(next)).toEqual(readMaterials(FIRST));
    expect(after.vendors).toEqual([...before.vendors, VERIFY_DOOR, SEND_CHECK_DOOR]);
    for (const door of [VERIFY_DOOR, SEND_CHECK_DOOR]) expect((SCRIPT_VENDORS as readonly string[]).includes(door)).toBe(true);
    // After the free "already in conversation" read, before the first paid thing about the reader.
    expect(next.indexOf('ctx.vendor.call("crm.person.thread"')).toBeLessThan(next.indexOf("refusedBeforeWriting(ctx, t, reader.email"));
    expect(next.indexOf("refusedBeforeWriting(ctx, t, reader.email")).toBeLessThan(next.indexOf("reader.research = research(ctx"));
    expect(() => addVerifyBeforeWrite(next, INTRO_FIRST_EMAIL_SHAPE)).toThrow(/already/);
    // Each family keeps its own anchors: a shape applied to the other family's code generates nothing.
    expect(() => addVerifyBeforeWrite(FIRST)).toThrow(/person thread line is found nowhere/);
    expect(() => addVerifyBeforeWrite(FIRST.replace("reader.research = research(", "reader.research = look("), INTRO_FIRST_EMAIL_SHAPE)).toThrow(/reader research line is found nowhere/);
    expect(() => addVerifyBeforeWrite(FIRST.replace("Number(dd.status) === 409", "Number(dd.status) === 410"), INTRO_FIRST_EMAIL_SHAPE)).toThrow(/refusal branch the look reproduces is found nowhere/);
    expect(COLD_SENDER_SHAPE.refusal).toBe("code");
    expect(INTRO_FIRST_EMAILS.map((x) => x.dynasty)).toEqual(["dy_intro_open", "dy_intro_lead_to_lead", "dy_intro_client_to_lead"]);
    expect(verifyBeforeWriteTactics(TACTICS)).toEqual(WINDOW);
  });

  it("no tactic stated: the very same calls, asks and result as the stored code", async () => {
    for (const w of [{}, { talked: true }, { send: { ok: false, data: { error: "x", status: 409, code: "recent_brand_contact" } } }] as World[]) {
      const a = await run(next, w, TACTICS);
      const b = await run(FIRST, w, TACTICS);
      expect(a.out).toEqual(b.out);
      expect(a.calls).toEqual(b.calls);
      expect(a.order).toEqual(b.order);
      expect(a.calls.some((c) => c.name === EMAIL_FOUND_READ || c.name === VERIFY_DOOR || c.name === SEND_CHECK_DOOR)).toBe(false);
    }
    expect((await run(FIRST, {}, TACTICS)).out.result.content.sentTo).toBe(READER);
  });

  it("a deliverable verdict in the window: read first, consumed on apollo's subject, then the run as stored", async () => {
    const a = await run(next, { units: [unit({})] }, WINDOW);
    const b = await run(FIRST, {}, TACTICS);
    expect(a.out).toEqual(b.out);
    expect(a.calls.find((c) => c.name === EMAIL_FOUND_READ)!.args).toEqual({ route: "listEmailFoundUnits", query: { emails: READER, decisive: "true", since: "2026-10-25T10:00:00.000Z", limit: 1 } });
    expect(a.calls.filter((c) => c.name !== EMAIL_FOUND_READ)).toEqual(b.calls);
    expect(a.consumed).toEqual([["email_checked", { service: "lead-service", id: "lead-77" }]]);
    expect(a.order.indexOf("read:email_found")).toBe(a.order.indexOf("crm.person.thread") + 1);
    expect(a.order.indexOf("read:email_found")).toBeLessThan(a.order.indexOf("scraping.page"));
  });

  it("a refused address ends the run as the stored send's refusal does, before any research, match or writer", async () => {
    const a = await run(next, { units: [unit({ verdict: "invalid", deliverable: false })], check: refusal409 }, WINDOW);
    expect(a.out.result).toEqual({ unmade: "email_not_verified: The address is not verified", again: true });
    expect(a.calls.map((c) => c.name)).toEqual(["brand.profile", "lead.serve", "crm.person.thread", EMAIL_FOUND_READ, SEND_CHECK_DOOR]);
    expect(a.calls[4]!.args).toEqual({ body: { type: "broadcast", to: READER } });
    expect(a.completions()).toBe(0);
    expect(a.consumed).toEqual([]);
    // What the stored code answers when its SEND refuses that address (after paying research and the writer): the same.
    const b = await run(FIRST, { send: refusal409 }, TACTICS);
    expect(b.out.result).toEqual(a.out.result);
    expect(b.completions()).toBeGreaterThan(0);
  });

  it("no verdict held: a new one asked on the run with the window; a verdict the send's door passes goes on", async () => {
    const fresh = (verdict: string) => ok({ results: [{ email: READER, verdict, deliverable: verdict === "valid" }] });
    const good = await run(next, { verify: fresh("valid") }, { ...TACTICS, verdictMaxAgeDays: 12 });
    expect(good.out.result.content.sentTo).toBe(READER);
    expect(good.calls.find((c) => c.name === VERIFY_DOOR)!.args).toEqual({ body: { emails: [READER], maxVerdictAgeDays: 12, source: "sender-before-write" } });
    expect(good.order.indexOf(VERIFY_DOOR)).toBeLessThan(good.order.indexOf("scraping.page"));
    const passed = await run(next, { units: [unit({ verdict: "catch_all", deliverable: false })], check: ok({ sendable: true }) }, WINDOW);
    expect(passed.out.result.content.sentTo).toBe(READER);
    const bad = await run(next, { verify: fresh("invalid"), check: refusal409 }, WINDOW);
    expect(bad.out.result).toEqual({ unmade: "email_not_verified: The address is not verified", again: true });
    expect(bad.completions()).toBe(0);
  });

  it("someone the brand already talks with is set aside before any look, and a check that does not answer fails the run", async () => {
    const talked = await run(next, { talked: true, units: [unit({})] }, WINDOW);
    expect(talked.out.result.unmade).toMatch(/^already_in_conversation/);
    expect(talked.calls.some((c) => c.name === EMAIL_FOUND_READ)).toBe(false);
    const down = await run(next, { units: [unit({ deliverable: false })], check: { ok: false, data: { error: "email-gateway-service answered 502", status: 502, code: null } } }, WINDOW);
    expect(down.out.kind).toBe("error");
    expect(down.out.message).toMatch(/email\.send_check/);
  });

  it("a staff test or a dry run sends nothing to the reader: nothing is asked about their address", async () => {
    for (const request of [{ testRecipient: "kevin+intro@hidistribute.com" }, { dryRun: true }]) {
      const a = await run(next, { request }, WINDOW);
      const b = await run(FIRST, { request }, TACTICS);
      expect(a.out).toEqual(b.out);
      expect(a.calls).toEqual(b.calls);
    }
  });
});

describe("the intro conversation asks the send's check on the other person before its writer", () => {
  const next = addIntroAnswerCheck(ANSWER);
  const READER = "pat@clinic.example";
  const OTHER = "sam@studio.example";
  const TACTICS = { intro: "conversation", persona: { name: "Sophie", says: "an AI" }, signature: "Sophie", relationships: "pure_prospect", asks: ["llm_completion"] };
  const CHECKED = introAnswerCheckTactics(TACTICS);
  const pending = (state: string) => ({ leadId: "lead-88", email: OTHER, name: "Sam Roy", title: "Founder", company: "Studio", state });
  const readerState = (p: unknown) => ({ role: "reader", campaignId: "c1", leadId: "lead-77", name: "Pat Lee", firstName: "Pat", company: "Clinic", pending: p, state: "proposed", declined: false, introductions: 0 });
  const refused409 = { ok: false, data: { error: "Lead opted out", status: 409, code: "lead_opted_out", body: { error: "Lead opted out", code: "lead_opted_out" } } };

  interface World {
    me: Record<string, unknown>;
    action: string;
    check?: unknown;
    send?: unknown;
  }
  async function run(code: string, w: World, tactics: Record<string, unknown>) {
    const calls: Call[] = [];
    const order: string[] = [];
    const asked: Array<Record<string, any>> = [];
    const store = new Map<string, unknown>([[`intro_people\u0000${READER}`, JSON.parse(JSON.stringify(w.me))]]);
    const bridge: Bridge = (op, args) => {
      if (op === "vendor") {
        const name = String(args[0]);
        order.push(name);
        calls.push({ name, args: (args[1] ?? {}) as Record<string, any> });
        if (name === "lead.followup.claim") return { v: ok({ found: true, followup: { id: "row-1", leadId: "lead-77" } }) };
        if (name === "lead.followup.record" || name === "lead.followup_date.set") return { v: ok({}) };
        if (name === "crm.person.thread") return { v: ok({ items: [] }) };
        if (name === "instantly.conversation") return { v: ok({ conversation: { messages: [{ at: "2026-11-24T09:00:00.000Z", direction: "inbound", subject: "Re: hello", text: "Yes, I would like to meet Sam.", messageId: "<m1@clinic.example>" }], threads: [{ campaignId: "c1" }] } }) };
        if (name === "brand.profile") return { v: ok({ brand: { name: "Acme", url: "https://acme.example" } }) };
        if (name === "voice.read") return { v: ok({ content: "plain words" }) };
        if (name === "instantly.reply.send") return { v: ok({ success: true }) };
        if (name === "email.send") return { v: w.send ?? ok({ success: true }) };
        if (name === INTRO_ANSWER_CHECK_DOOR && w.check) return { v: w.check };
        return { stop: `unexpected call ${name}` };
      }
      if (op === "ask") {
        order.push("ask:llm_completion");
        asked.push(((args[0] ?? {}) as Record<string, any>).request ?? {});
        return { v: null };
      }
      if (op === "get") {
        if (String(args[0]) === "intro_requested") return { v: { content: { step: "answer" } } };
        const open: string[] = asked[asked.length - 1]!.responseSchema.properties.action.enum;
        const action = open.includes(w.action) ? w.action : "reply";
        return { v: { content: { answer: { json: { action, replyText: "Thanks Pat.", readerText: "", otherSubject: "Pat would like to meet you", otherText: "Hello Sam.", introText: "", followText: "", wanted: "", nextFollowUpAt: "", why: "they said yes" } }, llm: {} } } };
      }
      const key = `${String(args[0])}\u0000${String(args[1])}`;
      if (op === "storage.get") return { v: store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null };
      if (op === "storage.set") {
        store.set(key, JSON.parse(JSON.stringify(args[2] ?? null)));
        return { v: null };
      }
      if (op.startsWith("storage.")) return { v: null };
      return { stop: `${String(op)} asked` };
    };
    const request = { now, brandIds: ["brand-1"], campaignId: "c1", trigger: { eventId: "ev-1", leadId: "lead-77", person: { email: READER } } };
    const out: any = await runScript(code, { subject: null, brand: "b", day: 0, tactics, request }, bridge);
    const openActions: string[] = asked.length ? asked[0]!.responseSchema.properties.action.enum : [];
    return { out, calls, order, asked, openActions, kept: store.get(`intro_people\u0000${READER}`) as Record<string, any>, other: store.get(`intro_people\u0000${OTHER}`) as Record<string, any> | undefined };
  }
  const proposed: World = { me: readerState(pending("proposed")), action: "ask_other" };

  it("the edit only adds: every stored line kept, a valid source, the same materials, one more door the catalogue allows", async () => {
    everyLineKept(ANSWER, next);
    const [after, before] = [await validateSource(next), await validateSource(ANSWER)];
    expect(readMaterials(next)).toEqual(readMaterials(ANSWER));
    expect(after.vendors).toEqual([...before.vendors.filter((v) => next.indexOf(`"${v}"`) < next.indexOf(`"${INTRO_ANSWER_CHECK_DOOR}"`)), INTRO_ANSWER_CHECK_DOOR, ...before.vendors.filter((v) => next.indexOf(`"${v}"`) > next.indexOf(`"${INTRO_ANSWER_CHECK_DOOR}"`))]);
    expect((SCRIPT_VENDORS as readonly string[]).includes(INTRO_ANSWER_CHECK_DOOR)).toBe(true);
    expect(next.indexOf(`ctx.vendor.call("${INTRO_ANSWER_CHECK_DOOR}"`)).toBeLessThan(next.indexOf('const d = complete(ctx, "writer", system, message, answerSchema(open));'));
    expect(() => addIntroAnswerCheck(next)).toThrow(/already asks the check/);
    expect(() => addIntroAnswerCheck(ANSWER.replace('state: "refused", refusal: code', 'state: "refused"'))).toThrow(/leaned-on #3 line nowhere/);
    expect(INTRO_ANSWER_SENDERS).toEqual([{ outcome: "message_sent", dynasty: "dy_intro_answer" }]);
    expect(CHECKED).toEqual({ ...TACTICS, checksEmailBeforeWriter: true });
  });

  it("no tactic stated: the very same calls, asks, kept state and result as the stored code", async () => {
    for (const w of [proposed, { ...proposed, send: refused409 }, { me: readerState(null), action: "reply" }, { ...proposed, action: "later" }] as World[]) {
      const a = await run(next, w, TACTICS);
      const b = await run(ANSWER, w, TACTICS);
      expect(a.out).toEqual(b.out);
      expect(a.calls).toEqual(b.calls);
      expect(a.asked).toEqual(b.asked);
      expect(a.kept).toEqual(b.kept);
      expect(a.calls.some((c) => c.name === INTRO_ANSWER_CHECK_DOOR)).toBe(false);
    }
  });

  it("a proposed person the send's door passes: checked before the writer, then the run as stored (thanks, then the new email)", async () => {
    const a = await run(next, { ...proposed, check: ok({ sendable: true }) }, CHECKED);
    const b = await run(ANSWER, proposed, TACTICS);
    expect(a.out).toEqual(b.out);
    expect(a.out.result).toEqual({ content: { action: "ask_other", asked: OTHER, sent: true } });
    expect(a.calls.find((c) => c.name === INTRO_ANSWER_CHECK_DOOR)!.args).toEqual({ body: { type: "broadcast", to: OTHER } });
    expect(a.calls.filter((c) => c.name !== INTRO_ANSWER_CHECK_DOOR)).toEqual(b.calls);
    expect(a.asked).toEqual(b.asked);
    expect(a.kept).toEqual(b.kept);
    expect(a.order.indexOf(INTRO_ANSWER_CHECK_DOOR)).toBeLessThan(a.order.indexOf("ask:llm_completion"));
    expect(a.order.indexOf("email.send")).toBeGreaterThan(a.order.indexOf("ask:llm_completion"));
  });

  it("a proposed person the door refuses: kept refused with the door's code as the stored refused ask keeps it, the ask not open, no new email written or sent", async () => {
    const a = await run(next, { ...proposed, check: refused409 }, CHECKED);
    expect(a.openActions).not.toContain("ask_other");
    expect(a.openActions).toContain("find");
    expect(a.calls.some((c) => c.name === "email.send")).toBe(false);
    expect(a.kept.pending).toMatchObject({ email: OTHER, state: "refused", refusal: "lead_opted_out" });
    expect(a.other).toBeUndefined();
    expect(a.out.result).toEqual({ content: { action: "reply" } });
    // The stored code on a refused SEND: the same pending state, after the writer wrote both emails.
    const b = await run(ANSWER, { ...proposed, send: refused409 }, TACTICS);
    expect(b.kept.pending).toEqual(a.kept.pending);
    expect(b.openActions).toContain("ask_other");
    // And what the stored code offers on its NEXT look at that state is what the writer is offered here.
    const later = await run(ANSWER, { me: b.kept, action: "reply" }, TACTICS);
    expect(a.openActions).toEqual(later.openActions);
  });

  it("never asked where no new email can leave: nothing pending, an intro already asked, the other person's own thread", async () => {
    const counterpart = { role: "counterpart", campaignId: "c1", name: "Pat Lee", firstName: "Pat", company: "Clinic", state: "asked", reader: { email: OTHER, name: "Sam Roy", company: "Studio" } };
    for (const me of [readerState(null), readerState(pending("asked")), readerState(pending("refused")), counterpart]) {
      const a = await run(next, { me, action: "reply" }, CHECKED);
      const b = await run(ANSWER, { me, action: "reply" }, TACTICS);
      expect(a.calls.some((c) => c.name === INTRO_ANSWER_CHECK_DOOR)).toBe(false);
      expect(a.out).toEqual(b.out);
      expect(a.calls).toEqual(b.calls);
    }
  });

  it("a check that does not answer, or refuses without a code, fails the run before the writer (as the send's does)", async () => {
    for (const check of [{ ok: false, data: { error: "email-gateway-service answered 502", status: 502, code: null } }, { ok: false, data: { error: "Invalid request", status: 400, code: null } }]) {
      const a = await run(next, { ...proposed, check }, CHECKED);
      expect(a.out.kind).toBe("error");
      expect(a.out.message).toMatch(/email\.send_check \(double opt-in\) failed/);
      expect(a.asked).toEqual([]);
    }
  });
});
