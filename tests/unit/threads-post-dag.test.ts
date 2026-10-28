import { describe, it, expect } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  CHECK_THREAD_CODE,
  CHECK_TURN_CODE,
  CLASSIFY_MAIN_CODE,
  COMPOSE_WRITE_CODE,
  FINAL_THREAD_CODE,
  MIN_GAP_MINUTES,
  PLAN_RUN_CODE,
  PUBLISH_WINDOW_UTC,
  THREADS_POST_PIPE_ID,
  THREAD_RESPONSE_SCHEMA,
  THREAD_SHAPES,
  buildThreadsPostDag,
} from "../../src/lib/threads-post-dag.js";

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

type Mod = { id: string; value: { type: string; branches?: { modules: Mod[] }[] } };
const allModules = (mods: Mod[]): Mod[] => mods.flatMap((m) => [m, ...(m.value.branches ?? []).flatMap((b) => allModules(b.modules))]);

const ACCOUNTS = [
  { id: "acc-personal", username: "kevin_personal", accountType: "personal_human", accountTypeLabel: "Personal (human)", health: "connected", createdAt: "2026-10-01T00:00:00Z" },
  { id: "acc-ai-1", username: "sophie_ai", accountType: "pro_ai", accountTypeLabel: "Pro (AI)", health: "connected", createdAt: "2026-10-02T00:00:00Z" },
  { id: "acc-ai-dead", username: "dead_ai", accountType: "pro_ai", accountTypeLabel: "Pro (AI)", health: "needs_reconnect", createdAt: "2026-10-03T00:00:00Z" },
  { id: "acc-pro-human", username: "kevin_pro", accountType: "pro_human", accountTypeLabel: "Pro (human)", health: "connected", createdAt: "2026-10-03T12:00:00Z" },
  { id: "acc-ai-2", username: "max_ai", accountType: "pro_ai", accountTypeLabel: "Pro (AI)", health: "connected", createdAt: "2026-10-04T00:00:00Z" },
];

const planAt = (iso: string, dryRun = false) => {
  const now = new Date(iso);
  const hour = now.getUTCHours();
  return { dryRun, campaignId: "camp-1", brandId: "brand-1", offerId: "offer-1", instruction: null, now: now.toISOString(), date: iso.slice(0, 10), inWindow: hour >= PUBLISH_WINDOW_UTC[0] && hour < PUBLISH_WINDOW_UTC[1] };
};

const FACTS = { exact: [{ id: "E1", label: "Positive replies within 24 hours", value: "At least 30% of positive replies arrive within 24 hours" }], neverGive: [] };
const COMPOSE = { getStarted: "Get started: distribute.you", factText: "At least 30% of positive replies arrive within 24 hours\ndistribute.you", message: "M" };

describe("Threads posts DAG (THREADS-CAMPAIGN-1028)", () => {
  const dag = buildThreadsPostDag();
  const flow = dagToOpenFlow(dag, "threads-post-test");
  const mods = allModules(flow.value.modules as Mod[]);

  it("runs on the Threads posts pipe, leg Start -> Post published", () => {
    expect(THREADS_POST_PIPE_ID).toBe("threads-post|start_to_post_published");
  });

  it("is a valid DAG that translates to Windmill, every script exporting main", () => {
    expect(validateDAG(dag).valid).toBe(true);
    for (const n of dag.nodes.filter((n) => n.type === "script")) expect(String(n.config?.code)).toMatch(/export async function main\(/);
    for (const id of ["decide_turn", "check_ship", "check_main"]) {
      expect((flow.value.modules as Mod[]).some((m) => m.id === id), `${id} is top level`).toBe(true);
    }
    expect(mods.some((m) => m.id === "publish_reply_3")).toBe(true);
  });

  it("writes with the leg's best LLM and a strict schema, and publishes nothing through any other service", () => {
    expect(dag.nodes.some((n) => n.id === "llm-pick")).toBe(true);
    const writer = dag.nodes.find((n) => n.id === "write-thread")!;
    expect(writer.inputMapping?.["body.model"]).toBe("$ref:llm-plan.output.model");
    expect(THREAD_RESPONSE_SCHEMA.additionalProperties).toBe(false);
    const publishers = dag.nodes.filter((n) => n.config?.method === "POST" && /posts$/.test(String(n.config?.path)));
    expect(publishers.map((n) => n.config?.service)).toEqual(["meta", "meta", "meta", "meta"]);
    for (const p of publishers) expect(p.inputMapping?.["body.idempotencyKey"]).toMatch(/^\$ref:final-thread\.output\.keys\./);
  });

  it("a live run needs its campaign and an offer; a dry run takes inputs.offerId", async () => {
    const plan = loadMain(PLAN_RUN_CODE);
    await expect(plan(false, null, "b", null, { offerId: "o" })).rejects.toThrow(/needs its campaign/);
    await expect(plan(true, null, "b", null, undefined)).rejects.toThrow(/no offer/);
    const dry = await plan(true, null, "b", "o", undefined);
    expect(dry).toMatchObject({ dryRun: true, offerId: "o", accountsQuery: { brandId: "b" } });
    const live = await plan(false, "c", "b", null, { offerId: "o2", instruction: " Never say agency. " });
    expect(live).toMatchObject({ dryRun: false, offerId: "o2", instruction: "Never say agency." });
  });

  // AC1: a day against a mocked meta-service: 2 Pro (AI) accounts, a Personal, a Pro (human) and a dead Pro (AI).
  // campaign-service re-runs every 10 minutes after an idle run; billing holds the campaign at its max volume (5).
  it("AC1: a day writes 5 threads an hour apart, rotating over the 2 Pro (AI) accounts, never the others", async () => {
    const checkTurn = loadMain(CHECK_TURN_CODE);
    const posts: Array<{ accountId: string; text: string; publishedAt: string; kind: string }> = [];
    const published: Array<{ at: string; account: string; shape: string }> = [];
    const maxVolume = 5;
    for (let t = Date.parse("2026-10-29T11:00:00Z"); t < Date.parse("2026-10-29T23:00:00Z"); t += 10 * 60 * 1000) {
      if (published.length >= maxVolume) break;
      const at = new Date(t).toISOString();
      const turn = await checkTurn(planAt(at), { accounts: ACCOUNTS }, { publications: [...posts].reverse() });
      if (!turn.proceed) continue;
      posts.push({ accountId: turn.account.id, text: `thread ${published.length + 1}`, publishedAt: at, kind: "post" });
      posts.push({ accountId: turn.account.id, text: "a reply", publishedAt: at, kind: "reply" });
      published.push({ at, account: turn.account.username, shape: turn.shape });
    }
    expect(published.map((p) => p.account)).toEqual(["sophie_ai", "max_ai", "sophie_ai", "max_ai", "sophie_ai"]);
    expect(published[0].at).toBe("2026-10-29T13:00:00.000Z");
    for (let i = 1; i < published.length; i++) {
      expect(Date.parse(published[i].at) - Date.parse(published[i - 1].at)).toBeGreaterThanOrEqual(MIN_GAP_MINUTES * 60 * 1000);
    }
    expect(new Set(published.map((p) => p.shape)).size).toBe(THREAD_SHAPES.length);
  });

  it("a newly connected Pro (AI) account joins the rotation first; no Pro (AI) account = idle", async () => {
    const checkTurn = loadMain(CHECK_TURN_CODE);
    const posts = [{ accountId: "acc-ai-1", text: "t", publishedAt: "2026-10-29T13:00:00Z", kind: "post" }, { accountId: "acc-ai-2", text: "t", publishedAt: "2026-10-29T14:00:00Z", kind: "post" }];
    const fresh = { id: "acc-ai-new", username: "new_ai", accountType: "pro_ai", health: "connected", createdAt: "2026-10-29T14:30:00Z" };
    const turn = await checkTurn(planAt("2026-10-29T15:10:00Z"), { accounts: [...ACCOUNTS, fresh] }, { publications: posts });
    expect(turn).toMatchObject({ proceed: true, account: { username: "new_ai" } });
    const none = await checkTurn(planAt("2026-10-29T15:10:00Z"), { accounts: ACCOUNTS.filter((a) => a.accountType !== "pro_ai") }, { publications: [] });
    expect(none).toMatchObject({ proceed: false, reason: "no_pro_ai_account" });
  });

  it("idles outside the window and within an hour of the last thread; a dry run ignores both", async () => {
    const checkTurn = loadMain(CHECK_TURN_CODE);
    const posts = [{ accountId: "acc-ai-1", text: "t", publishedAt: "2026-10-29T14:30:00Z", kind: "post" }];
    expect(await checkTurn(planAt("2026-10-29T22:00:00Z"), { accounts: ACCOUNTS }, { publications: [] })).toMatchObject({ proceed: false, reason: "outside_publish_window" });
    expect(await checkTurn(planAt("2026-10-29T15:20:00Z"), { accounts: ACCOUNTS }, { publications: posts })).toMatchObject({ proceed: false });
    expect(await checkTurn(planAt("2026-10-29T15:30:00Z"), { accounts: ACCOUNTS }, { publications: posts })).toMatchObject({ proceed: true });
    expect(await checkTurn(planAt("2026-10-29T15:20:00Z", true), { accounts: ACCOUNTS }, { publications: posts })).toMatchObject({ proceed: true, reason: "dry_run" });
  });

  it("fails loud on an unreadable meta-service answer", async () => {
    const checkTurn = loadMain(CHECK_TURN_CODE);
    await expect(checkTurn(planAt("2026-10-29T15:00:00Z"), { error: "x" }, { publications: [] })).rejects.toThrow(/no accounts list/);
    await expect(checkTurn(planAt("2026-10-29T15:00:00Z"), { accounts: ACCOUNTS }, { posts: [] })).rejects.toThrow(/no publications list/);
  });

  it("the writer gets the facts, the subjects already posted, today's shape and the brand's GET STARTED line", async () => {
    const compose = loadMain(COMPOSE_WRITE_CODE);
    const turn = { account: { username: "sophie_ai" }, shape: "myth vs fact", history: ["2026-10-28: Old subject"] };
    const out = await compose({ date: "2026-10-29", instruction: "Never call us an agency." }, turn, { brand: { name: "distribute.you", domain: "distribute.you" } }, FACTS, { content: "Angle A" });
    expect(out.getStarted).toBe("Get started: distribute.you");
    expect(out.message).toContain("[E1]");
    expect(out.message).toContain("2026-10-28: Old subject");
    expect(out.message).toContain("TODAY'S SHAPE: myth vs fact");
    expect(out.message).toContain("Never call us an agency.");
    expect(out.message).toContain("Angle A");
    const noAngles = await compose({ date: "2026-10-29", instruction: null }, turn, { name: "X", domain: "https://www.x.com/" }, FACTS, { ok: false, status: 502 });
    expect(noAngles.getStarted).toBe("Get started: x.com");
  });

  it("check-thread refuses an invented number, a banned word, a long post; cleans dashes and the last line", async () => {
    const check = loadMain(CHECK_THREAD_CODE);
    const good = await check({ json: { subject: "s", post: "Fast replies win — at least 30% arrive within 24 hours.", replies: ["Answer the same day.", "Your team already does this well.\n\nGet started: distribute.you"] } }, COMPOSE);
    expect(good.ok).toBe(true);
    expect(good.thread.post).toBe("Fast replies win, at least 30% arrive within 24 hours.");
    expect(good.thread.replies[1]).toBe("Your team already does this well.\n\nGet started: distribute.you");
    expect(good.thread.replies[0]).not.toContain("Get started");
    const bad = await check({ json: { subject: "s", post: "x".repeat(401), replies: ["We doubled 47% of pipelines.", "Lower your risk."] } }, COMPOSE);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(" ")).toMatch(/401 characters/);
    expect(bad.problems.join(" ")).toMatch(/47%/);
    expect(bad.problems.join(" ")).toMatch(/banned word/);
    expect(bad.rewriteMessage).toContain("IT BROKE THESE RULES");
    const one = await check({ json: { subject: "s", post: "p", replies: ["only one"] } }, COMPOSE);
    expect(one.problems.join(" ")).toMatch(/2 or 3 replies/);
  });

  it("final-thread takes the rewrite when the first draft failed, throws when it fails again, keys each part", async () => {
    const final = loadMain(FINAL_THREAD_CODE);
    const plan = { campaignId: "c", now: "2026-10-29T13:00:00.000Z" };
    const turn = { account: { id: "acc-ai-1", username: "sophie_ai" } };
    const first = { ok: false, thread: null };
    const out = await final(first, { json: { subject: "s", post: "P", replies: ["R1", "R2"] } }, COMPOSE, plan, turn);
    expect(out).toMatchObject({ accountId: "acc-ai-1", replyCount: 2, reply1: "R1", reply3: null });
    expect(new Set(Object.values(out.keys)).size).toBe(4);
    await expect(final(first, { json: { subject: "s", post: "P", replies: ["R1"] } }, COMPOSE, plan, turn)).rejects.toThrow(/nothing published/);
  });

  it("a dead account ends idle, any other refusal fails the run", async () => {
    const classify = loadMain(CLASSIFY_MAIN_CODE);
    const thread = { username: "sophie_ai" };
    expect(await classify({ postId: "p1", permalink: "https://threads.net/x" }, thread)).toMatchObject({ outcome: "published", postId: "p1" });
    expect(await classify({ ok: false, status: 409, error: '{"error":"x","reason":"needs_reconnect"}' }, thread)).toMatchObject({ outcome: "account_dead" });
    await expect(classify({ ok: false, status: 502, error: "Threads refused" }, thread)).rejects.toThrow(/publish failed/);
  });
});
