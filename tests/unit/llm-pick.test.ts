import { describe, it, expect } from "vitest";
import { callVendor, LLM_COMPLETE, LLM_PICK, TEMPLATE_PICK, type VendorDeps } from "../../src/lib/scripts/vendors.js";

// SCRIPT-VALUE-RATING-1113-WF2 (owner 2026-11-13: « un pick = toujours un script », « le LLM et le template sont des
// tactics du script »): `llm.pick` / `template.pick` read the script's OWN tactics; nothing asks features-service at run
// time. Another LLM or template is another dynasty, compared by features-service's script pick.
function vendors() {
  const asked: string[] = [];
  const completions: Record<string, unknown>[] = [];
  const deps: VendorDeps = {
    async complete(body) { completions.push(body); return { content: "{}", json: {}, model: String(body.model) }; },
    async platformComplete(body) { completions.push(body); return { content: "{}", json: {}, model: String(body.model) }; },
    async judge() { return {}; },
    async platformJudge() { return {}; },
    async readSkill() { return null; },
    async serviceDoor(service, _method, path) {
      asked.push(`${service} ${path}`);
      return { status: 500, body: { error: "no service is asked for a script's LLM or template" } };
    },
  };
  return { asked, completions, deps };
}
const HEADERS = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-script-1", "x-campaign-id": "camp-1" };
const KIMI = { provider: "moonshot", model: "kimi-k3" };
const FLASH = { provider: "google", model: "gemini-flash-lite" };

describe("llm.pick reads the script's tactics", () => {
  it("answers tactic llm for every call, llms[place] for a call the script states apart; no service is asked", async () => {
    const v = vendors();
    const tactics = { llm: KIMI, llms: { angles: FLASH } };
    const a = await callVendor(LLM_PICK, { place: "angles" }, { headers: HEADERS, tactics, outcome: "x_post_published" }, v.deps);
    const b = await callVendor(LLM_PICK, { place: "writer" }, { headers: HEADERS, tactics, outcome: "x_post_published" }, v.deps);
    expect(a).toMatchObject({ ok: true, data: { provider: "google", model: "gemini-flash-lite", place: "angles", outcome: "x_post_published" } });
    expect(b).toMatchObject({ ok: true, data: { provider: "moonshot", model: "kimi-k3", llm: { model: "kimi-k3" } } });
    // A DAG port states its call as a step (`query.place`; stored ports still carry the old service/path, inert): read the same way.
    const c = await callVendor(LLM_PICK, { service: "features", method: "GET", path: "/internal/llm-pick", query: { place: "writer" } }, { headers: HEADERS, tactics, outcome: "lead_interested" }, v.deps);
    expect(c).toMatchObject({ ok: true, data: { model: "kimi-k3" } });
    expect(v.asked).toEqual([]);
  });

  it("an Engine the script ASKS takes the asking script's LLM; any other Engine is refused", async () => {
    const v = vendors();
    const ok = await callVendor(LLM_PICK, { place: "writer", outcome: "message_written" }, { headers: HEADERS, tactics: { asks: ["message_written"], llm: FLASH }, outcome: "email_sent" }, v.deps);
    expect(ok).toMatchObject({ ok: true, data: { model: "gemini-flash-lite", outcome: "message_written" } });
    const no = await callVendor(LLM_PICK, { place: "writer", outcome: "paid_client" }, { headers: HEADERS, tactics: { asks: ["message_written"], llm: FLASH }, outcome: "email_sent" }, v.deps);
    expect(no.ok).toBe(false);
  });

  it("no LLM stated = a refusal naming the tactic, never a default model; Haiku 4.5 is refused", async () => {
    const v = vendors();
    const none = await callVendor(LLM_PICK, { place: "writer" }, { headers: HEADERS, tactics: {}, outcome: "x_post_published" }, v.deps);
    expect(none).toMatchObject({ ok: false });
    expect(String(none.data.error)).toMatch(/states no LLM/);
    expect((await callVendor(LLM_PICK, {}, { headers: HEADERS, tactics: { llm: KIMI }, outcome: "x_post_published" }, v.deps)).data.error).toMatch(/needs a place/);
    const banned = await callVendor(LLM_PICK, { place: "writer" }, { headers: HEADERS, tactics: { llm: { provider: "anthropic", model: "claude-haiku-4-5" } }, outcome: "x_post_published" }, v.deps);
    expect(banned.ok).toBe(false);
    expect(v.asked).toEqual([]);
  });

  it("a completion still takes only the call's own provider and model (what llm.pick read), never the tactic directly", async () => {
    const v = vendors();
    const out = await callVendor(LLM_COMPLETE, { message: "m", systemPrompt: "s" }, { headers: HEADERS, tactics: { llm: { provider: "anthropic", model: "sonnet" } } }, v.deps);
    expect(out.ok).toBe(false);
    expect(v.completions).toHaveLength(0);
  });
});

describe("template.pick reads the script's tactics", () => {
  it("answers tactic template (templates[place] first) in the shape the writers read; no service is asked", async () => {
    const v = vendors();
    const tactics = { template: "x-post-shape-rotation", templates: { reply: "x-post-reply" } };
    const out = await callVendor(TEMPLATE_PICK, { place: "writer" }, { headers: HEADERS, tactics, outcome: "x_post_published" }, v.deps);
    expect(out).toMatchObject({ ok: true, data: { templateDynastySlug: "x-post-shape-rotation", template: { templateDynastySlug: "x-post-shape-rotation" } } });
    const reply = await callVendor(TEMPLATE_PICK, { place: "reply" }, { headers: HEADERS, tactics, outcome: "x_post_published" }, v.deps);
    expect(reply).toMatchObject({ ok: true, data: { templateDynastySlug: "x-post-reply" } });
    expect(v.asked).toEqual([]);
  });

  it("no template stated = a refusal (never a fixed template)", async () => {
    const out = await callVendor(TEMPLATE_PICK, { place: "writer" }, { headers: HEADERS, tactics: {}, outcome: "x_post_published" }, vendors().deps);
    expect(out.ok).toBe(false);
    expect(String(out.data.error)).toMatch(/states no template/);
  });
});
