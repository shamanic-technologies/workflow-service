import { describe, it, expect } from "vitest";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { SERVICE_DOOR_VENDORS } from "../../src/lib/scripts/vendors.js";
import { readersOfHanded } from "../../src/lib/scripts/engine.js";
import {
  buildListicleOutreachSource,
  buildSendWrittenSource,
  LISTICLE_OUTREACH,
  SEND_WRITTEN,
} from "../../scripts/engine-ports/listicle-outreach.js";

// LISTICLE-OUTREACH-1110: the earning half of the Backlink Engine, and the email Engine's script it asks.
const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const now = "2026-11-10T09:00:00.000Z";
const brief = "Ask the authors of best lead generation companies lists to add Distribute.you, offering the cost per positive reply figure from our 125k emails study.";
const request = { now, campaignId: "camp-1", brandIds: ["brand-1"], brief };
const outreach = buildListicleOutreachSource();
const sendWritten = buildSendWrittenSource();

const briefYes = { name: "jev.noul", answer: ok({ probabilities: { asks: 0.93 }, model: "jev" }) };
const brand = { name: "brand.profile", args: { params: { id: "brand-1" } }, answer: ok({ brand: { name: "Distribute.you", url: "https://distribute.you" } }) };
const gap = {
  name: "scraping.backlinks.link_gap",
  args: { body: { idempotencyKey: "listicle-gap:2026-11-10", competitors: LISTICLE_OUTREACH.tactics.competitors, minCompetitors: 1, minDomainRank: 0, maxSpamScore: 5 } },
  answer: ok({ sources: [{ domain: "webfx.com", domainRank: 640, spamScore: 1, competitorCount: 2, competitors: ["belkins.io", "martal.ca"] }] }),
};
const map = { name: "scraping.site.map", answer: ok({ success: true, urls: ["https://webfx.com/", "https://webfx.com/blog/best-lead-generation-companies/"], count: 2, source: "map" }) };
const pick = { name: "llm.complete", answer: ok({ json: { url: "https://webfx.com/blog/best-lead-generation-companies/" } }) };
const page = { name: "scraping.page", answer: ok({ cached: false, result: { rawMarkdown: "# 12 best lead generation companies\nBy Jane Doe, Content Lead\n1. Belkins\n2. Martal" } }) };
const read = (over: Record<string, unknown> = {}) => ({
  name: "llm.complete",
  answer: ok({ json: { isCompanyList: true, title: "12 best lead generation companies", competitorsNamed: ["belkins.io", "martal.ca"], namesBrand: false, authorFirstName: "Jane", authorLastName: "Doe", authorRole: "Content Lead", listTopic: "lead generation companies", ...over } }),
});
const find = {
  name: "apollo.email.find",
  args: { body: { vendor: "treg", person: { firstName: "Jane", lastName: "Doe", domain: "webfx.com" } } },
  answer: ok({ status: "found", found: true, email: "jane@webfx.com", emailVerification: { verdict: "valid", deliverable: true } }),
};
const voice = { name: "voice.read", answer: ok({ content: "Short plain words." }) };
const pitch = { name: "llm.complete", answer: ok({ json: { subject: "Your lead generation list", body: "Hi Jane,\n\nOne figure — $12 per positive reply.\n\nDistribute.you" } }) };

describe("the listicle outreach script", () => {
  it("asks the email Engine, reads no material of its own, and reaches the world only through known doors", async () => {
    expect((await validateSource(outreach)).materials).toEqual(["email_sent"]);
    expect(LISTICLE_OUTREACH.tactics.asks).toEqual(["email_sent"]);
    expect(SERVICE_DOOR_VENDORS["apollo.email.find"]).toMatchObject({ service: "apollo", method: "POST", path: "/email-finder/find", asRun: true });
    expect(outreach).not.toMatch(/"backlink_earned"/);
    expect(LISTICLE_OUTREACH.tactics.recorded_by).toBe("scraping");
  });

  it("does nothing on a campaign whose brief does not ask for it (no spend past the one judgment)", async () => {
    const c: ReplayCase = {
      id: "brief-no",
      units: {},
      request: { ...request, brief: "Count the links we earn." },
      tactics: LISTICLE_OUTREACH.tactics,
      calls: [{ name: "jev.noul", answer: ok({ probabilities: { asks: 0.08 } }) }],
      expect: { nothing: true },
    };
    expect((await replayCase(outreach, c)).diffs).toEqual([]);
    expect((await replayCase(outreach, { ...c, id: "no-brief", request: { now }, calls: [] })).diffs).toEqual([]);
  });

  it("finds the list page, its author and their email, writes the pitch and hands both to the email Engine", async () => {
    const c: ReplayCase = {
      id: "pitched",
      units: { email_sent: { to: "jane@webfx.com", subject: "Your lead generation list" } },
      request,
      tactics: LISTICLE_OUTREACH.tactics,
      calls: [briefYes, brand, gap, map, pick, page, read(), find, voice, pitch],
      asks: [
        {
          units: {
            email_found: { content: { email: "jane@webfx.com", firstName: "Jane", lastName: "Doe", company: "webfx.com" } },
            message_written: { content: { subject: "Your lead generation list", bodyHtml: "<p>Hi Jane,</p><p>One figure, $12 per positive reply.</p><p>Distribute.you</p>", bodyText: "Hi Jane,\n\nOne figure, $12 per positive reply.\n\nDistribute.you" } },
          },
          request: { now, campaignId: "camp-1", idempotencyKey: "listicle-pitch:webfx.com" },
          recordedBy: "email-gateway",
        },
      ],
      expect: {
        content: {
          pitched: {
            domain: "webfx.com",
            page: "https://webfx.com/blog/best-lead-generation-companies/",
            title: "12 best lead generation companies",
            author: "Jane Doe",
            email: "jane@webfx.com",
            sentTo: "jane@webfx.com",
            subject: "Your lead generation list",
            body: "Hi Jane,\n\nOne figure, $12 per positive reply.\n\nDistribute.you",
          },
          looked: [],
        },
      },
    };
    expect((await replayCase(outreach, c)).diffs).toEqual([]);
  });

  it("sends a test to the staff address it is given, never to the author", async () => {
    const c: ReplayCase = {
      id: "test",
      units: { email_sent: { to: "kevin+listicle@example.com" } },
      request: { ...request, testRecipient: "Kevin+Listicle@example.com" },
      tactics: LISTICLE_OUTREACH.tactics,
      calls: [briefYes, brand, gap, map, pick, page, read(), find, voice, pitch],
      asks: [
        {
          units: {
            email_found: { content: { email: "kevin+listicle@example.com", firstName: "Jane", lastName: "Doe", company: "webfx.com" } },
            message_written: { content: { subject: "Your lead generation list", bodyHtml: "<p>Hi Jane,</p><p>One figure, $12 per positive reply.</p><p>Distribute.you</p>", bodyText: "Hi Jane,\n\nOne figure, $12 per positive reply.\n\nDistribute.you" } },
          },
          request: { now, campaignId: "camp-1", idempotencyKey: `listicle-pitch:webfx.com:test:${now}` },
          recordedBy: "email-gateway",
        },
      ],
      expect: { found: "" },
    };
    const diffs = (await replayCase(outreach, c)).diffs;
    expect(diffs.filter((d) => d.startsWith("asks"))).toEqual([]);
  });

  it("skips a page that already lists the brand or names no author, and says nothing is left", async () => {
    const c: ReplayCase = {
      id: "skipped",
      units: {},
      request,
      tactics: LISTICLE_OUTREACH.tactics,
      calls: [briefYes, brand, gap, map, pick, page, read({ namesBrand: true })],
      expect: { fails: "no_listicle_left: no author pitched this run (1 sites looked at, 1 in the link gap)" },
    };
    expect((await replayCase(outreach, c)).diffs).toEqual([]);
    const noAuthor = { ...c, id: "no-author", calls: [briefYes, brand, gap, map, pick, page, read({ authorFirstName: "", authorLastName: "" })] };
    expect((await replayCase(outreach, noAuthor)).diffs).toEqual([]);
  });

  it("never pitches an address the verifier calls undeliverable", async () => {
    const bad = { ...find, answer: ok({ status: "found", found: true, email: "jane@webfx.com", emailVerification: { verdict: "catch_all", deliverable: false } }) };
    const c: ReplayCase = {
      id: "undeliverable",
      units: {},
      request,
      tactics: LISTICLE_OUTREACH.tactics,
      calls: [briefYes, brand, gap, map, pick, page, read(), bad],
      expect: { fails: "no_listicle_left: no author pitched this run (1 sites looked at, 1 in the link gap)" },
    };
    expect((await replayCase(outreach, c)).diffs).toEqual([]);
  });
});

describe("the send-written script of the email Engine", () => {
  it("reads both handed Units and sends exactly what was written, keyed on the asker's key", async () => {
    expect((await validateSource(sendWritten)).materials.sort()).toEqual(["email_found", "message_written"]);
    expect(SEND_WRITTEN.tactics.recorded_by).toBe("email-gateway");
    const c: ReplayCase = {
      id: "sent",
      units: {
        email_found: { email: "jane@webfx.com", firstName: "Jane", lastName: "Doe", company: "webfx.com" },
        message_written: { subject: "Your list", bodyHtml: "<p>Hi</p>", bodyText: "Hi" },
      },
      request: { now, campaignId: "camp-1", idempotencyKey: "listicle-pitch:webfx.com" },
      tactics: SEND_WRITTEN.tactics,
      calls: [
        {
          name: "email.send",
          args: {
            body: {
              type: "broadcast",
              tag: "written-email",
              to: "jane@webfx.com",
              subject: "Your list",
              sequence: [{ step: 1, bodyHtml: "<p>Hi</p>", daysSinceLastStep: 0, bodyText: "Hi" }],
              idempotencyKey: "listicle-pitch:webfx.com",
              campaignId: "camp-1",
              recipientFirstName: "Jane",
              recipientLastName: "Doe",
              recipientCompany: "webfx.com",
            },
          },
          answer: ok({ success: true, messageId: "m1", provider: "broadcast" }),
        },
      ],
      expect: { content: { to: "jane@webfx.com", subject: "Your list", messageId: "m1", deduplicated: false } },
    };
    expect((await replayCase(sendWritten, c)).diffs).toEqual([]);
  });

  it("reads a named refusal as unmade, and refuses to send without a key", async () => {
    const units = { email_found: { email: "jane@webfx.com" }, message_written: { subject: "S", bodyHtml: "<p>B</p>" } };
    const refused: ReplayCase = {
      id: "refused",
      units,
      request: { idempotencyKey: "k" },
      tactics: SEND_WRITTEN.tactics,
      calls: [{ name: "email.send", answer: { ok: false, data: { status: 409, code: "lead_opted_out", error: "opted out" } } }],
      expect: { fails: "lead_opted_out: opted out" },
    };
    expect((await replayCase(sendWritten, refused)).diffs).toEqual([]);
    const noKey: ReplayCase = { id: "no-key", units, request: {}, tactics: SEND_WRITTEN.tactics, calls: [], expect: { fails: "send-written: the asker states no idempotencyKey (a retried run must never send twice)" } };
    expect((await replayCase(sendWritten, noKey)).diffs).toEqual([]);
  });
});

describe("an asked Engine serves the ask with the scripts that read what was handed", () => {
  const rows = [
    { dynasty: "dy_pushed_email", materials: [] as string[] },
    { dynasty: "dy_cold_email", materials: ["message_written"] },
    { dynasty: "dy_send_written", materials: ["email_found", "message_written"] },
  ];
  it("keeps only the readers of the most handed Units", () => {
    expect(readersOfHanded(rows, ["email_found", "message_written"]).map((r) => r.dynasty)).toEqual(["dy_send_written"]);
  });
  it("narrows nothing when no candidate reads what was handed, or nothing was handed", () => {
    const calls = [{ dynasty: "dy_ring_rep", materials: [] as string[] }, { dynasty: "dy_ring_rep_email_replies", materials: [] as string[] }];
    expect(readersOfHanded(calls, ["conversation"])).toEqual(calls);
    expect(readersOfHanded(rows, [])).toEqual(rows);
    expect(readersOfHanded(rows, undefined)).toEqual(rows);
  });
});
