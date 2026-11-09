import { describe, it, expect } from "vitest";
import { callVendor, LLM_COMPLETE, type VendorDeps } from "../../src/lib/scripts/vendors.js";

// BRAND-MCP-1109: a script asks chat-service for the brand's own MCP tools on its completion (`brandTools`). The door
// states the opt-in on BOTH tiers, each in the shape its endpoint reads: `/complete` = `{brandId}` (the org is the
// run's `x-org-id`), `/internal/platform-complete` = `{orgId, brandId}` (no org header on that tier).
function vendors(answer: Record<string, unknown> = { content: "{}", json: { decision: "later" }, model: "m" }) {
  const seen: Array<[string, Record<string, unknown>, Record<string, string>]> = [];
  const deps: VendorDeps = {
    async complete(body, headers) { seen.push(["complete", body, headers]); return answer; },
    async platformComplete(body, headers) { seen.push(["platformComplete", body, headers]); return answer; },
    async judge() { return {}; },
    async platformJudge() { return {}; },
    async readSkill() { return null; },
    async serviceDoor() { return { status: 500, body: {} }; },
  };
  return { seen, deps };
}
const HEADERS = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-script-1", "x-brand-id": "brand-1" };
const ARGS = { provider: "anthropic", model: "opus", systemPrompt: "S", message: "M", responseFormat: "json", responseSchema: { type: "object", properties: {} } };

describe("llm.complete with the brand's tools", () => {
  it("org tier: sends brandTools {brandId} to /complete", async () => {
    const v = vendors();
    const out = await callVendor(LLM_COMPLETE, { ...ARGS, brandTools: { brandId: "brand-1" } }, { headers: HEADERS, tactics: {} }, v.deps);
    expect(out.ok).toBe(true);
    expect(v.seen[0]![0]).toBe("complete");
    expect(v.seen[0]![1].brandTools).toEqual({ brandId: "brand-1" });
  });

  it("platform tier: sends brandTools {orgId, brandId} to /internal/platform-complete, the org from the run", async () => {
    const v = vendors();
    const out = await callVendor(LLM_COMPLETE, { ...ARGS, brandTools: { brandId: "brand-1" } }, { headers: HEADERS, tactics: {}, billing: "platform" }, v.deps);
    expect(out.ok).toBe(true);
    expect(v.seen[0]![0]).toBe("platformComplete");
    expect(v.seen[0]![1].brandTools).toEqual({ orgId: "org-1", brandId: "brand-1" });
    expect(v.seen[0]![2]).toEqual({ "x-run-id": "run-script-1" });
  });

  it("platform tier with no org behind the run: refused before any spend (a brand's tools are its org's)", async () => {
    const v = vendors();
    const out = await callVendor(LLM_COMPLETE, { ...ARGS, brandTools: { brandId: "brand-1" } }, { headers: { ...HEADERS, "x-org-id": "" }, tactics: {}, billing: "platform" }, v.deps);
    expect(out.ok).toBe(false);
    expect(v.seen).toEqual([]);
  });

  it("a brandTools with no brandId is refused", async () => {
    const v = vendors();
    const out = await callVendor(LLM_COMPLETE, { ...ARGS, brandTools: {} }, { headers: HEADERS, tactics: {} }, v.deps);
    expect(out.ok).toBe(false);
    expect(v.seen).toEqual([]);
  });

  it("without brandTools the body is byte-identical to before", async () => {
    const v = vendors();
    await callVendor(LLM_COMPLETE, ARGS, { headers: HEADERS, tactics: {} }, v.deps);
    expect(v.seen[0]![1]).toEqual({ message: "M", systemPrompt: "S", provider: "anthropic", model: "opus", responseSchema: { type: "object", properties: {} }, responseFormat: "json" });
  });

  it("passes chat-service's brandToolCalls through to the script", async () => {
    const v = vendors({ content: "{}", json: { decision: "later" }, model: "m", brandToolCalls: 2 });
    const out = await callVendor(LLM_COMPLETE, { ...ARGS, brandTools: { brandId: "brand-1" } }, { headers: HEADERS, tactics: {} }, v.deps);
    expect(out).toMatchObject({ ok: true, data: { json: { decision: "later" }, brandToolCalls: 2 } });
  });

  it("no server plugged (no brandToolCalls in the answer): the data shape is unchanged", async () => {
    const v = vendors();
    const out = await callVendor(LLM_COMPLETE, { ...ARGS, brandTools: { brandId: "brand-1" } }, { headers: HEADERS, tactics: {} }, v.deps);
    expect(out.data).toEqual({ content: "{}", json: { decision: "later" }, model: "m", tokensInput: null, tokensOutput: null });
  });
});
