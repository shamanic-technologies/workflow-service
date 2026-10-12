import { describe, it, expect } from "vitest";
import {
  buildAiMeetingBookingDag,
  isConversationResponder,
  needsChannelAgnosticReply,
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
  });
});
