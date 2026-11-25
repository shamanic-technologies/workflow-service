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
  job: { status: string; fraction?: number; words?: number } | null;
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
      if (door === "chat GET /orgs/media-transcriptions/tr-1") return { status: 200, body: { id: "tr-1", status: w.job!.status, language: "en", durationSeconds: 3600, segmentCount: 400, wordCount: w.job!.words ?? 9000, progress: { fraction: w.job!.fraction ?? 0 } } };
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
}, 300_000);
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
    // Only the fake hook is kept on its Engine: these tests are about the Reel post alone.
    setScriptStrategyReader(async (_c, outcome) => (await db.select().from(scripts).where(eq(scripts.outcome, outcome))).map((r) => r.dynasty).filter((d) => outcome !== HOOK_ADDED || d === "dy_fake_hook"));
  }, 300_000);

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

describe("a video where nobody speaks", () => {
  it("is no transcript: unmade no_speech, and it is not transcribed again", async () => {
    w.job = { status: "completed", words: 0 };
    const first = await run(VIDEO_TRANSCRIBED, "dy_box_transcript", { brief: BRIEF });
    expect(first.result.status).toBe("unmade");
    expect(String(first.result.error)).toMatch(/^no_speech: /);
    const second = await run(VIDEO_TRANSCRIBED, "dy_box_transcript", { brief: BRIEF });
    expect(second.result.status).toBe("unmade");
    expect(w.calls.filter((c) => c.door === "chat POST /orgs/media-transcriptions")).toHaveLength(1);
  });
});

describe("the whole chain, each Engine asking the one before it", () => {
  /** A fake of the clips service (content-generation) and of chat-service's transcription, as their contracts state them. */
  function chainVendors(state: { transcript: string; calls: string[]; bodies: Record<string, unknown>[]; judged: string[] }): VendorDeps {
    const clip = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, kind, status: "done", videoId: "vid-1", parentClipId: kind === "hooked" ? "clip-0" : null, start: 10, end: 40, durationSeconds: 30, url: `https://distribute.example/reels/${id}/clip.mp4`, text: "What nobody tells you.", hook: null, ...extra });
    return {
      async readSkill() {
        return { content: "Short, plain words.", version: 1 };
      },
      async serviceDoor(service, method, path, body) {
        const door = `${service} ${method} ${path.split("?")[0]}`;
        state.calls.push(door);
        state.bodies.push({ door, ...(body ?? {}) });
        if (door === "chat POST /orgs/media-transcriptions") return { status: 202, body: { id: "tr-1", status: "downloading" } };
        if (door === "chat GET /orgs/media-transcriptions/tr-1") return { status: 200, body: { id: "tr-1", status: state.transcript, language: "en", durationSeconds: 3600, segmentCount: 400, wordCount: 9000, progress: { fraction: 0.5 } } };
        if (door === "chat POST /orgs/judgments") {
          const choice = state.judged.shift();
          if (!choice) throw new Error("no judgment scripted");
          return { status: 200, body: { answers: { q: { type: "choice", choice, confidence: 0.9, probabilities: {} } } } };
        }
        if (door === "content-generation POST /videos") return { status: 202, body: { id: "vid-1", status: "queued" } };
        if (door === "content-generation GET /videos/vid-1") return { status: 200, body: { id: "vid-1", status: "ready" } };
        if (door === "content-generation POST /videos/vid-1/transcript") return { status: 202, body: { id: "vid-1", status: "queued" } };
        if (door === "content-generation GET /videos/vid-1/transcript") return { status: 200, body: { id: "vid-1", status: "done" } };
        if (door === "content-generation POST /videos/vid-1/moments/request") return { status: 200, body: { request: { message: "0|hello", systemPrompt: "pick the moments", responseFormat: "json", maxTokens: 500 } } };
        if (door === "content-generation POST /videos/vid-1/moments") {
          return { status: 200, body: { id: "prop-1", model: "fake", moments: [0, 1].map((i) => ({ start: 10 + 100 * i, end: 40 + 100 * i, durationSeconds: 30, title: `Moment ${i}`, why: "strong", quote: "q" })) } };
        }
        if (door === "content-generation POST /video-clips") return { status: 202, body: clip(`clip-${String((body as { idempotencyKey: string }).idempotencyKey).split(":").pop()}`, "cut", { status: "queued" }) };
        const read = /^content-generation GET \/video-clips\/(.+)$/.exec(door);
        if (read) return { status: 200, body: read[1]!.startsWith("hooked") ? clip(read[1]!, "hooked", { hook: { type: "internal", start: 20, end: 22, quote: "nobody tells you", why: "curiosity" } }) : clip(read[1]!, "cut") };
        const hookRequest = /^content-generation POST \/video-clips\/(.+)\/internal-hook\/request$/.exec(door);
        if (hookRequest) return { status: 200, body: { request: { message: "0|0.0|what", systemPrompt: "pick the hook", responseFormat: "json", maxTokens: 300 } } };
        const hook = /^content-generation POST \/video-clips\/(.+)\/internal-hook$/.exec(door);
        if (hook) return { status: 202, body: clip(`hooked-${state.calls.filter((c) => /internal-hook$/.test(c)).length}`, "hooked", { status: "queued" }) };
        if (door === "social GET /orgs/social/accounts") return { status: 200, body: { accounts: [{ id: "acc-1", handle: "polarity", publishable: true }] } };
        if (door === "social POST /orgs/social/accounts/acc-1/posts") return { status: 200, body: { publication: { id: "pub-1", permalink: "https://instagram.example/p/1" }, created: true } };
        throw new Error(`unexpected door ${door}`);
      },
    } as unknown as VendorDeps;
  }
  const chain = async (state: Parameters<typeof chainVendors>[0], outcome: string, dynasty: string, request: Record<string, unknown> = {}) => {
    const { l, declared } = ledger();
    const result = await runStoredScript(
      db,
      { outcome, dynasty, units: {}, request: { now: "2026-01-01T10:00:00.000Z", campaignId: "camp-1", brandIds: ["brand-1"], brief: BRIEF, ...request }, ...(outcome === INSTAGRAM_REEL_PUBLISHED ? { recordedBy: "social" } : {}) },
      who,
      { ledger: l, vendors: chainVendors(state) },
      { runId: `run-engine-${Math.random()}`, onWait: async () => {} },
    );
    return { result, declared };
  };
  /** Only the automatic internal hook and the automatic clip are kept (the strategy of a brief asking no validation). */
  const autoOnly = () =>
    setScriptStrategyReader(async (_c, outcome) =>
      (await db.select().from(scripts).where(eq(scripts.outcome, outcome))).map((r) => r.dynasty).filter((d) => !d.endsWith("_validated") && d !== "dy_external_hook"),
    );

  it("a Reel: transcript still running ends the look idle; then transcript, clip, hook and Reel in one run, each consuming the one before", async () => {
    autoOnly();
    const state = { transcript: "transcribing", calls: [] as string[], bodies: [] as Record<string, unknown>[], judged: [] as string[] };
    const first = await chain(state, INSTAGRAM_REEL_PUBLISHED, "dy_reel_post");
    expect(first.result.status).toBe("unmade");
    expect(first.result.decided).toBe("idle");
    expect(first.result.error).toContain("transcribing");
    expect(state.calls).not.toContain("content-generation POST /videos");

    state.transcript = "completed";
    const second = await chain(state, INSTAGRAM_REEL_PUBLISHED, "dy_reel_post");
    expect(second.result.status).toBe("made");
    const consumed = second.declared.flatMap((d) => d.consumed.map((c) => `${c.outcomeKey}:${c.subjectId}`));
    expect(consumed).toEqual(expect.arrayContaining(["video_transcribed:tr-1", "video_clip_cut:clip-0", "hook_added:hooked-1"]));
    const produced = second.declared.flatMap((d) => d.produced.map((c) => `${c.outcomeKey}:${c.subjectService}:${c.subjectId}`));
    expect(produced).toEqual(expect.arrayContaining(["video_transcribed:chat-service:tr-1", "video_clip_cut:content-generation-service:clip-0", "hook_added:content-generation-service:hooked-1"]));
    // The clips service got the transcript the Engine made, the asked completion, and the hooked clip went to Instagram.
    expect(state.bodies.find((b) => b.door === "content-generation POST /videos/vid-1/transcript")).toMatchObject({ transcriptionId: "tr-1" });
    const moments = state.bodies.find((b) => b.door === "content-generation POST /videos/vid-1/moments") as { completion: { request: unknown; answer: unknown; runId: string } };
    expect(moments.completion.request).toMatchObject({ systemPrompt: "pick the moments" });
    expect(typeof moments.completion.runId).toBe("string");
    expect(state.bodies.find((b) => b.door === "social POST /orgs/social/accounts/acc-1/posts")).toMatchObject({ media: [{ url: "https://distribute.example/reels/hooked-1/clip.mp4", type: "video" }] });

    // The next Reel takes the NEXT moment of the same video: no second download, no second moments pick.
    const third = await chain(state, INSTAGRAM_REEL_PUBLISHED, "dy_reel_post");
    expect(third.result.status).toBe("made");
    expect(state.calls.filter((c) => c === "content-generation POST /videos")).toHaveLength(1);
    expect(state.calls.filter((c) => c === "content-generation POST /videos/vid-1/moments")).toHaveLength(1);
    expect(state.bodies.filter((b) => b.door === "content-generation POST /video-clips").map((b) => b.start)).toEqual([10, 110]);
  });

  it("a change handed down about the hook keeps the clip; about the clip, another moment is cut", async () => {
    autoOnly();
    const state = { transcript: "completed", calls: [] as string[], bodies: [] as Record<string, unknown>[], judged: [] as string[] };
    const first = await chain(state, HOOK_ADDED, "dy_internal_hook");
    expect(first.result.status).toBe("made");
    const hooked = first.result.unit!.content as { clip: { id: string }; id: string };
    expect(hooked.clip.id).toBe("clip-0");

    state.judged.push("own");
    const again = await chain(state, HOOK_ADDED, "dy_internal_hook", { feedback: "change the hook", previous: hooked });
    expect(again.result.status).toBe("made");
    expect((again.result.unit!.content as { clip: { id: string } }).clip.id).toBe("clip-0");
    expect(state.bodies.filter((b) => b.door === "content-generation POST /video-clips")).toHaveLength(1);
    const redo = state.bodies.filter((b) => /internal-hook\/request$/.test(String(b.door))).pop() as { brief: string };
    expect(redo.brief).toContain("change the hook");

    state.judged.push("source");
    const other = await chain(state, HOOK_ADDED, "dy_internal_hook", { feedback: "another clip please", previous: hooked });
    expect(other.result.status).toBe("made");
    expect((other.result.unit!.content as { clip: { id: string } }).clip.id).toBe("clip-1");
  });
});
