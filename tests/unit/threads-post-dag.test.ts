import { describe, it, expect } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  CHECK_TURN_CODE,
  CLASSIFY_MAIN_CODE,
  COMPOSE_OWN_FIGURES_CODE,
  COMPOSE_WRITE_CODE,
  DRY_SUMMARY_CODE,
  FINAL_THREAD_CODE,
  MIN_GAP_MINUTES,
  PLAN_RUN_CODE,
  PUBLISH_WINDOW_UTC,
  THREADS_POST_PIPE_ID,
  THREAD_SHAPES,
  buildThreadsPostDag,
} from "../../src/lib/threads-post-dag.js";
import { GENERATE_THREAD_PATH, THREAD_WRITER_PLAN_CODE, writesWithLegBestTemplate } from "../../src/lib/whatsapp-template-writer.js";

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
const COMPOSE = { getStarted: "Get started: distribute.you", message: "M" };

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

  it("THREADS-IDEAS-AB: writes through content-generation with the pipe's best template dynasty and LLM, no prompt and no model of its own", () => {
    const writer = dag.nodes.find((n) => n.id === "write-thread")!;
    expect(writer.config).toMatchObject({ service: "content-generation", method: "POST", path: GENERATE_THREAD_PATH });
    expect(writer.config?.body).toEqual({ featureSlug: "threads-post" });
    expect(writer.inputMapping).toMatchObject({
      "body.type": "$ref:template-head.output.template.type",
      "body.model": "$ref:writer-plan.output.model",
      "body.variables": "$ref:compose-write.output.variables",
      "body.context": "$ref:compose-write.output.context",
      "body.workflowSlug": "$ref:flow_input.workflowSlug",
      "body.campaignId": "$ref:flow_input.campaignId",
    });
    expect(writesWithLegBestTemplate(dag, "write-thread")).toBe(true);
    expect(dag.edges).toEqual(expect.arrayContaining([
      { from: "compose-write", to: "writer-pick" },
      { from: "writer-pick", to: "writer-plan" },
      { from: "writer-plan", to: "template-head" },
      { from: "template-head", to: "write-thread" },
    ]));
    expect(dag.nodes.find((n) => n.id === "writer-plan")?.config?.code).toBe(THREAD_WRITER_PLAN_CODE);
    // Only the two READING calls go to chat-service, each with its own model; no LLM pick of a chat writer is left.
    const chats = dag.nodes.filter((n) => n.config?.service === "chat" && n.config?.path === "/complete");
    expect(chats.map((n) => n.id)).toEqual(["read-angles", "read-own-figures"]);
    for (const c of chats) expect(c.config).toMatchObject({ tolerateFailure: true, body: { webSearch: true } });
    expect(dag.nodes.some((n) => n.id === "llm-pick" || n.id === "llm-plan")).toBe(false);
    expect(JSON.stringify(dag)).not.toMatch(/haiku|"opus"|THREAD_RESPONSE|You write ONE Threads thread/i);
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

  it("the writer gets its variables and one context whose section headers come in the contract's order", async () => {
    const compose = loadMain(COMPOSE_WRITE_CODE);
    const turn = { account: { username: "sophie_ai" }, shape: "myth vs fact", history: ["2026-10-28: Old subject"] };
    const facts = { ...FACTS, neverGive: ["a discount"] };
    const out = await compose(
      { date: "2026-10-29", brandId: "brand-1", instruction: "Never call us an agency." },
      turn,
      { brand: { name: "distribute.you", domain: "distribute.you" } },
      facts,
      { content: "Angle A" },
      { content: "- 412 positive replies measured across 9 clients (https://distribute.you/indexes)" },
    );
    expect(out.variables).toEqual({ brandName: "distribute.you", getStartedLine: "Get started: distribute.you" });
    expect(out.brandIds).toEqual(["brand-1"]);
    const headers = [
      "BRAND: distribute.you (distribute.you)",
      "PUBLISHED ON: @sophie_ai",
      "TODAY: 2026-10-29",
      "SUGGESTED SHAPE: myth vs fact",
      "OUR FACTS (the only source of numbers besides OUR PUBLISHED FIGURES):",
      "NEVER STATE OR OFFER:",
      "THE BRAND'S INSTRUCTION FOR THESE THREADS:",
      "OUR PUBLISHED FIGURES (read today on distribute.you, each with its page):",
      "THIS WEEK IN THE INDUSTRY (angles only):",
      "ALREADY POSTED (never repeat a subject):",
    ];
    const at = headers.map((h) => out.context.indexOf(h));
    expect(at.every((i: number) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(out.context.split("\n").slice(0, 5)).toEqual([...headers.slice(0, 4), ""]);
    for (const piece of ["[E1]", "- a discount", "Never call us an agency.", "412 positive replies", "Angle A", "2026-10-28: Old subject"]) expect(out.context).toContain(piece);
    // No rule and no prompt here: those are the template's.
    expect(out).not.toHaveProperty("systemPrompt");
    const bare = await compose({ date: "2026-10-29", brandId: "b", instruction: null }, { ...turn, history: [] }, { name: "X", domain: "https://www.x.com/" }, { exact: [], neverGive: [] }, { ok: false, status: 502 }, null);
    expect(bare.variables.getStartedLine).toBe("Get started: x.com");
    expect(bare.context).not.toContain("NEVER STATE OR OFFER:");
    expect(bare.context).not.toContain("INSTRUCTION");
    expect(bare.context).toContain("OUR FACTS (the only source of numbers besides OUR PUBLISHED FIGURES):\n(none)");
    expect(bare.context).toContain("OUR PUBLISHED FIGURES (read today on x.com, each with its page):\n(none)");
    expect(bare.context).toContain("THIS WEEK IN THE INDUSTRY (angles only):\n(none)");
    expect(bare.context).toContain("ALREADY POSTED (never repeat a subject):\n(none yet)");
  });

  it("reads the brand's OWN published figures on its own domain only, tolerated, for any brand", async () => {
    const read = dag.nodes.find((n) => n.id === "read-own-figures")!;
    expect(read.config).toMatchObject({ service: "chat", path: "/complete", tolerateFailure: true, body: { webSearch: true } });
    expect(dag.edges).toEqual(expect.arrayContaining([{ from: "read-angles", to: "compose-own-figures" }, { from: "compose-own-figures", to: "read-own-figures" }, { from: "read-own-figures", to: "compose-write" }]));
    const compose = loadMain(COMPOSE_OWN_FIGURES_CODE);
    const out = await compose({ brand: { name: "Acme", domain: "https://www.acme.io/pricing" } }, { date: "2026-10-29" });
    expect(out.systemPrompt).toContain("Read only pages on acme.io");
    expect(out.systemPrompt).toMatch(/Never a page from another domain/);
    expect(out.systemPrompt).toMatch(/last 14 days/);
    expect(out.message).toContain("BRAND: Acme (acme.io)");
    expect(COMPOSE_OWN_FIGURES_CODE).not.toMatch(/distribute/i);
    expect(`${out.systemPrompt}${out.message}`).not.toMatch(/[\u2013\u2014]/);
  });

  it("a writer pick with no template or no LLM writes nothing", async () => {
    const plan = loadMain(THREAD_WRITER_PLAN_CODE);
    await expect(plan({ legKey: "start_to_post_published", template: null, templateUnavailableReason: "none_ranked", llm: { model: "opus" } }, undefined)).rejects.toThrow(/no Threads template.*none_ranked/);
    await expect(plan({ legKey: "start_to_post_published", template: { templateDynastySlug: "threads-research-finding" }, llm: null }, undefined)).rejects.toThrow(/no LLM/);
    expect(await plan({ legKey: "l", template: { templateDynastySlug: "t" }, llm: { model: "m", provider: "p" } }, undefined)).toMatchObject({ templateDynastySlug: "t", model: "m" });
  });

  it("a dry run says which template dynasty and LLM wrote it", async () => {
    const dry = dag.nodes.find((n) => n.id === "dry-summary")!;
    expect(dry.inputMapping?.writer).toBe("$ref:writer-plan.output");
    const summary = loadMain(DRY_SUMMARY_CODE);
    const out = await summary({ username: "sophie_ai", subject: "s", post: "p", replies: ["r"] }, { candidates: ["@sophie_ai"], shape: "insight" }, { templateDynastySlug: "threads-research-finding", model: "m" });
    expect(out).toMatchObject({ dryRun: true, published: false, templateDynastySlug: "threads-research-finding", model: "m", post: "p" });
  });

  it("publishes the model's thread as written (owner: the writer is TRUSTED): dashes and the last line only", async () => {
    const final = loadMain(FINAL_THREAD_CODE);
    const plan = { campaignId: "c", now: "2026-10-29T13:00:00.000Z" };
    const turn = { account: { id: "acc-ai-1", username: "sophie_ai" } };
    const out = await final({ subject: "s", post: "Fast replies win \u2014 at least 30% arrive within 24 hours.", replies: ["Get started: distribute.you\nAnswer the same day, 47 of them.", "Your team already does this well.\n\nGet started: distribute.you"] }, COMPOSE, plan, turn);
    expect(out.post).toBe("Fast replies win, at least 30% arrive within 24 hours.");
    expect(out.reply1).toBe("Answer the same day, 47 of them.");
    expect(out.reply2).toBe("Your team already does this well.\n\nGet started: distribute.you");
    expect(out).toMatchObject({ accountId: "acc-ai-1", replyCount: 2, reply3: null });
    expect(new Set(Object.values(out.keys)).size).toBe(4);
    const long = await final({ subject: "s", post: "P", replies: ["1", "2", "3", "4"] }, COMPOSE, plan, turn);
    expect(long.replyCount).toBe(3);
    expect(long.reply3).toBe("3\n\nGet started: distribute.you");
    await expect(final({ subject: "s", post: "", replies: [] }, COMPOSE, plan, turn)).rejects.toThrow(/no main post/);
  });

  it("no validation, retry or refusal sits on the writer's output", () => {
    const ids = dag.nodes.map((n) => n.id);
    expect(ids.filter((id) => /check-thread|rewrite/.test(id))).toEqual([]);
    expect(dag.edges).toContainEqual({ from: "write-thread", to: "final-thread" });
  });

  it("a dead account ends idle, any other refusal fails the run", async () => {
    const classify = loadMain(CLASSIFY_MAIN_CODE);
    const thread = { username: "sophie_ai" };
    expect(await classify({ postId: "p1", permalink: "https://threads.net/x" }, thread)).toMatchObject({ outcome: "published", postId: "p1" });
    expect(await classify({ ok: false, status: 409, error: '{"error":"x","reason":"needs_reconnect"}' }, thread)).toMatchObject({ outcome: "account_dead" });
    await expect(classify({ ok: false, status: 502, error: "Threads refused" }, thread)).rejects.toThrow(/publish failed/);
  });
});
