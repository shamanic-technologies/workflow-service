import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMaterials, runScript, validateSource, type Bridge, type BridgeAnswer } from "../../src/lib/scripts/sandbox.js";
import { callVendor, type VendorDeps } from "../../src/lib/scripts/vendors.js";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import {
  ASK_PAGE_JUDGMENT_MARK,
  ASK_PAGE_JUDGMENT_SCRIPTS,
  JUDGMENT_MADE,
  NOT_MIGRATED,
  PAGE_READ,
  askPageJudgmentSource,
  askPageJudgmentTactics,
  namesARawDoor,
  restateCaseForAskedPageJudgment,
} from "../../src/lib/scripts/ask-page-judgment.js";
import { buildJudgmentSource, buildPageReadSource } from "../../scripts/engine-ports/page-read-judgment.js";

// ENGINE-GET-ASK-1123: the scripts that read a page or asked a judgment through a raw door, byte for byte as production
// stores them (2026-11-24), ask the Page read and Judgment made Engines instead. No recorded case of these dynasties
// holds such a call (script_cases, 2026-11-24: 0 `scraping.page`, 0 `chat.judgment`, 0 `jev.noul` outside the two
// scripts not migrated), so the asked paths below are proven on fakes: the stored Engine scripts' own code, run in the
// sandbox, answer the asks.
const fixture = (f: string) => readFileSync(join(__dirname, "../fixtures/stored-scripts/ask-page-judgment", f), "utf8");

/** Production's active version per dynasty (several dynasties are one code: md5 equal in production). */
const STORED: Record<string, { file: string; asks: string[]; had: string[] }> = {
  "lead_interested/dy_follow_up_due": { file: "lead_interested__dy_follow_up_due.v13.ts.txt", asks: [PAGE_READ, JUDGMENT_MADE], had: ["message_written"] },
  "paid_client/dy_client_check_in": { file: "paid_client__dy_client_check_in.v6.ts.txt", asks: [PAGE_READ, JUDGMENT_MADE], had: ["message_written"] },
  "paid_client/dy_brand_team": { file: "paid_client__dy_brand_team.v6.ts.txt", asks: [PAGE_READ, JUDGMENT_MADE], had: ["message_written"] },
  "client_satisfied/dy_client_whatsapp": { file: "client_satisfied__dy_client_whatsapp.v7.ts.txt", asks: [PAGE_READ, JUDGMENT_MADE], had: [] },
  "linkedin_post_published/dy_linkedin_post": { file: "linkedin_post_published__dy_linkedin_post.v7.ts.txt", asks: [PAGE_READ], had: ["industry_news_found", "llm_completion"] },
  "x_post_published/dy_x_post": { file: "linkedin_post_published__dy_linkedin_post.v7.ts.txt", asks: [PAGE_READ], had: ["industry_news_found", "llm_completion"] },
  "threads_post_published/dy_threads_thread": { file: "threads_post_published__dy_threads_thread.v6.ts.txt", asks: [PAGE_READ], had: ["llm_completion"] },
  "threads_post_published/dy_threads_shape_rotation": { file: "threads_post_published__dy_threads_thread.v6.ts.txt", asks: [PAGE_READ], had: ["llm_completion"] },
  "threads_post_published/dy_threads_contrarian_take": { file: "threads_post_published__dy_threads_thread.v6.ts.txt", asks: [PAGE_READ], had: ["llm_completion"] },
  "paid_client/dy_intro_path": { file: "paid_client__dy_intro_path.v5.ts.txt", asks: [PAGE_READ, JUDGMENT_MADE], had: ["email_sent", "message_sent", "llm_completion"] },
  "email_sent/dy_intro_open": { file: "email_sent__dy_intro_open.v9.ts.txt", asks: [PAGE_READ, JUDGMENT_MADE], had: ["llm_completion"] },
  "email_sent/dy_intro_lead_to_lead": { file: "email_sent__dy_intro_open.v9.ts.txt", asks: [PAGE_READ, JUDGMENT_MADE], had: ["llm_completion"] },
  "email_sent/dy_intro_client_to_lead": { file: "email_sent__dy_intro_open.v9.ts.txt", asks: [PAGE_READ, JUDGMENT_MADE], had: ["llm_completion"] },
  "message_sent/dy_intro_answer": { file: "message_sent__dy_intro_answer.v6.ts.txt", asks: [PAGE_READ, JUDGMENT_MADE], had: ["llm_completion"] },
  "backlink_earned/dy_listicle_outreach": { file: "backlink_earned__dy_listicle_outreach.v6.ts.txt", asks: [PAGE_READ, JUDGMENT_MADE], had: ["email_sent", "llm_completion"] },
  "press_feature_found/dy_press_mailbox": { file: "press_feature_found__dy_press_mailbox.v3.ts.txt", asks: [PAGE_READ, JUDGMENT_MADE], had: ["llm_completion"] },
  "email_sent/dy_cold_email_signed_client_person": { file: "email_sent__dy_cold_email_signed_client_person.v11.ts.txt", asks: [JUDGMENT_MADE], had: ["message_written", "llm_completion", "lead_found"] },
  "email_sent/dy_cold_email_signed_sender_client_brand": { file: "email_sent__dy_cold_email_signed_client_person.v11.ts.txt", asks: [JUDGMENT_MADE], had: ["message_written", "llm_completion", "lead_found"] },
};

/** The rewrite undone token by token: what is left must be the stored code, byte for byte. */
function undone(next: string): string {
  let code = next.slice(0, next.indexOf("\n/** " + ASK_PAGE_JUDGMENT_MARK)).trimEnd();
  code = code.split("askPageTolerated(ctx, ").join('tolerated(ctx, "scraping.page", ');
  code = code.split("askYesNoMust(ctx, ").join('must(ctx, "jev.noul", ');
  code = code.split("askYesNo(ctx, ").join('ctx.vendor.call("jev.noul", ');
  code = code.split(`callStep(ctx, "${PAGE_READ}", `).join('callStep(ctx, "scraping.page", ');
  code = code.split(`callStep(ctx, "${JUDGMENT_MADE}", `).join('callStep(ctx, "chat.judgment", ');
  code = code.replace(/ {4}\/\/ ENGINE-GET-ASK-1123: a page read and a judgment are asked of their Engines\.\n( {4}const r: \{ ok: boolean; data: any \} = ).*ctx\.vendor\.call\(door, args\);/, "$1ctx.vendor.call(door, args);");
  return code;
}

describe("every stored script that called a raw page or judgment door asks the Engine", () => {
  it("covers exactly the scripts in scope", () => {
    expect(ASK_PAGE_JUDGMENT_SCRIPTS.map((s) => `${s.outcome}/${s.dynasty}`).sort()).toEqual(Object.keys(STORED).sort());
    for (const n of NOT_MIGRATED) expect(Object.keys(STORED)).not.toContain(`${n.outcome}/${n.dynasty}`);
  });

  for (const [slug, s] of Object.entries(STORED)) {
    it(`${slug}: only the calls' first token moves, and it asks ${s.asks.join(" + ")}`, async () => {
      const stored = fixture(s.file);
      expect(namesARawDoor(stored)).not.toBeNull();
      const next = askPageJudgmentSource(stored, slug);
      expect(next.asks).toEqual(s.asks);
      expect(namesARawDoor(next.code)).toBeNull();
      expect(undone(next.code)).toBe(stored.trimEnd());
      // It transpiles and evaluates in the sandbox, and reads no material nobody hands or it does not ask.
      const read = await validateSource(next.code);
      const before = readMaterials(stored);
      expect(read.materials.filter((m) => !before.includes(m)).sort()).toEqual([...s.asks].sort());
      const tactics = askPageJudgmentTactics({ asks: s.had, channel: "x" }, next.asks);
      expect(tactics).toEqual({ channel: "x", asks: [...s.had, ...s.asks] });
      // No judge, model or provider is added to the script.
      const added = next.code.slice(next.code.indexOf("\n/** " + ASK_PAGE_JUDGMENT_MARK));
      expect(added).not.toMatch(/"jev"|judge: "|model: "|provider: "|openai|anthropic/i);
      // Applied twice = refused (already done).
      expect(() => askPageJudgmentSource(next.code, slug)).toThrow(/already asks/);
    });
  }

  it("a script that runs platform-billed for a service is not migrated", () => {
    expect(NOT_MIGRATED.map((n) => `${n.outcome}/${n.dynasty}`).sort()).toEqual(["email_reply_received/dy_orphan_reply", "lead_identified/dy_screen_reveal"]);
    // The orphan reply's choice judgment is a call form the rewrite does not know: nothing is generated.
    expect(() => askPageJudgmentSource(fixture("email_reply_received__dy_orphan_reply.v2.ts.txt"), "orphan")).toThrow(/calls no raw page or judgment door/);
  });

  it("a script calling neither door, or another form of one, generates nothing", () => {
    expect(() => askPageJudgmentSource("export default function run() { return null; }", "x")).toThrow(/calls no raw/);
    expect(() => askPageJudgmentSource('export default function run(ctx: any) { tolerated(ctx, "scraping.page", {}); return ctx.vendor.call("chat.judgment", {}); }', "x")).toThrow(/still names chat\.judgment/);
  });
});

// ─── The asked paths, on fakes ──────────────────────────────────────────────

/** A script written with the stored scripts' own call forms (their `must` / `tolerated`, a DAG port's step caller). */
const ASKER = `
type Answer = { ok: boolean; data: Record<string, any> };
function must(ctx: any, name: string, args: Record<string, unknown>): any {
  const r: Answer = ctx.vendor.call(name, args);
  if (!r.ok) throw new Error(name + " failed (" + String(r.data.status ?? "") + "): " + String(r.data.error ?? "").slice(0, 500));
  return r.data;
}
function tolerated(ctx: any, name: string, args: Record<string, unknown>): any {
  const r: Answer = ctx.vendor.call(name, args);
  if (r.ok) return r.data;
  return { ok: false, status: r.data.status ?? null, error: r.data.body && Object.keys(r.data.body).length ? JSON.stringify(r.data.body) : String(r.data.error ?? "") };
}
function callStep(ctx: any, door: string, s: any, retries: number): any {
  if (s.skip === true) return { ok: false, skipped: true, notCalled: true };
  const args: Record<string, unknown> = { body: s.body ?? {} };
  for (let attempt = 0; ; attempt++) {
    const r: { ok: boolean; data: any } = ctx.vendor.call(door, args);
    if (r.ok) return r.data ?? {};
    const status = r.data.status;
    if (s.tolerateFailure === true) return { ok: false, status: typeof status === "number" ? status : 0 };
    if (attempt < retries) continue;
    throw new Error(door + " failed (" + String(status ?? "") + ")");
  }
}
export default function run(ctx: any): any {
  const r: any = ctx.request;
  let out: any;
  if (r.kind === "page") out = tolerated(ctx, "scraping.page", { body: r.body });
  else if (r.kind === "must") out = must(ctx, "jev.noul", r.args);
  else if (r.kind === "call") out = ctx.vendor.call("jev.noul", r.args);
  else if (r.kind === "stepPage") out = callStep(ctx, "scraping.page", { service: "scraping", body: r.body, skip: r.skip, tolerateFailure: true }, 0);
  else out = callStep(ctx, "chat.judgment", { service: "chat", body: r.body }, 1);
  return { content: { out }, subject: { service: "test", id: "1" } };
}
`;
const ASKING = askPageJudgmentSource(ASKER, "asker").code;

interface World {
  /** What scraping-service / chat-service answer the door (status + body). */
  door: { status: number; body: Record<string, unknown> } | "no_answer";
}
type Sent = { door: string; body: Record<string, unknown> };
const spec = (request: Record<string, unknown>, tactics: Record<string, unknown> = {}) => ({ subject: null, brand: "b", day: 0, tactics, request });

/** A run door's answer, as vendors.ts `runDoor` states it. */
function doorAnswer(w: World): { ok: boolean; data: Record<string, unknown> } {
  if (w.door === "no_answer") return { ok: false, data: { error: "fetch failed" } };
  const { status, body } = w.door;
  if (status >= 200 && status < 300) return { ok: true, data: body };
  return { ok: false, data: { error: String(body.error ?? `service answered ${status}`), status, code: typeof body.code === "string" ? body.code : null, body } };
}

/** The stored code on the raw doors: `scraping.page` / `chat.judgment` as run doors, `jev.noul` through vendors.ts. */
async function runRaw(request: Record<string, unknown>, w: World) {
  const sent: Sent[] = [];
  const deps = {
    judge: async (body: Record<string, unknown>) => {
      sent.push({ door: "chat /orgs/judgments", body });
      const a = doorAnswer(w);
      if (!a.ok) throw new Error(`chat-service POST /orgs/judgments -> ${String(a.data.status ?? "")}: ${String(a.data.error)}`);
      return a.data;
    },
  } as unknown as VendorDeps;
  const bridge: Bridge = async (op, args) => {
    if (op !== "vendor") return { stop: `${op} asked` };
    const name = String(args[0]);
    const a = (args[1] ?? {}) as Record<string, any>;
    if (name === "jev.noul") return { v: await callVendor(name, a, { headers: { "x-run-id": "r", "x-org-id": "o" }, tactics: {} }, deps) };
    sent.push({ door: name === "scraping.page" ? "scraping /scrape" : "chat /orgs/judgments", body: a.body });
    return { v: doorAnswer(w) };
  };
  return { out: await runScript(ASKER, spec(request), bridge), sent };
}

/** The upgraded code: each ask answered by the stored Engine script's own code, as script-runner.ts `provide` hands it. */
async function runAsking(request: Record<string, unknown>, w: World) {
  const sent: Sent[] = [];
  const asks: Array<Record<string, unknown>> = [];
  let asked: Record<string, any> | null = null;
  const bridge: Bridge = async (op, args): Promise<BridgeAnswer> => {
    if (op === "ask") {
      asked = args[0] as Record<string, any>;
      asks.push(asked);
      return { v: null };
    }
    if (op !== "get" || !asked) return { stop: `${op} asked` };
    const outcome = String(args[0]);
    const req = asked;
    asked = null;
    expect(req.units).toEqual({});
    const page = outcome === PAGE_READ;
    const child = await runScript(page ? buildPageReadSource() : buildJudgmentSource(), spec(req.request, page ? {} : { judge: "jev" }), (cop, cargs) => {
      if (cop !== "vendor") return { stop: `${cop} asked by the Engine script` };
      expect(String(cargs[0])).toBe(page ? "scraping.page" : "chat.judgment");
      sent.push({ door: page ? "scraping /scrape" : "chat /orgs/judgments", body: (cargs[1] as Record<string, any>).body });
      return { v: doorAnswer(w) };
    });
    if (child.kind !== "done") return { stop: `asked for ${outcome}: ${child.kind === "error" ? child.message : child.reason}` };
    const r: any = child.result;
    if (r && r.content) return { v: { outcome, content: r.content, run: {} } };
    return { v: { outcome, content: null, unmade: r?.unmade ?? "nothing", ...(r?.decided ? { decided: r.decided } : {}), ...(r?.answer ? { answer: r.answer } : {}), run: {} } };
  };
  return { out: await runScript(ASKING, spec(request), bridge), sent, asks };
}

const content = (o: { out: any }) => (o.out.kind === "done" ? o.out.result.content.out : o.out);
const PAGE = { requestId: "req-1", cached: false, result: { rawMarkdown: "# Acme\nWe sell anvils." } };
const PAGE_BODY = { url: "https://acme.example", enrich: false, brandIds: ["brand-1"], campaignId: "camp-1", featureSlug: "ai-follow-up-email", workflowSlug: undefined };
const NOUL = { state: { brief: "Copy Kevin on every email." }, questions: { asks: { instructions: "Does the brief ask to copy the signer?" }, twice: { instructions: "Twice?", whenTrue: "yes it does", whenFalse: "no" } } };
const JUDGED = { answers: { asks: { noul: 0.91 }, twice: { noul: 0.2 } }, judge: "jev", model: "jev-1.13", usage: { inputTokens: 40 } };

describe("an asked page read answers the script as the raw page door did", () => {
  for (const kind of ["page", "stepPage"]) {
    it(`${kind}: a fresh read is the same page; the Request holds the door's own fields only`, async () => {
      const w: World = { door: { status: 200, body: PAGE } };
      const raw = await runRaw({ kind, body: PAGE_BODY }, w);
      const next = await runAsking({ kind, body: PAGE_BODY }, w);
      expect(content(next)).toEqual(content(raw));
      expect(content(next)).toEqual(PAGE);
      expect(next.asks).toEqual([{ units: {}, request: { url: "https://acme.example", enrich: false } }]);
      // What reaches scraping-service: the same read, minus what the asked run's own headers carry.
      expect(next.sent).toEqual([{ door: "scraping /scrape", body: { url: "https://acme.example", enrich: false } }]);
    });

    it(`${kind}: a page the reader already held (no Unit, the page as its answer) is the same page`, async () => {
      const held = { ...PAGE, cached: true };
      const w: World = { door: { status: 200, body: held } };
      expect(content(await runAsking({ kind, body: PAGE_BODY }, w))).toEqual(content(await runRaw({ kind, body: PAGE_BODY }, w)));
      expect(content(await runAsking({ kind, body: PAGE_BODY }, w))).toEqual(held);
    });

    it(`${kind}: a refusal the reader answered stays tolerated, with its status`, async () => {
      const w: World = { door: { status: 422, body: { error: "The page could not be reached", code: "unreachable" } } };
      const raw = content(await runRaw({ kind, body: PAGE_BODY }, w));
      const next = content(await runAsking({ kind, body: PAGE_BODY }, w));
      expect(next.ok).toBe(false);
      expect(next.status).toBe(422);
      expect(raw.status).toBe(422);
      if (kind === "page") expect(next.error).toBe("The page could not be reached");
    });

    it(`${kind}: a read with NO answer stays tolerated (the asker goes on without the page)`, async () => {
      const w: World = { door: "no_answer" };
      expect(content(await runRaw({ kind, body: PAGE_BODY }, w)).ok).toBe(false);
      const next = content(await runAsking({ kind, body: PAGE_BODY }, w));
      expect(next.ok).toBe(false);
      if (kind === "page") expect(String(next.error)).toMatch(/fetch failed/);
    });
  }

  it("a read naming no page asks nobody and stays a tolerated refusal", async () => {
    const next = await runAsking({ kind: "page", body: { url: "  ", enrich: false } }, { door: { status: 200, body: PAGE } });
    expect(content(next)).toEqual({ ok: false, status: null, error: "page_read: the read names no page (url)" });
    expect(next.asks).toEqual([]);
  });

  it("a skipped step asks nobody", async () => {
    const next = await runAsking({ kind: "stepPage", body: PAGE_BODY, skip: true }, { door: { status: 200, body: PAGE } });
    expect(content(next)).toEqual({ ok: false, skipped: true, notCalled: true });
    expect(next.asks).toEqual([]);
  });

  it("a field a page read's Request does not hold is a named throw, never dropped", async () => {
    const next = await runAsking({ kind: "page", body: { url: "https://acme.example", provider: "other" } }, { door: { status: 200, body: PAGE } });
    expect(next.out).toMatchObject({ kind: "error" });
    expect((next.out as { message: string }).message).toMatch(/states provider/);
  });

  it("no script of the Engine may run = a refusal the script reads", async () => {
    const out = await runScript(ASKING, spec({ kind: "page", body: PAGE_BODY }), (op) => (op === "ask" ? { v: null } : { v: { content: null, unmade: "no_script: no live script of that Engine can run on nothing", run: null } }));
    expect(content({ out })).toEqual({ ok: false, status: null, error: "no live script of that Engine can run on nothing" });
  });
});

describe("an asked judgment answers the script as the raw judgment doors did", () => {
  for (const kind of ["must", "call"]) {
    it(`jev.noul (${kind}): the same probabilities, from the same request to chat-service plus the judge the Engine script states`, async () => {
      const w: World = { door: { status: 200, body: JUDGED } };
      const raw = await runRaw({ kind, args: NOUL }, w);
      const next = await runAsking({ kind, args: NOUL }, w);
      expect(content(next)).toEqual(content(raw));
      expect(kind === "must" ? content(next) : content(next).data).toEqual({ probabilities: { asks: 0.91, twice: 0.2 }, model: "jev-1.13" });
      expect(raw.sent).toHaveLength(1);
      expect(next.sent).toEqual([{ door: raw.sent[0]!.door, body: { ...raw.sent[0]!.body, judge: "jev" } }]);
    });
  }

  it("jev.noul: a judgment the judge refused is a refusal (must throws, a bare call reads ok: false)", async () => {
    const w: World = { door: { status: 502, body: { error: "TypeSafe is out of credits", code: "judge_unavailable" } } };
    const called = content(await runAsking({ kind: "call", args: NOUL }, w));
    expect(called).toEqual({ ok: false, data: { error: "TypeSafe is out of credits", code: "judge_unavailable", body: {}, status: 502 } });
    expect(content(await runRaw({ kind: "call", args: NOUL }, w)).ok).toBe(false);
    const must = await runAsking({ kind: "must", args: NOUL }, w);
    expect((must.out as { message: string }).message).toMatch(/judgment_made failed \(502\): TypeSafe is out of credits/);
    expect((await runRaw({ kind: "must", args: NOUL }, w)).out.kind).toBe("error");
  });

  it("jev.noul: an answer without a readable probability, or a question without instructions, is the door's refusal", async () => {
    const noP = content(await runAsking({ kind: "call", args: NOUL }, { door: { status: 200, body: { answers: { asks: { noul: 0.5 } } } } }));
    expect(noP).toEqual({ ok: false, data: { error: "judgment twice answered without a readable probability" } });
    const none = await runAsking({ kind: "call", args: { state: {}, questions: { a: {} } } }, { door: { status: 200, body: JUDGED } });
    expect(content(none).ok).toBe(false);
    expect(none.asks).toEqual([]);
  });

  it("chat.judgment (a DAG port's step): the judge's whole answer, the same request plus the judge", async () => {
    const body = { state: "They sell anvils.\n\nTHE BRIEF\nSell more.", questions: { asBusiness: { type: "noul", instructions: "Answer as the writer's business?" } } };
    const w: World = { door: { status: 200, body: JUDGED } };
    const raw = await runRaw({ kind: "stepJudgment", body }, w);
    const next = await runAsking({ kind: "stepJudgment", body }, w);
    expect(content(next)).toEqual(JUDGED);
    expect(content(next)).toEqual(content(raw));
    expect(next.sent).toEqual([{ door: "chat /orgs/judgments", body: { ...raw.sent[0]!.body, judge: "jev" } }]);
    expect(next.asks).toEqual([{ units: {}, request: body }]);
  });

  it("chat.judgment: a refusal fails the step as before; a field a judgment's Request does not hold is a named throw", async () => {
    const body = { state: "x", questions: { q: { type: "noul", instructions: "?" } } };
    const refused = await runAsking({ kind: "stepJudgment", body }, { door: { status: 400, body: { error: "bad" } } });
    expect((refused.out as { message: string }).message).toMatch(/judgment_made failed \(400\)/);
    expect(refused.sent).toHaveLength(2); // the step's one retry, as on the raw door
    const extra = await runAsking({ kind: "stepJudgment", body: { ...body, judge: "openai-luna" } }, { door: { status: 200, body: JUDGED } });
    expect((extra.out as { message: string }).message).toMatch(/states judge/);
  });
});

describe("a recorded case holding a page read or a judgment is restated", () => {
  const base = { id: "c1", units: {}, request: { kind: "page", body: PAGE_BODY }, expect: { content: { out: PAGE } } };

  it("a case holding none is unchanged", () => {
    const c = { ...base, calls: [{ name: "lead.serve", args: {}, answer: { ok: true, data: {} } }] };
    expect(restateCaseForAskedPageJudgment(c)).toEqual({ case: c, restated: 0 });
  });

  it("a fresh page read becomes the held Unit and the asked Request, and the upgrade replays it", async () => {
    const recorded = { ...base, calls: [{ name: "scraping.page", args: { body: { url: "https://acme.example", enrich: false, brandIds: ["brand-1"], campaignId: "camp-1", featureSlug: "ai-follow-up-email" } }, answer: { ok: true, data: PAGE } }] };
    expect((await replayCase(ASKER, recorded as unknown as ReplayCase)).match).toBe(true);
    const r = restateCaseForAskedPageJudgment(recorded);
    if ("excluded" in r) throw new Error(r.excluded);
    expect(r.case.calls).toEqual([]);
    expect(r.case.units).toEqual({ [PAGE_READ]: [PAGE] });
    expect(r.case.asks).toEqual([{ units: {}, request: { url: "https://acme.example", enrich: false } }]);
    expect(await replayCase(ASKING, r.case as ReplayCase)).toEqual({ id: "c1", match: true, diffs: [] });
  });

  it("yes / no and typed judgments become held Units of the judge's whole answer, replayed", async () => {
    const noul = { id: "c2", units: {}, request: { kind: "must", args: NOUL }, expect: { content: { out: { probabilities: { asks: 0.91, twice: 0.2 }, model: "jev-1.13" } } }, calls: [{ name: "jev.noul", args: NOUL, answer: { ok: true, data: { probabilities: { asks: 0.91, twice: 0.2 }, model: "jev-1.13" } } }] };
    const r = restateCaseForAskedPageJudgment(noul);
    if ("excluded" in r) throw new Error(r.excluded);
    expect(r.case.units).toEqual({ [JUDGMENT_MADE]: [{ answers: { asks: { noul: 0.91 }, twice: { noul: 0.2 } }, model: "jev-1.13" }] });
    expect((await replayCase(ASKING, r.case as ReplayCase)).diffs).toEqual([]);
    const body = { state: "x", questions: { q: { type: "noul", instructions: "?" } } };
    const typed = { id: "c3", units: {}, request: { kind: "stepJudgment", body }, expect: { content: { out: JUDGED } }, calls: [{ name: "chat.judgment", args: { body }, answer: { ok: true, data: JUDGED } }] };
    const t = restateCaseForAskedPageJudgment(typed);
    if ("excluded" in t) throw new Error(t.excluded);
    expect(t.case.asks).toEqual([{ units: {}, request: body }]);
    expect((await replayCase(ASKING, t.case as ReplayCase)).diffs).toEqual([]);
  });

  it("a record whose call made no Unit, or had no answer, is excluded with its reason", () => {
    const call = (answer: { ok: boolean; data: Record<string, unknown> }, name = "scraping.page") => restateCaseForAskedPageJudgment({ ...base, calls: [{ name, args: { body: {} }, answer }] });
    expect(call({ ok: true, data: { ...PAGE, cached: true } })).toEqual({ excluded: expect.stringMatching(/already held/) });
    expect(call({ ok: false, data: { status: 422, error: "x" } })).toEqual({ excluded: expect.stringMatching(/refused scraping\.page \(422\)/) });
    expect(call({ ok: false, data: { error: "fetch failed" } })).toEqual({ excluded: expect.stringMatching(/no answer/) });
    expect(call({ ok: true, data: {} }, "jev.choice")).toEqual({ excluded: expect.stringMatching(/jev\.choice/) });
  });
});
