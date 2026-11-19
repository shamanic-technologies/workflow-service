import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMaterials, readVendors, runScript, validateSource, type Bridge } from "../../src/lib/scripts/sandbox.js";
import { replayCase, sameJson, type ReplayCase } from "../../src/lib/scripts/replay.js";
import {
  FOUNDER_HELLO_ANCHORS,
  FOUNDER_HELLO_PERSON_FIELDS,
  FOUNDER_HELLO_REQUESTED,
  compareFounderHelloOnCase,
  founderHelloTactics,
  senderReplayCase,
  splitFounderHello,
  storedCaseOfReplay,
  type StoredFounderHelloCase,
} from "../../src/lib/scripts/founder-hello-split.js";
import { asksCompletion, isPairWriter } from "../../src/lib/scripts/writer-proof.js";
import { callVendor, writesToPerson, type VendorDeps } from "../../src/lib/scripts/vendors.js";

// WRITER-SENDER-SPLIT-1119-FOUNDER: the stored founder hello (whatsapp_message_sent/dy_founder_hello v6, byte for byte as
// production stores it, md5 558a5f69...) is cut into its writer and its sender. Same model answer = the same doors called
// with the same bodies, in the same order, the model asked the same request, and the same end.
const STORED = readFileSync(join(__dirname, "../fixtures/founder-hello-stored-v6.js"), "utf8");
const HALVES = splitFounderHello(STORED);
const NOW = "2026-11-19T08:59:12.000Z";
const REQUEST = {
  now: NOW,
  campaignId: "camp-1",
  runId: "run-1",
  brandIds: ["brand-1"],
  trigger: { eventId: "ev-1", leadId: "lead-1", person: { email: "ann@co.test", phone: "+33612345678", name: "Ann Lee" }, item: { firstName: "Ann" } },
};

type Answer = { ok: boolean; data: Record<string, unknown> };
const ok = (data: Record<string, unknown>): Answer => ({ ok: true, data });
const refused = (status: number, code: string): Answer => ({ ok: false, data: { status, code, error: code, body: { error: "They wrote to the brand meanwhile.", code } } });
const RECORD = { kind: "event", source: "onboarding", event: { step: "onboarding_record" }, text: "Brand: Acme\nOffer: Booked meetings\nBudget: $20/day", at: "2026-11-19T08:50:00Z" };
const THREAD = ok({ items: [RECORD], sources: [{ source: "matrix", status: "ok" }, { source: "onboarding", status: "ok" }], factFeed: { settled: true } });
const REACH = ok({
  reachable: true,
  fromAccount: "+33600000000",
  persona: { name: "Kevin", role: "founder" },
  assistantLine: { phone: "+77700000000", persona: { name: "Sophie", role: "the Acme assistant", instructions: "Be brief." } },
});
const SAMPLE = {
  personId: "p-9",
  emails: ["bob@client.test"],
  phones: ["+15550001111"],
  connectionTags: [{ tag: "professional_to_brand" }],
  presences: [{ source: "matrix", outboundCount: 5 }],
};
const SAMPLE_THREAD = ok({
  items: [
    { kind: "message", direction: "outbound", source: "matrix", sentBy: "person", text: "hey Bob, quick one", at: "2026-11-01T10:00:00Z" },
    { kind: "message", direction: "outbound", source: "matrix", sentBy: "person", text: "call at 3?", at: "2026-11-02T10:00:00Z" },
  ],
  sources: [],
  factFeed: { settled: true },
});
const GENERATED = ok({ id: "g-1", decision: "write", bubbles: ["Hi Ann!", "Kevin here, founder of Acme."], message: "Hi Ann!\n\nKevin here, founder of Acme.\n\nSaw your Acme setup: booked meetings at $20/day.[[ASSISTANT]]Hi, Sophie here.\n\nTell me what you want first." });

/** The doors of one run, answered in order (a door asked twice answers its list in turn). */
function doors(over: Record<string, Answer | Answer[]> = {}): Record<string, Answer[]> {
  const base: Record<string, Answer | Answer[]> = {
    "lead.followup.claim": ok({ found: true, followup: { id: "row-1", leadId: "lead-1", email: "ann@co.test", phone: "+33612345678", brandId: "brand-1" } }),
    "crm.whatsapp.sent": ok({ sends: [] }),
    "crm.person.thread": [THREAD],
    "crm.team.membership": ok({ staff: false, ownTeam: false, matches: [] }),
    "crm.whatsapp.reach": REACH,
    "brand.profile": ok({ brand: { name: "Acme" } }),
    "brand.sales_rep": ok({ salesRepFirstName: "Kevin" }),
    "crm.people.list": ok({ people: [] }),
    "template.pick": ok({ templateDynastySlug: "founder-hello-whatsapp", template: { templateDynastySlug: "founder-hello-whatsapp" }, place: "writer" }),
    "content.template_head": ok({ template: { type: "founder-hello-whatsapp-v5" } }),
    "content.whatsapp.request": ok({ request: { systemPrompt: "SYSTEM", message: "CONTEXT", responseSchema: { type: "object" } } }),
    "content.whatsapp.generate": GENERATED,
    "crm.whatsapp.send": ok({ status: "sent" }),
    "lead.followup.record": ok({}),
    ...over,
  };
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
}
const COMPLETION = { id: "c", outcome: "llm_completion", subject: "lead-1", ageDays: 0, content: { answer: { json: { decision: "write", message: "x" }, content: "{}" }, llm: { provider: "deepseek", model: "deepseek-flash" } } };

/** A recorded case, as production keeps one: the stored code run once on these doors, every call and its answer kept. */
async function record(d: Record<string, Answer[]> = doors(), request: Record<string, unknown> = REQUEST): Promise<StoredFounderHelloCase> {
  const calls: StoredFounderHelloCase["calls"] = [];
  const used = new Map<string, number>();
  const bridge: Bridge = async (op, args) => {
    if (op === "vendor") {
      const name = String(args[0]);
      const list = d[name];
      if (!list) return { stop: `no door ${name}` };
      const n = used.get(name) ?? 0;
      used.set(name, n + 1);
      const answer = list[Math.min(n, list.length - 1)]!;
      calls.push({ name, args: JSON.parse(JSON.stringify(args[1] ?? null)), answer });
      return { v: answer };
    }
    if (op === "ask") return { v: null };
    if (op === "get") return { v: COMPLETION };
    return { v: null };
  };
  const spec = { subject: null, brand: "brand-1", day: 0, tactics: {}, request };
  const out = await runScript(STORED, spec, bridge);
  if (out.kind === "stopped") throw new Error(`the fixture case stopped: ${out.reason}`);
  return { units: {}, request, tactics: {}, subject: null, brand: "brand-1", day: 0, calls, asked: { llm_completion: COMPLETION } };
}
const compare = (c: StoredFounderHelloCase) => compareFounderHelloOnCase(STORED, HALVES, c, runScript as never, sameJson);
const names = (steps: Array<{ kind: string; name: string }>) => steps.map((s) => (s.kind === "ask" ? "ASK " : "") + s.name);

describe("splitFounderHello: the cut", () => {
  it("moves compose, the template writer, the completion and finalize to the writer; the sender calls no model", () => {
    for (const line of [FOUNDER_HELLO_ANCHORS.compose, FOUNDER_HELLO_ANCHORS.finalize]) {
      expect(HALVES.writer.split(line).length - 1, line).toBe(1);
      expect(HALVES.sender.includes(line), line).toBe(false);
    }
    expect(HALVES.sender).toContain('ctx.get("message_written")');
    expect(HALVES.sender).not.toContain('ctx.get("llm_completion")');
    expect(HALVES.sender).not.toContain("askedWriter(");
    expect(readMaterials(HALVES.sender)).toEqual(["message_written"]);
    expect(readMaterials(HALVES.writer).sort()).toEqual([FOUNDER_HELLO_REQUESTED, "llm_completion"].sort());
  });

  it("the writer sends to nobody and names no run; the sender is the only one that sends", () => {
    expect(writesToPerson(HALVES.writer)).toBe(false);
    expect(writesToPerson(HALVES.sender)).toBe(true);
    expect(HALVES.writer).not.toContain("crm.whatsapp.send");
    expect(HALVES.writer).not.toContain("ctx.request");
    expect(readVendors(HALVES.writer)).toEqual([]);
    expect(readVendors(HALVES.sender)).toEqual(["crm.person.thread", "crm.whatsapp.send"]);
  });

  it("both halves are valid script sources", async () => {
    await expect(validateSource(HALVES.writer)).resolves.toMatchObject({ materials: expect.arrayContaining([FOUNDER_HELLO_REQUESTED, "llm_completion"]) });
    await expect(validateSource(HALVES.sender)).resolves.toMatchObject({ materials: ["message_written"] });
  });

  it("refuses a moved anchor and an already split code", () => {
    expect(() => splitFounderHello(STORED.replace(FOUNDER_HELLO_ANCHORS.finalize, "  const final = finalize(composed, draft, person, campaignId, verdict, null, undefined);\n"))).toThrow(/anchor finalize/);
    expect(() => splitFounderHello(HALVES.sender)).toThrow();
  });

  it("states each half's tactics: the writer asks its model on the template, the sender asks its writer", () => {
    const t = founderHelloTactics({ asks: ["llm_completion"], template: "founder-hello-whatsapp", recorded_by: "crm" });
    expect(t.writer).toEqual({ asks: ["llm_completion"], template: "founder-hello-whatsapp", personFields: FOUNDER_HELLO_PERSON_FIELDS });
    expect(t.sender).toEqual({ recorded_by: "crm", asks: ["message_written"] });
    expect(asksCompletion({ tactics: t.writer })).toBe(true);
    expect(isPairWriter({ tactics: t.writer, code: HALVES.writer })).toBe(true);
    expect(asksCompletion({ tactics: t.sender })).toBe(false);
  });
});

describe("compareFounderHelloOnCase: the halves do what the stored code did", () => {
  it("a hello with the assistant line: the same reads, the same model request, the same two sends with the same keys", async () => {
    const r = await compare(await record());
    expect(r.diff).toBeNull();
    expect(names(r.split.steps)).toEqual([
      "lead.followup.claim", "crm.whatsapp.sent", "crm.person.thread", "crm.team.membership", "crm.whatsapp.reach", "brand.profile", "brand.sales_rep", "crm.people.list",
      "template.pick", "content.template_head", "content.whatsapp.request", "ASK llm_completion", "content.whatsapp.generate",
      "crm.whatsapp.send", "crm.whatsapp.send", "lead.followup.record",
    ]);
    const sends = r.split.steps.filter((s) => s.name === "crm.whatsapp.send").map((s) => (s.args as { body: Record<string, unknown> }).body);
    expect(sends.map((b) => [b.fromLine, b.idempotencyKey, b.email, b.phone])).toEqual([
      ["founder", "founder-hello:camp-1:lead-1", "ann@co.test", "+33612345678"],
      ["assistant", "founder-hello-assistant:camp-1:lead-1", "ann@co.test", "+33612345678"],
    ]);
    expect(r.ask).toMatchObject({ subject: { service: "lead-service", id: "lead-1" }, recordedBy: "content" });
    expect(r.written).toMatchObject({ written: true, text: expect.stringContaining("Kevin here"), assistantText: expect.stringContaining("Sophie here") });
    expect(r.split.end).toEqual(r.stored.end);
  });

  it("the writer's store names no run: the door fills completion.runId with the writer's own run", async () => {
    const r = await compare(await record());
    const gen = r.split.steps.find((s) => s.name === "content.whatsapp.generate")!.args as { body: { completion: Record<string, unknown> } };
    expect(gen.body.completion.runId).toBeUndefined();
    expect(Object.keys(gen.body.completion).sort()).toEqual(["answer", "request"]);
  });

  it("voice samples: the same thread and team reads, the same context handed to the template", async () => {
    const r = await compare(await record(doors({ "crm.people.list": ok({ people: [SAMPLE] }), "crm.person.thread": [THREAD, SAMPLE_THREAD] })));
    expect(r.diff).toBeNull();
    expect(r.split.steps.filter((s) => s.name === "crm.person.thread")).toHaveLength(2);
    expect(JSON.stringify(r.split.steps.find((s) => s.name === "content.whatsapp.request")!.args)).toContain("hey Bob, quick one");
  });

  it("no assistant line: one send, the same", async () => {
    const { assistantLine: _a, ...noLine } = REACH.data;
    const r = await compare(await record(doors({ "crm.whatsapp.reach": ok(noLine) })));
    expect(r.diff).toBeNull();
    expect(r.split.steps.filter((s) => s.name === "crm.whatsapp.send")).toHaveLength(1);
  });

  it("already greeted, unreachable, a refused hello, nobody named: no writer asked where no model was, the same end", async () => {
    const greeted = await compare(await record(doors({ "crm.whatsapp.sent": ok({ sends: [{ campaignId: "camp-1", status: "sent", sentAt: "2026-11-18T10:00:00Z" }] }) })));
    expect(greeted.diff).toBeNull();
    expect(greeted.handed).toBeNull();
    const unreachable = await compare(await record(doors({ "crm.whatsapp.reach": ok({ reachable: false, code: "not_on_whatsapp", error: "Not on WhatsApp." }) })));
    expect(unreachable.diff).toBeNull();
    expect(unreachable.handed).toBeNull();
    const refusedHello = await compare(await record(doors({ "crm.whatsapp.send": refused(409, "person_replied") })));
    expect(refusedHello.diff).toBeNull();
    expect(refusedHello.handed).not.toBeNull();
    expect(refusedHello.split.steps.filter((s) => s.name === "crm.whatsapp.send")).toHaveLength(1);
    const nobody = await compare(await record(doors(), { ...REQUEST, trigger: { eventId: "ev-2" } }));
    expect(nobody.diff).toBeNull();
    expect(nobody.split.steps).toEqual([]);
  });

  it("no onboarding record, or a writer answer that is not a hello: the writer fails as the stored code did, nothing sent", async () => {
    const noRecord = await compare(await record(doors({ "crm.person.thread": [ok({ items: [], sources: [], factFeed: { settled: true } })] })));
    expect(noRecord.diff).toBeNull();
    expect(noRecord.stored.end).toMatchObject({ kind: "error", message: expect.stringContaining("no onboarding record") });
    const later = await compare(await record(doors({ "content.whatsapp.generate": ok({ decision: "later", message: "" }) })));
    expect(later.diff).toBeNull();
    expect(later.split.steps.some((s) => s.name === "crm.whatsapp.send")).toBe(false);
  });
});

describe("senderReplayCase: the sender's own recorded case, restated for its upgrade", () => {
  it("replays the sender alone on the record minus the writer's doors, the writer's Unit as its material", async () => {
    const c = await record();
    const r = await compare(c);
    const restated = senderReplayCase("case-1", c, r) as unknown as ReplayCase;
    expect(restated.calls.map((x) => x.name)).not.toContain("content.whatsapp.generate");
    const replayed = await replayCase(HALVES.sender, restated);
    expect(replayed.diffs).toEqual([]);
    // The same case is not the stored code's any more (it reads no message_written): the restatement is the sender's.
    expect((await replayCase(STORED, restated)).match).toBe(false);
  });

  it("a recorded replay case that never reaches the writer stands as it is for the sender", async () => {
    const c = await record(doors({ "crm.whatsapp.sent": ok({ sends: [{ campaignId: "camp-1", status: "sent" }] }) }));
    const asReplay: ReplayCase = { id: "r-1", units: {}, request: REQUEST, calls: c.calls.map((x) => ({ name: x.name, args: x.args as Record<string, unknown>, answer: x.answer })), expect: { fails: "person_not_admitted: already_greeted" } };
    expect((await replayCase(STORED, asReplay)).diffs).toEqual([]);
    expect((await replayCase(HALVES.sender, asReplay)).diffs).toEqual([]);
    expect((await compare(storedCaseOfReplay(asReplay))).diff).toBeNull();
  });
});

describe("content.whatsapp.generate: the run a handed-back completion is declared on", () => {
  it("is filled with the script's run; a stated run must be that run", async () => {
    const seen: unknown[] = [];
    const deps = {
      async serviceDoor(_s: string, _m: string, _p: string, body: unknown) {
        seen.push(body);
        return { status: 200, body: { id: "g" } };
      },
    } as unknown as VendorDeps;
    const ctx = { headers: { "x-org-id": "org-1", "x-run-id": "writer-run" }, tactics: {} };
    const completion = { request: { message: "m" }, answer: { json: {} } };
    expect((await callVendor("content.whatsapp.generate", { body: { type: "t", completion } }, ctx, deps)).ok).toBe(true);
    expect((await callVendor("content.whatsapp.generate", { body: { type: "t", completion: { ...completion, runId: "writer-run" } } }, ctx, deps)).ok).toBe(true);
    expect(seen).toEqual([
      { type: "t", completion: { ...completion, runId: "writer-run" } },
      { type: "t", completion: { ...completion, runId: "writer-run" } },
    ]);
    expect((await callVendor("content.whatsapp.generate", { body: { type: "t", completion: { ...completion, runId: "another-run" } } }, ctx, deps)).ok).toBe(false);
    // No completion handed back: nothing to fill.
    expect((await callVendor("content.whatsapp.generate", { body: { type: "t" } }, ctx, deps)).ok).toBe(true);
    expect(seen[2]).toEqual({ type: "t" });
  });
});
