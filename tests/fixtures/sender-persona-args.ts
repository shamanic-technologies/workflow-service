/**
 * Compose inputs for the SOPHIE-WA-1016 golden prompts: the follow-up channel on WhatsApp and the conversation
 * responder answering on WhatsApp, both with no persona (the golden files were written by the code before the
 * persona existed, so "no persona = the prompt of before" is a byte comparison).
 */
const WHO = { state: "not_known", lines: ["Not known to the brand."], threadLines: [], strategy: "WHO STRATEGY" };

export const followUpArgs = (channelExtra: Record<string, unknown> = {}): unknown[] => [
  { timezone: "America/New_York", lead: { firstName: "Nina" } },
  { channel: "whatsapp", phone: "+15855550123", why: "The brand's WhatsApp reaches them.", ...channelExtra },
  { name: "Offer" },
  { brand: { name: "Brand" } },
  { exact: [] },
  {},
  { notCalled: true },
  "",
  { answering: false, skipTriggerRead: true },
  { notCalled: true },
  null,
  "2026-10-16T12:00:00.000Z",
  "2026-10-16",
  WHO,
];

export const replyArgs = (...extra: unknown[]): unknown[] => [
  { id: "row-1", leadId: "lead-1", followupCount: 0, brandId: "b-1", phone: "+15855550123" },
  { leadDetail: { lead: { firstName: "Nina", timezone: "America/New_York" } } },
  {
    replyChannel: "whatsapp",
    conversation: {
      messages: [
        { direction: "outbound", text: "Would a short call help?", channel: "whatsapp", at: "2026-10-15T10:00:00Z" },
        { direction: "inbound", text: "What does it cost?", channel: "whatsapp", at: "2026-10-15T11:00:00Z" },
      ],
    },
  },
  null,
  { timezone: "America/New_York", degraded: true, degradedReason: "no_booking_url", bookingUrl: null, slots: [] },
  { offerId: "offer-1", name: "Offer", bookingUrl: null },
  { brand: { name: "Brand" } },
  "2026-10-16",
  { exact: [], neverGive: [] },
  { stance: "insider", evidence: "I'm Sam at Brand." },
  "none",
  undefined,
  WHO,
  ...extra,
];
