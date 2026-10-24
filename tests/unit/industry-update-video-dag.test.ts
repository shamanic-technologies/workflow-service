import { describe, it, expect } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  BUILD_BULLETIN_CODE,
  CHECK_DAY_CODE,
  COMPOSE_JUDGE_CODE,
  COMPOSE_PICK_CODE,
  INDUSTRY_UPDATE_PIPE_ID,
  KEEP_SOLID_CODE,
  PLAN_DAY_CODE,
  PUBLISH_WAIT_DELAY_SECONDS,
  OWNER_TELEGRAM,
  REPORT_NOTIFY_CODE,
  buildIndustryUpdateVideoDag,
  composeNotifyCode,
} from "../../src/lib/industry-update-video-dag.js";
import { PICK_RESPONSE_SCHEMA, WRITE_RESPONSE_SCHEMA } from "../../src/lib/industry-update-editorial.js";

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

function holds(condition: string, results: Record<string, unknown>): boolean {
  return new Function("results", `return (${condition});`)(results) as boolean;
}

type Mod = {
  id: string;
  retry?: { constant: { attempts: number; seconds: number } };
  skip_if?: { expr: string };
  value: { type: string; branches?: { modules: Mod[] }[]; input_transforms?: Record<string, { type: string; value?: unknown; expr?: string }> };
};
const allModules = (mods: Mod[]): Mod[] => mods.flatMap((m) => [m, ...(m.value.branches ?? []).flatMap((b) => allModules(b.modules))]);

/** Every object an Anthropic strict schema reads must close itself and require every property. */
function assertStrict(schema: any, path = "$"): void {
  if (schema?.type === "object") {
    expect(schema.additionalProperties, path).toBe(false);
    expect([...schema.required].sort(), path).toEqual(Object.keys(schema.properties).sort());
    for (const [k, v] of Object.entries(schema.properties)) assertStrict(v, `${path}.${k}`);
  }
  if (schema?.type === "array") assertStrict(schema.items, `${path}[]`);
}

const today = new Date().toISOString().slice(0, 10);

describe("industry update video DAG (Social post pipe)", () => {
  const dag = buildIndustryUpdateVideoDag();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const flow = dagToOpenFlow(dag, "industry-update-test");
  const mods = allModules(flow.value.modules as Mod[]);
  const mod = (id: string) => mods.find((m) => m.id === id.replace(/-/g, "_"))!;

  it("runs on the Social post pipe, leg Start -> Industry update video", () => {
    expect(INDUSTRY_UPDATE_PIPE_ID).toBe("social-post|start_to_industry_update_video");
  });

  it("is a valid DAG that translates to Windmill, every script exporting main", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    for (const n of dag.nodes.filter((x) => x.type === "script")) expect(n.config?.code).toContain("export async function main");
  });

  it("emits its three decisions as top-level branchones, never nested where they would silently do nothing", () => {
    const top = (flow.value.modules as Mod[]).filter((m) => m.value.type === "branchone");
    expect(top.map((m) => m.id)).toEqual(["decide_day", "check_solid", "check_ship"]);
    for (const e of dag.edges.filter((x) => x.condition)) expect(e.condition).toContain("?.");
  });

  it("only ever publishes on a live run whose render is done, and a dry run reaches the drafts instead", () => {
    const live = dag.edges.find((e) => e.from === "check-ship" && e.to === "render-media")!.condition!;
    const dry = dag.edges.find((e) => e.from === "check-ship" && e.to === "dry-summary")!.condition!;
    const done = { "render-wait": { status: "done" } };
    expect(holds(live, { ...done, "plan-day": { dryRun: false } })).toBe(true);
    expect(holds(live, { ...done, "plan-day": { dryRun: true } })).toBe(false);
    expect(holds(dry, { ...done, "plan-day": { dryRun: true } })).toBe(true);
    // Idle and thin paths: the render never ran, nothing is published.
    expect(holds(live, { "plan-day": { dryRun: false } })).toBe(false);
    expect(holds(dry, { "plan-day": { dryRun: true } })).toBe(false);
  });

  it("skips the campaign chassis on a dry run and keeps it on a live one", () => {
    for (const id of ["gate-check", "start-run", "end-run", "end-run-idle", "end-run-thin"]) {
      const expr = mod(id).skip_if!.expr;
      expect(new Function("flow_input", `return (${expr});`)({ dryRun: true })).toBe(true);
      expect(new Function("flow_input", `return (${expr});`)({})).toBe(false);
    }
  });

  it("publishes once per network with a per-day key, the step, the video, and waits for each post with a minute between asks", () => {
    for (const [id, account] of [["publish-x", "kevin"], ["publish-linkedin", "linkedin-kevin"]] as const) {
      const n = byId.get(id)!;
      expect(n.config).toMatchObject({ service: "social", method: "POST", path: "/internal/social-posts", body: { account, stepKey: "industry_update_video" } });
      expect(n.inputMapping!["body.idempotencyKey"]).toMatch(/^\$ref:plan-day\.output\.publishKeys\./);
      expect(n.inputMapping!["body.mediaUrls"]).toBe("$ref:render-media.output.mediaUrls");
    }
    for (const id of ["wait-x", "wait-linkedin"]) {
      expect(byId.get(id)!.config!.validateResponse).toEqual({ field: "post.status", equals: "published" });
      expect(mod(id).retry!.constant.seconds).toBe(PUBLISH_WAIT_DELAY_SECONDS);
      expect(mod(id).value.input_transforms!.retryDelaySeconds).toBeUndefined();
    }
    expect(mod("scan-news").retry!.constant.seconds).toBe(5);
  });

  it("long-polls the render until it is done", () => {
    const n = byId.get("render-wait")!;
    expect(n.config).toMatchObject({ service: "content-generation", path: "/industry-debrief-videos/{id}", validateResponse: { field: "status", equals: "done" } });
  });

  it("gives Anthropic strict schemas for both model calls", () => {
    assertStrict(PICK_RESPONSE_SCHEMA);
    assertStrict(WRITE_RESPONSE_SCHEMA);
  });
});

describe("plan-day / check-day", () => {
  it("a live run without a campaign fails loud; a dry run needs none", async () => {
    await expect(loadMain(PLAN_DAY_CODE)(undefined, "", today)).rejects.toThrow(/needs its campaign/);
    const dry = await loadMain(PLAN_DAY_CODE)(true, "", today);
    expect(dry).toMatchObject({ dryRun: true, date: today, query: { stepKey: "industry_update_video" } });
    expect(dry.query.campaignId).toBeUndefined();
    const live = await loadMain(PLAN_DAY_CODE)("", "11111111-1111-1111-1111-111111111111", today);
    expect(live.publishKeys).toEqual({
      x: `industry-update:11111111-1111-1111-1111-111111111111:${today}:x`,
      linkedin: `industry-update:11111111-1111-1111-1111-111111111111:${today}:linkedin`,
    });
  });

  it("ends the day once a post was made today, keeps going after a failed one, and stays idle outside the window", async () => {
    const check = loadMain(CHECK_DAY_CODE);
    const plan = { dryRun: false, date: today, inWindow: true };
    const at = `${today}T12:30:00.000Z`;
    expect((await check(plan, { posts: [{ platform: "x", status: "queued", createdAt: at, text: "" }] })).proceed).toBe(false);
    expect((await check(plan, { posts: [{ platform: "x", status: "failed", createdAt: at, text: "" }] })).proceed).toBe(true);
    expect((await check({ ...plan, inWindow: false }, { posts: [] })).reason).toBe("outside_publish_window");
    expect((await check({ ...plan, dryRun: true, inWindow: false }, { posts: [{ platform: "x", status: "published", createdAt: at }] })).proceed).toBe(true);
  });
});

describe("pick -> judge -> keep", () => {
  const scan = {
    scan: {
      rawCount: 589,
      candidates: [
        { id: "u1", url: "https://x.com/jasonlk/status/2109289938692784499", network: "x", postId: "2109289938692784499", author: "jasonlk", text: "Read every one of your AI SDR’s first 1,000 emails. Then spot check." },
        { id: "u2", url: "https://www.linkedin.com/posts/billstath_in-2024-activity-7515370513691697153-Jl1l", network: "linkedin", postId: null, author: "Bill Stathopoulos", text: "In 2024, 30 people ran our outbound research. Now 5 do, with Clay." },
        { id: "u3", url: "https://news.ycombinator.com/item?id=1", network: "hn", text: "Some HN story" },
      ],
    },
  };

  it("offers only posts that can be shown as a card, with the reference the render needs", async () => {
    const out = await loadMain(COMPOSE_PICK_CODE)(scan, { date: today, covered: [] });
    expect(out.candidates.map((c: any) => c.post)).toEqual([
      { platform: "x", tweetId: "2109289938692784499" },
      { platform: "linkedin", activityId: "7515370513691697153" },
    ]);
    expect(out.postsRead).toBe(589);
    expect(out.message).toContain("--- id: c1");
  });

  it("drops a pick whose spotlight is not verbatim in its post, matching curly and straight apostrophes", async () => {
    const pickInput = await loadMain(COMPOSE_PICK_CODE)(scan, { date: today, covered: [] });
    const out = await loadMain(COMPOSE_JUDGE_CODE)(pickInput, {
      json: {
        picks: [
          { candidateId: "c1", spotlight: "Read every one of your AI SDR's first 1,000 emails.", company: "SaaStr", relation: "own", whyNews: "x" },
          { candidateId: "c2", spotlight: "Not in the post at all.", company: "SalesCaptain", relation: "own", whyNews: "y" },
          { candidateId: "c9", spotlight: "nothing", company: "?", relation: "third", whyNews: "z" },
        ],
      },
    });
    expect(out.picks.map((p: any) => p.candidate.key)).toEqual(["c1"]);
    expect(Object.keys(out.questions)).toEqual(["s1"]);
    expect(out.questions.s1.type).toBe("noul");
  });

  it("keeps the solid picks in order, at most three, and says when fewer than two are solid", async () => {
    const keep = loadMain(KEEP_SOLID_CODE);
    const p = (k: string) => ({ candidate: { key: k } });
    const four = { picks: [p("a"), p("b"), p("c"), p("d")] };
    const r = await keep(four, { answers: { s1: { noul: 0.9 }, s2: { noul: 0.2 }, s3: { noul: 0.7 }, s4: { noul: 0.95 } } });
    expect(r.stories.map((s: any) => s.candidate.key)).toEqual(["a", "c", "d"]);
    expect(r.enough).toBe(true);
    const thin = await keep({ picks: [p("a"), p("b")] }, { answers: { s1: { noul: 0.9 }, s2: { noul: 0.1 } } });
    expect(thin.enough).toBe(false);
    expect((await keep({ picks: [] }, undefined)).enough).toBe(false);
  });
});

describe("build-bulletin", () => {
  const solid = {
    stories: [
      { spotlight: "Now 5 do, with Clay.", relation: "own", company: "SalesCaptain", candidate: { key: "c2", network: "linkedin", author: "Bill", url: "https://li/1", post: { platform: "linkedin", activityId: "7515370513691697153" } } },
      { spotlight: "Then spot check.", relation: "own", company: "SaaStr", candidate: { key: "c1", network: "x", author: "jasonlk", url: "https://x/2", post: { platform: "x", tweetId: "2109289938692784499" } } },
    ],
  };
  const copy = (over: Record<string, unknown> = {}) => ({
    json: {
      stories: ["c2", "c1"].map((k) => ({ candidateId: k, kicker: "SalesCaptain", headline: "SalesCaptain replaced 30 researchers with 5 people and Clay", role: "CEO, SalesCaptain", about: "SalesCaptain runs outbound for B2B companies.", why: "AI handles research — humans earn the conversation.", note: "Per his post.", take: "Automate research first." })),
      xText: "2 things we spotted today in Revenue Automation\n\n1. SalesCaptain\n2. SaaStr\n\nWhat did we miss?",
      linkedinText: "2 things we spotted today\n\nWhat did we miss?",
      entities: [
        { name: "Clay", kind: "company", candidateId: "c2", xHandle: "clay", linkedinUrl: "https://www.linkedin.com/company/grow-with-clay" },
        { name: "Bill Stathopoulos", kind: "person", candidateId: "c2", xHandle: "", linkedinUrl: "" },
      ],
      ...over,
    },
  });
  const day = { date: today };
  const plan = { query: { campaignId: "camp-1" } };
  const pickInput = { postsRead: 589 };
  const build = loadMain(BUILD_BULLETIN_CODE);

  it("builds the render request, the two posts and every tag, without a dash on screen", async () => {
    const out = await build(solid, copy(), pickInput, day, plan);
    expect(out.render.stories).toHaveLength(2);
    expect(out.render.stories[0]).toMatchObject({ post: { platform: "linkedin", activityId: "7515370513691697153" }, spotlight: ["Now 5 do, with Clay."], poster: { relation: "own" } });
    expect(out.render.stories[0].why).toBe("AI handles research, humans earn the conversation.");
    expect(out.render.scan).toEqual({ postsRead: 589, windowHours: 36 });
    expect(out.render.idempotencyKey).toMatch(new RegExp(`^industry-update:camp-1:${today}:`));
    expect(out.linkedin.text.endsWith("Get started: distribute.you")).toBe(true);
    expect(out.x.reply).toContain("https://x/2");
    expect(out.tags).toEqual([
      { name: "Clay", kind: "company", xHandle: "clay", linkedinUrl: "https://www.linkedin.com/company/grow-with-clay" },
      { name: "Bill Stathopoulos", kind: "person" },
      { name: "jasonlk", kind: "person", xHandle: "jasonlk" },
    ]);
  });

  it("tells content-generation whether the render is a dry run, so a test is never counted as a delivered video (LEDGER-HISTORY-1024)", async () => {
    expect((await build(solid, copy(), pickInput, day, plan)).render.dryRun).toBe(false);
    expect((await build(solid, copy(), pickInput, day, { ...plan, dryRun: true })).render.dryRun).toBe(true);
  });

  it("tags an X poster under the full name the writer gave, never twice under their handle", async () => {
    const named = copy();
    named.json.entities.push({ name: "Jason Lemkin", kind: "person", candidateId: "c1", xHandle: "jasonlk", linkedinUrl: "" });
    const out = await build(solid, named, pickInput, day, plan);
    expect(out.tags.filter((t: any) => t.xHandle === "jasonlk")).toEqual([{ name: "Jason Lemkin", kind: "person", xHandle: "jasonlk" }]);
  });

  it("refuses an X text X would refuse, and a screen line too long to read", async () => {
    await expect(build(solid, copy({ xText: "Hi @jasonlk" }), pickInput, day, plan)).rejects.toThrow(/mentions someone/);
    await expect(build(solid, copy({ xText: "x".repeat(281) }), pickInput, day, plan)).rejects.toThrow(/X holds 280/);
    const long = copy();
    long.json.stories[0].headline = "a".repeat(141);
    await expect(build(solid, long, pickInput, day, plan)).rejects.toThrow(/headline is 141 characters/);
    await expect(build(solid, copy({ stories: [] }), pickInput, day, plan)).rejects.toThrow(/no copy for story 1/);
  });
});

const DELIVERED_ANSWER = { outcome: "sent", target: "owner", telegramMessageId: 7 };
const NOT_REACHABLE_ANSWER = { outcome: "not_reachable", reason: "This org's owner has not linked a Telegram chat." };

describe("owner Telegram line once a post is published (POST-PUBLISHED-TELEGRAM-1014)", () => {
  const dag = buildIndustryUpdateVideoDag();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const mods = allModules(dagToOpenFlow(dag, "industry-update-test").value.modules as Mod[]);
  const mod = (id: string) => mods.find((m) => m.id === id.replace(/-/g, "_"))!;

  it("sends one line per post right after THAT post is published, then ends the run", () => {
    const next = (from: string) => dag.edges.filter((e) => e.from === from).map((e) => e.to);
    expect(next("wait-x")).toEqual(["compose-notify-x"]);
    expect(next("compose-notify-x")).toEqual(["notify-x"]);
    expect(next("notify-x")).toEqual(["wait-linkedin"]);
    expect(next("wait-linkedin")).toEqual(["compose-notify-linkedin"]);
    expect(next("compose-notify-linkedin")).toEqual(["notify-linkedin"]);
    expect(next("notify-linkedin")).toEqual(["report-notify"]);
    expect(next("report-notify")).toEqual(["end-run"]);
  });

  it("asks client-service for the org owner's Telegram and never fails the run on it", () => {
    for (const n of ["x", "linkedin"]) {
      const node = byId.get(`notify-${n}`)!;
      expect(node.config).toMatchObject({ ...OWNER_TELEGRAM, tolerateFailure: true });
      expect(node.retries).toBe(0);
      expect(node.inputMapping?.["params.orgId"]).toBe("$ref:flow_input.orgId");
      expect(node.inputMapping?.["body.text"]).toBe(`$ref:compose-notify-${n}.output.text`);
      expect(mod(`notify-${n}`).value.input_transforms?.tolerateFailure).toEqual({ type: "static", value: true });
    }
  });

  it("says where, the link, and the first line of what the post says", async () => {
    const compose = loadMain(composeNotifyCode("x"));
    const out = await compose({ post: { id: "p1", status: "published", postUrl: "https://x.com/KevinLourd/status/1", text: "  \nThree things moved in AI sales today.\nMore below\nhttps://x.com/a/status/2" } });
    expect(out).toEqual({ network: "x", postId: "p1", postUrl: "https://x.com/KevinLourd/status/1", text: "Posted on X: https://x.com/KevinLourd/status/1\nThree things moved in AI sales today." });
    const li = await loadMain(composeNotifyCode("linkedin"))({ post: { id: "p2", status: "published", postUrl: "https://www.linkedin.com/feed/update/u", text: "y".repeat(400) } });
    expect(li.text.split("\n")[0]).toBe("Posted on LinkedIn: https://www.linkedin.com/feed/update/u");
    expect(li.text.split("\n")[1]).toHaveLength(160);
    expect(li.text).not.toMatch(/[\u2013\u2014]/);
  });

  it("logs loudly a line that was not delivered, and never throws", async () => {
    const report = loadMain(REPORT_NOTIFY_CODE);
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => errors.push(String(m));
    try {
      const x = { network: "x", postUrl: "https://x.com/1" };
      const li = { network: "linkedin", postUrl: "https://li/1" };
      const out = await report(x, li, DELIVERED_ANSWER, { ok: false, status: 502, error: "boom" });
      expect(out.notified.map((n: any) => n.delivered)).toEqual([true, false]);
      const unreachable = await report(x, li, NOT_REACHABLE_ANSWER, DELIVERED_ANSWER);
      expect(unreachable.notified.map((n: any) => n.delivered)).toEqual([false, true]);
    } finally {
      console.error = orig;
    }
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/NOT delivered for linkedin post https:\/\/li\/1/);
    expect(errors[1]).toMatch(/NOT delivered for x post https:\/\/x.com\/1/);
  });
});
