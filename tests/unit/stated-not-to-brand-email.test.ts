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
