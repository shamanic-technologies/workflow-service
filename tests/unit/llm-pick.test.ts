import { describe, it, expect } from "vitest";
import { callVendor, LLM_COMPLETE, LLM_PICK, TEMPLATE_PICK, type VendorDeps } from "../../src/lib/scripts/vendors.js";
import { LLM_PICK_UPGRADES, NAMED_MODEL, PICK_LLM_FN, restateCase, restateTemplateCase, TEMPLATE_PICK_UPGRADES, UpgradeEditError } from "../../src/lib/scripts/llm-pick-upgrade.js";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";

// LLM-PICK-SCRIPTS-1112 (owner 2026-11-12): every LLM call of a script asks the Rating's pick for its Engine and that
// call; no script names a model; no LLM in the Engine's universe = the script writes nothing (fails, retried later).
function vendors(pickStatus = 200) {
  const asked: Array<{ service: string; path: string; headers: Record<string, string> }> = [];
  const completions: Record<string, unknown>[] = [];
  let n = 0;
  const deps: VendorDeps = {
    async complete(body) { completions.push(body); return { content: "{}", json: {}, model: String(body.model) }; },
    async platformComplete(body) { completions.push(body); return { content: "{}", json: {}, model: String(body.model) }; },
    async judge() { return {}; },
    async platformJudge() { return {}; },
    async readSkill() { return null; },
    async serviceDoor(service, _method, path, _body, headers) {
      asked.push({ service, path, headers });
      if (pickStatus !== 200) return { status: pickStatus, body: { error: "no LLM of the x Engine's universe can be picked now", reason: "no_llm_in_engine_universe" } };
      n++;
      return { status: 200, body: { llm: n % 2 ? { llmDynastySlug: "kimi-k3", name: "Kimi K3", provider: "moonshot", model: "kimi-k3" } : { llmDynastySlug: "gemini-flash-lite", name: "Gemini Flash-Lite", provider: "google", model: "gemini-flash-lite" } } };
    },
  };
  return { asked, completions, deps };
}
const HEADERS = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-script-1", "x-campaign-id": "camp-1" };

describe("llm.pick", () => {
  it("asks features-service per call: the script's Engine, the call's place, the campaign, on the script's run", async () => {
    const v = vendors();
    const a = await callVendor(LLM_PICK, { place: "angles" }, { headers: HEADERS, tactics: {}, outcome: "x_post_published" }, v.deps);
    const b = await callVendor(LLM_PICK, { place: "writer" }, { headers: HEADERS, tactics: {}, outcome: "x_post_published" }, v.deps);
    expect(v.asked.map((x) => x.path)).toEqual([
      "/internal/llm-pick?outcome=x_post_published&place=angles&campaignId=camp-1",
      "/internal/llm-pick?outcome=x_post_published&place=writer&campaignId=camp-1",
    ]);
    expect(v.asked.every((x) => x.service === "features" && x.headers["x-run-id"] === "run-script-1")).toBe(true);
    expect(a).toMatchObject({ ok: true, data: { provider: "moonshot", model: "kimi-k3", place: "angles", outcome: "x_post_published" } });
    expect(b).toMatchObject({ ok: true, data: { provider: "google", model: "gemini-flash-lite", llm: { model: "gemini-flash-lite" } } });
  });

  it("picks for an Engine the script ASKS (the one whose script makes the call), never another", async () => {
    const v = vendors();
    const ok = await callVendor(LLM_PICK, { place: "writer", outcome: "message_written" }, { headers: HEADERS, tactics: { asks: ["message_written"] }, outcome: "email_sent" }, v.deps);
    expect(ok.ok).toBe(true);
    expect(v.asked[0]!.path).toContain("outcome=message_written&place=writer");
    const no = await callVendor(LLM_PICK, { place: "writer", outcome: "paid_client" }, { headers: HEADERS, tactics: { asks: ["message_written"] }, outcome: "email_sent" }, v.deps);
    expect(no.ok).toBe(false);
    expect(v.asked).toHaveLength(1);
  });

  it("no LLM in the Engine's universe = a refusal naming it (never a fallback model)", async () => {
    const v = vendors(422);
    const out = await callVendor(LLM_PICK, { place: "writer" }, { headers: HEADERS, tactics: {}, outcome: "x_post_published" }, v.deps);
    expect(out).toMatchObject({ ok: false, data: { status: 422, code: "no_llm_in_engine_universe" } });
    expect((await callVendor(LLM_PICK, {}, { headers: HEADERS, tactics: {}, outcome: "x_post_published" }, v.deps)).data.error).toMatch(/needs a place/);
  });

  it("a completion never takes its model from a tactic: only the call's own (the pick's) provider and model", async () => {
    const v = vendors();
    const out = await callVendor(LLM_COMPLETE, { message: "m", systemPrompt: "s" }, { headers: HEADERS, tactics: { llm: { provider: "anthropic", model: "opus" } } }, v.deps);
    expect(out.ok).toBe(false);
    expect(String(out.data.error)).toMatch(/llm\.pick/);
    expect(v.completions).toHaveLength(0);
  });
});

// A miniature of the reply judge's stored code: the shape the upgrade edits.
const JUDGE_V2 = `/**
 * v2 states the model call exactly as production sends it
 * (provider deepseek, deepseek-flash, JSON, temperature 0, reasoning off), proven on instantly's recorded requests.
 */
export default function run(ctx: any) {
  const message = String(ctx.request.text);
  const answer = ctx.vendor.call("llm.complete", { message, systemPrompt: "S", provider: "deepseek", model: "deepseek-flash", responseFormat: "json", temperature: 0, disableThinking: true });
  if (!answer.ok) throw new Error("llm.complete failed: " + String(answer.data.error));
  return { content: { label: answer.data.json.label } };
}
`;
const JUDGE = LLM_PICK_UPGRADES.find((u) => u.dynasty === "dy_reply_judge")!;
const RECORDED: ReplayCase = {
  id: "judge-1",
  units: {},
  request: { text: "Sounds good, call me" },
  calls: [{ name: "llm.complete", args: { message: "Sounds good, call me", systemPrompt: "S", provider: "deepseek", model: "deepseek-flash", responseFormat: "json", temperature: 0, disableThinking: true }, answer: { ok: true, data: { json: { label: "interested" } } } }],
  expect: { content: { label: "interested" } },
};

describe("the upgrade of a script that named a model", () => {
  it("states no model any more, asks the pick for each call, and replays its restated record 100 %", async () => {
    const code = JUDGE.code(JUDGE_V2);
    expect(code.split("\n").filter((l) => NAMED_MODEL.test(l))).toEqual([]);
    expect(code).toContain('...pickLlm(ctx, "judge")');
    expect(code).toContain(PICK_LLM_FN.trim());
    expect((await replayCase(JUDGE_V2, RECORDED)).match).toBe(true);
    // The old record no longer matches the new code (a pick is called first) ...
    expect((await replayCase(code, RECORDED)).match).toBe(false);
    // ... its restatement does: one pick before the call, answering what the call recorded, the request byte for byte.
    const restated = restateCase(JUDGE, RECORDED);
    expect(restated.calls.map((c) => c.name)).toEqual(["llm.pick", "llm.complete"]);
    expect(restated.calls[0]).toMatchObject({ args: { place: "judge" }, answer: { ok: true, data: { provider: "deepseek", model: "deepseek-flash" } } });
    expect(await replayCase(code, restated)).toMatchObject({ match: true });
  });

  it("a recorded call whose request was not recorded is restated with the model the old code stated", async () => {
    const unrecorded: ReplayCase = { ...RECORDED, calls: [{ name: "llm.complete", answer: RECORDED.calls[0]!.answer }] };
    const restated = restateCase(JUDGE, unrecorded);
    expect(restated.calls[0]).toEqual({ name: "llm.pick", answer: { ok: true, data: expect.objectContaining({ provider: "deepseek", model: "deepseek-flash" }) } });
    expect(await replayCase(JUDGE.code(JUDGE_V2), restated)).toMatchObject({ match: true });
  });

  it("a pick that answers no LLM fails the run before any LLM call: nothing is written", async () => {
    const code = JUDGE.code(JUDGE_V2);
    const refused: ReplayCase = {
      ...RECORDED,
      calls: [{ name: "llm.pick", args: { place: "judge" }, answer: { ok: false, data: { error: "no LLM of the lead_interested Engine's universe", code: "no_llm_in_engine_universe" } } }],
      expect: { fails: "llm.pick judge: no LLM of the lead_interested Engine's universe" },
    };
    expect(await replayCase(code, refused)).toMatchObject({ match: true });
  });

  it("refuses to half-edit a stored version that drifted from the expected shape", () => {
    expect(() => JUDGE.code(JUDGE_V2.replace('provider: "deepseek", model: "deepseek-flash", ', ""))).toThrow(UpgradeEditError);
  });

  it("the model-name check reads names, not a file extension", () => {
    expect(NAMED_MODEL.test('{ model: "sonnet" }')).toBe(true);
    expect(NAMED_MODEL.test('provider: "anthropic", model: "opus"')).toBe(true);
    expect(NAMED_MODEL.test("/\\.(ogg|opus|mp3)$/i")).toBe(false);
  });
});

// Phase 2 (LLM-RATING-PER-ENGINE-1112): the template of a writing call is the Rating's pick too.
function templateDoor(status = 200) {
  const asked: string[] = [];
  const deps: VendorDeps = {
    async complete() { return {}; }, async platformComplete() { return {}; }, async judge() { return {}; }, async platformJudge() { return {}; }, async readSkill() { return null; },
    async serviceDoor(_s, _m, path) {
      asked.push(path);
      return status === 200
        ? { status, body: { template: { templateDynastySlug: "x-post-shape-rotation", name: "X: Shape of the day", head: "x-post-shape-rotation-v2" } } }
        : { status, body: { error: "no active template dynasty the x Engine may write with", reason: "no_template_for_engine" } };
    },
  };
  return { asked, deps };
}

describe("template.pick", () => {
  it("asks the Rating's template pick for the script's Engine and writing call, per call", async () => {
    const v = templateDoor();
    const out = await callVendor(TEMPLATE_PICK, { place: "writer" }, { headers: HEADERS, tactics: {}, outcome: "x_post_published" }, v.deps);
    expect(v.asked).toEqual(["/internal/template-pick?outcome=x_post_published&place=writer&campaignId=camp-1"]);
    expect(out).toMatchObject({ ok: true, data: { templateDynastySlug: "x-post-shape-rotation", template: { templateDynastySlug: "x-post-shape-rotation" } } });
  });
  it("no template for the Engine = a refusal (never a fixed template)", async () => {
    const out = await callVendor(TEMPLATE_PICK, { place: "writer" }, { headers: HEADERS, tactics: {}, outcome: "x_post_published" }, templateDoor(422).deps);
    expect(out).toMatchObject({ ok: false, data: { status: 422, code: "no_template_for_engine" } });
  });
  it("the upgrade replaces the legacy writer pick call, and its record is restated as the template pick", async () => {
    const u = TEMPLATE_PICK_UPGRADES.find((x) => x.dynasty === "dy_x_post")!;
    const stored = `export default function run(ctx: any) {
  const writerPick = must(ctx, "features.writer_pick", { query: { campaignId } });
  return writerPick;
}
function must(ctx: any, n: string, a: any) { const r = ctx.vendor.call(n, a); if (!r.ok) throw new Error(n); return r.data; }
const campaignId = "c";
`;
    const code = u.code(stored);
    expect(code).toContain('must(ctx, "template.pick", { place: "writer" })');
    expect(code).not.toContain("writer_pick");
    const c: ReplayCase = { id: "t1", units: {}, calls: [{ name: "features.writer_pick", args: { query: { campaignId: "c" } }, answer: { ok: true, data: { template: { templateDynastySlug: "x-post-shape-rotation" }, llm: { model: "fable" } } } }], expect: { content: undefined } };
    const r = restateTemplateCase(u, c);
    expect(r.calls[0]).toMatchObject({ name: "template.pick", args: { place: "writer" }, answer: { ok: true, data: { template: { templateDynastySlug: "x-post-shape-rotation" } } } });
    expect(JSON.stringify(r)).not.toContain("fable");
  });
});
