import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";

// MIGRATE-1105 S2b: the orphan-reply judgment's script runs in the sandbox and decides like instantly-service's code:
// excluded (warmup tag in the BODY), no candidate lead, then ONE jev.choice whose request is the service's own.
const SOURCE = readFileSync(join(__dirname, "../../scripts/engine-ports/orphan-reply.script.ts"), "utf8");

const lead = (o: Partial<Record<string, unknown>> = {}) => ({
  instantlyCampaignId: "seq-1",
  leadEmail: "stacy.blecher@twinhealth.com",
  firstName: "Stacy",
  lastName: "Blecher",
  companyName: "Twin Health",
  subject: "Metabolic programs",
  excerpt: "Hi Stacy, quick idea",
  lastStep: 2,
  firstSentAt: "2026-09-20T10:00:00.000Z",
  lastSentAt: "2026-09-23T10:00:00.000Z",
  orgId: "org-doc",
  ...o,
});
const material = (text: string, leads = [lead()]) => ({
  message: {
    fromAddress: "Dr Blecher <drblecher@chsmetabolismdoc.com>",
    toAddress: "kevin@mail-dy.com",
    subject: "Re: your note",
    headers: { from: "Dr Blecher <drblecher@chsmetabolismdoc.com>" },
    text,
    receivedAt: "2026-09-24T12:00:00.000Z",
    recipients: ["kevin@mail-dy.com"],
  },
  ownMailDomains: ["mail-dy.com"],
  staffAddresses: ["kevin.lourd@gmail.com"],
  staffDomains: ["distribute.you"],
  leads,
});

describe("the orphan-reply script", () => {
  it("excludes a warmup tag found only in the body, before any judgment", async () => {
    const c: ReplayCase = { id: "w", units: { message_sent: material("hello 3849WSQ WNT6JJB") }, calls: [], expect: { content: { outcome: "excluded", reason: "instantly_warmup" } } };
    expect((await replayCase(SOURCE, c)).match).toBe(true);
  });

  it("asks nothing when no lead shares a token with the message", async () => {
    const c: ReplayCase = { id: "n", units: { message_sent: material("Hi, want to buy SEO links?", [lead({ firstName: "Paul", lastName: "Durand", leadEmail: "p@acme.io", companyName: "Acme", subject: "Growth" })]) }, calls: [], expect: { content: { outcome: "no_candidate_lead" } } };
    expect((await replayCase(SOURCE, c)).match).toBe(true);
  });

  it("matches the chosen lead at 0.75+, with the request the service sends", async () => {
    const text = "Stacy here, writing from my practice address. Happy to talk metabolic programs.";
    const state = ["From: Dr Blecher <drblecher@chsmetabolismdoc.com>", "To: kevin@mail-dy.com", "Date: 2026-09-24T12:00:00.000Z", "Subject: Re: your note", "", text].join("\n");
    const answers = { orphan_reply: { type: "choice", choice: "lead_1", confidence: 0.8, probabilities: { lead_1: 0.9, none: 0.1 } } };
    const c: ReplayCase = {
      id: "m",
      units: { message_sent: material(text) },
      calls: [{ name: "jev.choice", answer: { ok: true, data: { answers, model: "jev-1", usage: { inputTokens: 700 } } } }],
      expect: {
        content: {
          outcome: "matched", model: "jev-1", choice: "lead_1", probability: 0.9, confidence: 0.8, probabilities: { lead_1: 0.9, none: 0.1 }, inputTokens: 700,
          candidates: [{ instantlyCampaignId: "seq-1", leadEmail: "stacy.blecher@twinhealth.com", score: 7 }],
          instantlyCampaignId: "seq-1", leadEmail: "stacy.blecher@twinhealth.com",
        },
      },
    };
    const report = await replayCase(SOURCE, c);
    expect(report.diffs).toEqual([]);
    expect(report.match).toBe(true);
    // The recorded request must be the one the script sends.
    const withArgs = { ...c, calls: [{ ...c.calls[0]!, args: { state, questions: { orphan_reply: { type: "choice" } } } }] };
    expect((await replayCase(SOURCE, withArgs)).match).toBe(false);
  });
});
