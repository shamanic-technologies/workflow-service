import { describe, it, expect } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { SEND_DELIVERY_CODE } from "../../src/lib/occurrence-delivery.js";
import { buildAiFollowUpEmailDag } from "../../src/lib/ai-follow-up-email-dag.js";
import { buildProspectFollowUpProactiveDag, buildProspectFollowUpReactiveDag } from "../../src/lib/prospect-follow-up-dag.js";
import { buildAiInstantCallDag } from "../../src/lib/ai-instant-call-dag.js";
import { buildColdWhatsappOutreachDag } from "../../src/lib/cold-whatsapp-outreach-dag.js";
import { buildAiMeetingBookingDag, needsOccurrenceDelivery } from "../../src/lib/ai-meeting-booking-dag.js";
import { buildOfferDocumentReplyDag } from "../../src/lib/offer-document-reply-dag.js";

/**
 * PUSHED-TRUTH-1015, second pass: every DAG whose run carries a trigger occurrence tells campaign-service on /end-run
 * what became of it. A sender refusal the run skips is `refused` + code + sentence (verbatim), never a bare
 * `success: true` that campaign-service records as delivered; a send that went out is `delivered`; a failure (the send
 * threw) ends on the error end-run with no delivery, so the occurrence is redelivered.
 */

type Transform = { type: string; value?: unknown; expr?: string };
type Module = { id: string; value: { input_transforms?: Record<string, Transform>; branches?: Array<{ modules: Module[] }>; modules?: Module[]; default?: Module[] } };

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, unknown>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, unknown>>;
}

/** The `/end-run` body Windmill builds for a module of the converted flow, given the results the run holds. */
function endRunBody(dag: DAG, id: string, results: Record<string, unknown>): Record<string, unknown> {
  const flow = dagToOpenFlow(dag, "occurrence-delivery") as unknown as { value: { modules: Module[]; failure_module?: Module } };
  const all = (mods: Module[]): Module[] =>
    mods.flatMap((m) => [m, ...all(m.value.modules ?? []), ...all(m.value.default ?? []), ...(m.value.branches ?? []).flatMap((b) => all(b.modules))]);
  const modules = all([...flow.value.modules, ...(flow.value.failure_module ? [flow.value.failure_module] : [])]);
  const m = modules.find((x) => x.id === id || x.id === id.replace(/-/g, "_"));
  if (!m) throw new Error(`no module ${id}`);
  const t = m.value.input_transforms!.body;
  if (t.type === "static") return t.value as Record<string, unknown>;
  return new Function("results", "flow_input", `return (${t.expr});`)(results, {}) as Record<string, unknown>;
}

const delivery = (code: string, reason: string) => ({ state: "refused", code, reason });
/** What http-call returns for a send it skipped on a refusal (scripts/nodes/http-call.ts). */
const refusedSend = (code: string, reason: string) => ({ ok: false, skipped: true, status: 409, code, reason, delivery: delivery(code, reason) });
const ERROR_BODY = { success: false, stopCampaign: false };

describe("SEND_DELIVERY_CODE (one end-run closing both a sent and a skipped send)", () => {
  const main = loadMain(SEND_DELIVERY_CODE);
  it("refused with the send's code and sentence when it skipped a refusal; delivered when it went out", async () => {
    expect(await main(refusedSend("recent_brand_contact", "already emailed"))).toEqual(delivery("recent_brand_contact", "already emailed"));
    expect(await main({ ok: false, skipped: true, code: "brand_sequence_queued" })).toEqual(delivery("brand_sequence_queued", "brand_sequence_queued"));
    expect(await main({ success: true })).toEqual({ state: "delivered" });
  });
});

describe("ai-follow-up-email", () => {
  const dag = buildAiFollowUpEmailDag();
  it("sent = delivered; a passing refusal (deferred) and a final one = refused verbatim; a throw = no delivery", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    const passing = refusedSend("brand_sequence_queued", "a step of their sequence is still queued");
    const final = refusedSend("lead_opted_out", "they asked us to stop");
    expect(endRunBody(dag, "end-run", { send_email: { success: true } })).toEqual({ success: true, stopCampaign: false, delivery: { state: "delivered" } });
    expect(endRunBody(dag, "end-run-deferred", { send_email: passing })).toEqual({ success: true, stopCampaign: false, delivery: passing.delivery });
    expect(endRunBody(dag, "end-run-refused", { send_email: final })).toEqual({ success: true, stopCampaign: false, delivery: final.delivery });
    expect(dag.edges).toContainEqual({ from: "record-deferred", to: "end-run-deferred" });
    expect(dag.edges).toContainEqual({ from: "record-sent", to: "end-run" });
    expect(endRunBody(dag, "end-run-error", {})).toEqual(ERROR_BODY);
  });
});

describe("prospect-follow-up (both pipes)", () => {
  for (const [name, dag] of [["reactive", buildProspectFollowUpReactiveDag()], ["proactive", buildProspectFollowUpProactiveDag()]] as const) {
    it(`${name}: the shared end-run reads the send (sent = delivered, passing refusal = refused); a stop refusal = refused`, async () => {
      expect(validateDAG(dag).errors).toEqual([]);
      const passing = refusedSend("recent_brand_contact", "emailed 2 days ago");
      const main = loadMain(SEND_DELIVERY_CODE);
      const sentDelivery = await main({ success: true });
      const passingDelivery = await main(passing);
      expect(endRunBody(dag, "end-run", { send_delivery: sentDelivery })).toEqual({ success: true, stopCampaign: false, delivery: { state: "delivered" } });
      expect(endRunBody(dag, "end-run", { send_delivery: passingDelivery })).toEqual({ success: true, stopCampaign: false, delivery: passing.delivery });
      const stop = refusedSend("lead_not_a_prospect", "not a prospect");
      expect(endRunBody(dag, "end-run-opted-out", { send_email: stop })).toEqual({ success: true, stopCampaign: false, delivery: stop.delivery });
      expect(dag.edges).toContainEqual({ from: "send-delivery", to: "end-run" });
      expect(endRunBody(dag, "end-run-error", {})).toEqual(ERROR_BODY);
    });
  }
});

describe("cold-whatsapp-outreach", () => {
  const dag = buildColdWhatsappOutreachDag();
  it("every arm after the send states record-plan's delivery; a throw = no delivery", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    const refused = delivery("not_on_whatsapp", "+336 is not on WhatsApp");
    for (const id of ["end-run", "end-run-followup", "end-run-unreachable"]) {
      expect(endRunBody(dag, id, { record_plan: { delivery: refused } })).toEqual({ success: true, stopCampaign: false, delivery: refused });
    }
    expect(endRunBody(dag, "end-run-error", {})).toEqual(ERROR_BODY);
  });
});

describe("ai-meeting-booking replies (and the offer-document responder derived from it)", () => {
  const opts = { provider: "google", model: "pro" };
  for (const [name, dag] of [["ai-meeting-booking", buildAiMeetingBookingDag(opts)], ["offer-document-reply", buildOfferDocumentReplyDag(opts)]] as const) {
    it(`${name}: a sent reply = delivered; the sender refusing it (human_took_over) = refused verbatim`, () => {
      for (const id of ["end-run", "end-run-booking-confirmed", "end-run-closed-with-thanks"]) {
        expect(endRunBody(dag, id, {})).toEqual({ success: true, stopCampaign: false, delivery: { state: "delivered" } });
      }
      const took = delivery("human_took_over", "A person answers this thread");
      expect(endRunBody(dag, "end-run-human-took-over", { classify_send: { outcome: "human_took_over", delivery: took } }))
        .toEqual({ success: true, stopCampaign: false, delivery: took });
      expect(endRunBody(dag, "end-run-error", {})).toEqual(ERROR_BODY);
      expect(needsOccurrenceDelivery(dag)).toBe(false);
    });
  }
  it("the seed predicate calls a stored DAG without it stale", () => {
    const dag = buildAiMeetingBookingDag(opts);
    const stale = { nodes: dag.nodes.map((n) => (n.id === "end-run-human-took-over" ? { ...n, inputMapping: undefined } : n)) };
    expect(needsOccurrenceDelivery(stale)).toBe(true);
    expect(needsOccurrenceDelivery({ nodes: [] })).toBe(false);
  });
});

describe("ai-instant-call", () => {
  it("a placed call = delivered; a throw = no delivery", () => {
    const dag = buildAiInstantCallDag();
    expect(endRunBody(dag, "end-run", {})).toEqual({ success: true, stopCampaign: false, delivery: { state: "delivered" } });
    expect(endRunBody(dag, "end-run-error", {})).toEqual(ERROR_BODY);
  });
});
