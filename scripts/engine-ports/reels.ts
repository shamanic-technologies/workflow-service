/**
 * REELS-1124 (owner 2026-11-24: a long recorded video becomes published Instagram Reels with hooks, measured, « et met
 * de l'human in the loop à chaque étape clé », at $0). Four Engines, one outcome each, every script through the shared
 * mechanisms (the Rating picks, the campaign's strategy narrows, a script asks the Engine before it):
 *
 *   instagram_reel_published  asks  hook_added  asks  video_clip_cut  asks  video_transcribed
 *
 * Each ask is a child run, and the asking run consumes the Unit it got, so what a Reel led to (social-service declares
 * `post_viewed` / `post_engaged` under the publishing run) credits the hook, the clip and the transcript behind it:
 * that chain is what the Rating compares the hook scripts on.
 *
 * - « Video transcribed » (`dy_box_transcript`): the videos are the links the campaign BRIEF gives (read once per
 *   brief by the model the Rating picks) or `request.videoUrl` on a direct ask. chat-service transcribes on our own
 *   box ($0, a job polled across runs: its id is kept in the Engine's storage); the Unit is the transcript.
 * - « Instagram Reel published » (`dy_reel_post`, `dy_reel_post_validated`): ONE code; asks a hooked clip, writes the
 *   caption, publishes on the brand's Instagram (social-service declares the Unit: `recorded_by` social).
 *
 * A human-validated script is the SAME code with tactic `validation: "human"` (human-validated.ts): a fork, never a
 * second code, never a new object. Never a model, a brand or a channel named here.
 */
import { PORT_HEAD } from "./port-kit.js";
import { COMPLETION_HELPERS } from "./ask-completion.js";
import { HUMAN_VALIDATION_FNS, VALIDATED_BY_HUMAN, VALIDATED_DESCRIPTION, VALIDATION_TACTIC } from "./human-validated.js";

export const VIDEO_TRANSCRIBED = "video_transcribed";
export const VIDEO_CLIP_CUT = "video_clip_cut";
export const HOOK_ADDED = "hook_added";
export const INSTAGRAM_REEL_PUBLISHED = "instagram_reel_published";

/** A transcription job that failed is started again at most this many times per video. */
export const TRANSCRIPTION_MAX_ATTEMPTS = 3;

export interface EngineScript {
  outcome: string;
  dynasty: string;
  name: string;
  description: string;
  tactics: Record<string, unknown>;
  code: string;
}

const HEAD = `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";
${PORT_HEAD}`;

/** What every Reels script hands the Engine it asks: the campaign's own Request (brief, clock, brand), never its run. */
const CARRY_FN = `
/** The Request handed to an asked Engine: the campaign's context as this run got it, plus what this ask adds. */
function carry(ctx: any, extra: Record<string, unknown>): Record<string, unknown> {
  const r: any = ctx.request ?? {};
  const out: Record<string, unknown> = {};
  for (const k of ["campaignId", "brief", "now", "brandIds", "offerId", "whatsappSenderPhone", "videoUrl"]) if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
  return { ...out, ...extra };
}
/** An asked Engine that made nothing: its answer, passed on as this script's own. */
function passOn(u: any): any {
  const out: any = { unmade: typeof u.unmade === "string" && u.unmade ? u.unmade : "nothing" };
  if (u.decided === "done" || u.decided === "idle") out.decided = u.decided;
  // An unfinished look below (a render, a download still running) is unfinished here too: asked again soon.
  if (u.run && u.run.again === true) out.again = true;
  return out;
}
/** What a script keeps of a clip the clips service made (cut or hooked). */
function slimClip(c: any): any {
  return { id: String(c.id), kind: c.kind ?? null, url: c.url ?? null, text: c.text ?? null, start: c.start ?? null, end: c.end ?? null, durationSeconds: c.durationSeconds ?? null, hook: c.hook ?? null, videoId: c.videoId ?? null, parentClipId: c.parentClipId ?? null };
}
/** A door's answered refusal as a script's reason: its code, else the fallback, then its words. */
function refusalOf(a: Answer, fallback: string): string {
  const d: any = a.data ?? {};
  const body: any = d.body ?? {};
  const code = typeof d.code === "string" && d.code ? d.code : typeof body.errorCode === "string" && body.errorCode ? body.errorCode : fallback;
  return String(code).toLowerCase() + ": " + String(d.error ?? "refused") + " (" + String(d.status) + ")";
}
`;

/** Seconds one read waits on a job of the clips service (a download, a render): past it the look ends and is asked again. */
export const CLIPS_WAIT_SECONDS = 60;

/** « Video transcribed »: the brief's videos, one transcript per run, on our own box. */
export function buildTranscriptSource(): string {
  return `${HEAD}
const MAX_ATTEMPTS = ${TRANSCRIPTION_MAX_ATTEMPTS};
/** The long videos this run is asked to work on: the one the request names, else the links the campaign brief gives. */
function videoUrls(ctx: any): string[] {
  const r: any = ctx.request ?? {};
  if (typeof r.videoUrl === "string" && r.videoUrl.trim()) return [r.videoUrl.trim()];
  const brief = typeof r.brief === "string" ? r.brief.trim() : "";
  if (!brief) return [];
  const key = stableKey(brief);
  const kept: any = ctx.storage.get("briefs", key);
  if (kept && Array.isArray(kept.urls)) return kept.urls;
  const json: any = askCompletion(ctx, {
    systemPrompt: "You read a campaign brief. List every download link of a long recorded video (an interview, a talk, a live) the brief asks to turn into short clips. Copy each link exactly as written, whole. A link to anything else (a website, a profile, a booking page) is not one. None = an empty list. Answer as JSON: {\\"urls\\": [\\"...\\"]}.",
    message: brief,
    responseSchema: { type: "object", additionalProperties: false, required: ["urls"], properties: { urls: { type: "array", items: { type: "string" } } } },
  }).data.json;
  const urls = (json && Array.isArray(json.urls) ? json.urls : []).map((u: any) => String(u).trim()).filter((u: string) => /^https:[/][/]/i.test(u));
  ctx.storage.set("briefs", key, { urls, readAt: String(r.now ?? "") });
  return urls;
}
function stableKey(v: any): string {
  const s = JSON.stringify(v ?? null);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
/** Video transcribed (REELS-1124): the next video of the brief not transcribed yet; a transcript still being made ends the look idle. */
export default function run(ctx: ScriptContext): ScriptResult {
  const r: any = ctx.request ?? {};
  const t: any = ctx.tactics ?? {};
  const urls = videoUrls(ctx);
  if (urls.length === 0) return { unmade: "no_video: the campaign brief gives no download link of a long video (and the request names no videoUrl)", decided: "idle" };
  let pending: string | null = null;
  let failed: string | null = null;
  for (const url of urls) {
    const key = stableKey(url);
    let st: any = ctx.storage.get("videos", key);
    if (st && st.state === "done") continue;
    if (st && st.state === "failed" && Number(st.attempts ?? 0) >= MAX_ATTEMPTS) {
      failed = failed ?? "transcription_failed: " + String(st.error ?? "the video could not be transcribed") + " (" + url + ", " + MAX_ATTEMPTS + " tries)";
      continue;
    }
    if (!st || st.state === "failed") {
      const attempts = Number(st?.attempts ?? 0) + 1;
      const body: any = { url, idempotencyKey: "video:" + String(r.campaignId ?? "direct") + ":" + key + ":" + attempts };
      if (typeof t.language === "string" && t.language) body.language = t.language;
      const a: Answer = ctx.vendor.call("chat.media.transcribe", { body });
      if (!a.ok) {
        if (typeof a.data.status !== "number" || a.data.status >= 500) throw new Error("chat.media.transcribe failed (" + String(a.data.status ?? "") + "): " + String(a.data.error ?? "").slice(0, 300));
        // A link chat-service names as unusable (unreachable, not a media file, too large): said, never retried blind.
        ctx.storage.set("videos", key, { url, state: "failed", attempts: MAX_ATTEMPTS, error: String(a.data.code ?? "refused") + ": " + String(a.data.error ?? "") });
        failed = failed ?? "transcription_refused: " + String(a.data.code ?? a.data.status) + ": " + String(a.data.error ?? "") + " (" + url + ")";
        continue;
      }
      st = { url, state: "running", jobId: String(a.data.id), attempts, startedAt: String(r.now ?? "") };
      ctx.storage.set("videos", key, st);
    }
    const job: any = must(ctx, "chat.media.transcription", { params: { id: st.jobId } });
    if (job.status === "completed") {
      ctx.storage.set("videos", key, { ...st, state: "done", doneAt: String(r.now ?? "") });
      return {
        content: { transcriptId: String(job.id), videoUrl: url, language: job.language ?? null, durationSeconds: job.durationSeconds ?? null, segmentCount: job.segmentCount ?? null, wordCount: job.wordCount ?? null },
        subject: { service: "chat-service", id: String(job.id) },
      };
    }
    if (job.status === "failed") {
      const why = job.error ? String(job.error.code ?? "") + ": " + String(job.error.message ?? "") : "failed";
      ctx.storage.set("videos", key, { ...st, state: "failed", error: why });
      failed = failed ?? "transcription_failed: " + why + " (" + url + ")";
      continue;
    }
    const done = job.progress && typeof job.progress.fraction === "number" ? Math.round(job.progress.fraction * 100) + " %" : String(job.status);
    pending = pending ?? "transcribing: " + url + " is being transcribed (" + done + ")";
  }
  // Nothing new this run: a transcript still being made, or a failure, or every video of the brief already transcribed.
  if (pending) return { unmade: pending, decided: "idle" };
  if (failed) return { unmade: failed, decided: "idle" };
  return { unmade: "no_video_left: every video the brief gives is already transcribed", decided: "idle" };
}
${COMPLETION_HELPERS}`;
}

/** « Video clip cut »: one strong moment of a transcribed video, cut into a vertical clip with captions. */
export function buildClipSource(): string {
  return `${HEAD}
${CARRY_FN}
const WAIT = ${CLIPS_WAIT_SECONDS};
function sourceOf(ctx: any, id: string): any {
  return ctx.storage.get("sources", id);
}
function saveSource(ctx: any, src: any): void {
  ctx.storage.set("sources", String(src.transcriptId), src);
}
/** A moment is never cut twice (used) nor proposed again once the brand's person refused it (rejected). */
function mark(ctx: any, transcriptId: any, index: any, what: "used" | "rejected"): void {
  if (typeof transcriptId !== "string" || typeof index !== "number") return;
  const src: any = sourceOf(ctx, transcriptId);
  if (!src) return;
  const flags: any = { ...(src[what] ?? {}) };
  if (flags[String(index)] === true) return;
  flags[String(index)] = true;
  saveSource(ctx, { ...src, [what]: flags });
}
/** The next clip: a transcribed video with a moment left, its moments picked once by the asked model, one moment cut. */
function makeClip(ctx: any, scope: string, feedback: any): any {
  const r: any = ctx.request ?? {};
  const brief = typeof r.brief === "string" && r.brief.trim() ? r.brief.trim() : null;
  if (feedback && feedback.previous) mark(ctx, feedback.previous.transcriptId, feedback.previous.momentIndex, "rejected");
  for (let turn = 0; turn < 6; turn++) {
    const index: string[] = ctx.storage.get("sources_index", scope) ?? [];
    let src: any = null;
    for (const id of index) {
      const s: any = sourceOf(ctx, id);
      if (s && s.exhausted !== true) {
        src = { ...s };
        break;
      }
    }
    if (!src) {
      const u: any = ctx.ask("${VIDEO_TRANSCRIBED}", { request: carry(ctx, {}) });
      if (!u.content) return passOn(u);
      src = { transcriptId: String(u.content.transcriptId), videoUrl: String(u.content.videoUrl), used: {}, rejected: {} };
      saveSource(ctx, src);
      ctx.storage.set("sources_index", scope, [...index.filter((i) => i !== src.transcriptId), src.transcriptId]);
    }
    // The video on the clips service (fetched once per source), then its transcript handed over.
    if (!src.videoId) {
      const a: Answer = ctx.vendor.call("content.video.download", { body: { sourceUrl: src.videoUrl } });
      if (!a.ok) {
        if (typeof a.data.status !== "number" || a.data.status >= 500) throw new Error("content.video.download failed (" + String(a.data.status ?? "") + "): " + String(a.data.error ?? "").slice(0, 300));
        saveSource(ctx, { ...src, exhausted: true, error: refusalOf(a, "video_refused") });
        return { unmade: refusalOf(a, "video_refused") };
      }
      src.videoId = String(a.data.id);
      saveSource(ctx, src);
    }
    const video: any = must(ctx, "content.video.read", { params: { id: src.videoId }, query: { waitSeconds: WAIT } });
    if (video.status === "failed") {
      const why = "video_download_failed: " + String(video.errorCode ?? "") + " " + String(video.error ?? "");
      saveSource(ctx, { ...src, exhausted: true, error: why });
      return { unmade: why };
    }
    if (video.status !== "ready") return { unmade: "downloading: the video is being fetched (" + String(video.stage ?? video.status) + ")", again: true };
    if (src.transcriptAttached !== true) {
      must(ctx, "content.video.transcript.attach", { params: { id: src.videoId }, body: { transcriptionId: src.transcriptId } });
      src.transcriptAttached = true;
      saveSource(ctx, src);
    }
    const transcript: any = must(ctx, "content.video.transcript", { params: { id: src.videoId }, query: { waitSeconds: WAIT, words: "false", from: 0, to: 1 } });
    if (transcript.status === "failed") {
      const why = "transcript_failed: " + String(transcript.error ?? "");
      saveSource(ctx, { ...src, exhausted: true, error: why });
      return { unmade: why };
    }
    if (transcript.status !== "done") return { unmade: "transcript_loading: the transcript is being read (" + String(transcript.status) + ")", again: true };
    if (!Array.isArray(src.moments)) {
      const ask: any = brief ? { brief } : {};
      const request: any = must(ctx, "content.video.moments.request", { params: { id: src.videoId }, body: ask }).request;
      const answer: any = askCompletion(ctx, request).data;
      const picked: any = must(ctx, "content.video.moments", { params: { id: src.videoId }, body: { ...ask, completion: { request, answer } } });
      src.moments = Array.isArray(picked.moments) ? picked.moments : [];
      src.momentsId = picked.id ?? null;
      saveSource(ctx, src);
    }
    const used: any = src.used ?? {};
    const rejected: any = src.rejected ?? {};
    let at = -1;
    for (let i = 0; i < src.moments.length; i++) {
      if (used[String(i)] !== true && rejected[String(i)] !== true) {
        at = i;
        break;
      }
    }
    if (at < 0) {
      // Every moment of this video is cut or refused: the next video (another transcript is asked for on the next turn).
      saveSource(ctx, { ...src, exhausted: true });
      continue;
    }
    const moment: any = src.moments[at];
    const cut: Answer = ctx.vendor.call("content.clip.cut", { body: { videoId: src.videoId, start: moment.start, end: moment.end, idempotencyKey: "clip:" + src.videoId + ":" + at } });
    if (!cut.ok) {
      if (typeof cut.data.status !== "number" || cut.data.status >= 500) throw new Error("content.clip.cut failed (" + String(cut.data.status ?? "") + "): " + String(cut.data.error ?? "").slice(0, 300));
      mark(ctx, src.transcriptId, at, "rejected");
      return { unmade: refusalOf(cut, "clip_refused"), again: true };
    }
    const clip: any = must(ctx, "content.clip.read", { params: { id: String(cut.data.id) }, query: { waitSeconds: WAIT } });
    if (clip.status === "failed" || clip.status === "expired") {
      mark(ctx, src.transcriptId, at, "rejected");
      return { unmade: "clip_render_failed: " + String(clip.errorCode ?? clip.status) + " " + String(clip.error ?? ""), again: true };
    }
    if (clip.status !== "done") return { unmade: "rendering: the clip is being cut (" + String(clip.stage ?? clip.status) + ")", again: true };
    return { proposal: { ...slimClip(clip), transcriptId: src.transcriptId, momentIndex: at, moment } };
  }
  return { unmade: "no_moment_left: no video of the brief has a moment left to cut", decided: "idle" };
}
/** Video clip cut (REELS-1124): one moment of a long video, cut vertical with its captions. */
export default function run(ctx: ScriptContext): ScriptResult {
  const r: any = ctx.request ?? {};
  const scope = String(r.campaignId ?? "direct");
  // A change the asking script hands down (the brand's person refused the clip it was shown): another moment.
  const handed = typeof r.feedback === "string" && r.feedback.trim() ? { words: r.feedback.trim(), previous: r.previous ?? null, about: "own" } : null;
  const v: any = validated(
    ctx,
    (feedback: any) => makeClip(ctx, scope, feedback ?? handed),
    (p: any) => ({
      what: "a short clip cut from your video" + (p.moment && p.moment.title ? ": " + String(p.moment.title) : ""),
      facts: [
        "Length: " + Math.round(Number(p.durationSeconds ?? 0)) + " seconds, taken at " + Math.round(Number(p.start ?? 0)) + " s of the video",
        p.moment && p.moment.quote ? "It says: " + String(p.moment.quote) : "",
        p.moment && p.moment.why ? "Why this moment: " + String(p.moment.why) : "",
      ].filter(Boolean),
      links: [p.url],
      then: "a hook is added at its start, then it becomes a Reel",
      own: "which moment of the video was cut",
      source: "",
    }),
  );
  if (!v || !v.proposal) return v;
  const p: any = v.proposal;
  mark(ctx, p.transcriptId, p.momentIndex, "used");
  ctx.consume("${VIDEO_TRANSCRIBED}", { service: "chat-service", id: String(p.transcriptId) });
  settle(ctx, v);
  return { content: p, subject: { service: "content-generation-service", id: String(p.id) } };
}
${COMPLETION_HELPERS}
${HUMAN_VALIDATION_FNS}`;
}

/** « Hook added »: a clip that opens on a hook. Where the hook comes from is the script's tactic \`hook\`. */
export function buildHookSource(): string {
  return `${HEAD}
${CARRY_FN}
const WAIT = ${CLIPS_WAIT_SECONDS};
const OWN = "the hook: the first seconds that open the clip";
const SOURCE = "the clip itself: which moment of the video was cut";
/** The clips service's door of this script's kind of hook (tactic hook). */
function hookDoor(ctx: any): string {
  const kind = (ctx.tactics ?? {}).hook;
  if (kind === "internal") return "content.clip.internal_hook";
  if (kind === "external") return "content.clip.external_hook";
  throw new Error("this script states no kind of hook (tactic hook: internal or external)");
}
/** A hooked clip in the making, kept across runs (the clip it got, the render it started) until it is a Unit. */
function makeHook(ctx: any, base: string, feedback: any): any {
  const r: any = ctx.request ?? {};
  const door = hookDoor(ctx);
  const wipKey = base + "|" + stableKey(feedback ? String(feedback.words) : "");
  const wip: any = { ...(ctx.storage.get("wip", wipKey) ?? {}) };
  if (!wip.clip) {
    if (feedback && feedback.about === "own" && feedback.previous && feedback.previous.clip) {
      // They asked for another hook: the same clip.
      wip.clip = feedback.previous.clip;
      wip.clipSubject = feedback.previous.clipSubject ?? null;
    } else {
      const u: any = ctx.ask("${VIDEO_CLIP_CUT}", { request: carry(ctx, feedback ? { feedback: feedback.words, previous: feedback.previous ? feedback.previous.clip : null } : {}) });
      if (!u.content) return passOn(u);
      wip.clip = u.content;
      wip.clipSubject = u.run && u.run.unit ? u.run.unit.subject : null;
    }
    ctx.storage.set("wip", wipKey, wip);
  }
  if (!wip.hookedId) {
    const lines = [typeof r.brief === "string" && r.brief.trim() ? r.brief.trim() : ""];
    if (feedback && feedback.about === "own") {
      lines.push("The brand's person saw a first hook on this clip and asked for a change. Their words: " + String(feedback.words));
      if (feedback.previous && feedback.previous.hook) lines.push("The hook they refused: " + JSON.stringify(feedback.previous.hook));
    }
    const brief = lines.filter(Boolean).join("\\n\\n");
    const ask: any = brief ? { brief } : {};
    const request: any = must(ctx, door + ".request", { params: { id: String(wip.clip.id) }, body: ask }).request;
    const answer: any = askCompletion(ctx, request).data;
    const a: Answer = ctx.vendor.call(door, { params: { id: String(wip.clip.id) }, body: { ...ask, completion: { request, answer }, idempotencyKey: "hook:" + wipKey + ":" + String(wip.clip.id) } });
    if (!a.ok) {
      if (typeof a.data.status !== "number") throw new Error(door + ": " + String(a.data.error ?? "no answer"));
      // The clip is gone (expired): this work starts again from a new clip.
      if (a.data.status === 404 || a.data.status === 410) ctx.storage.delete("wip", wipKey);
      return { unmade: refusalOf(a, "hook_refused"), again: true };
    }
    wip.hookedId = String(a.data.id);
    ctx.storage.set("wip", wipKey, wip);
  }
  const hooked: any = must(ctx, "content.clip.read", { params: { id: wip.hookedId }, query: { waitSeconds: WAIT } });
  if (hooked.status === "failed" || hooked.status === "expired") {
    ctx.storage.set("wip", wipKey, { ...wip, hookedId: null });
    return { unmade: "hook_render_failed: " + String(hooked.errorCode ?? hooked.status) + " " + String(hooked.error ?? ""), again: true };
  }
  if (hooked.status !== "done") return { unmade: "rendering: the hook is being added (" + String(hooked.stage ?? hooked.status) + ")", again: true };
  return { proposal: { ...slimClip(hooked), clip: wip.clip, clipSubject: wip.clipSubject ?? null, wipKey } };
}
/** Hook added (REELS-1124): a clip whose first seconds are made to stop the scroll. */
export default function run(ctx: ScriptContext): ScriptResult {
  const r: any = ctx.request ?? {};
  const base = String(r.campaignId ?? "direct") + "|" + stableKey(ctx.tactics ?? {});
  // A change the asking script hands down: about the hook (the same clip, another hook) or about the clip (another clip).
  const words = typeof r.feedback === "string" ? r.feedback.trim() : "";
  const handed = words ? { words, previous: r.previous ?? null, about: changeIsAbout(ctx, words, OWN, SOURCE) } : null;
  const v: any = validated(
    ctx,
    (feedback: any) => makeHook(ctx, base, feedback ?? handed),
    (p: any) => ({
      what: "a clip with its hook, ready to become a Reel",
      facts: [
        p.hook && p.hook.type === "external" ? "It opens on this line on screen: " + String(p.hook.text) : p.hook && p.hook.quote ? "It opens on its strongest seconds: " + String(p.hook.quote) : "",
        p.hook && p.hook.why ? "Why this hook: " + String(p.hook.why) : "",
        "Length: " + Math.round(Number(p.durationSeconds ?? 0)) + " seconds",
      ].filter(Boolean),
      links: [p.url],
      then: "it goes on to be published as a Reel",
      own: OWN,
      source: SOURCE,
    }),
  );
  if (!v || !v.proposal) return v;
  const p: any = v.proposal;
  if (p.clipSubject) ctx.consume("${VIDEO_CLIP_CUT}", p.clipSubject);
  ctx.storage.delete("wip", String(p.wipKey));
  settle(ctx, v);
  const { wipKey: _w, ...content } = p;
  return { content, subject: { service: "content-generation-service", id: String(p.id) } };
}
${COMPLETION_HELPERS}
${HUMAN_VALIDATION_FNS}`;
}

/** « Instagram Reel published »: a hooked clip, its caption, published on the brand's Instagram. */
export function buildReelPostSource(): string {
  return `${HEAD}
${CARRY_FN}
/** The caption under the Reel, written by the model the Rating picks from the clip's own words and the brief. */
function writeCaption(ctx: any, hooked: any, feedback: any, previous: string | null): string {
  const r: any = ctx.request ?? {};
  const voice: any = must(ctx, "voice.read", {});
  const json: any = askCompletion(ctx, {
    systemPrompt: [
      "You write the caption under one Instagram Reel of a brand: a short vertical clip cut from a longer video.",
      "Write in the language the clip is spoken in. Open on the idea of the clip in one short line, then one or two lines that add something the video does not say twice, then at most five hashtags a person of this field would search. No dash. At most 600 characters.",
      "State only what the clip's own words and the campaign brief say.",
      "Answer as JSON: {\\"caption\\": \\"...\\"}.",
      "",
      "OUR VOICE (how we write):",
      String(voice.content),
    ].join("\\n"),
    message: [
      "WHAT IS SAID IN THE CLIP:",
      String(hooked.text ?? "").slice(0, 6000),
      "THE HOOK IT OPENS ON: " + JSON.stringify(hooked.hook ?? null),
      typeof r.brief === "string" && r.brief.trim() ? "THE CAMPAIGN BRIEF:\\n" + r.brief.trim().slice(0, 3000) : "",
      feedback && previous ? "THE CAPTION WE PROPOSED BEFORE:\\n" + previous + "\\nWHAT THE BRAND'S PERSON ASKED TO CHANGE:\\n" + String(feedback.words) : "",
    ].filter((l) => l !== "").join("\\n"),
    responseSchema: { type: "object", additionalProperties: false, required: ["caption"], properties: { caption: { type: "string" } } },
  }).data.json;
  const caption = noDashes(String((json && json.caption) ?? "")).trim();
  if (!caption) throw new Error("the caption came back empty: nothing is published");
  return caption;
}
/** Instagram Reel published (REELS-1124): one hooked clip published on the brand's Instagram account. */
export default function run(ctx: ScriptContext): ScriptResult {
  const brandId = brandOf(ctx);
  // The account first: no hooked clip is asked for a brand that cannot publish.
  const listed: any = must(ctx, "social.accounts", { query: { brandId, network: "instagram" } });
  const accounts: any[] = Array.isArray(listed.accounts) ? listed.accounts : [];
  const account = accounts.find((a) => a && a.publishable === true);
  if (!account) {
    const why = accounts.length === 0 ? "no Instagram account is connected for this brand" : accounts.map((a) => String(a.handle ?? a.username ?? a.id) + ": " + String(a.notPublishableReason ?? "not publishable")).join("; ");
    return { unmade: "no_publishable_account: " + why, decided: "idle" };
  }
  const v: any = validated(
    ctx,
    (feedback: any) => {
      // A change about the caption keeps the clip; any other change re-asks the Hook added Engine with their words.
      let hooked: any = feedback && feedback.about === "own" ? feedback.previous.hooked : null;
      let subject: any = hooked ? feedback.previous.subject : null;
      if (!hooked) {
        const u: any = ctx.ask("${HOOK_ADDED}", { request: carry(ctx, feedback ? { feedback: feedback.words, previous: feedback.previous.hooked } : {}) });
        if (!u.content) return passOn(u);
        hooked = u.content;
        subject = u.run && u.run.unit ? u.run.unit.subject : null;
      }
      if (typeof hooked.url !== "string" || !/^https:[/][/]/i.test(hooked.url)) throw new Error("the hooked clip states no public https address: Instagram cannot fetch it");
      return { proposal: { hooked, subject, caption: writeCaption(ctx, hooked, feedback, feedback ? feedback.previous.caption : null) } };
    },
    (p: any) => ({
      what: "a Reel ready to publish on Instagram (" + String(account.handle ?? account.username ?? "the brand's account") + ")",
      facts: ["Caption: " + p.caption, "Hook: " + (p.hooked.hook && p.hooked.hook.text ? String(p.hooked.hook.text) : JSON.stringify(p.hooked.hook ?? null))],
      links: [p.hooked.url],
      then: "it is published on Instagram",
      own: "the caption written under the Reel",
      source: "the video itself: the clip, the moment chosen, or the hook it opens on",
    }),
  );
  if (!v || !v.proposal) return v;
  const p: any = v.proposal;
  if (p.subject) ctx.consume("${HOOK_ADDED}", p.subject);
  const a: Answer = ctx.vendor.call("social.publish", {
    params: { id: String(account.id) },
    body: { text: p.caption, idempotencyKey: "reel:" + String(p.hooked.id ?? p.hooked.url), media: [{ url: p.hooked.url, type: "video" }] },
  });
  if (!a.ok) {
    if (typeof a.data.status !== "number") throw new Error("social.publish: " + String(a.data.error ?? "no answer"));
    // Refused for a reason the account or Instagram gave: said; the approved proposal stays approved for the next run.
    return { unmade: (typeof a.data.code === "string" && a.data.code ? a.data.code : "reel_not_published") + ": " + String(a.data.error ?? "refused (" + a.data.status + ")") };
  }
  settle(ctx, v);
  const pub: any = a.data.publication ?? {};
  return { content: { publicationId: pub.id ?? null, permalink: pub.permalink ?? null, caption: p.caption, hooked: p.hooked }, subject: { service: "social-service", id: String(pub.id ?? "") } };
}
${COMPLETION_HELPERS}
${HUMAN_VALIDATION_FNS}`;
}

const human = (tactics: Record<string, unknown>) => ({ ...tactics, [VALIDATION_TACTIC]: VALIDATED_BY_HUMAN });

function clipAndHookScripts(): EngineScript[] {
  const clip = buildClipSource();
  const hook = buildHookSource();
  const clipDescription = "Cuts one strong moment of a long video into a short vertical clip with its captions. Asks for the video's transcript, has the moments worth cutting picked once per video, and cuts the next one that was not cut yet. One clip per run.";
  const internal = "Makes a clip open on its own strongest two seconds: asks for a clip, has the juiciest moment of its words picked, and plays it first, before the clip.";
  const external = "Makes a clip open on a line proven elsewhere: asks for a clip, picks from a library of hooks that worked on other videos the one that fits it, and shows that line over its first seconds.";
  const asks = ["llm_completion"];
  return [
    { outcome: VIDEO_CLIP_CUT, dynasty: "dy_clip_cut", name: "Automatic clip", description: clipDescription + " Nobody validates it first.", tactics: { asks }, code: clip },
    { outcome: VIDEO_CLIP_CUT, dynasty: "dy_clip_cut_validated", name: "Clip you approve first", description: clipDescription + " " + VALIDATED_DESCRIPTION, tactics: human({ asks }), code: clip },
    { outcome: HOOK_ADDED, dynasty: "dy_internal_hook", name: "Internal hook", description: internal + " Nobody validates it first.", tactics: { asks, hook: "internal" }, code: hook },
    { outcome: HOOK_ADDED, dynasty: "dy_external_hook", name: "External hook", description: external + " Nobody validates it first.", tactics: { asks, hook: "external" }, code: hook },
    { outcome: HOOK_ADDED, dynasty: "dy_internal_hook_validated", name: "Internal hook you approve first", description: internal + " " + VALIDATED_DESCRIPTION, tactics: human({ asks, hook: "internal" }), code: hook },
    { outcome: HOOK_ADDED, dynasty: "dy_external_hook_validated", name: "External hook you approve first", description: external + " " + VALIDATED_DESCRIPTION, tactics: human({ asks, hook: "external" }), code: hook },
  ];
}

/** The scripts stored for the Engines whose producers are live. An automatic script and its human-validated fork share one code. */
export function engineScripts(): EngineScript[] {
  const post = buildReelPostSource();
  const postDescription = "Publishes one Reel on the brand's Instagram account: asks for a short vertical clip that opens on a hook, writes its caption from the clip's own words and the campaign brief, and publishes it. One Reel per run.";
  return [
    {
      outcome: VIDEO_TRANSCRIBED,
      dynasty: "dy_box_transcript",
      name: "Transcript on our own machine",
      description: "Puts a long recorded video into text with the time of every word, on our own machine, at no cost. The videos are the download links the campaign brief gives, one per run; a direct ask states videoUrl. A transcript still being made ends the look, and the next one reads it.",
      tactics: { asks: ["llm_completion"] },
      code: buildTranscriptSource(),
    },
    ...clipAndHookScripts(),
    {
      outcome: INSTAGRAM_REEL_PUBLISHED,
      dynasty: "dy_reel_post",
      name: "Automatic Reel",
      description: postDescription + " Nobody validates it first.",
      tactics: { asks: ["llm_completion"], recorded_by: "social" },
      code: post,
    },
    {
      outcome: INSTAGRAM_REEL_PUBLISHED,
      dynasty: "dy_reel_post_validated",
      name: "Reel you approve first",
      description: postDescription + " " + VALIDATED_DESCRIPTION,
      tactics: human({ asks: ["llm_completion"], recorded_by: "social" }),
      code: post,
    },
  ];
}
