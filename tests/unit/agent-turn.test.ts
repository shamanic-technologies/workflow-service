import { describe, it, expect } from "vitest";
import { runAgentTurn, splitQuery, AGENT_READ_STEP_SCHEMA, AGENT_MAX_STEPS, AGENT_TOOLS_STRATEGY } from "../../src/lib/agent-turn.js";
import type { RecipientScope } from "../../src/lib/figure-reader.js";

const CHAIM_ORG = "11111111-1111-4111-8111-111111111111";
const CHAIM_USER = "22222222-2222-4222-8222-222222222222";
const CHAIM_BRAND = "33333333-3333-4333-8333-333333333333";
const CHAIM_CAMPAIGN = "44444444-4444-4444-8444-444444444444";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const OTHER_CAMPAIGN = "88888888-8888-4888-8888-888888888888";

const bearer = [{ bearerAuth: [] }];
const SPEC = {
  paths: {
    "/v1/brands": { get: { summary: "List brands", security: bearer } },
    "/v1/campaigns": { get: { summary: "List campaigns", security: bearer, parameters: [{ name: "brandId", in: "query", required: false }] } },
    "/v1/campaigns/{id}": { get: { summary: "One campaign", security: bearer, parameters: [{ name: "id", in: "path", required: true }] } },
    "/v1/billing/accounts/balance": { get: { summary: "Balance", security: bearer } },
  },
};

const CHAIM: RecipientScope = {
  email: "chaim@beyondlogic.test",
  userIds: [CHAIM_USER],
  organizations: [{ orgId: CHAIM_ORG, name: "Beyond Logic", userId: CHAIM_USER }],
};

const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { decision: { type: "string" }, message: { type: "string" }, reason: { type: "string" } },
  required: ["decision", "message", "reason"],
};

function deps(opts: { scope: RecipientScope; steps: Array<Record<string, unknown>> }) {
  const calls: Array<Record<string, unknown>> = [];
  const gets: Array<{ url: string; identity: { orgId: string; userId: string } | null }> = [];
  let i = 0;
  return {
    calls,
    gets,
    d: {
      loadSpec: async () => SPEC,
      resolveRecipient: async () => opts.scope,
      apiGet: async (url: string, identity: { orgId: string; userId: string } | null) => {
        gets.push({ url, identity });
        if (url === "/v1/brands") return { status: 200, body: { brands: [{ id: CHAIM_BRAND, name: "Beyond Logic" }] } };
        if (url.startsWith("/v1/campaigns")) return { status: 200, body: { campaigns: [{ id: CHAIM_CAMPAIGN, name: "Wide Email Replies 23", status: "ongoing" }] } };
        return { status: 200, body: { balanceUsd: 0, paymentMethod: "card_saved" } };
      },
      complete: async (request: Record<string, unknown>) => {
        calls.push(request);
        const json = opts.steps[Math.min(i, opts.steps.length - 1)];
        i += 1;
        return { content: JSON.stringify(json), json, model: "glm-5.3" };
      },
    },
  };
}

const ANSWER = { decision: "later", message: "", reason: "His campaign launched 2 minutes ago: nothing to move yet." };

describe("runAgentTurn", () => {
  const req = { systemPrompt: "GAME", message: "THREAD", responseSchema: ANSWER_SCHEMA, provider: "zai", model: "glm", recipientEmail: "Chaim@BeyondLogic.test" };

  it("reads the person's own account through tools, then answers in the writer's own schema, and records why and what", async () => {
    const { d, calls, gets } = deps({
      scope: CHAIM,
      steps: [
        { why: "Is his campaign live, and is his card saved?", reads: [
          { orgId: CHAIM_ORG, path: "/v1/campaigns", query: [{ name: "brandId", value: CHAIM_BRAND }] },
          { orgId: CHAIM_ORG, path: "/v1/billing/accounts/balance", query: [] },
        ] },
        { why: "Campaign live, card saved: nothing to ask, results come next.", reads: [] },
        ANSWER,
      ],
    });
    const out = await runAgentTurn(req, d);
    expect(out.json).toEqual(ANSWER);
    expect(out.steps.map((s) => s.action)).toEqual(["read", "read", "answer"]);
    expect(out.steps[0].why).toBe("Is his campaign live, and is his card saved?");
    expect(out.reads.map((r) => r.target)).toEqual(["/v1/brands", `/v1/campaigns?brandId=${CHAIM_BRAND}`, "/v1/billing/accounts/balance"]);
    // Every read acts as HIM, in HIS org.
    expect(gets.every((g) => g.identity?.orgId === CHAIM_ORG && g.identity?.userId === CHAIM_USER)).toBe(true);
    // The model the caller states (GLM), through chat-service: flat read steps, then the writer's schema itself.
    expect(calls.every((c) => c.provider === "zai" && c.model === "glm")).toBe(true);
    expect(calls[0].responseSchema).toEqual(AGENT_READ_STEP_SCHEMA);
    expect(calls[2].responseSchema).toEqual(ANSWER_SCHEMA);
    expect((calls[2].systemPrompt as string)).toBe("GAME\n\n" + AGENT_TOOLS_STRATEGY);
    // What he already has is in front of the model when it answers; the route list is not.
    expect(calls[2].message as string).toContain("Wide Email Replies 23");
    expect(calls[2].message as string).not.toContain("READABLE ROUTES");
  });

  it("never reads another organization, whatever the model asks", async () => {
    const { d, gets } = deps({
      scope: CHAIM,
      steps: [
        { why: "x", reads: [
          { orgId: OTHER_ORG, path: "/v1/campaigns", query: [] },
          { orgId: CHAIM_ORG, path: `/v1/campaigns/${OTHER_CAMPAIGN}`, query: [] },
        ] },
        { why: "y", reads: [] },
        ANSWER,
      ],
    });
    const out = await runAgentTurn(req, d);
    expect(gets.map((g) => g.url)).toEqual(["/v1/brands"]);
    expect(out.reads.filter((r) => r.refused).map((r) => r.refused?.split(":")[0])).toEqual(["org_not_recipients", "identifier_not_from_recipient"]);
  });

  it("stops reading after its read steps and answers, and throws on an answer that is not JSON", async () => {
    const read = { why: "more", reads: [{ orgId: CHAIM_ORG, path: "/v1/brands", query: [] }] };
    const { d, calls } = deps({ scope: CHAIM, steps: [read, read, read, ANSWER] });
    const out = await runAgentTurn(req, d);
    expect(calls).toHaveLength(AGENT_MAX_STEPS);
    expect(calls[AGENT_MAX_STEPS - 1].responseSchema).toEqual(ANSWER_SCHEMA);
    expect(out.json).toEqual(ANSWER);

    const broken = deps({ scope: CHAIM, steps: [{ why: "", reads: [] }] });
    broken.d.complete = async (request: Record<string, unknown>) =>
      request.responseSchema === ANSWER_SCHEMA ? { content: "not json", model: "glm-5.3" } : { content: "{}", json: { why: "", reads: [] }, model: "glm-5.3" };
    await expect(runAgentTurn(req, broken.d)).rejects.toThrow(/answered no JSON/);
  });

  it("a read the gateway fails is shown as unread and the turn goes on; an unreadable account fails the turn", async () => {
    const { d, calls } = deps({
      scope: CHAIM,
      steps: [{ why: "campaigns", reads: [{ orgId: CHAIM_ORG, path: "/v1/campaigns", query: [{ name: "brandId", value: CHAIM_BRAND }] }] }, { why: "ok", reads: [] }, ANSWER],
    });
    const get = d.apiGet;
    d.apiGet = async (url, identity) => {
      if (url.startsWith("/v1/campaigns")) throw new Error("api-service GET /v1/campaigns -> 500");
      return get(url, identity);
    };
    const out = await runAgentTurn(req, d);
    expect(out.json).toEqual(ANSWER);
    expect(out.reads[1]).toMatchObject({ status: null, refused: expect.stringMatching(/^read_failed: /) });
    expect(calls[2].message as string).toContain("Not a fact about them");

    const down = deps({ scope: CHAIM, steps: [ANSWER] });
    down.d.apiGet = async () => { throw new Error("api-service down"); };
    await expect(runAgentTurn(req, down.d)).rejects.toThrow(/their account could not be read/);
  });

  it("answers in one call, no tools, for a person with no account", async () => {
    const none: RecipientScope = { email: "p@x.test", userIds: [], organizations: [] };
    const { d, calls, gets } = deps({ scope: none, steps: [ANSWER] });
    const out = await runAgentTurn({ ...req, systemPrompt: "S", recipientEmail: "p@x.test" }, d);
    expect(gets).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].responseSchema).toEqual(ANSWER_SCHEMA);
    expect(calls[0].systemPrompt).toBe("S");
    expect(out.json).toEqual(ANSWER);
    expect(out.reads).toEqual([]);
  });
});

describe("splitQuery", () => {
  it("reads a query string written in the path as query parameters, keeping a stated one", () => {
    expect(splitQuery({ orgId: "o", path: "/v1/campaigns?brandId=b&status=all", query: [{ name: "status", value: "ongoing" }] })).toEqual({
      orgId: "o",
      path: "/v1/campaigns",
      query: [{ name: "status", value: "ongoing" }, { name: "brandId", value: "b" }],
    });
    const plain = { orgId: "o", path: "/v1/brands", query: [] };
    expect(splitQuery(plain)).toBe(plain);
  });
});
