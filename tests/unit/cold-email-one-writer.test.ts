import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { runStoredScript, type LedgerDeps } from "../../src/lib/scripts/script-runner.js";
import type { VendorDeps } from "../../src/lib/scripts/vendors.js";
import { setScriptPickReader, setScriptStrategyReader } from "../../src/lib/scripts/engine.js";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { scripts } from "../../src/db/schema.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { testNamer } from "../helpers/script-names.js";
import { buildCompletionSource, COMPLETION_LLMS, completionDynasty, completionTactics } from "../../scripts/engine-ports/llm-completion.js";
import {
  buildSenderSource,
  buildWriterSource,
  GENERATION_REQUEST,
  mergePlaces,
  senderTactics,
  WAYS_OF_WRITING,
  writerTactics,
} from "../../scripts/engine-ports/cold-email-one-writer.js";

// ONE-WRITER-N-MODELS-1116: the cold email built from the STORED code (fixtures = production's active versions on
// 2026-11-16): the sender asks a way of writing, the writer asks a completion, nobody names a model.
const FIX = join(__dirname, "../fixtures/stored-scripts");
const STORED_WRITER = readFileSync(join(FIX, "message_written__dy_template_writer_full.v4.ts.txt"), "utf8");
const STORED_SENDER = readFileSync(join(FIX, "email_sent__dy_cold_email_signed_sender_client_brand.v7.ts.txt"), "utf8");
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
let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
  // The campaign's strategy keeps every script of the Engine (features-service's answer with no strategy).
  setScriptStrategyReader(async (_c, outcome) => (await db.select().from(scripts).where(eq(scripts.outcome, outcome))).map((r) => r.dynasty));
}, 60_000);
async function add(outcome: string, dynasty: string, code: string, tactics: Record<string, unknown>) {
  const row = await createScript(db, { outcome, dynasty, code, description: "x" }, author, known);
  await db.update(scripts).set({ tactics }).where(eq(scripts.id, row.id));
}

const SENDER_TACTICS = senderTactics({
  llm: { provider: "zai", model: "glm-flash" },
  template: "cold-reply-three-line-reply-named",
  asks: ["message_written"],
  intro: "none",
  pitches: "offer",
  signedBy: "client_person_with_client_brand",
  recorded_by: "instantly",
  brandFields: [{ key: "companyOverview", description: "x" }],
});

function world() {
  const doors: Array<{ path: string; body: any }> = [];
  const completions: Array<Record<string, unknown>> = [];
  const runs: Array<{ id: string; taskName: string; parentRunId: string }> = [];
  const declared: Array<{ runId: string; body: any }> = [];
  const ledger: LedgerDeps = {
    async createRun(o) {
      runs.push({ id: `run-${runs.length + 1}`, taskName: o.taskName, parentRunId: o.parentRunId });
      return `run-${runs.length}`;
    },
    async declareOutcomes(runId, _o, body) {
      declared.push({ runId, body });
      return {};
    },
    async closeRun() {},
  };
  const complete = async (body: Record<string, unknown>) => {
    completions.push(body);
    if (String(body.systemPrompt).startsWith("You write the signature block")) return { content: "{}", json: { signature: "Jane Doe\nReed" }, model: `${String(body.model)}-v1` };
    return { content: "{}", json: { subject: "Quick one", emails: [{ body: "Hi Ana, a line." }] }, model: `${String(body.model)}-v1` };
  };
  const vendors = {
    complete,
    platformComplete: complete,
    judge: async () => ({}),
    platformJudge: async () => ({}),
    readSkill: async () => ({ content: "OUR VOICE", version: 1 }),
    serviceDoor: async (_s: string, _m: string, path: string, body: any) => {
      doors.push({ path, body });
      if (path.startsWith("/orgs/buffer/next")) return { status: 200, body: { found: true, lead: { leadId: "lead-9", email: "a@staff.test", brandIds: ["brand-1"], data: { firstName: "Ana", organization: { name: "Acme" } } } } };
      if (path.startsWith("/orgs/people/timeline")) return { status: 200, body: { items: [], sources: [] } };
      if (path.startsWith("/internal/brands/")) return { status: 200, body: { brand: { name: "Reed" } } };
      if (path.startsWith("/orgs/brands/extract-fields")) return { status: 200, body: { fields: { companyOverview: { value: "We sell" } } } };
      if (path.startsWith("/internal/template-dynasties/")) return { status: 200, body: { template: { type: `${path.split("/")[3]}-v9` } } };
      if (path === "/generate/materials")
        return {
          status: 200,
          body: {
            existing: null,
            subject: { service: "lead-service", id: "lead-9" },
            units: { lead_identified: { content: { variables: { leadFirstName: "Ana" } } }, brand_context: { content: { variables: { clientName: "Reed" } } }, template_written: { content: { text: "Write to {{leadFirstName}} for {{clientName}}" } } },
            tactics: { llm: { provider: "google", model: "pro" } },
          },
        };
      if (path === "/generate") return { status: 200, body: { id: "gen-1", subject: "Quick one", sequence: [{ step: 1, bodyHtml: "<p>Hi</p>" }] } };
      if (path.startsWith("/orgs/send")) return { status: 200, body: { success: true } };
      return { status: 404, body: { error: `unexpected ${path}` } };
    },
  } as unknown as VendorDeps;
  return { ledger, vendors, doors, completions, runs, declared };
}

const who = { orgId: "org-1", userId: "user-1", parentRunId: "caller", headers: { "x-brand-id": "brand-1", "x-campaign-id": "camp-1" } };
const request = { now: "2026-11-16T18:00:00Z", brandIds: ["brand-1"], campaignId: "camp-1", offerId: "offer-1", brief: "Book dentists" };

describe("the cold email, one writer per way of writing", () => {
  it("builds from the stored code: the sender names no template and no model, the writer names no model", async () => {
    const writer = buildWriterSource(STORED_WRITER);
    const sender = buildSenderSource(STORED_SENDER);
    expect(sender).not.toMatch(/llm\.pick|template\.pick|"llm\.complete"|pickLlm|writerPlan/);
    expect(writer).not.toMatch(/llm\.pick|"llm\.complete"|tactics\.llm/);
    // What each reads: the writer its request and the completion it asks; the sender what it asks.
    expect((await validateSource(writer)).materials.sort()).toEqual([GENERATION_REQUEST, "llm_completion"]);
    expect((await validateSource(sender)).materials.sort()).toEqual(["llm_completion", "message_written"]);
    // Nothing that writes also sends: the writer calls no sending door.
    expect(writer).not.toMatch(/"email\.send"|"instantly\.reply\.send"|"crm\.whatsapp\.send"/);
  });

  it("serve -> the Rating picks a way of writing for the sender -> its writer asks a model -> content-generation stores -> sent", async () => {
    const pick = fakeScriptPick({ dy_free_offer: 2, dy_gemini_flash: 3 });
    setScriptPickReader(pick);
    await add("email_sent", "dy_cold_email_signed_client_person", buildSenderSource(STORED_SENDER), SENDER_TACTICS);
    for (const way of WAYS_OF_WRITING) await add("message_written", way.dynasty, buildWriterSource(STORED_WRITER), writerTactics(way));
    for (const l of COMPLETION_LLMS.filter((x) => ["gemini-flash", "claude-haiku"].includes(x.model))) await add("llm_completion", completionDynasty(l), buildCompletionSource(), completionTactics(l));
    const w = world();
    const out = await runStoredScript(db, { outcome: "email_sent", dynasty: "dy_cold_email_signed_client_person", units: {}, request, recordedBy: "instantly" }, who, w);
    expect(out.error).toBeNull();
    expect(out.status).toBe("made");
    // The Rating was asked for a writer by the sender, and for a model by the writer (and by the sender, for the signature).
    expect(pick.calls.find((c) => c.outcome === "message_written")!.askedBy).toBe("email_sent/dy_cold_email_signed_client_person");
    expect(pick.calls.filter((c) => c.outcome === "llm_completion").map((c) => c.askedBy).sort()).toEqual(["email_sent/dy_cold_email_signed_client_person", "message_written/dy_free_offer"]);
    // The writer asked for ITS template's materials; content-generation got the writer's whole run, its trace holding ONE completion.
    const materials = w.doors.find((d) => d.path === "/generate/materials")!;
    expect(materials.body.type).toBe("cold-reply-free-offer-named-v9");
    expect(materials.body).not.toHaveProperty("model");
    const generate = w.doors.find((d) => d.path === "/generate")!;
    expect(generate.body.type).toBe("cold-reply-free-offer-named-v9");
    const traced = (generate.body.written.trace as Array<{ name: string; sent?: any; raw?: any }>).filter((t) => t.name === "llm.complete");
    expect(traced).toHaveLength(1);
    expect(traced[0]!.sent).toMatchObject({ provider: "google", model: "gemini-flash" });
    expect(traced[0]!.raw).toMatchObject({ model: "gemini-flash-v1" });
    expect(generate.body.written.unit.content).toMatchObject({ subject: "Quick one" });
    expect(generate.body.units.template_written.content.text).toContain("{{leadFirstName}}");
    // The signature was written by the picked model too, then the email sent with it.
    const send = w.doors.find((d) => d.path.startsWith("/orgs/send"))!;
    expect(send.body.signature).toEqual({ text: "Jane Doe\nReed" });
    // Credit chain: the writer consumed its completion, the sender the written message and its signature completion.
    const writerRun = w.runs.find((r) => r.taskName === "script:message_written/dy_free_offer")!;
    expect(w.declared.find((d) => d.runId === writerRun.id)!.body.consumed).toEqual([{ outcomeKey: "llm_completion", subjectService: "lead-service", subjectId: "lead-9" }]);
    expect(w.declared.find((d) => d.runId === out.runId)!.body.consumed).toEqual([
      { outcomeKey: "llm_completion", subjectService: "lead-service", subjectId: "lead-9" },
      { outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-9" },
    ]);
  });

  it("an email content-generation already wrote for this person is answered from its store, nothing written again", async () => {
    setScriptPickReader(fakeScriptPick());
    await add("email_sent", "dy_cold_email", buildSenderSource(STORED_SENDER), senderTactics({ recorded_by: "instantly" }));
    await add("message_written", "dy_three_line_reply", buildWriterSource(STORED_WRITER), writerTactics(WAYS_OF_WRITING[1]!));
    const w = world();
    const door = w.vendors.serviceDoor;
    w.vendors.serviceDoor = async (s, m, path, body, h) => (path === "/generate/materials" ? { status: 200, body: { existing: { id: "gen-0" }, subject: null, units: null, tactics: null } } : door(s, m, path, body, h));
    const out = await runStoredScript(db, { outcome: "email_sent", dynasty: "dy_cold_email", units: {}, request, recordedBy: "instantly" }, who, w);
    expect(out.status).toBe("made");
    expect(w.completions).toHaveLength(0);
    expect(w.doors.find((d) => d.path === "/generate")!.body.written).toEqual({ existing: { id: "gen-0" }, subject: null, units: null, tactics: null });
  });

  it("a per-model copy counts at its sender, its way of writing and its model", () => {
    expect(mergePlaces({ dynasty: "dy_cold_email_signed_sender_client_brand__claude_haiku__cresn", template: "cold-reply-eight-second-named", model: "claude-haiku" })).toEqual([
      { survivor: "email_sent/dy_cold_email_signed_sender_client_brand", askedBy: null },
      { survivor: "message_written/dy_eight_second_pitch", askedBy: "email_sent/dy_cold_email_signed_sender_client_brand" },
      { survivor: "llm_completion/dy_claude_haiku", askedBy: "message_written/dy_eight_second_pitch" },
    ]);
  });
});
