import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { runStoredScript, type LedgerDeps, type OccurrenceInput } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { setScriptPickReader, setScriptStrategyReader } from "../../src/lib/scripts/engine.js";
import { setProofContext } from "../../src/lib/scripts/writer-proof.js";
import { scripts } from "../../src/db/schema.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { testNamer } from "../helpers/script-names.js";
import { PORT_HEAD } from "../../scripts/engine-ports/port-kit.js";
import { COMPLETION_HELPERS } from "../../scripts/engine-ports/ask-completion.js";
import { HUMAN_VALIDATION_FNS, VALIDATION_RECHECK_MINUTES } from "../../scripts/engine-ports/human-validated.js";

// HUMAN-VALIDATED-1124: a script whose tactic is `validation: human` makes its Unit only after the brand's person said
// yes on WhatsApp; a change they ask re-asks the Engine before it with their words. Fictional data only.
const MIGRATIONS = join(__dirname, "../../drizzle");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true, nameDynasties: testNamer() };
const who = { orgId: "org-1", userId: "user-1", parentRunId: "run-parent", headers: { "x-brand-id": "brand-1", "x-campaign-id": "camp-1" } };
const PHONE = "+15550100";

/** A script of `thing_published`: asks `thing_made`, has it validated, then "publishes" it. */
const PUBLISHER = `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";
${PORT_HEAD}
export default function run(ctx: ScriptContext): ScriptResult {
  const r: any = ctx.request ?? {};
  const v: any = validated(
    ctx,
    (feedback: any) => {
      const u: any = ctx.ask("thing_made", { request: { now: r.now, ...(feedback ? { feedback: feedback.words, about: feedback.about } : {}) } });
      if (!u.content) return { unmade: u.unmade };
      return { proposal: { thing: u.content, subject: u.run.unit.subject } };
    },
    (p: any) => ({ what: "a thing", facts: ["Thing " + p.thing.n], links: ["https://example.com/thing/" + p.thing.n], then: "it is published", own: "the publication", source: "the thing itself" }),
  );
  if (!v || !v.proposal) return v;
  ctx.consume("thing_made", v.proposal.subject);
  settle(ctx, v);
  return { content: { published: v.proposal.thing.n }, subject: { service: "runs-service", id: "pub-" + v.proposal.thing.n } };
}
${COMPLETION_HELPERS}
${HUMAN_VALIDATION_FNS}
`;
/** `thing_made`: a new numbered thing each ask (its count kept in its Engine's storage), echoing the feedback it got. */
const MAKER = `export default function run(ctx) {
  const n = (ctx.storage.get("count", "n") ?? 0) + 1;
  ctx.storage.set("count", "n", n);
  const r = ctx.request ?? {};
  return { content: { n, feedback: r.feedback ?? null, about: r.about ?? null }, subject: { service: "runs-service", id: "thing-" + n } };
}`;
const COMPLETION = `export default function run(ctx) {
  const r = ctx.request ?? {};
  return { content: { answer: { json: { bubbles: ["Thing ready \\u2014 look", String(r.message).split("LINKS (give each exactly):\\n- ")[1].split("\\n")[0], "Ok?"] } }, llm: { provider: "fake", model: "fake" } } };
}`;

interface World {
  thread: Array<{ kind: string; source: string; direction: string; text: string; at: string }>;
  sends: Array<Record<string, unknown>>;
  judged: Array<{ state: string; instructions: string }>;
  verdicts: string[];
  repPhone: string | null;
  doors: string[];
  /** When crm-service says a send left (the run's minute, 40 s in). */
  clock: string;
}

function vendors(w: World): VendorDeps {
  return {
    async readSkill() {
      return { content: "Short, plain words.", version: 1 };
    },
    async serviceDoor(service, method, path, body, headers) {
      w.doors.push(`${service} ${method} ${path.split("?")[0]}`);
      if (service === "brand" && path.endsWith("/sales-rep")) return { status: 200, body: { salesRepPhone: w.repPhone, salesRepFirstName: "Ada", salesRepEmail: null, salesRepRole: null } };
      if (service === "crm" && method === "GET" && path.startsWith("/orgs/people/timeline")) {
        if (w.thread.length === 0) return { status: 404, body: { error: "person_not_found" } };
        return { status: 200, body: { sources: [{ source: "matrix", status: "ok" }], items: w.thread } };
      }
      if (service === "crm" && method === "POST" && path === "/orgs/whatsapp/messages") {
        w.sends.push({ ...(body ?? {}), campaignHeader: headers["x-campaign-id"] ?? null });
        const at = w.clock;
        for (const text of ((body as { messages?: string[] }).messages ?? [(body as { text: string }).text])) w.thread.push({ kind: "message", source: "matrix", direction: "outbound", text, at });
        return { status: 200, body: { sendId: "s", status: "sent", sentAt: at } };
      }
      if (service === "chat" && path === "/orgs/judgments") {
        const b = body as { state: string; questions: { q: { instructions: string } } };
        w.judged.push({ state: b.state, instructions: b.questions.q.instructions });
        const choice = w.verdicts.shift();
        if (!choice) throw new Error("no verdict scripted");
        return { status: 200, body: { answers: { q: { type: "choice", choice, confidence: 0.9, probabilities: {} } } } };
      }
      throw new Error(`unexpected door ${service} ${method} ${path}`);
    },
  } as unknown as VendorDeps;
}

function ledger() {
  const declared: Array<{ runId: string; produced: OccurrenceInput[]; consumed: OccurrenceInput[] }> = [];
  let n = 0;
  const l: LedgerDeps = {
    async createRun() {
      return `run-${++n}`;
    },
    async declareOutcomes(runId, _org, body) {
      declared.push({ runId, ...body });
      return {};
    },
    async closeRun() {},
  };
  return { l, declared };
}

let db: AnyPgDb;
let w: World;
beforeEach(async () => {
  db = await freshDb();
  w = { thread: [], sends: [], judged: [], verdicts: [], repPhone: PHONE, doors: [], clock: "" };
  setScriptPickReader(fakeScriptPick());
  setScriptStrategyReader(async (_c, outcome) => (await db.select().from(scripts).where(eq(scripts.outcome, outcome))).map((r) => r.dynasty));
  setProofContext(null);
  await createScript(db, { outcome: "thing_made", dynasty: "dy_maker", code: MAKER, description: "x" }, author, known);
  await createScript(db, { outcome: "llm_completion", dynasty: "dy_fake", code: COMPLETION, description: "x" }, author, known);
}, 300_000);
afterEach(() => {
  setScriptPickReader(null);
  setScriptStrategyReader(null);
});

let tick = 0;
async function runPublisher(dynasty: string, minute: number) {
  const waits: number[] = [];
  const { l, declared } = ledger();
  w.clock = `2026-01-01T10:${String(minute).padStart(2, "0")}:40.000Z`;
  const result = await runStoredScript(
    db,
    { outcome: "thing_published", dynasty, units: {}, request: { now: `2026-01-01T10:${String(minute).padStart(2, "0")}:30.000Z`, campaignId: "camp-1", brandIds: ["brand-1"], brief: "I validate every thing." } },
    who,
    { ledger: l, vendors: vendors(w) },
    { runId: `run-engine-${++tick}`, onWait: async (d) => void waits.push(d) },
  );
  return { result, waits, declared };
}
const theySay = (text: string, minute: number) => w.thread.push({ kind: "message", source: "matrix", direction: "inbound", text, at: `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z` });

describe("a script validated by a human", () => {
  beforeEach(async () => {
    await createScript(db, { outcome: "thing_published", dynasty: "dy_validated", code: PUBLISHER, description: "x", tactics: { validation: "human" } }, author, known);
    await createScript(db, { outcome: "thing_published", dynasty: "dy_auto", code: PUBLISHER, description: "x", tactics: {} }, author, known);
  });

  it("the same code without the tactic makes its Unit at once: nobody is asked", async () => {
    const { result, waits } = await runPublisher("dy_auto", 0);
    expect(result.status).toBe("made");
    expect(result.unit?.content).toEqual({ published: 1 });
    expect(waits).toEqual([]);
    expect(w.sends).toEqual([]);
    expect(w.doors).toEqual([]);
  });

  it("sends the proposal on WhatsApp and waits; an ok turns it into the Unit, consuming what it was built from", async () => {
    const first = await runPublisher("dy_validated", 0);
    expect(first.result.status).toBe("waiting");
    expect(first.waits).toEqual([VALIDATION_RECHECK_MINUTES / 1440]);
    expect(w.sends).toHaveLength(1);
    // To the brand's rep, from the assistant line, not as the campaign, the link as given, no dash.
    expect(w.sends[0]).toMatchObject({ brandId: "brand-1", phone: PHONE, fromLine: "assistant", campaignHeader: null, messages: ["Thing ready, look", "https://example.com/thing/1", "Ok?"] });
    // Nothing published yet: the asked thing was made, the publication was not.
    expect(first.declared.flatMap((d) => d.produced.map((p) => p.outcomeKey)).sort()).toEqual(["llm_completion", "thing_made"]);

    // No answer yet: it waits again, asks nobody, makes nothing new.
    const second = await runPublisher("dy_validated", 6);
    expect(second.result.status).toBe("waiting");
    expect(w.sends).toHaveLength(1);
    expect(w.judged).toEqual([]);

    theySay("ok top", 9);
    w.verdicts.push("approved");
    const third = await runPublisher("dy_validated", 11);
    expect(third.result.status).toBe("made");
    expect(third.result.unit?.content).toEqual({ published: 1 });
    expect(w.judged).toHaveLength(1);
    expect(w.judged[0]!.state).toContain("THEM [2026-01-01T10:09:00.000Z]: ok top");
    expect(third.result.declared.consumed).toContainEqual({ outcomeKey: "thing_made", subjectService: "runs-service", subjectId: "thing-1" });
    expect(third.result.declared.produced).toEqual([{ outcomeKey: "thing_published", subjectService: "runs-service", subjectId: "pub-1" }]);
    expect(w.sends).toHaveLength(1);

    // Settled: the next run proposes a NEW thing.
    const fourth = await runPublisher("dy_validated", 16);
    expect(fourth.result.status).toBe("waiting");
    expect(w.sends).toHaveLength(2);
    expect((w.sends[1] as { messages: string[] }).messages[1]).toBe("https://example.com/thing/2");
  });

  it("a change they ask re-asks the Engine before it with their words, and sends the new version", async () => {
    await runPublisher("dy_validated", 0);
    theySay("change the thing please, too long", 3);
    w.verdicts.push("change", "source");
    const second = await runPublisher("dy_validated", 6);
    expect(second.result.status).toBe("waiting");
    expect(w.judged).toHaveLength(2);
    expect(w.sends).toHaveLength(2);
    expect((w.sends[1] as { messages: string[] }).messages[1]).toBe("https://example.com/thing/2");
    // The second thing was made WITH their words.
    theySay("yes", 8);
    w.verdicts.push("approved");
    const third = await runPublisher("dy_validated", 11);
    expect(third.result.status).toBe("made");
    expect(third.result.unit?.content).toEqual({ published: 2 });
    const [maker] = await db.select().from(scripts).where(eq(scripts.dynasty, "dy_maker"));
    expect(maker).toBeTruthy();
    // Only the messages after the SECOND proposal were judged for it.
    expect(w.judged[2]!.state).not.toContain("too long");
  });

  it("a message that is neither a yes nor a change keeps it waiting, and is not judged twice", async () => {
    await runPublisher("dy_validated", 0);
    theySay("which thing is that?", 3);
    w.verdicts.push("other");
    const second = await runPublisher("dy_validated", 6);
    expect(second.result.status).toBe("waiting");
    const third = await runPublisher("dy_validated", 12);
    expect(third.result.status).toBe("waiting");
    expect(w.judged).toHaveLength(1);
    expect(w.sends).toHaveLength(1);
  });

  it("a brand with no sales rep phone makes nothing and says why", async () => {
    w.repPhone = null;
    const { result, waits } = await runPublisher("dy_validated", 0);
    expect(result.status).toBe("unmade");
    expect(result.error).toContain("no_validator");
    expect(waits).toEqual([]);
    expect(w.sends).toEqual([]);
  });

  it("a send crm-service refuses is the script's answer, nothing kept", async () => {
    const v = vendors(w);
    const door = v.serviceDoor;
    v.serviceDoor = async (service, method, path, body, headers) =>
      service === "crm" && method === "POST" ? { status: 422, body: { type: "refused", code: "whatsapp_not_linked", error: "no linked account" } } : door(service, method, path, body, headers);
    const { l } = ledger();
    const result = await runStoredScript(
      db,
      { outcome: "thing_published", dynasty: "dy_validated", units: {}, request: { now: "2026-01-01T10:00:30.000Z", campaignId: "camp-1", brandIds: ["brand-1"] } },
      who,
      { ledger: l, vendors: v },
      { runId: "run-engine-x", onWait: async () => {} },
    );
    expect(result.status).toBe("unmade");
    expect(result.error).toBe("whatsapp_not_linked: no linked account");
  });
});
