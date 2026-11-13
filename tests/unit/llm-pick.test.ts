import { describe, it, expect } from "vitest";
import { callVendor, LLM_COMPLETE, LLM_PICK, TEMPLATE_PICK, type VendorDeps } from "../../src/lib/scripts/vendors.js";

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
});
