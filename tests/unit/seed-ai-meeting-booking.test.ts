import { describe, it, expect } from "vitest";
import {
  buildAiMeetingBookingDag,
  isConversationResponder,
  needsChannelAgnosticReply,
  needsEveryPredecessorClaim,
  needsOccurrenceSendKey,
} from "../../src/lib/ai-meeting-booking-dag.js";
import { buildFormMeetingBookingDag } from "../../src/lib/form-meeting-booking-dag.js";

describe("seed-ai-meeting-booking only upgrades CONVERSATION responders (WA-RESPONDER-1012)", () => {
  const conversation = buildAiMeetingBookingDag({ provider: "google", model: "pro" });

  it("leaves the form responder alone: upgrading it would turn the form workflow into a conversation one", () => {
    // ai-meeting-booking-fulu (the form pipe's workflow) sits in the same feature;
    // its DAG has no predecessor read, so every staleness check called it stale.
    const form = buildFormMeetingBookingDag();
    expect(isConversationResponder(form)).toBe(false);
    expect(isConversationResponder(conversation)).toBe(true);
  });

  it("calls a responder that answers on email only stale, and the current one current", () => {
    const emailOnly = { ...conversation, nodes: conversation.nodes.filter((n) => n.id !== "person-timeline") };
    expect(needsChannelAgnosticReply(emailOnly)).toBe(true);
    expect(needsChannelAgnosticReply(conversation)).toBe(false);
    // v0.48.57's DAG: the prior-generation read still threw on a WhatsApp-only person's 404.
    const strictPrior = {
      ...conversation,
      nodes: conversation.nodes.map((n) => (n.id === "prior-generation" ? { ...n, config: { ...n.config, tolerateFailure: undefined } } : n)),
    };
    expect(needsChannelAgnosticReply(strictPrior)).toBe(true);
    // v0.48.62's DAG: no WhatsApp alert to the rep on a chat escalation.
    const noAlert = { ...conversation, nodes: conversation.nodes.filter((n) => n.id !== "alert-rep") };
    expect(needsChannelAgnosticReply(noAlert)).toBe(true);
  });

  it("calls a responder that claims from one predecessor only stale (several live campaigns open conversations)", () => {
    expect(needsEveryPredecessorClaim(conversation)).toBe(false);
    const onePredecessor = {
      ...conversation,
      nodes: conversation.nodes.map((n) => {
        if (n.id !== "claim-followup") return n;
        const { ["body.alsoCampaignIds"]: _dropped, ...rest } = n.inputMapping ?? {};
        return { ...n, inputMapping: rest };
      }),
    };
    expect(needsEveryPredecessorClaim(onePredecessor)).toBe(true);
    expect(needsEveryPredecessorClaim(buildFormMeetingBookingDag())).toBe(false);
  });
});

describe("seed-ai-meeting-booking upgrades a responder whose sends are not keyed on the occurrence (REDELIVERY-IDEMPOTENCY-1014)", () => {
  const conversation = buildAiMeetingBookingDag({ provider: "google", model: "pro" });

  it("calls a DAG whose WhatsApp reply or rep alert does not read the trigger stale, the current one current", () => {
    expect(needsOccurrenceSendKey(conversation)).toBe(false);
    for (const id of ["finalize-reply", "compose-rep-alert"]) {
      const before = {
        ...conversation,
        nodes: conversation.nodes.map((n) => {
          if (n.id !== id) return n;
          const { trigger: _t, ...rest } = n.inputMapping ?? {};
          return { ...n, inputMapping: rest };
        }),
      };
      expect(needsOccurrenceSendKey(before)).toBe(true);
    }
    expect(needsOccurrenceSendKey(buildFormMeetingBookingDag())).toBe(false);
  });
});

describe("the seed never re-upgrades a current DAG (LEDGER-HISTORY-1024)", () => {
  it("the thinking-budget check reads only model calls, never the client-comms skill read", async () => {
    const { needsThinkingBudget } = await import("../../src/lib/ai-meeting-booking-dag.js");
    const current = buildAiMeetingBookingDag({ provider: "google", model: "pro" });
    expect(current.nodes.some((n) => n.config?.service === "chat" && !String(n.config?.path).endsWith("/complete"))).toBe(true);
    expect(needsThinkingBudget(current)).toBe(false);
    const starved = {
      nodes: current.nodes.map((n) =>
        n.config?.service === "chat" && String(n.config?.path).endsWith("/complete")
          ? { ...n, config: { ...n.config, body: { ...(n.config?.body as object), maxTokens: 800 } } }
          : n,
      ),
    };
    expect(needsThinkingBudget(starved)).toBe(true);
  });
});
