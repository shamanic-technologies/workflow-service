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
  return out;
}
`;

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
