import { describe, it, expect, vi, beforeEach } from "vitest";
import { main as httpCall } from "../../scripts/nodes/http-call.js";
import { REFUSAL_SKIP_CODES } from "../../src/lib/dag-to-openflow.js";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { STATED_NOT_TO_BRAND_CODE } from "../../src/lib/stated-not-to-brand.js";
import { OCCURRENCE_SEND_REFUSAL_CODES, SEND_DELIVERY_CODE } from "../../src/lib/occurrence-delivery.js";
import { FOLLOW_UP_SEND_REFUSAL_CODES, PASSING_REFUSAL_CODES } from "../../src/lib/right-moment.js";
import {
  FINAL_EMAIL_REFUSAL_CODES,
  NO_CHANNEL_RECHECK_DAYS,
  OUTCOME_CODE as FOLLOW_UP_OUTCOME_CODE,
  buildFollowUpReactiveDag,
} from "../../src/lib/follow-up-dag.js";
import { buildFormMeetingBookingDag, REFUSED as FORM_REFUSED } from "../../src/lib/form-meeting-booking-dag.js";
import {
  CLASSIFY_SEND_CODE,
  COMPOSE_REP_ALERT_CODE,
  PLAN_HAND_OVER_CODE,
  buildAiMeetingBookingDag,
  needsStatedNotToBrandSkip,
} from "../../src/lib/ai-meeting-booking-dag.js";
import { buildOfferDocumentReplyDag } from "../../src/lib/offer-document-reply-dag.js";

/**
 * DUALIST-WA-SILENCE-EMAIL-1104: email-gateway `/orgs/send` and instantly-service `/orgs/replies` (+ `/escalate`)
 * refuse 409 `stated_not_to_brand` for a person the brand stated is not someone of theirs. Every email-sending
 * workflow reads it as a quiet, final skip for that person: never a failure, a retry, a rep alert or another channel.
 * Every other refusal code behaves exactly as before.
 */

const CODE = STATED_NOT_TO_BRAND_CODE;

const mockEnv: Record<string, string> = {};
vi.stubGlobal("Bun", { env: mockEnv });
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

const refusedSend = (code: string) => ({ ok: false, skipped: true, status: 409, code, reason: "x" });
const notCalled = { ok: false, skipped: true, notCalled: true };
const node = (dag: DAG, id: string) => dag.nodes.find((n) => n.id === id);
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the cold-email send list (REFUSAL_SKIP_CODES, injected by the converter)", () => {
  const ENVS = { EMAIL_GATEWAY_SERVICE_URL: "https://gw.example.com", EMAIL_GATEWAY_SERVICE_API_KEY: "gw-key" };
  const SKIP_POSITION = 25;
  function callSend(codes: string[]) {
    const args = new Array(SKIP_POSITION + 1).fill(undefined);
    ["email-gateway", "POST", "/orgs/send", { to: "a@b.com" }, undefined, ENVS].forEach((v, i) => { args[i] = v; });
    args[7] = { field: "success", equals: true };
    args[SKIP_POSITION] = codes;
    return (httpCall as (...a: unknown[]) => Promise<unknown>)(...args);
  }
  const conflict = (code: string) =>
    new Response(JSON.stringify({ error: "refused", code }), { status: 409, headers: { "Content-Type": "application/json" } });

  it("lists the code, beside the two it had", () => {
    expect([...REFUSAL_SKIP_CODES]).toEqual(["recent_brand_contact", "lead_opted_out", CODE]);
    expect(OCCURRENCE_SEND_REFUSAL_CODES).toContain(CODE);
  });

  it("a 409 stated_not_to_brand is read as a skip: the run ends normally, nothing thrown", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(conflict(CODE));
    expect(await callSend([...REFUSAL_SKIP_CODES])).toMatchObject({ ok: false, skipped: true, status: 409, code: CODE });
  });

  it("an unlisted code still fails loud, as before", async () => {
    mockFetch.mockResolvedValueOnce(conflict("email_not_verified"));
    await expect(callSend([...REFUSAL_SKIP_CODES])).rejects.toThrow(/409/);
  });

  it("an occurrence run states it verbatim, the code campaign-service counts as an intended silence", async () => {
    const delivery = loadMain(SEND_DELIVERY_CODE);
    expect(await delivery({ skipped: true, code: CODE, reason: "stated", delivery: { state: "refused", code: CODE, reason: "stated" } }))
      .toEqual({ state: "refused", code: CODE, reason: "stated" });
  });
});

describe("form responder: every 409 already read, no other channel", () => {
  it("form responder: a refused email never goes on to WhatsApp", () => {
    const dag = buildFormMeetingBookingDag();
    expect(node(dag, "send-email")?.config?.skipOnRefusalCodes).toContain(CODE);
    expect(dag.edges).toContainEqual({ from: "check-sent", to: "record-refused", condition: FORM_REFUSED });
    const fromRefused = dag.edges.filter((e) => e.from === "record-refused").map((e) => e.to);
    expect(fromRefused).toEqual(["end-run-refused"]);
    expect(node(dag, "end-run-refused")?.config?.body).toEqual({ success: true, stopCampaign: false });
  });
});

describe("the follow-up channel's email", () => {
  const person = (over: Record<string, unknown> = {}) => ({ ok: true, entry: "claimed", rowId: "row-1", leadId: "lead-1", email: "sam@example.com", brandId: "b", ...over });
  const plan = { proceed: true, kind: "owed" };
  const write = { decision: "write", channel: "email", nextFollowUpAt: inDays(4), nextFollowUpWhy: "w" };
  const outcome = loadMain(FOLLOW_UP_OUTCOME_CODE);

  it("the send reads the refusal; it is not a final stop (the statement can be undone)", () => {
    expect(FOLLOW_UP_SEND_REFUSAL_CODES).toContain(CODE);
    expect(PASSING_REFUSAL_CODES as readonly string[]).not.toContain(CODE);
    expect(FINAL_EMAIL_REFUSAL_CODES).not.toContain(CODE);
    expect(FINAL_EMAIL_REFUSAL_CODES).toEqual(["lead_opted_out", "lead_not_a_prospect"]);
    expect(node(buildFollowUpReactiveDag({ readFigures: false }), "send-email")?.config?.skipOnRefusalCodes).toContain(CODE);
  });

  it("refused by email: ends like the WhatsApp statement (row reason, recheck date, no delivery, not admitted)", async () => {
    const out = await outcome(person(), plan, { channel: "email" }, write, notCalled, refusedSend(CODE), new Date().toISOString());
    expect(out).toMatchObject({
      endKind: "not_to_brand",
      skipRow: false,
      rowBody: { kind: "stopped", reason: "follow_up_stated_not_to_brand" },
      skipSetDate: false,
      skipStop: true,
      delivery: null,
      notAdmitted: { reason: CODE },
    });
    expect(Date.parse(out.setDateBody.nextFollowupAt)).toBeCloseTo(Date.now() + NO_CHANNEL_RECHECK_DAYS * 86400000, -5);
  });

  it("other email refusals behave as before", async () => {
    const now = new Date().toISOString();
    const kept = await outcome(person(), plan, { channel: "email" }, write, notCalled, refusedSend("recent_brand_contact"), now);
    expect(kept).toMatchObject({ endKind: "refused_kept", delivery: { state: "refused", code: "recent_brand_contact" } });
    const final = await outcome(person(), plan, { channel: "email" }, write, notCalled, refusedSend("lead_opted_out"), now);
    expect(final).toMatchObject({ endKind: "refused_final", skipStop: false, delivery: { state: "refused", code: "lead_opted_out" } });
  });
});

describe("ai-meeting-booking (and its offer-document copy): the email reply and the escalation", () => {
  const OPTS = { provider: "google", model: "pro" } as const;
  const classify = loadMain(CLASSIFY_SEND_CODE);
  const replyRefusal = (code: string) => ({ success: false, status: 409, error: JSON.stringify({ error: "refused", code }) });

  it("a 409 stated_not_to_brand on /orgs/replies ends on end-run-stated-not-to-brand, no delivery", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await classify(replyRefusal(CODE), notCalled, "email")).toEqual({ outcome: CODE, status: 409, channel: "email" });
    // Also when the sender nests the code under details.
    const nested = { success: false, status: 409, error: JSON.stringify({ error: "refused", details: { code: CODE } }) };
    expect(await classify(nested, notCalled, "email")).toMatchObject({ outcome: CODE });
    for (const dag of [buildAiMeetingBookingDag(OPTS), buildOfferDocumentReplyDag(OPTS)]) {
      expect(dag.edges).toContainEqual({ from: "check-sent", to: "end-run-stated-not-to-brand", condition: `results['classify-send']?.outcome == '${CODE}'` });
      expect(node(dag, "end-run-stated-not-to-brand")?.config?.body).toEqual({ success: true, stopCampaign: false });
      expect(node(dag, "end-run-stated-not-to-brand")?.inputMapping).toBeUndefined();
      expect(validateDAG(dag).valid).toBe(true);
    }
  });

  it("the takeover and every other refusal behave as before", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await classify(replyRefusal("human_took_over"), notCalled, "email"))
      .toMatchObject({ outcome: "human_took_over", delivery: { state: "refused", code: "human_took_over" } });
    await expect(classify(replyRefusal("no_reply_to_thread"), notCalled, "email")).rejects.toThrow(/could not be sent/);
    // A non-409 carrying the code is not the refusal.
    await expect(classify({ success: false, status: 500, error: JSON.stringify({ code: CODE }) }, notCalled, "email")).rejects.toThrow(/could not be sent/);
  });

  it("a refused escalation hands no row and alerts nobody", async () => {
    for (const dag of [buildAiMeetingBookingDag(OPTS), buildOfferDocumentReplyDag(OPTS)]) {
      expect(node(dag, "escalate-unanswerable")?.config?.skipOnRefusalCodes).toEqual([CODE]);
    }
    const planHandOver = loadMain(PLAN_HAND_OVER_CODE);
    const thread = { replyChannel: "email" };
    const claimed = { queue: "own", followup: { id: "row-1" } };
    expect(await planHandOver(thread, claimed, refusedSend(CODE))).toMatchObject({ skip: true });
    // The rep alert is email-thread-skipped already (escalation only runs on an email thread).
    const alert = await loadMain(COMPOSE_REP_ALERT_CODE)({ json: { question: "q" } }, { email: "sam@example.com" }, thread, { brand: { salesRepPhone: "+33600000000" } }, null);
    expect(alert).toMatchObject({ skip: true, reason: "email_thread" });
  });

  it("an escalation that went through, or was not called, is handed as before", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const planHandOver = loadMain(PLAN_HAND_OVER_CODE);
    const claimed = { queue: "own", followup: { id: "row-1" } };
    expect(await planHandOver({ replyChannel: "email" }, claimed, { success: true, escalation: { followupsStopped: true } })).toMatchObject({ skip: false });
    expect(await planHandOver({ replyChannel: "whatsapp" }, claimed, notCalled)).toMatchObject({ skip: false });
  });

  it("the seed upgrades a stored DAG whose escalation or reply does not read it", () => {
    const dag = buildAiMeetingBookingDag(OPTS);
    expect(needsStatedNotToBrandSkip(dag)).toBe(false);
    const oldEscalate = {
      nodes: dag.nodes.map((n) => (n.id === "escalate-unanswerable" ? { ...n, config: { ...n.config, skipOnRefusalCodes: undefined } } : n)),
    };
    expect(needsStatedNotToBrandSkip(oldEscalate)).toBe(true);
    const oldClassify = { nodes: dag.nodes.map((n) => (n.id === "classify-send" ? { ...n, config: { code: "old" } } : n)) };
    expect(needsStatedNotToBrandSkip(oldClassify)).toBe(true);
    const oldPlan = { nodes: dag.nodes.map((n) => (n.id === "plan-hand-over" ? { ...n, config: { code: "old" } } : n)) };
    expect(needsStatedNotToBrandSkip(oldPlan)).toBe(true);
  });
});
