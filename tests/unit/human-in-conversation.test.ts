/**
 * SOPHIE-WA-1016 follow-up: crm-service refuses a WhatsApp send with `human_in_conversation` when someone of the brand
 * typed by hand in that person's thread (automation stays out of it for good). A run hitting it ends cleanly, never
 * as a failed run that campaign-service retries, and never re-looks at the person.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BRAND_SIDE_REFUSAL_CODES,
  HUMAN_IN_CONVERSATION_CODE,
  REACH_VERDICT_CODE,
  RECORD_PLAN_CODE,
  WHATSAPP_REFUSAL_CODES,
  buildColdWhatsappOutreachDag,
} from "../../src/lib/cold-whatsapp-outreach-dag.js";
import { FOLLOW_UP_WHATSAPP_REFUSAL_CODES } from "../../src/lib/follow-up-dag.js";
import {
  CLASSIFY_SEND_CODE,
  buildAiMeetingBookingDag,
  needsWhatsappTakeover,
} from "../../src/lib/ai-meeting-booking-dag.js";

type Fn = (...args: unknown[]) => Promise<Record<string, any>>;
const loadMain = (code: string): Fn =>
  new Function(code.replace(/^export async function main/m, "async function main") + "\nreturn main;")() as Fn;

const refused = { ok: false, skipped: true, status: 422, code: HUMAN_IN_CONVERSATION_CODE, refusal: "A person of the brand writes to them by hand." };

describe("human_in_conversation is a named WhatsApp refusal, never a failed run", () => {
  it("is in every WhatsApp writer's refusal list, and is about the person, not the brand's account", () => {
    expect(WHATSAPP_REFUSAL_CODES).toContain(HUMAN_IN_CONVERSATION_CODE);
    expect(FOLLOW_UP_WHATSAPP_REFUSAL_CODES).toContain(HUMAN_IN_CONVERSATION_CODE);
    expect(BRAND_SIDE_REFUSAL_CODES).not.toContain(HUMAN_IN_CONVERSATION_CODE);
    const send = buildColdWhatsappOutreachDag().nodes.find((n) => n.id === "send-whatsapp");
    expect((send?.config as { skipOnRefusalCodes: string[] }).skipOnRefusalCodes).toContain(HUMAN_IN_CONVERSATION_CODE);
  });

  it("cold-whatsapp-outreach: a follow-up look hands them over for good (send or reach refused), an occurrence stops", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const record = loadMain(RECORD_PLAN_CODE);
    const person = { kind: "followup", rowId: "r", email: "x@y.com" };
    const atSend = await record(person, refused, "2026-10-16", { skip: false }, { decision: "write", nextFollowUpAt: "2026-10-20T10:00:00.000Z" });
    expect(atSend).toMatchObject({ action: "record", body: { kind: "handed", reason: "whatsapp_human_in_conversation" } });
    expect(atSend.delivery).toMatchObject({ state: "refused", code: HUMAN_IN_CONVERSATION_CODE });

    const verdict = await loadMain(REACH_VERDICT_CODE)({ skip: false }, { reachable: false, code: HUMAN_IN_CONVERSATION_CODE, error: "A person writes to them." });
    expect(verdict).toMatchObject({ skip: true, code: HUMAN_IN_CONVERSATION_CODE });
    const atReach = await record(person, { ok: false, skipped: true, notCalled: true }, "2026-10-16", verdict, { skipSend: true });
    expect(atReach).toMatchObject({ action: "record", body: { kind: "handed", reason: "whatsapp_human_in_conversation" } });

    const occ = await record({ kind: "occurrence", rowId: "r", email: "x@y.com" }, refused, "2026-10-16", { skip: false }, { decision: "write" });
    expect(occ).toMatchObject({ body: { kind: "stopped", reason: "whatsapp_human_in_conversation" } });
  });

  it("ai-meeting-booking: the WhatsApp reply refused this way is the takeover, a clean end stating the refusal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await loadMain(CLASSIFY_SEND_CODE)({ ok: false, skipped: true, notCalled: true }, refused, "whatsapp");
    expect(out).toMatchObject({ outcome: "human_took_over", delivery: { state: "refused", code: HUMAN_IN_CONVERSATION_CODE, reason: refused.refusal } });
    // Any other refusal still fails loud.
    await expect(loadMain(CLASSIFY_SEND_CODE)({}, { ok: false, skipped: true, code: "not_on_whatsapp" }, "whatsapp")).rejects.toThrow(/no send on record/);
    const dag = buildAiMeetingBookingDag({ provider: "anthropic", model: "opus" } as never);
    const send = dag.nodes.find((n) => n.id === "send-whatsapp-reply");
    expect((send?.config as { skipOnRefusalCodes: string[] }).skipOnRefusalCodes).toEqual([HUMAN_IN_CONVERSATION_CODE]);
    expect(dag.edges.some((e) => e.to === "end-run-human-took-over" && e.condition?.includes("human_took_over"))).toBe(true);
    expect(needsWhatsappTakeover(dag)).toBe(false);
    expect(needsWhatsappTakeover({ nodes: [{ id: "send-whatsapp-reply", config: {} }] })).toBe(true);
  });
});
