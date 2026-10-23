/**
 * WA-BUBBLES-1023 (owner 2026-10-23: « Tu ne peux pas envoyer des multi messages pour faire plus naturel ? »): every
 * WhatsApp writer sends several short bubbles, delivered by crm-service one by one; the voice it copies is only what the
 * owner typed by hand, never an automated burst.
 */
import { describe, expect, it } from "vitest";
import { BUBBLE_SEND_FN, HAND_TYPED_FN, MAX_BUBBLES, bubblesOf, whatsappBubblesStrategy } from "../../src/lib/whatsapp-bubbles.js";

const fn = <T>(code: string, name: string) => new Function(code + "\nreturn " + name + ";")() as T;
const bubbleSendFields = fn<(t: string) => Record<string, unknown>>(BUBBLE_SEND_FN, "bubbleSendFields");
const handTyped = fn<(items: { at: string; text: string }[]) => { text: string }[]>(HAND_TYPED_FN, "handTyped");

describe("bubbles", () => {
  it("splits on empty lines only, a single line break stays inside a bubble", () => {
    expect(bubblesOf("Hi Jeremy\n\nquick read on your site:\n- fit\n- move\n\n \nWho buys from you today?")).toEqual([
      "Hi Jeremy",
      "quick read on your site:\n- fit\n- move",
      "Who buys from you today?",
    ]);
  });

  it("one bubble is the single-text send of before; several are crm-service's messages", () => {
    expect(bubbleSendFields("  Hi there  ")).toEqual({ text: "Hi there" });
    expect(bubbleSendFields("Hi\n\nquick one\n\nwho buys?")).toEqual({ messages: ["Hi", "quick one", "who buys?"] });
  });

  it("folds bubbles past crm-service's cap into the last one, never drops a word", () => {
    const out = bubbleSendFields(["a", "b", "c", "d", "e", "f", "g"].join("\n\n")) as { messages: string[] };
    expect(out.messages).toHaveLength(MAX_BUBBLES);
    expect(out.messages[MAX_BUBBLES - 1]).toBe("e\n\nf\n\ng");
  });

  it("the JS the writers run agrees with the TS mirror", () => {
    const fromJs = fn<(t: string) => string[]>(BUBBLE_SEND_FN, "bubblesOf");
    const sample = "a\r\n\r\nb\nc\n\n\nd";
    expect(fromJs(sample)).toEqual(bubblesOf(sample));
  });

  it("tells the model to write bubbles, in the owner's rhythm or a persona's", () => {
    expect(whatsappBubblesStrategy("owner")).toContain("HIS OWN MESSAGES");
    expect(whatsappBubblesStrategy("persona")).not.toContain("HIS OWN MESSAGES");
    expect(whatsappBubblesStrategy("persona", "paragraph")).toContain("its own <p>");
    expect(whatsappBubblesStrategy("owner")).not.toMatch(/[–—]/);
  });
});

describe("hand-typed voice", () => {
  it("drops an automated burst (~1.5 s apart) and keeps bubbles typed seconds apart", () => {
    const kept = handTyped([
      { at: "2026-10-21T18:01:06.515Z", text: "Good news, you can now add anyone" },
      { at: "2026-10-21T18:01:08.114Z", text: "3 ways, whichever is easiest" },
      { at: "2026-10-21T18:01:09.632Z", text: "Just give the name" },
      { at: "2026-08-23T09:22:11.000Z", text: "Yeah most of the clients take the free tier right now right" },
      { at: "2026-08-23T09:22:20.000Z", text: "Probably the paid tier could save you" },
      { at: "2026-08-23T09:22:31.000Z", text: "Of you time -box the free tier" },
    ]).map((i) => i.text);
    expect(kept).toEqual([
      "Yeah most of the clients take the free tier right now right",
      "Probably the paid tier could save you",
      "Of you time -box the free tier",
    ]);
  });
});

describe("the meeting-booking seed upgrades a responder still answering WhatsApp in one block", () => {
  it("needsWhatsappBubbles: false on the current DAG, true on a stored one without bubbles", async () => {
    const { buildAiMeetingBookingDag, needsWhatsappBubbles } = await import("../../src/lib/ai-meeting-booking-dag.js");
    const dag = buildAiMeetingBookingDag({ provider: "google", model: "pro" });
    expect(needsWhatsappBubbles(dag)).toBe(false);
    const old = { nodes: dag.nodes.map((n) => (n.id === "finalize-reply" ? { ...n, config: { code: "export async function main() { return { whatsappBody: { text } }; }" } } : n)) };
    expect(needsWhatsappBubbles(old)).toBe(true);
    expect(needsWhatsappBubbles({ nodes: [] })).toBe(false);
  });
});
