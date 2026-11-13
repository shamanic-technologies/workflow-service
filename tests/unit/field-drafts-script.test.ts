import { describe, it, expect } from "vitest";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import {
  buildFieldDraftSource,
  DRAFT_REQUEST,
  FIELD_DRAFT_ENGINES,
  FIELD_DRAFT_DYNASTY,
  fieldDraftTactics,
  forkDynasty,
} from "../../scripts/engine-ports/field-drafts.js";

// SCRIPT-VALUE-RATING-1113-WF3: brand-service's offer/brand field drafts are made by a script whose tactic states the LLM.
const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const src = buildFieldDraftSource();
const engine = FIELD_DRAFT_ENGINES[0]!;
const tactics = fieldDraftTactics(engine.base);
const schema = { type: "object", properties: { offerName: { type: "string" } }, required: ["offerName"] };

describe("the field draft script", () => {
  it("reads only the draft request, names no outcome and no model", async () => {
    expect((await validateSource(src)).materials).toEqual([DRAFT_REQUEST]);
    expect(src).not.toMatch(/offer_fields_drafted|brand_fields_drafted/);
    for (const llm of Object.values(engine)) if (typeof llm === "object" && llm && "model" in llm) expect(src).not.toContain(`"${(llm as { model: string }).model}"`);
  });

  it("writes every call of the draft, in order, with the LLM its tactics state, passing the call's fields as stated", async () => {
    const c: ReplayCase = {
      id: "two-batches",
      units: {
        [DRAFT_REQUEST]: {
          calls: [
            { place: "draft", systemPrompt: "S1", message: "M1", responseFormat: "json", responseSchema: schema, maxTokens: 24000 },
            { place: "draft", systemPrompt: "S2", message: "M2", responseFormat: "json", maxTokens: 24000, disableThinking: true },
          ],
        },
      },
      request: null,
      tactics,
      calls: [
        { name: "llm.pick", args: { place: "draft" }, answer: ok({ provider: "deepseek", model: "deepseek-flash" }) },
        {
          name: "llm.complete",
          args: { message: "M1", systemPrompt: "S1", provider: "deepseek", model: "deepseek-flash", responseSchema: schema, responseFormat: "json", maxTokens: 24000 },
          answer: ok({ content: "{}", json: { offerName: "A" }, model: "deepseek-flash-v5" }),
        },
        { name: "llm.pick", args: { place: "draft" }, answer: ok({ provider: "deepseek", model: "deepseek-flash" }) },
        {
          name: "llm.complete",
          args: { message: "M2", systemPrompt: "S2", provider: "deepseek", model: "deepseek-flash", responseFormat: "json", maxTokens: 24000, disableThinking: true },
          answer: ok({ content: "{}", json: { usp: "B" }, model: "deepseek-flash-v5" }),
        },
      ],
      expect: {
        content: {
          answers: [
            { place: "draft", json: { offerName: "A" }, content: "{}", model: "deepseek-flash-v5" },
            { place: "draft", json: { usp: "B" }, content: "{}", model: "deepseek-flash-v5" },
          ],
        },
      },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("fails loud when chat-service refuses a call, and on a request with no call", async () => {
    const refused: ReplayCase = {
      id: "refused",
      units: { [DRAFT_REQUEST]: { calls: [{ place: "consolidate", systemPrompt: "S", message: "M" }] } },
      request: null,
      tactics,
      calls: [
        { name: "llm.pick", args: { place: "consolidate" }, answer: ok({ provider: "deepseek", model: "deepseek-flash" }) },
        { name: "llm.complete", args: { message: "M", systemPrompt: "S", provider: "deepseek", model: "deepseek-flash" }, answer: { ok: false, data: { error: "402 balance" } } },
      ],
      expect: { fails: "llm.complete failed (): 402 balance" },
    };
    expect((await replayCase(src, refused)).diffs).toEqual([]);
    const empty: ReplayCase = { id: "empty", units: { [DRAFT_REQUEST]: { calls: [] } }, request: null, tactics, calls: [], expect: { fails: "fields-draft: the draft request states no call" } };
    expect((await replayCase(src, empty)).diffs).toEqual([]);
  });

  it("one dynasty per LLM production ran, the base on the most-run one, never Claude Opus, Fable or Haiku 4.5", () => {
    const all = FIELD_DRAFT_ENGINES.flatMap((e) => [e.base, ...e.forks].map((l) => ({ outcome: e.outcome, dynasty: l === e.base ? FIELD_DRAFT_DYNASTY : forkDynasty(l), model: l.model })));
    expect(all.map((d) => `${d.outcome}/${d.dynasty}:${d.model}`)).toEqual([
      "offer_fields_drafted/dy_fields_draft:deepseek-flash",
      "offer_fields_drafted/dy_fields_draft__gemini_pro:gemini-pro",
      "offer_fields_drafted/dy_fields_draft__gpt_terra:gpt-terra",
      "offer_fields_drafted/dy_fields_draft__glm:glm",
      "offer_fields_drafted/dy_fields_draft__gpt_astra:gpt-astra",
      "brand_fields_drafted/dy_fields_draft:kimi-k3",
    ]);
    for (const d of all) expect(d.model).not.toMatch(/opus|fable|haiku-4-5/i);
    expect(tactics.recorded_by).toBe("brand");
  });
});
