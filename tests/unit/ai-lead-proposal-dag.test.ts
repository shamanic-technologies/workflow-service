import { describe, it, expect, vi, afterEach } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { ANSWERS_LEADS_ONLY_POLICY } from "../../src/lib/ai-meeting-booking-dag.js";
import {
  AI_LEAD_PROPOSAL_DESCRIPTION,
  AI_LEAD_PROPOSAL_PIPE_ID,
  ASK,
  ASKED,
  CLAIMED_CODE,
  CLASSIFY_ASK_CODE,
  COMPOSE_TURN_CODE,
  HOT_LEAD_NO_COPILOT_USER_REASON,
  HOT_LEAD_PROPOSED_REASON,
  NO_COPILOT_USER,
  NOBODY_DUE,
  NOT_ADMITTED,
  OTHER_PERSON,
  PENDING,
  PLAN_CLAIM_CODE,
  UNCLAIMED,
  buildAiLeadProposalDag,
} from "../../src/lib/ai-lead-proposal-dag.js";

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, unknown>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, unknown>>;
}

function holds(condition: string, results: Record<string, unknown>): boolean {
  return new Function("results", `return (${condition});`)(results) as boolean;
}

afterEach(() => vi.restoreAllMocks());

const ORG = "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const BRAND = "11111111-2222-4333-8444-555555555555";
const HUMAN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const trigger = (over: Record<string, unknown> = {}) => ({
  eventId: "ev-offer-1",
  triggerId: "hot_lead",
  leadId: "lead-1",
  person: { email: "Jo@Example.com", name: "Jo Smith", phone: "+44 7700 900123" },
  item: {
    kind: "hot_lead",
    humanId: HUMAN,
    companyKey: "example.com",
    relationKey: `rel:${HUMAN}:example.com`,
    relationKeys: [`rel:${HUMAN}:example.com`],
    leadId: "lead-1",
    name: "Jo Smith",
    emails: ["jo@example.com"],
    phones: ["+447700900123"],
    lead: { state: "yes", basis: "judged" },
    wantsBusiness: { state: "yes", basis: "judged", confidence: 0.9, at: "2026-10-19T09:00:00.000Z" },
    lastInboundAt: "2026-10-19T08:59:00.000Z",
    becameHotAt: "2026-10-19T09:01:00.000Z",
    episode: 1,
  },
  ...over,
});
const claim = { found: true, followup: { id: "row-1", leadId: "lead-1", email: "jo@example.com", phone: null } };

describe("AI Lead Proposal DAG", () => {
  const dag = buildAiLeadProposalDag();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));

  it("lives on the Start -> Paid client pipe of the AI Lead Proposal channel", () => {
    expect(AI_LEAD_PROPOSAL_PIPE_ID).toBe("ai-lead-proposal|start_to_paid_client");
  });

  it("is a valid DAG that translates to Windmill with two top-level branchones", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    const flow = dagToOpenFlow(dag, "ai-lead-proposal-test");
    const top = flow.value.modules.filter((m: { value: { type: string } }) => m.value.type === "branchone");
    expect(top).toHaveLength(2);
    expect(dag.edges.filter((e) => e.to === "check-asked").map((e) => e.from)).toContain("claimed");
  });

  it("calls the proactive-turn route exactly once, and performs nothing else", () => {
    const calls = dag.nodes.filter((n) => n.type === "http.call").map((n) => `${n.config?.service} ${n.config?.method} ${n.config?.path}`);
    expect(calls.filter((c) => c === "chat POST /internal/copilot/proactive-turns")).toHaveLength(1);
    for (const c of calls) {
      expect(c).not.toMatch(/email-gateway|instantly|whatsapp|\/orgs\/replies|\/campaigns$|content-generation|\/complete/);
    }
    expect(byId.get("ask-copilot")?.inputMapping).toEqual({ body: "$ref:compose-turn.output.request" });
  });

  it("claims leads of the brand only (the tactic the leads-only strategy requires), stated in the body literal", () => {
    expect(byId.get("claim-own")?.config?.body).toEqual({ relationships: ANSWERS_LEADS_ONLY_POLICY });
    expect(ANSWERS_LEADS_ONLY_POLICY).toBe("pure_prospect");
    expect(AI_LEAD_PROPOSAL_DESCRIPTION).toContain('relationships set to "pure_prospect"');
  });

  it("closes the row strictly after the ask, with a named reason per outcome", () => {
    expect(byId.get("record-asked")?.config?.body).toEqual({ kind: "stopped", reason: HOT_LEAD_PROPOSED_REASON });
    expect(byId.get("record-no-copilot-user")?.config?.body).toEqual({ kind: "stopped", reason: HOT_LEAD_NO_COPILOT_USER_REASON });
    expect(byId.get("end-run-no-copilot-user")?.inputMapping).toEqual({ "body.delivery": "$ref:classify-ask.output.delivery" });
    expect(byId.get("end-run")?.config?.body).toMatchObject({ success: true, delivery: { state: "delivered" } });
  });

  it("a run carrying no hot lead claims nobody and ends idle", async () => {
    const plan = await loadMain(PLAN_CLAIM_CODE)(null);
    expect(plan).toEqual({ skip: true });
    const claimed = await loadMain(CLAIMED_CODE)(plan, { ok: false, skipped: true, notCalled: true }, null, ORG, BRAND);
    expect(claimed.outcome).toBe("nobody_due");
    expect(holds(NOBODY_DUE, { claimed })).toBe(true);
    expect(holds(ASK, { claimed })).toBe(false);
  });

  it("builds ONE request for the trigger's person, keyed on the fact", async () => {
    const plan = await loadMain(PLAN_CLAIM_CODE)(trigger());
    expect(plan).toEqual({ skip: false });
    const claimed = await loadMain(CLAIMED_CODE)(plan, claim, trigger(), ORG, BRAND);
    expect(claimed.outcome).toBe("ask");
    expect(claimed.rowId).toBe("row-1");
    const req = claimed.request as Record<string, unknown>;
    expect(req).toMatchObject({
      kind: "hot_lead",
      orgId: ORG,
      brandId: BRAND,
      lead: { leadId: "lead-1", email: "jo@example.com", phone: "+44 7700 900123", name: "Jo Smith" },
    });
    expect(req.idempotencyKey).toMatch(new RegExp(`^ai-lead-proposal:hot_lead:${BRAND}:${HUMAN}:[0-9a-f]{16}:1$`));
    expect(claimed.timelineQuery).toEqual({ brandId: BRAND, relationKey: `rel:${HUMAN}:example.com`, limit: "50" });
  });

  it("a retry of the same fact, or the same fact reported for another offer, sends the same key; a new episode a new one", async () => {
    const run = async (t: Record<string, unknown>) =>
      ((await loadMain(CLAIMED_CODE)({ skip: false }, claim, t, ORG, BRAND)).request as { idempotencyKey: string }).idempotencyKey;
    const first = await run(trigger());
    expect(await run(trigger())).toBe(first);
    expect(await run(trigger({ eventId: "ev-offer-2" }))).toBe(first);
    const nextEpisode = trigger();
    (nextEpisode.item as Record<string, unknown>).episode = 2;
    expect(await run(nextEpisode)).not.toBe(first);
  });

  it("keys on the event when the item carries no hot lead fact", async () => {
    const t = trigger({ item: {} });
    const claimed = await loadMain(CLAIMED_CODE)({ skip: false }, claim, t, ORG, BRAND);
    expect((claimed.request as { idempotencyKey: string }).idempotencyKey).toBe("ai-lead-proposal:event:ev-offer-1");
  });

  it("a person lead-service refuses is not admitted (final), a pending one ends idle", async () => {
    const refused = { found: false, relationships: { refused: [{ email: "jo@example.com", reason: "not_a_lead", tags: ["customer"] }], pending: [] } };
    const notAdmitted = await loadMain(CLAIMED_CODE)({ skip: false }, refused, trigger(), ORG, BRAND);
    expect(notAdmitted).toMatchObject({ outcome: "not_admitted", notAdmitted: { reason: "not_a_lead" }, request: null });
    expect(holds(NOT_ADMITTED, { claimed: notAdmitted })).toBe(true);

    const pending = { found: false, relationships: { refused: [], pending: [{ email: "jo@example.com", reason: "not_judged" }] } };
    const idle = await loadMain(CLAIMED_CODE)({ skip: false }, pending, trigger(), ORG, BRAND);
    expect(idle.outcome).toBe("pending");
    expect(holds(PENDING, { claimed: idle })).toBe(true);

    vi.spyOn(console, "error").mockImplementation(() => {});
    const none = await loadMain(CLAIMED_CODE)({ skip: false }, { found: false, reason: "nobody_due" }, trigger(), ORG, BRAND);
    expect(holds(UNCLAIMED, { claimed: none })).toBe(true);
  });

  it("claimed someone else: nothing asked, their row left alone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const other = { found: true, followup: { id: "row-2", leadId: "lead-2", email: "sam@other.com" } };
    const claimed = await loadMain(CLAIMED_CODE)({ skip: false }, other, trigger({ leadId: null }), ORG, BRAND);
    expect(claimed).toMatchObject({ outcome: "other_person", rowId: null, request: null });
    expect(holds(OTHER_PERSON, { claimed })).toBe(true);
  });

  it("refuses a run with several brands", async () => {
    await expect(loadMain(CLAIMED_CODE)({ skip: false }, claim, trigger(), ORG, `${BRAND},${BRAND}`)).rejects.toThrow(/exactly one brand/);
  });

  it("passes their latest inbound message as what they wrote", async () => {
    const claimed = await loadMain(CLAIMED_CODE)({ skip: false }, claim, trigger(), ORG, BRAND);
    const timeline = {
      items: [
        { kind: "message", direction: "inbound", channel: "email", text: "old", at: "2026-10-18T10:00:00.000Z" },
        { kind: "message", direction: "outbound", channel: "email", text: "our answer", at: "2026-10-19T08:00:00.000Z" },
        { kind: "message", direction: "inbound", channel: "whatsapp", text: "We want  to\nbuy 40 seats", at: "2026-10-19T08:59:00.000Z" },
      ],
    };
    const { request } = await loadMain(COMPOSE_TURN_CODE)(claimed, timeline);
    expect((request as Record<string, unknown>).inbound).toEqual({ channel: "whatsapp", text: "We want to buy 40 seats", at: "2026-10-19T08:59:00.000Z" });

    vi.spyOn(console, "error").mockImplementation(() => {});
    const unread = await loadMain(COMPOSE_TURN_CODE)(claimed, { ok: false, status: 500, error: "boom" });
    expect((unread.request as Record<string, unknown>).inbound).toEqual({ at: "2026-10-19T08:59:00.000Z" });
  });

  it("asked (202 or 200 duplicate) records the proposal", async () => {
    for (const ask of [
      { id: "6f1c1b7e-0000-4000-8000-000000000001", status: "processing", duplicate: false, delivery: "whatsapp" },
      { id: "6f1c1b7e-0000-4000-8000-000000000001", status: "delivered", duplicate: true, delivery: "web" },
    ]) {
      const classified = await loadMain(CLASSIFY_ASK_CODE)(ask);
      expect(classified.outcome).toBe("asked");
      expect(holds(ASKED, { "classify-ask": classified })).toBe(true);
      expect(holds(NO_COPILOT_USER, { "classify-ask": classified })).toBe(false);
    }
  });

  it("409 no_copilot_user ends as a named, final refusal", async () => {
    const classified = await loadMain(CLASSIFY_ASK_CODE)({
      ok: false,
      status: 409,
      error: JSON.stringify({ error: "no_copilot_user", detail: "Nobody in this org has used the Copilot yet: there is no thread to write in." }),
    });
    expect(classified).toEqual({
      outcome: "no_copilot_user",
      delivery: { state: "refused", code: "no_copilot_user", reason: "Nobody in this org has used the Copilot yet: there is no thread to write in." },
    });
    expect(holds(NO_COPILOT_USER, { "classify-ask": classified })).toBe(true);
  });

  it("any other failure throws (the run fails and is redelivered with the same key)", async () => {
    await expect(loadMain(CLASSIFY_ASK_CODE)({ ok: false, status: 502, error: "bad gateway" })).rejects.toThrow(/not accepted \(502\)/);
    await expect(loadMain(CLASSIFY_ASK_CODE)({ ok: false, status: 409, error: '{"error":"other"}' })).rejects.toThrow(/409/);
  });
});
