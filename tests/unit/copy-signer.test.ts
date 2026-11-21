import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMaterials, runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { writesToPerson } from "../../src/lib/scripts/vendors.js";
import { COPY_SIGNER_STORAGE, addCopySigner, copySignerTactics, senderCodeOf } from "../../src/lib/scripts/copy-signer.js";

// COPY-SIGNER-1121: the cold email sender and the intro first email (byte for byte as production stores them) copy the
// person the email is signed as, only under the tactic AND a brief that asks for it.
const COLD = readFileSync(join(__dirname, "../fixtures/stored-scripts/email_sent__dy_cold_email_signed_sender_client_brand.v8.ts.txt"), "utf8");
const INTRO = readFileSync(join(__dirname, "../fixtures/stored-scripts/email_sent__dy_intro_open.v6.ts.txt"), "utf8");

type Call = { name: string; args: Record<string, any> };
type Handler = (name: string, args: Record<string, any>) => { ok: boolean; data: Record<string, unknown> } | undefined;
const ok = (data: Record<string, unknown>) => ({ ok: true, data });

function harness(handler: Handler, opts: { units?: Record<string, unknown>; asked: (outcome: string, request: any) => unknown; storage?: Record<string, unknown> }) {
  const calls: Call[] = [];
  const store = new Map<string, unknown>(Object.entries(opts.storage ?? {}));
  let pending: any = null;
  const bridge: Bridge = (op, args) => {
    if (op === "vendor") {
      const name = String(args[0]);
      const a = (args[1] ?? {}) as Record<string, any>;
      calls.push({ name, args: a });
      const answer = handler(name, a);
      return answer ? { v: answer } : { stop: `unexpected call ${name}` };
    }
    if (op === "ask") {
      pending = args[0];
      return { v: null };
    }
    if (op === "get") {
      const outcome = String(args[0]);
      if (opts.units && outcome in opts.units) return { v: { id: "u", outcome, subject: "", ageDays: 0, content: opts.units[outcome] } };
      const r = pending;
      pending = null;
      return { v: opts.asked(outcome, r) };
    }
    const key = `${String(args[0])}\u0000${String(args[1])}`;
    if (op === "storage.get") return { v: store.get(key) ?? null };
    if (op === "storage.set") {
      store.set(key, args[2]);
      return { v: null };
    }
    return { stop: `${String(op)} asked` };
  };
  return { bridge, calls, store };
}

const now = "2026-11-21T10:00:00.000Z";
const ASKING_BRIEF = "Reach equity investors to start a conversation. Always copy Kevin on every email.";
const SILENT_BRIEF = "Reach equity investors to start a conversation.";
const REP = { salesRepEmail: "Kevin+Signer@Distribute.you", salesRepPhone: null, salesRepFirstName: "Kevin", salesRepRole: "Founder" };

function jev(asks: number) {
  return (a: any) => ok({ probabilities: { asks: String(a.state?.brief ?? "").includes("copy Kevin") ? asks : 0.02 } });
}

describe("addCopySigner (the edit)", () => {
  for (const [name, stored, kind] of [["cold", COLD, "cold"], ["intro", INTRO, "intro"]] as const) {
    it(`${name}: recognised, valid, the same materials, every stored line kept but the ones it rewrites`, async () => {
      expect(senderCodeOf(stored)).toBe(kind);
      const next = addCopySigner(stored);
      await expect(validateSource(next)).resolves.toBeDefined();
      expect(readMaterials(next)).toEqual(readMaterials(stored));
      expect(writesToPerson(next)).toBe(true);
      const rewritten = new Set(["  const t: any = ctx.tactics ?? {};", '  if (tactics.signedBy === "sender_with_client_brand") {']);
      const lines = new Set(next.split("\n"));
      for (const l of stored.split("\n")) if (!rewritten.has(l)) expect(lines.has(l), l).toBe(true);
      expect(next.split("cc: copied.email").length - 1).toBe(1);
      expect(() => addCopySigner(next)).toThrow(/already/);
    });
  }
  it("refuses a code it does not know", () => {
    expect(() => addCopySigner("export default function run() {}")).toThrow(/neither/);
  });
  it("the tactics gain only copiesSigner", () => {
    expect(copySignerTactics({ signedBy: "x" })).toEqual({ signedBy: "x", copiesSigner: true });
  });
});

describe("the cold email sender", () => {
  const next = addCopySigner(COLD);
  function doors(over: Record<string, (a: any) => any> = {}) {
    return (name: string, a: any) => {
      if (over[name]) return over[name]!(a);
      if (name === "lead.serve") return ok({ found: true, lead: { leadId: "l1", email: "sarah@corvia.com", data: { firstName: "Sarah", lastName: "Doe", organization: { name: "Corvia" } } } });
      if (name === "crm.person.thread") return { ok: false, data: { status: 404, error: "no thread" } };
      if (name === "brand.profile") return ok({ brand: { name: "distribute.you" } });
      if (name === "brand.extract_fields") return ok({ fields: {} });
      if (name === "brand.sales_rep") return ok(REP);
      if (name === "jev.noul") return jev(0.97)(a);
      if (name === "content.generate") return ok({ id: "g1", subject: "Hello", sequence: [{ step: 1, bodyHtml: "<p>Hi</p>" }] });
      if (name === "email.send") return ok({ success: true });
      return undefined;
    };
  }
  const asked = (outcome: string) => (outcome === "message_written" ? { content: { existing: false, generation: { body: {}, units: {} } }, run: { id: "w1" } } : { content: { answer: { json: { signature: "Anna\nAcme" } } } });
  const run = (tactics: Record<string, unknown>, brief: string, over: Record<string, (a: any) => any> = {}, storage: Record<string, unknown> = {}) => {
    const h = harness(doors(over), { asked, storage });
    return runScript(next, { subject: null, brand: "b", day: 0, tactics, request: { now, brief, brandIds: ["brand-1"], campaignId: "c1", offerId: "o1" } }, h.bridge).then((out) => ({ out, h }));
  };
  const sendOf = (h: { calls: Call[] }) => h.calls.find((c) => c.name === "email.send")!.args.body;
  const base = { signedBy: "sender_with_client_brand" };

  it("tactic + a brief that asks: signed as the rep, the writer reads it, the rep is the Cc", async () => {
    const { out, h } = await run(copySignerTactics(base), ASKING_BRIEF);
    expect((out as any).result.content.sent).toBe(true);
    const send = sendOf(h);
    expect(send.cc).toBe("kevin+signer@distribute.you");
    expect(send.signature).toEqual({ text: "Kevin\nFounder, distribute.you" });
    expect(h.calls.find((c) => c.name === "brand.sales_rep")!.args).toEqual({ params: { brandId: "brand-1" } });
    // The judgment is kept: a second run on the same brief asks Jev nothing.
    const kept = [...h.store.entries()].find(([k]) => k.startsWith(COPY_SIGNER_STORAGE + "\u0000"))!;
    expect(kept[1]).toMatchObject({ asks: true });
    const again = await run(copySignerTactics(base), ASKING_BRIEF, {}, Object.fromEntries([kept]));
    expect(again.h.calls.some((c) => c.name === "jev.noul")).toBe(false);
    expect(sendOf(again.h).cc).toBe("kevin+signer@distribute.you");
  });

  it("tactic + a brief that does not ask: no Cc, the stated signature, no rep read", async () => {
    const { h } = await run(copySignerTactics(base), SILENT_BRIEF);
    const send = sendOf(h);
    expect("cc" in send).toBe(false);
    expect(send.signature).toEqual({ text: "{full_name}\ndistribute.you" });
    expect(h.calls.some((c) => c.name === "brand.sales_rep")).toBe(false);
  });

  it("no tactic, even on a brief that asks: the very same send as the stored code, nothing judged", async () => {
    const a = await run(base, ASKING_BRIEF);
    const h0 = harness(doors(), { asked });
    await runScript(COLD, { subject: null, brand: "b", day: 0, tactics: base, request: { now, brief: ASKING_BRIEF, brandIds: ["brand-1"], campaignId: "c1", offerId: "o1" } }, h0.bridge);
    expect(a.h.calls).toEqual(h0.calls);
    expect("cc" in sendOf(a.h)).toBe(false);
  });

  it("a brief that asks on a brand stating no rep address: nothing written, nothing sent", async () => {
    const { out, h } = await run(copySignerTactics(base), ASKING_BRIEF, { "brand.sales_rep": () => ok({ ...REP, salesRepEmail: null }) });
    expect((out as any).result.unmade).toMatch(/^no_signer_address/);
    expect(h.calls.some((c) => c.name === "email.send" || c.name === "content.generate")).toBe(false);
  });

  it("the copy wins over a signer completion: none is asked", async () => {
    const asks: string[] = [];
    const h = harness(doors(), { asked: (o) => (asks.push(o), asked(o)) });
    await runScript(next, { subject: null, brand: "b", day: 0, tactics: copySignerTactics({ signedBy: "client_person_with_client_brand" }), request: { now, brief: ASKING_BRIEF, brandIds: ["brand-1"], campaignId: "c1", offerId: "o1" } }, h.bridge);
    expect(asks).toEqual(["message_written"]);
    expect(sendOf(h).cc).toBe("kevin+signer@distribute.you");
  });
});

describe("the intro first email", () => {
  const next = addCopySigner(INTRO);
  const units = { intro_requested: { step: "first_email" } };
  const tactics = { intro: "open", persona: { name: "Sophie", says: "an AI specialized in introducing people to clients" }, signature: "Sophie\nAI introductions, distribute.you", sendTag: "intro-email" };
  const handler = (name: string, a: any) => {
    if (name === "brand.profile") return ok({ brand: { name: "distribute.you", url: "https://distribute.you" } });
    if (name === "lead.serve") return ok({ found: true, lead: { leadId: "l1", email: "sarah@corvia.com", data: { firstName: "Sarah", lastName: "Doe", organization: { name: "Corvia", websiteUrl: "https://corvia.com" } } } });
    if (name === "crm.person.thread") return { ok: false, data: { status: 404, error: "no thread" } };
    if (name === "scraping.page") return ok({ result: { rawMarkdown: "Corvia cuts onboarding to six days." } });
    if (name === "voice.read") return ok({ content: "Short plain words." });
    if (name === "brand.sales_rep") return ok(REP);
    if (name === "jev.noul") return jev(0.97)(a);
    if (name === "email.send") return ok({ success: true });
    return undefined;
  };
  const writerPrompts: string[] = [];
  const asked = (_o: string, r: any) => {
    const req = r.request ?? {};
    if (req.webSearch) return { content: { answer: { json: { sells: "x", sellsTo: "y", facts: [{ fact: "f", url: "https://corvia.com" }], looksFor: [], canBring: [] } } } };
    writerPrompts.push(String(req.systemPrompt));
    return { content: { answer: { json: { subject: "Who would you like to meet?", body: "Hi Sarah,\n\nWho would help most?\n\nCheers," } } } };
  };
  const run = (t: Record<string, unknown>, brief: string) => {
    const h = harness(handler, { units, asked });
    return runScript(next, { subject: null, brand: "b", day: 0, tactics: t, request: { now, brief, brandIds: ["brand-1"], campaignId: "c1" } }, h.bridge).then((out) => ({ out, h }));
  };
  const sendOf = (h: { calls: Call[] }) => h.calls.find((c) => c.name === "email.send")!.args.body;

  it("tactic + a brief that asks: the rep writes, signs and is the Cc", async () => {
    writerPrompts.length = 0;
    const { out, h } = await run(copySignerTactics(tactics), "Offer free intros. " + ASKING_BRIEF);
    expect((out as any).result.content).toBeDefined();
    const send = sendOf(h);
    expect(send.cc).toBe("kevin+signer@distribute.you");
    expect(send.signature).toEqual({ text: "Kevin\nFounder, distribute.you" });
    expect(writerPrompts.pop()).toContain("WHO YOU ARE: Kevin, Founder of distribute.you, who introduces people to each other. Your signature, added after your text, reads: Kevin, Founder, distribute.you");
  });

  it("tactic + a brief that does not ask: Sophie signs, no Cc", async () => {
    const { h } = await run(copySignerTactics(tactics), "Offer free intros.");
    const send = sendOf(h);
    expect("cc" in send).toBe(false);
    expect(send.signature).toEqual({ text: "Sophie\nAI introductions, distribute.you" });
  });
});
