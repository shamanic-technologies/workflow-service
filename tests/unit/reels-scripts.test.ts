import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { runStoredScript, type LedgerDeps, type OccurrenceInput, type ScriptRunResult } from "../../src/lib/scripts/script-runner.js";
import { SERVICE_DOOR_VENDORS, type VendorDeps } from "../../src/lib/scripts/vendors.js";
import { setScriptPickReader, setScriptStrategyReader } from "../../src/lib/scripts/engine.js";
import { setProofContext } from "../../src/lib/scripts/writer-proof.js";
import { scripts } from "../../src/db/schema.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { testNamer } from "../helpers/script-names.js";
import { engineScripts, HOOK_ADDED, INSTAGRAM_REEL_PUBLISHED, VIDEO_TRANSCRIBED } from "../../scripts/engine-ports/reels.js";
import { scriptNameProblem } from "../../src/lib/scripts/script-names.js";

// REELS-1124: the Reels Engines' scripts against fakes of their producers' contracts. Fictional data only.
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

/** A completion script that answers what the test scripted for the prompt it gets. */
const COMPLETION = `export default function run(ctx) {
  const r = ctx.request ?? {};
  const sys = String(r.systemPrompt);
  const json = sys.indexOf("download link") >= 0 ? { urls: ["https://media.example.com/talk.mp4", "not a link"] } : sys.indexOf("caption") >= 0 ? { caption: "The idea \\u2014 in one line #talk" } : { bubbles: ["Look", "Ok?"] };
  return { content: { answer: { json }, llm: { provider: "fake", model: "fake" } } };
}`;

interface World {
  calls: Array<{ door: string; body: Record<string, unknown> | null }>;
  job: { status: string; fraction?: number } | null;
  accounts: Array<Record<string, unknown>>;
  publish: { status: number; body: Record<string, unknown> };
}
function vendors(w: World): VendorDeps {
  return {
    async readSkill() {
      return { content: "Short, plain words.", version: 1 };
    },
    async serviceDoor(service, method, path, body) {
      const door = `${service} ${method} ${path.split("?")[0]}`;
      w.calls.push({ door, body });
      if (door === "chat POST /orgs/media-transcriptions") return { status: 202, body: { id: "tr-1", status: "downloading" } };
      if (door === "chat GET /orgs/media-transcriptions/tr-1") return { status: 200, body: { id: "tr-1", status: w.job!.status, language: "en", durationSeconds: 3600, segmentCount: 400, wordCount: 9000, progress: { fraction: w.job!.fraction ?? 0 } } };
      if (door === "social GET /orgs/social/accounts") return { status: 200, body: { accounts: w.accounts } };
      if (door === "social POST /orgs/social/accounts/acc-1/posts") return w.publish;
      throw new Error(`unexpected door ${door}`);
    },
  } as unknown as VendorDeps;
}
function ledger() {
  const declared: Array<{ produced: OccurrenceInput[]; consumed: OccurrenceInput[] }> = [];
  let n = 0;
  const l: LedgerDeps = {
    async createRun() {
      return `run-${++n}`;
    },
    async declareOutcomes(_r, _o, body) {
      declared.push(body);
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
  w = { calls: [], job: { status: "transcribing", fraction: 0.4 }, accounts: [], publish: { status: 200, body: { publication: { id: "pub-1", permalink: "https://instagram.example/p/1", status: "published" }, created: true } } };
  setScriptPickReader(fakeScriptPick());
  setScriptStrategyReader(async (_c, outcome) => (await db.select().from(scripts).where(eq(scripts.outcome, outcome))).map((r) => r.dynasty));
  setProofContext(null);
  await createScript(db, { outcome: "llm_completion", dynasty: "dy_fake", code: COMPLETION, description: "x" }, author, known);
  for (const s of engineScripts()) await createScript(db, { outcome: s.outcome, dynasty: s.dynasty, code: s.code, description: s.description, tactics: s.tactics, name: s.name }, author, known);
}, 60_000);
afterEach(() => {
  setScriptPickReader(null);
  setScriptStrategyReader(null);
});

async function run(outcome: string, dynasty: string, request: Record<string, unknown>, recordedBy?: string): Promise<{ result: ScriptRunResult; declared: ReturnType<typeof ledger>["declared"] }> {
  const { l, declared } = ledger();
  const result = await runStoredScript(
    db,
    { outcome, dynasty, units: {}, request: { now: "2026-01-01T10:00:00.000Z", campaignId: "camp-1", brandIds: ["brand-1"], ...request }, ...(recordedBy ? { recordedBy } : {}) },
    who,
    { ledger: l, vendors: vendors(w) },
    { runId: "run-engine", onWait: async () => {} },
  );
  return { result, declared };
}
const BRIEF = "Turn this morning's interview into Reels: https://media.example.com/talk.mp4";

describe("the Reels scripts as stored", () => {
  it("every script has a client-readable name, no dash in what a person reads, and calls only doors that exist", () => {
    for (const s of engineScripts()) {
      expect(scriptNameProblem(s.name), s.dynasty).toBeNull();
      expect(/[\u2013\u2014]/.test(s.description + s.code.replace(/\\u201[34]/g, "")), s.dynasty).toBe(false);
      for (const m of s.code.matchAll(/ctx\.vendor\.call\("([a-z_.]+)"|must\(ctx, "([a-z_.]+)"/g)) {
        const name = (m[1] ?? m[2])!;
        if (name === "voice.read") continue;
        expect(Object.keys(SERVICE_DOOR_VENDORS), `${s.dynasty} calls ${name}`).toContain(name);
      }
    }
    // An automatic script and its human-validated fork are ONE code, told apart by the tactic alone.
    const posts = engineScripts().filter((s) => s.outcome === INSTAGRAM_REEL_PUBLISHED);
    expect(posts.map((p) => p.tactics.validation)).toEqual([undefined, "human"]);
    expect(posts[0]!.code).toBe(posts[1]!.code);
  });
});

describe("Video transcribed", () => {
  it("starts the brief's video once, ends idle while it is transcribed, then makes the transcript Unit", async () => {
    const first = await run(VIDEO_TRANSCRIBED, "dy_box_transcript", { brief: BRIEF });
    expect(first.result.status).toBe("unmade");
    expect(first.result.decided).toBe("idle");
    expect(first.result.error).toContain("transcribing: https://media.example.com/talk.mp4 is being transcribed (40 %)");
    const started = w.calls.filter((c) => c.door === "chat POST /orgs/media-transcriptions");
    expect(started).toHaveLength(1);
    expect(started[0]!.body).toMatchObject({ url: "https://media.example.com/talk.mp4" });
    expect(String(started[0]!.body!.idempotencyKey)).toMatch(/^video:camp-1:[a-z0-9]+:1$/);

    // The next look reads the same job: no second start, the brief not read by a model again.
    w.job = { status: "completed" };
    const second = await run(VIDEO_TRANSCRIBED, "dy_box_transcript", { brief: BRIEF });
    expect(w.calls.filter((c) => c.door === "chat POST /orgs/media-transcriptions")).toHaveLength(1);
    expect(second.result.status).toBe("made");
    expect(second.result.unit?.subject).toEqual({ service: "chat-service", id: "tr-1" });
    expect(second.result.unit?.content).toMatchObject({ transcriptId: "tr-1", videoUrl: "https://media.example.com/talk.mp4", durationSeconds: 3600 });
    expect(second.declared.flatMap((d) => d.produced.map((p) => p.outcomeKey))).toEqual([VIDEO_TRANSCRIBED]);

    // Every video of the brief is transcribed: nothing left, said as idle.
    const third = await run(VIDEO_TRANSCRIBED, "dy_box_transcript", { brief: BRIEF });
    expect(third.result.error).toContain("no_video_left");
  });

  it("a brief with no video link makes nothing and says why; a failed job is started again under a new key", async () => {
    const none = await run(VIDEO_TRANSCRIBED, "dy_box_transcript", {});
    expect(none.result.error).toContain("no_video");
    w.job = { status: "failed" };
    const failed = await run(VIDEO_TRANSCRIBED, "dy_box_transcript", { videoUrl: "https://media.example.com/talk.mp4" });
    expect(failed.result.error).toContain("transcription_failed");
    w.job = { status: "transcribing" };
    await run(VIDEO_TRANSCRIBED, "dy_box_transcript", { videoUrl: "https://media.example.com/talk.mp4" });
    const keys = w.calls.filter((c) => c.door === "chat POST /orgs/media-transcriptions").map((c) => String(c.body!.idempotencyKey));
    expect(keys).toHaveLength(2);
    expect(keys[0]!.endsWith(":1") && keys[1]!.endsWith(":2")).toBe(true);
  });
});

describe("Instagram Reel published", () => {
  const HOOKED = `export default function run(ctx) {
  return { content: { id: "hooked-1", url: "https://distribute.example/reels/tok/clip.mp4", text: "What nobody tells you about talks.", hook: { kind: "external", text: "Nobody tells you this" } }, subject: { service: "content-generation-service", id: "hooked-1" } };
}`;
  beforeEach(async () => {
    await createScript(db, { outcome: HOOK_ADDED, dynasty: "dy_fake_hook", code: HOOKED, description: "x" }, author, known);
  });

  it("asks no clip for a brand with no publishable Instagram account", async () => {
    w.accounts = [{ id: "acc-1", handle: "polarity", publishable: false, notPublishableReason: "needs_reconnect" }];
    const { result } = await run(INSTAGRAM_REEL_PUBLISHED, "dy_reel_post", {}, "social");
    expect(result.status).toBe("unmade");
    expect(result.error).toBe("no_publishable_account: polarity: needs_reconnect");
    expect(w.calls.map((c) => c.door)).toEqual(["social GET /orgs/social/accounts"]);
  });

  it("publishes the hooked clip as ONE video with its caption, and consumes the hook it was built from", async () => {
    w.accounts = [{ id: "acc-1", handle: "polarity", publishable: true }];
    const { result } = await run(INSTAGRAM_REEL_PUBLISHED, "dy_reel_post", { brief: BRIEF }, "social");
    expect(result.status).toBe("made");
    const post = w.calls.find((c) => c.door === "social POST /orgs/social/accounts/acc-1/posts")!;
    // The door fills outcomeKey (the script never names its outcome); the caption carries no dash.
    expect(post.body).toEqual({ text: "The idea, in one line #talk", idempotencyKey: "reel:hooked-1", media: [{ url: "https://distribute.example/reels/tok/clip.mp4", type: "video" }], outcomeKey: INSTAGRAM_REEL_PUBLISHED });
    // social-service declares the Reel; this run declares only what it used.
    expect(result.declared.produced).toEqual([]);
    expect(result.declared.consumed).toContainEqual({ outcomeKey: HOOK_ADDED, subjectService: "content-generation-service", subjectId: "hooked-1" });
    expect(result.unit?.subject).toEqual({ service: "social-service", id: "pub-1" });
  });

  it("a refusal Instagram or the account gives is the script's answer, with its code", async () => {
    w.accounts = [{ id: "acc-1", handle: "polarity", publishable: true }];
    w.publish = { status: 409, body: { code: "instagram_publish_permission_missing", error: "the account did not grant publishing" } };
    const { result } = await run(INSTAGRAM_REEL_PUBLISHED, "dy_reel_post", {}, "social");
    expect(result.status).toBe("unmade");
    expect(result.error).toBe("instagram_publish_permission_missing: the account did not grant publishing");
  });
});
