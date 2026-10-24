/**
 * THE WORKFLOW OF THE SOCIAL POST PIPE (`social-post|start_to_industry_update_video`, owner 2026-10-12): the daily
 * industry update video, run by campaign-service like every proactive Start pipe (no lead at entry), one bulletin a
 * day, published once on X (@KevinLourd) and once on LinkedIn (Kevin).
 *
 * Each run, in order:
 *  - The campaign chassis (`/gate-check`, `/start-run`, an `/end-run` on every exit). A staff DRY RUN
 *    (`inputs.dryRun: true`, no campaign needed) skips the chassis and stops before publishing: it produces the
 *    video and the two post drafts (`dry-summary`).
 *  - Is today's bulletin owed? social-service lists this campaign's posts on the step; a post already made today
 *    (any state but failed / cancelled / deleted) ends the run idle (`noWorkAvailable`: campaign-service rechecks in
 *    10 minutes, which is a cheap read). Outside the PUBLISH_WINDOW_UTC hours the run also ends idle, which bounds
 *    what a thin day costs (a day with no bulletin leaves no post, so without the window every recheck would scan
 *    and pay a model again).
 *  - social-service scans the last 36 h of industry news (`/internal/industry-news/scans`, the morning brief's
 *    sources, ranked). Only X and LinkedIn posts can be shown as the post card, so only they are offered.
 *  - The model PICKS the stories (chat-service `/complete`, the editorial strategy in `industry-update-editorial.ts`),
 *    each with its spotlight sentence verbatim; a pick whose sentence is not in the post is dropped here.
 *  - Jev judges each pick "solid news?" (chat-service `/orgs/judgments`, one `noul` per pick). Fewer than
 *    MIN_SOLID_STORIES solid = nothing is published today (`end-run-thin`, idle).
 *  - The model WRITES the screens and the two posts, then content-generation renders the 4:5 bulletin
 *    (`/industry-debrief-videos`, async: POST then a long-poll GET, idempotent per day and story set).
 *  - social-service publishes once per network (`/internal/social-posts`, idempotency key per campaign, day and
 *    network, every named person and company tagged), and the flow waits until each post is published. As soon as a
 *    post is published, the owner of the org the run acts for gets ONE Telegram line about it (where, the link, its
 *    first line) through client-service; a line not delivered is logged loudly, never failing the run
 *    (POST-PUBLISHED-TELEGRAM-1014). The people
 *    who engage are synced by social-service itself every 6 h onto the step `industry_update_video` and this
 *    campaign.
 *
 * Every spend is declared by the service that makes it, on this run (`x-run-id`): the scan and the publishes by
 * social-service, the model calls and Jev by chat-service, the render by content-generation.
 *
 * Shape: three decisions (`decide-day`, `check-solid`, `check-ship`) are SIBLING top-level branchones, each pinned by
 * a convergence edge from `check-day` (`nodeToModule` builds a condition nested in a branch as an ordinary module,
 * which silently does nothing); every arm reads positive evidence with `?.`, because on another path the node it
 * reads never ran.
 */
import { withIndustryUpdateVideoDeclaration } from "./industry-update-video-outcome.js";
import type { DAG } from "./dag-validator.js";
import { CHAT_STEP_MAX_TOKENS } from "./ai-meeting-booking-dag.js";
import {
  INDUSTRY_NAME,
  MAX_CANDIDATES,
  MAX_STORIES,
  MIN_SOLID_STORIES,
  PICK_RESPONSE_SCHEMA,
  PICK_SYSTEM_PROMPT,
  SOLID_NEWS_CRITERIA,
  SOLID_NEWS_QUESTION,
  SOLID_THRESHOLD,
  WRITE_RESPONSE_SCHEMA,
  WRITE_SYSTEM_PROMPT,
} from "./industry-update-editorial.js";

export const SOCIAL_POST_FEATURE_SLUG = "social-post";

/** The step the video produces (features-service catalogue, 2026-10-12). */
export const INDUSTRY_UPDATE_STEP_KEY = "industry_update_video";

export const INDUSTRY_UPDATE_LEG_KEY = "start_to_industry_update_video";

export const INDUSTRY_UPDATE_PIPE_ID = `${SOCIAL_POST_FEATURE_SLUG}|${INDUSTRY_UPDATE_LEG_KEY}`;

export const INDUSTRY_UPDATE_DESCRIPTION =
  "Once a day, picks the top stories in Revenue Automation & Done-For-You (at least two, else nothing that day), renders a news bulletin video and publishes it once on X and once on LinkedIn, tagging every person and company named.";

/** The model the picks and the copy are written with, through chat-service. */
export const INDUSTRY_UPDATE_LLM = { provider: "anthropic", model: "opus" } as const;

/** UTC hours [from, to) in which a live run may build today's bulletin. */
export const PUBLISH_WINDOW_UTC = [12, 14] as const;

/** How far back the scan reads. */
export const SCAN_WINDOW_HOURS = 36;

/** The accounts each network publishes from (social-service `account`). */
export const PUBLISH_ACCOUNTS = { x: "kevin", linkedin: "linkedin-kevin" } as const;

/** The render's long-poll (content-generation caps one GET at 240 s, under the platform's 300 s timeout). */
export const RENDER_WAIT_SECONDS = 240;
export const RENDER_WAIT_ATTEMPTS = 10;

/** The box scheduler publishes due posts every 5 minutes: ask once a minute, for 20 minutes. */
export const PUBLISH_WAIT_ATTEMPTS = 20;
export const PUBLISH_WAIT_DELAY_SECONDS = 60;

/**
 * The day's plan: dry run or live, the day, whether a live run may build now, and the read of this campaign's
 * posts on the step.
 */
export const PLAN_DAY_CODE = `
export async function main(dryRun, campaignId, currentDate) {
  const dry = dryRun === true || dryRun === "true";
  const date = typeof currentDate === "string" && /^\\d{4}-\\d{2}-\\d{2}$/.test(currentDate) ? currentDate : new Date().toISOString().slice(0, 10);
  const hour = new Date().getUTCHours();
  const inWindow = hour >= ${PUBLISH_WINDOW_UTC[0]} && hour < ${PUBLISH_WINDOW_UTC[1]};
  const campaign = typeof campaignId === "string" && campaignId ? campaignId : null;
  if (!dry && !campaign) throw new Error("plan-day: a live run needs its campaign (a staff run without one must say dryRun: true)");
  const query = { stepKey: "${INDUSTRY_UPDATE_STEP_KEY}", limit: "50" };
  if (campaign) query.campaignId = campaign;
  const scope = campaign ?? "dry-run";
  return {
    dryRun: dry,
    date,
    inWindow,
    query,
    publishKeys: {
      x: "industry-update:" + scope + ":" + date + ":x",
      linkedin: "industry-update:" + scope + ":" + date + ":linkedin",
    },
  };
}
`.trim();

/**
 * Is today's bulletin owed, and which stories ran lately (never twice). A dry run always proceeds and publishes
 * nothing.
 */
export const CHECK_DAY_CODE = `
export async function main(plan, recent) {
  const posts = Array.isArray(recent?.posts) ? recent.posts : [];
  const gone = new Set(["failed", "cancelled", "deleted"]);
  const today = posts.filter((p) => String(p.createdAt ?? "").slice(0, 10) === plan.date && !gone.has(p.status));
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const covered = posts
    .filter((p) => p.platform === "linkedin" && !gone.has(p.status) && Date.parse(p.createdAt) >= weekAgo)
    .map((p) => String(p.createdAt).slice(0, 10) + ": " + String(p.text ?? "").slice(0, 1200));
  const date = plan.date;
  if (plan.dryRun) return { proceed: true, reason: "dry_run", covered, date };
  if (today.length > 0) {
    console.log("[industry-update] today's bulletin is already made (" + today.map((p) => p.platform + " " + p.status).join(", ") + ")");
    return { proceed: false, reason: "already_made_today", covered, date };
  }
  if (!plan.inWindow) return { proceed: false, reason: "outside_publish_window", covered, date };
  return { proceed: true, reason: "owed", covered, date };
}
`.trim();

/**
 * The model's input for the PICK: today's X and LinkedIn candidates (the only ones that can be shown as a post card),
 * each with the post reference the render needs, and the stories already covered.
 */
export const COMPOSE_PICK_CODE = `
export async function main(scan, day) {
  const s = scan?.scan ?? {};
  const all = Array.isArray(s.candidates) ? s.candidates : [];
  const postRef = (c) => {
    if (c.network === "x") {
      const id = String(c.postId ?? "").match(/^\\d{5,25}$/) ? String(c.postId) : (String(c.url ?? "").match(/status\\/(\\d{5,25})/) ?? [])[1];
      return id ? { platform: "x", tweetId: id } : null;
    }
    if (c.network === "linkedin") {
      const hay = String(c.postId ?? "") + " " + String(c.url ?? "");
      const id = (hay.match(/activity[:-](\\d{10,25})/) ?? [])[1] ?? (String(c.postId ?? "").match(/^\\d{10,25}$/) ?? [])[0];
      return id ? { platform: "linkedin", activityId: id } : null;
    }
    return null;
  };
  const candidates = all
    .map((c, i) => ({ c, post: postRef(c), key: "c" + (i + 1) }))
    .filter((x) => x.post !== null)
    .map(({ c, post, key }) => ({
      key,
      url: c.url,
      network: c.network,
      author: c.author ?? null,
      publishedAt: c.publishedAt ?? null,
      engagement: c.engagement ?? null,
      companies: c.companies ?? [],
      text: String(c.text ?? ""),
      post,
    }));
  const message = [
    "TODAY: " + day.date,
    "",
    "ALREADY COVERED (recent bulletins, never pick these stories again):",
    ...(day.covered?.length ? day.covered : ["(none)"]),
    "",
    "TODAY'S POSTS (" + candidates.length + " of " + all.length + " scanned items can be shown as a post card):",
    ...candidates.map((c) => [
      "--- id: " + c.key + " | " + c.network + " | author: " + (c.author ?? "?") + " | engagement: " + (c.engagement ?? "?") + " | companies: " + (c.companies.join(", ") || "-"),
      c.text.slice(0, 3000),
    ].join("\\n")),
  ].join("\\n");
  return {
    systemPrompt: ${JSON.stringify(PICK_SYSTEM_PROMPT)},
    message,
    candidates,
    postsRead: Number(s.rawCount) > 0 ? Number(s.rawCount) : all.length,
  };
}
`.trim();

/**
 * Holds the picks to their contract (a known candidate, a spotlight found verbatim in its text, no story twice) and
 * builds the Jev request: one yes/no question per pick.
 */
export const COMPOSE_JUDGE_CODE = `
export async function main(pickInput, pick) {
  const byKey = new Map((pickInput?.candidates ?? []).map((c) => [c.key, c]));
  const norm = (t) => String(t ?? "").replace(/[\\u2018\\u2019]/g, "'").replace(/[\\u201C\\u201D]/g, '"').replace(/\\s+/g, " ").trim();
  const seen = new Set();
  const picks = [];
  for (const p of pick?.json?.picks ?? []) {
    const c = byKey.get(p.candidateId);
    if (!c) { console.error("[industry-update] pick names no candidate: " + p.candidateId); continue; }
    if (seen.has(c.key)) continue;
    if (!norm(c.text).includes(norm(p.spotlight)) || norm(p.spotlight).length < 3) {
      console.error("[industry-update] dropped " + c.key + ": its spotlight is not verbatim in the post: " + JSON.stringify(p.spotlight));
      continue;
    }
    seen.add(c.key);
    picks.push({ ...p, candidate: c });
    if (picks.length >= ${MAX_CANDIDATES}) break;
  }
  const questions = {};
  picks.forEach((p, i) => {
    questions["s" + (i + 1)] = {
      type: "noul",
      instructions: ${JSON.stringify(SOLID_NEWS_QUESTION)} + " Judge story s" + (i + 1) + ".",
      criteria: ${JSON.stringify(SOLID_NEWS_CRITERIA)},
    };
  });
  const state = picks.map((p, i) => ({
    story: "s" + (i + 1),
    company: p.company,
    relation: p.relation,
    whatIsNew: p.whyNews,
    spotlight: p.spotlight,
    post: p.candidate.text.slice(0, 2500),
  }));
  return { picks, questions, state, questionCount: picks.length };
}
`.trim();

/** Keeps the solid picks in the model's order, at most MAX_STORIES; `enough` = at least MIN_SOLID_STORIES. */
export const KEEP_SOLID_CODE = `
export async function main(judgeInput, judge) {
  const picks = judgeInput?.picks ?? [];
  const answers = judge?.answers ?? {};
  const kept = [];
  const verdicts = [];
  picks.forEach((p, i) => {
    const yes = answers["s" + (i + 1)]?.noul;
    if (picks.length > 0 && typeof yes !== "number") throw new Error("keep-solid: Jev returned no answer for story s" + (i + 1));
    verdicts.push(p.candidate.key + "=" + yes.toFixed(2));
    if (yes >= ${SOLID_THRESHOLD} && kept.length < ${MAX_STORIES}) kept.push(p);
  });
  console.log("[industry-update] solid news: " + (verdicts.join(", ") || "no picks") + " -> kept " + kept.length);
  return { stories: kept, count: kept.length, enough: kept.length >= ${MIN_SOLID_STORIES} };
}
`.trim();

/** The model's input for the WRITE: the kept stories, their posts and authors. */
export const COMPOSE_WRITE_CODE = `
export async function main(solid, day) {
  const stories = solid?.stories ?? [];
  if (stories.length < ${MIN_SOLID_STORIES}) throw new Error("compose-write: fewer than ${MIN_SOLID_STORIES} solid stories reached the writer");
  const message = [
    "TODAY: " + day.date,
    "",
    ...stories.map((s, i) => [
      "=== STORY " + (i + 1) + " | candidateId: " + s.candidate.key + " | " + s.candidate.network + " post by " + (s.candidate.network === "x" && s.candidate.author ? "X handle @" + String(s.candidate.author).replace(/^@/, "") + " (name them by the full name their post or bio shows, and give this handle as their xHandle)" : (s.candidate.author ?? "?")) + " | company in the news: " + s.company + " | relation: " + s.relation,
      "Spotlit sentence: " + s.spotlight,
      "Post URL: " + s.candidate.url,
      "Post:",
      s.candidate.text.slice(0, 4000),
    ].join("\\n")),
  ].join("\\n\\n");
  return { systemPrompt: ${JSON.stringify(WRITE_SYSTEM_PROMPT)}, message };
}
`.trim();

/**
 * Holds the copy to its contract and builds the render request and the two posts. Throws on a broken contract
 * (a story missing, a field too long for the screen, an @ in the X text) rather than shipping a half bulletin.
 * No em or en dash ever reaches the screen or a post: rewritten (between digits a hyphen, otherwise a comma).
 */
export const BUILD_BULLETIN_CODE = `
export async function main(solid, write, pickInput, day, plan) {
  const json = write?.json ?? {};
  const undash = (s) => String(s ?? "")
    .replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-")
    .replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ")
    .trim();
  const fit = (label, v, max) => {
    const t = undash(v);
    if (!t) throw new Error("build-bulletin: " + label + " is empty");
    if (t.length > max) throw new Error("build-bulletin: " + label + " is " + t.length + " characters, the screen holds " + max + ": " + JSON.stringify(t));
    return t;
  };
  const copyByKey = new Map((json.stories ?? []).map((s) => [s.candidateId, s]));
  const stories = (solid?.stories ?? []).map((s, i) => {
    const c = copyByKey.get(s.candidate.key);
    if (!c) throw new Error("build-bulletin: the writer returned no copy for story " + (i + 1) + " (" + s.candidate.key + ")");
    return {
      post: s.candidate.post,
      spotlight: [s.spotlight],
      kicker: fit("story " + (i + 1) + " kicker", c.kicker, 40),
      headline: fit("story " + (i + 1) + " headline", c.headline, 140),
      poster: {
        relation: s.relation,
        role: fit("story " + (i + 1) + " role", c.role, 60),
        about: fit("story " + (i + 1) + " about", c.about, 120),
      },
      why: fit("story " + (i + 1) + " why", c.why, 140),
      note: fit("story " + (i + 1) + " note", c.note, 160),
      take: fit("story " + (i + 1) + " take", c.take, 140),
    };
  });

  const xText = undash(json.xText);
  if (!xText) throw new Error("build-bulletin: the X text is empty");
  if (/@\\w/.test(xText)) throw new Error("build-bulletin: the X text mentions someone (X refuses it; tags go in the reply): " + JSON.stringify(xText));
  if (/https?:\\/\\//.test(xText)) throw new Error("build-bulletin: the X text carries a link (links go in the reply)");
  if ([...xText].length > 280) throw new Error("build-bulletin: the X text is " + [...xText].length + " characters, X holds 280");
  let linkedinText = undash(json.linkedinText);
  if (!linkedinText) throw new Error("build-bulletin: the LinkedIn text is empty");
  if (!/Get started: distribute\\.you\\s*$/.test(linkedinText)) linkedinText = linkedinText.replace(/\\s+$/, "") + "\\n\\nGet started: distribute.you";

  // Tags: every entity the writer named, plus the author of each X post by its handle.
  const tags = [];
  const seenTag = new Set();
  const addTag = (t) => {
    const k = t.kind + ":" + t.name.toLowerCase();
    if (!t.name || seenTag.has(k)) return;
    seenTag.add(k);
    tags.push(t);
  };
  for (const e of json.entities ?? []) {
    const name = undash(e.name);
    if (!name) continue;
    const t = { name, kind: e.kind === "company" ? "company" : "person" };
    const h = String(e.xHandle ?? "").trim().replace(/^@/, "");
    if (/^\\w{1,15}$/.test(h)) t.xHandle = h;
    const li = String(e.linkedinUrl ?? "").trim();
    if (/^https:\\/\\/(www\\.)?linkedin\\.com\\/(company|in)\\//.test(li)) t.linkedinUrl = li;
    addTag(t);
  }
  // The author of an X post is tagged by their handle even when the writer left them out.
  for (const s of solid.stories) {
    const h = s.candidate.network === "x" && s.candidate.author ? String(s.candidate.author).replace(/^@/, "") : null;
    if (h && !tags.some((t) => (t.xHandle ?? "").toLowerCase() === h.toLowerCase())) addTag({ name: h, kind: "person", xHandle: h });
  }
  const links = solid.stories.map((s) => s.candidate.url);
  const xReply = ["Links:", ...links, "Credit to the people behind today's stories.", "Get started: distribute.you"].join("\\n\\n");
  const linkedinComment = ["Links to every post:", ...links].join("\\n\\n");

  const storyKey = solid.stories.map((s) => s.candidate.key + ":" + s.spotlight).join("|");
  let h = 0;
  for (const ch of storyKey) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    render: {
      date: day.date,
      scan: { postsRead: pickInput.postsRead, windowHours: ${SCAN_WINDOW_HOURS} },
      stories,
      idempotencyKey: "industry-update:" + (plan.query.campaignId ?? "dry-run") + ":" + day.date + ":" + h.toString(36),
    },
    x: { text: xText, reply: xReply },
    linkedin: { text: linkedinText, reply: linkedinComment },
    tags,
  };
}
`.trim();

/** What a dry run hands back: the video and the two drafts, nothing published. */
export const DRY_SUMMARY_CODE = `
export async function main(render, bulletin) {
  return {
    dryRun: true,
    published: false,
    videoUrl: render?.videoUrl ?? null,
    durationSeconds: render?.durationSeconds ?? null,
    x: bulletin.x,
    linkedin: bulletin.linkedin,
    tags: bulletin.tags,
  };
}
`.trim();

/**
 * POST-PUBLISHED-TELEGRAM-1014 (owner 2026-10-14: "Tu peux me notifier d'un message sur Telegram quand c'est
 * posté ? (Inclus ça dans le workflow of course)"): once a post is PUBLISHED, the owner of the org the run acts for
 * gets ONE short Telegram line per post (where, the link, one line of what it says) through client-service, which
 * owns who an org's owner is and whether their Telegram is reachable. The line is a side note: the call tolerates
 * failure (never fails the run that published), and `report-notify` logs loudly anything but a delivered line.
 */
export const OWNER_TELEGRAM = { service: "client", method: "POST", path: "/internal/orgs/{orgId}/owner-telegram/messages" } as const;

const NETWORK_LABEL = { x: "X", linkedin: "LinkedIn" } as const;

/** Longest "what it says" line. */
export const NOTIFY_LINE_MAX = 160;

/**
 * One post's Telegram line: where, the link, the first line of what it says (never a bare link line). Never throws:
 * `wait-<network>` already proved the post published, and a throw here would fail a run that published.
 */
export const composeNotifyCode = (network: "x" | "linkedin"): string => `
export async function main(published) {
  const post = published?.post;
  const line = String(post?.text ?? "").split("\\n").map((l) => l.trim()).find((l) => l && !/^https?:\\/\\//.test(l)) ?? "";
  const said = line.length > ${NOTIFY_LINE_MAX} ? line.slice(0, ${NOTIFY_LINE_MAX - 3}).trimEnd() + "..." : line;
  const text = ["Posted on ${NETWORK_LABEL[network]}: " + (post?.postUrl ?? "no link returned"), said].filter(Boolean).join("\\n");
  return { network: "${network}", postId: post?.id ?? null, postUrl: post?.postUrl ?? null, text };
}
`.trim();

export const REPORT_NOTIFY_CODE = `
export async function main(x, linkedin, notifyX, notifyLinkedin) {
  const outcome = (compose, sent) => {
    const delivered = sent?.outcome === "sent";
    if (!delivered) console.error("[industry-update] owner Telegram line NOT delivered for " + compose?.network + " post " + compose?.postUrl + ": " + JSON.stringify(sent));
    return { network: compose?.network, postUrl: compose?.postUrl ?? null, delivered, answer: sent ?? null };
  };
  return { published: true, notified: [outcome(x, notifyX), outcome(linkedin, notifyLinkedin)] };
}
`.trim();

const composeNotify = (network: "x" | "linkedin") => ({
  id: `compose-notify-${network}`,
  type: "script" as const,
  config: { code: composeNotifyCode(network) },
  retries: 0,
  inputMapping: { published: `$ref:wait-${network}.output` },
});

const notifyOwner = (network: "x" | "linkedin") => ({
  id: `notify-${network}`,
  type: "http.call" as const,
  config: { ...OWNER_TELEGRAM, tolerateFailure: true },
  retries: 0,
  inputMapping: {
    "params.orgId": "$ref:flow_input.orgId",
    "body.text": `$ref:compose-notify-${network}.output.text`,
  },
});

const END_RUN_SKIP_ON_DRY = "flow_input.dryRun === true || flow_input.dryRun === 'true'";

const endRun = (id: string, body: Record<string, unknown>) => ({
  id,
  type: "http.call" as const,
  config: { service: "campaign", method: "POST", path: "/end-run", body, skipIf: END_RUN_SKIP_ON_DRY },
  retries: 0,
});

const chatComplete = (id: string, responseSchema: unknown, from: string) => ({
  id,
  type: "http.call" as const,
  config: {
    service: "chat",
    method: "POST",
    path: "/complete",
    body: {
      provider: INDUSTRY_UPDATE_LLM.provider,
      model: INDUSTRY_UPDATE_LLM.model,
      responseFormat: "json",
      responseSchema,
      maxTokens: CHAT_STEP_MAX_TOKENS,
    },
  },
  retries: 0,
  inputMapping: {
    "body.message": `$ref:${from}.output.message`,
    "body.systemPrompt": `$ref:${from}.output.systemPrompt`,
  },
});

const publish = (id: string, network: "x" | "linkedin") => ({
  id,
  type: "http.call" as const,
  config: {
    service: "social",
    method: "POST",
    path: "/internal/social-posts",
    body: {
      account: PUBLISH_ACCOUNTS[network],
      stepKey: INDUSTRY_UPDATE_STEP_KEY,
      ...(network === "linkedin" ? { mediaTitle: `${INDUSTRY_NAME}: what we spotted today` } : {}),
    },
  },
  retries: 0,
  inputMapping: {
    "body.idempotencyKey": `$ref:plan-day.output.publishKeys.${network}`,
    "body.text": `$ref:build-bulletin.output.${network}.text`,
    "body.reply": `$ref:build-bulletin.output.${network}.reply`,
    "body.tags": "$ref:build-bulletin.output.tags",
    "body.mediaUrls": "$ref:render-media.output.mediaUrls",
  },
});

const waitPublished = (id: string, from: string) => ({
  id,
  type: "http.call" as const,
  config: {
    service: "social",
    method: "GET",
    path: "/internal/social-posts/{id}",
    validateResponse: { field: "post.status", equals: "published" },
    retryDelaySeconds: PUBLISH_WAIT_DELAY_SECONDS,
  },
  retries: PUBLISH_WAIT_ATTEMPTS,
  inputMapping: { "params.id": `$ref:${from}.output.post.id` },
});

export const RENDER_MEDIA_CODE = `
export async function main(render) {
  if (render?.status !== "done" || !render?.videoUrl) throw new Error("render-media: the render is not done (" + String(render?.status) + ")");
  return { mediaUrls: [render.videoUrl] };
}
`.trim();

const DAY = "results['check-day']";
const SOLID = "results['keep-solid']";
const RENDER = "results['render-wait']";
const DRY = "results['plan-day']?.dryRun";

/** The bulletin's DAG; once its first post is published the run declares the video it produced (LEDGER-HISTORY-1024). */
export function buildIndustryUpdateVideoDag(): DAG {
  return withIndustryUpdateVideoDeclaration(buildBulletinDag());
}

function buildBulletinDag(): DAG {
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/gate-check",
          stopAfterIf: "result.allowed == false",
          skipIf: END_RUN_SKIP_ON_DRY,
        },
      },
      {
        id: "start-run",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/start-run", skipIf: END_RUN_SKIP_ON_DRY },
      },
      {
        id: "plan-day",
        type: "script",
        config: { code: PLAN_DAY_CODE },
        retries: 0,
        inputMapping: {
          dryRun: "$ref:flow_input.dryRun",
          campaignId: "$ref:flow_input.campaignId",
          currentDate: "$ref:flow_input.currentDate",
        },
      },
      {
        id: "recent-posts",
        type: "http.call",
        config: { service: "social", method: "GET", path: "/internal/social-posts" },
        inputMapping: { query: "$ref:plan-day.output.query" },
      },
      {
        id: "check-day",
        type: "script",
        config: { code: CHECK_DAY_CODE },
        retries: 0,
        inputMapping: { plan: "$ref:plan-day.output", recent: "$ref:recent-posts.output" },
      },
      { id: "decide-day", type: "condition" },
      endRun("end-run-idle", { success: true, stopCampaign: false, noWorkAvailable: true }),
      {
        id: "scan-news",
        type: "http.call",
        config: { service: "social", method: "POST", path: "/internal/industry-news/scans", body: { hours: SCAN_WINDOW_HOURS } },
        retries: 1,
      },
      {
        id: "compose-pick",
        type: "script",
        config: { code: COMPOSE_PICK_CODE },
        retries: 0,
        inputMapping: { scan: "$ref:scan-news.output", day: "$ref:check-day.output" },
      },
      chatComplete("pick-stories", PICK_RESPONSE_SCHEMA, "compose-pick"),
      {
        id: "compose-judge",
        type: "script",
        config: { code: COMPOSE_JUDGE_CODE },
        retries: 0,
        inputMapping: { pickInput: "$ref:compose-pick.output", pick: "$ref:pick-stories.output" },
      },
      {
        id: "judge-stories",
        type: "http.call",
        config: {
          service: "chat",
          method: "POST",
          path: "/orgs/judgments",
          skipIf: "results.compose_judge.questionCount == 0",
        },
        retries: 1,
        inputMapping: {
          "body.state": "$ref:compose-judge.output.state",
          "body.questions": "$ref:compose-judge.output.questions",
        },
      },
      {
        id: "keep-solid",
        type: "script",
        config: { code: KEEP_SOLID_CODE },
        retries: 0,
        inputMapping: { judgeInput: "$ref:compose-judge.output", judge: "$ref:judge-stories.output" },
      },
      { id: "check-solid", type: "condition" },
      endRun("end-run-thin", { success: true, stopCampaign: false, noWorkAvailable: true }),
      {
        id: "compose-write",
        type: "script",
        config: { code: COMPOSE_WRITE_CODE },
        retries: 0,
        inputMapping: { solid: "$ref:keep-solid.output", day: "$ref:check-day.output" },
      },
      chatComplete("write-copy", WRITE_RESPONSE_SCHEMA, "compose-write"),
      {
        id: "build-bulletin",
        type: "script",
        config: { code: BUILD_BULLETIN_CODE },
        retries: 0,
        inputMapping: {
          solid: "$ref:keep-solid.output",
          write: "$ref:write-copy.output",
          pickInput: "$ref:compose-pick.output",
          day: "$ref:check-day.output",
          plan: "$ref:plan-day.output",
        },
      },
      {
        id: "render-start",
        type: "http.call",
        config: { service: "content-generation", method: "POST", path: "/industry-debrief-videos" },
        retries: 1,
        inputMapping: { body: "$ref:build-bulletin.output.render" },
      },
      {
        id: "render-wait",
        type: "http.call",
        config: {
          service: "content-generation",
          method: "GET",
          path: "/industry-debrief-videos/{id}",
          query: { waitSeconds: String(RENDER_WAIT_SECONDS) },
          validateResponse: { field: "status", equals: "done" },
        },
        retries: RENDER_WAIT_ATTEMPTS,
        inputMapping: { "params.id": "$ref:render-start.output.id" },
      },
      { id: "check-ship", type: "condition" },
      {
        id: "dry-summary",
        type: "script",
        config: { code: DRY_SUMMARY_CODE },
        retries: 0,
        inputMapping: { render: "$ref:render-wait.output", bulletin: "$ref:build-bulletin.output" },
      },
      {
        id: "render-media",
        type: "script",
        config: { code: RENDER_MEDIA_CODE },
        retries: 0,
        inputMapping: { render: "$ref:render-wait.output" },
      },
      publish("publish-x", "x"),
      publish("publish-linkedin", "linkedin"),
      waitPublished("wait-x", "publish-x"),
      composeNotify("x"),
      notifyOwner("x"),
      waitPublished("wait-linkedin", "publish-linkedin"),
      composeNotify("linkedin"),
      notifyOwner("linkedin"),
      {
        id: "report-notify",
        type: "script",
        config: { code: REPORT_NOTIFY_CODE },
        retries: 0,
        inputMapping: {
          x: "$ref:compose-notify-x.output",
          linkedin: "$ref:compose-notify-linkedin.output",
          notifyX: "$ref:notify-x.output",
          notifyLinkedin: "$ref:notify-linkedin.output",
        },
      },
      endRun("end-run", { success: true, stopCampaign: false }),
      {
        id: "end-run-error",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/end-run", body: { success: false, stopCampaign: false } },
        retries: 0,
      },
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "plan-day" },
      { from: "plan-day", to: "recent-posts" },
      { from: "recent-posts", to: "check-day" },
      { from: "check-day", to: "decide-day" },
      { from: "decide-day", to: "end-run-idle", condition: `${DAY}?.proceed == false` },
      { from: "decide-day", to: "scan-news", condition: `${DAY}?.proceed == true` },
      { from: "scan-news", to: "compose-pick" },
      { from: "compose-pick", to: "pick-stories" },
      { from: "pick-stories", to: "compose-judge" },
      { from: "compose-judge", to: "judge-stories" },
      { from: "judge-stories", to: "keep-solid" },
      // Converges (edge from check-day, outside decide-day's branches) so it is top level.
      { from: "keep-solid", to: "check-solid" },
      { from: "check-day", to: "check-solid" },
      { from: "check-solid", to: "end-run-thin", condition: `${SOLID}?.enough == false` },
      { from: "check-solid", to: "compose-write", condition: `${SOLID}?.enough == true` },
      { from: "compose-write", to: "write-copy" },
      { from: "write-copy", to: "build-bulletin" },
      { from: "build-bulletin", to: "render-start" },
      { from: "render-start", to: "render-wait" },
      // Converges (edge from check-day) so it is top level.
      { from: "render-wait", to: "check-ship" },
      { from: "check-day", to: "check-ship" },
      { from: "check-ship", to: "dry-summary", condition: `${RENDER}?.status == 'done' && ${DRY} == true` },
      { from: "check-ship", to: "render-media", condition: `${RENDER}?.status == 'done' && ${DRY} == false` },
      { from: "render-media", to: "publish-x" },
      { from: "publish-x", to: "publish-linkedin" },
      { from: "publish-linkedin", to: "wait-x" },
      // Each post's owner line goes out as soon as THAT post is published (an X line is not held by LinkedIn).
      { from: "wait-x", to: "compose-notify-x" },
      { from: "compose-notify-x", to: "notify-x" },
      { from: "notify-x", to: "wait-linkedin" },
      { from: "wait-linkedin", to: "compose-notify-linkedin" },
      { from: "compose-notify-linkedin", to: "notify-linkedin" },
      { from: "notify-linkedin", to: "report-notify" },
      { from: "report-notify", to: "end-run" },
    ],
    onError: "end-run-error",
  };
}
