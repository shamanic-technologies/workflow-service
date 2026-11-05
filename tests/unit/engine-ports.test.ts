import { describe, it, expect } from "vitest";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { buildThreadsPostSource } from "../../scripts/engine-ports/threads-post.js";
import { buildEmailSendingSource } from "../../scripts/engine-ports/email-sending.js";
import { buildAiLeadProposalSource } from "../../scripts/engine-ports/ai-lead-proposal.js";
import { buildFounderHelloSource } from "../../scripts/engine-ports/founder-hello.js";
import { SETTLED_THREAD_WAIT } from "../../src/lib/dag-to-openflow.js";
import { createHash } from "node:crypto";

// MIGRATE-1105 S4: each ported workflow, as the stored script the Engine runs, in the SAME sandbox, on fictional cases
// (real cases live in script_cases, never in git). Each case states the calls the old DAG made, in order.
const ok = (data: Record<string, unknown>) => ({ ok: true, data });

describe("the Threads post port", () => {
  const src = buildThreadsPostSource();
  const now = "2026-11-05T15:30:00.000Z";
  const request = { now, campaignId: "camp-1", offerId: "offer-1", brief: "Write for founders." };
  const accounts = ok({ accounts: [{ id: "acc-1", username: "brand_ai", accountType: "pro_ai", health: "connected", createdAt: "2026-10-01T00:00:00Z" }] });
  const postsQuery = { brandId: "replay", since: "2026-10-06T15:30:00.000Z", limit: "1000" };

  it("is a valid script that needs no material (a proactive Engine finds its own work)", async () => {
    const v = await validateSource(src);
    expect(v.materials).toEqual([]);
  });

  it("ends idle when the brand posted less than an hour ago", async () => {
    const c: ReplayCase = {
      id: "idle",
      units: {},
      request,
      calls: [
        { name: "meta.threads.accounts", args: { query: { brandId: "replay" } }, answer: accounts },
        { name: "meta.threads.publications", args: { query: postsQuery }, answer: ok({ publications: [{ kind: "post", accountId: "acc-1", publishedAt: "2026-11-05T15:00:00.000Z", text: "x" }] }) },
      ],
      expect: { nothing: true },
    };
    const r = await replayCase(src, c);
    expect(r.diffs).toEqual([]);
  });

  it("writes with the picked template + LLM, then publishes the main post and each reply", async () => {
    const c: ReplayCase = {
      id: "published",
      units: {},
      request,
      calls: [
        { name: "meta.threads.accounts", answer: accounts },
        { name: "meta.threads.publications", answer: ok({ publications: [] }) },
        { name: "brand.profile", args: { params: { id: "replay" } }, answer: ok({ brand: { name: "Brand", domain: "brand.com" } }) },
        { name: "brand.offer.answers", answer: ok({ answers: [] }) },
        { name: "brand.offer.fields", answer: ok({ fields: [] }) },
        { name: "brand.fields", answer: ok({ fields: [] }) },
        { name: "llm.complete", answer: ok({ content: "angle" }) },
        { name: "scraping.site.map", answer: { ok: false, data: { error: "down", status: 502 } } },
        { name: "features.writer_pick", args: { query: { campaignId: "camp-1" } }, answer: ok({ legKey: "start_to_post_published", template: { templateDynastySlug: "tpl" }, llm: { model: "sonnet", provider: "anthropic" } }) },
        { name: "content.template.head", args: { params: { slug: "tpl" } }, answer: ok({ template: { type: "threads-v3" } }) },
        { name: "content.thread.generate", answer: ok({ subject: "s", post: "Main — post", replies: ["one", "two"] }) },
        { name: "meta.threads.publish", args: { params: { id: "acc-1" }, body: { text: "Main, post", idempotencyKey: `threads-post:camp-1:${now}:main` } }, answer: ok({ postId: "p0" }) },
        { name: "meta.threads.publish", args: { params: { id: "acc-1" }, body: { text: "one", replyToPostId: "p0", idempotencyKey: `threads-post:camp-1:${now}:reply-1` } }, answer: ok({ postId: "p1" }) },
        { name: "meta.threads.publish", args: { params: { id: "acc-1" }, body: { text: "two\n\nGet started: brand.com", replyToPostId: "p1", idempotencyKey: `threads-post:camp-1:${now}:reply-2` } }, answer: ok({ postId: "p2" }) },
      ],
      expect: { content: { end: { success: true, stopCampaign: false } } },
    };
    const r = await replayCase(src, c);
    expect(r.diffs).toEqual([]);
  });
});

describe("the pushed email port", () => {
  const src = buildEmailSendingSource();
  const trigger = { eventId: "ev-1", person: { email: "Ana@Staff.test" }, item: { subject: "Hi", bodyText: "Line 1\nLine 2" } };
  const claim = ok({ found: true, followup: { id: "row-1", email: "ana@staff.test", leadId: "lead-1" } });

  it("sends the email exactly as written, keyed on the occurrence, then stops the row", async () => {
    const r = await replayCase(src, {
      id: "sent",
      units: {},
      request: { campaignId: "camp-1", trigger },
      calls: [
        { name: "lead.followup.claim", args: { params: { campaignId: "camp-1" } }, answer: claim },
        { name: "lead.detail", answer: ok({ leadDetail: { lead: { timezone: "Europe/Paris" } } }) },
        {
          name: "email.send",
          args: {
            body: {
              type: "broadcast", tag: "email-sending", to: "ana@staff.test", subject: "Hi", leadId: "lead-1", campaignId: "camp-1", timezone: "Europe/Paris",
              idempotencyKey: "email-sending:ev-1", sequence: [{ step: 1, bodyHtml: "Line 1<br>Line 2", daysSinceLastStep: 0, bodyText: "Line 1\nLine 2" }],
            },
          },
          answer: ok({ success: true }),
        },
        { name: "lead.followup.record", args: { params: { id: "row-1" }, body: { kind: "stopped", reason: "pushed_email_sent" } }, answer: ok({}) },
      ],
      expect: { content: { end: { success: true, stopCampaign: false, delivery: { state: "delivered" } } } },
    });
    expect(r.diffs).toEqual([]);
  });

  it("a 409 the sender names is a final refusal with its words; a run carrying no push claims nobody", async () => {
    const refused = await replayCase(src, {
      id: "refused",
      units: {},
      request: { campaignId: "camp-1", trigger },
      calls: [
        { name: "lead.followup.claim", answer: claim },
        { name: "lead.detail", answer: ok({}) },
        { name: "email.send", answer: { ok: false, data: { status: 409, code: "lead_opted_out", error: "This person unsubscribed" } } },
        { name: "lead.followup.record", args: { params: { id: "row-1" }, body: { kind: "stopped", reason: "pushed_email_refused" } }, answer: ok({}) },
      ],
      expect: { fails: "lead_opted_out: This person unsubscribed" },
    });
    expect(refused.diffs).toEqual([]);
    const idle = await replayCase(src, { id: "idle", units: {}, request: { campaignId: "camp-1", trigger: null }, calls: [], expect: { nothing: true } });
    expect(idle.diffs).toEqual([]);
  });
});

describe("the hot lead proposal port", () => {
  const src = buildAiLeadProposalSource();
  const ORG = "11111111-1111-4111-8111-111111111111";
  const BRAND = "22222222-2222-4222-8222-222222222222";

  it("keys the turn on the fact with the same SHA-256 the DAG used (WebCrypto there, plain JS here)", async () => {
    const companyKey = "domain:acme.com";
    const company = createHash("sha256").update(companyKey).digest("hex").slice(0, 16);
    const trigger = { eventId: "ev-1", person: { email: "bo@acme.com" }, item: { kind: "hot_lead", humanId: "h-1", companyKey, episode: 2 } };
    const r = await replayCase(
      src.replace('ctx.brand)', `${JSON.stringify(BRAND)})`),
      {
        id: "asked",
        units: {},
        request: { campaignId: "camp-1", orgId: ORG, trigger },
        calls: [
          { name: "lead.followup.claim", args: { params: { campaignId: "camp-1" }, body: { relationships: "pure_prospect" } }, answer: ok({ found: true, followup: { id: "row-1", email: "bo@acme.com" } }) },
          { name: "crm.person.thread", answer: ok({ items: [{ kind: "message", direction: "inbound", text: "Can we work together?", at: "2026-11-05T10:00:00Z", channel: "email" }] }) },
          {
            name: "chat.copilot.proactive_turn",
            args: { body: { kind: "hot_lead", idempotencyKey: `ai-lead-proposal:hot_lead:${BRAND}:h-1:${company}:2`, orgId: ORG, brandId: BRAND, lead: { email: "bo@acme.com" }, inbound: { channel: "email", text: "Can we work together?", at: "2026-11-05T10:00:00Z" } } },
            answer: ok({ id: "turn-1" }),
          },
          { name: "lead.followup.record", args: { params: { id: "row-1" }, body: { kind: "stopped", reason: "hot_lead_proposed" } }, answer: ok({}) },
        ],
        expect: { content: { end: { success: true, stopCampaign: false, delivery: { state: "delivered" } } } },
      },
    );
    expect(r.diffs).toEqual([]);
  });

  it("a person lead-service refuses as not a lead is not admitted (final)", async () => {
    const r = await replayCase(src, {
      id: "refused",
      units: {},
      request: { campaignId: "camp-1", orgId: ORG, trigger: { eventId: "ev-2", person: { email: "c@x.com" } } },
      calls: [{ name: "lead.followup.claim", answer: ok({ found: false, relationships: { refused: [{ email: "c@x.com", reason: "customer" }] } }) }],
      expect: { fails: "person_not_admitted: customer" },
    });
    expect(r.diffs).toEqual([]);
  });
});

describe("the founder hello port", () => {
  const src = buildFounderHelloSource();
  const now = "2026-11-05T15:30:00.000Z";
  const trigger = { eventId: "ev-1", person: { email: "Ana@Acme.test", name: "Ana Diaz" }, item: {} };
  const request = { now, campaignId: "camp-1", brief: "Be warm.", trigger };
  const claim = {
    name: "lead.followup.claim",
    args: { params: { campaignId: "camp-1" }, body: { person: { email: "Ana@Acme.test", phone: null, leadId: null } } },
    answer: ok({ found: true, followup: { id: "row-1", email: "ana@acme.test", leadId: "lead-1", phone: "+33612345678" } }),
  };
  const sendsRead = (sends: unknown[]) => ({ name: "crm.whatsapp.sent", args: { query: { brandId: "replay", email: "ana@acme.test" } }, answer: ok({ sends }) });
  const record = { kind: "event", source: "onboarding", event: { step: "onboarding_record" }, text: "Offer: Team lunches\nAudience: founders of service firms", at: "2026-11-05T15:00:00Z" };
  const threadRead = {
    name: "crm.person.thread",
    args: { query: { brandId: "replay", personKey: "email:ana@acme.test" }, pollWhile: { ...SETTLED_THREAD_WAIT } },
    answer: ok({ items: [record], sources: [], factFeed: { settled: true } }),
  };
  const person = { brandId: "replay", email: "ana@acme.test", phone: "+33612345678" };
  const team = { name: "crm.team.membership", args: { body: person }, answer: ok({ staff: false, ownTeam: false, matches: [] }) };
  const reachArgs = { body: { brandId: "replay", fromLine: "founder", skipIfReplied: true, email: "ana@acme.test", phone: "+33612345678" } };

  it("is a valid script that needs no material (the occurrence rides the request)", async () => {
    const v = await validateSource(src);
    expect(v.materials).toEqual([]);
  });

  it("greets the claimed person from the founder line, then the assistant from its own line, then stops the row", async () => {
    const r = await replayCase(src, {
      id: "sent",
      units: {},
      request,
      calls: [
        claim,
        sendsRead([]),
        threadRead,
        team,
        {
          name: "crm.whatsapp.reach",
          args: reachArgs,
          answer: ok({ reachable: true, persona: null, fromAccount: "+15550001111", assistantLine: { phone: "+15550002222", persona: { name: "Sophie", role: "AI assistant" } } }),
        },
        { name: "brand.profile", args: { params: { id: "replay" } }, answer: ok({ brand: { name: "Acme" } }) },
        { name: "brand.sales_rep", args: { params: { brandId: "replay" } }, answer: ok({ salesRepFirstName: "Kevin" }) },
        {
          name: "crm.people.list",
          args: { query: { brandId: "replay", source: "matrix", limit: "60" } },
          answer: ok({ people: [{ personId: "p-9", emails: ["bob@client.test"], connectionTags: [{ tag: "professional_to_brand" }], presences: [{ source: "matrix", outboundCount: 5 }] }] }),
        },
        {
          name: "crm.person.thread",
          args: { query: { brandId: "replay", personId: "p-9" }, pollWhile: { ...SETTLED_THREAD_WAIT } },
          answer: ok({ items: [{ kind: "message", direction: "outbound", source: "matrix", sentBy: "person", text: "hey Bob, all good?", at: "2026-11-01T10:00:00Z" }] }),
        },
        { name: "crm.team.membership", args: { body: { brandId: "replay", email: "bob@client.test" } }, answer: ok({ staff: false, ownTeam: false }) },
        { name: "features.writer_pick", args: { query: { campaignId: "camp-1" } }, answer: ok({ legKey: "start_to_conversation", template: { templateDynastySlug: "founder-hello-whatsapp" }, llm: { model: "glm", provider: "zai" } }) },
        { name: "content.template.head", args: { params: { slug: "founder-hello-whatsapp" } }, answer: ok({ template: { type: "founder-hello-whatsapp-v6" } }) },
        { name: "content.whatsapp.generate", answer: ok({ json: { decision: "write", message: "Hi Ana — Kevin from Acme\n\nSaw your campaign to founders\n[[ASSISTANT]]\nHi Ana, Sophie here" } }) },
        {
          name: "crm.whatsapp.send",
          args: {
            body: {
              email: "ana@acme.test", brandId: "replay", fromLine: "founder", messages: ["Hi Ana, Kevin from Acme", "Saw your campaign to founders"],
              idempotencyKey: "founder-hello:camp-1:lead-1", skipIfReplied: true, phone: "+33612345678",
            },
          },
          answer: ok({ id: "m1" }),
        },
        {
          name: "crm.whatsapp.send",
          args: {
            body: {
              email: "ana@acme.test", brandId: "replay", fromLine: "assistant", text: "Hi Ana, Sophie here",
              idempotencyKey: "founder-hello-assistant:camp-1:lead-1", skipIfReplied: false, phone: "+33612345678",
            },
          },
          answer: ok({ id: "m2" }),
        },
        { name: "lead.followup.record", args: { params: { id: "row-1" }, body: { kind: "stopped", reason: "founder_hello_sent" } }, answer: ok({}) },
      ],
      expect: { content: { end: { success: true, stopCampaign: false, delivery: { state: "delivered" } } } },
    });
    expect(r.diffs).toEqual([]);
  });

  it("someone this campaign already greeted is not admitted (final), and their row is stopped", async () => {
    const r = await replayCase(src, {
      id: "already-greeted",
      units: {},
      request,
      calls: [
        claim,
        sendsRead([{ campaignId: "camp-1", status: "sent", sentAt: "2026-11-01T09:00:00Z" }]),
        threadRead,
        { name: "lead.followup.record", args: { params: { id: "row-1" }, body: { kind: "stopped", reason: "founder_hello_already_greeted" } }, answer: ok({}) },
      ],
      expect: { fails: "person_not_admitted: already_greeted: this campaign already said hello (2026-11-01T09:00:00Z)" },
    });
    expect(r.diffs).toEqual([]);
  });

  it("a person the brand stated is not theirs is not admitted; a run whose trigger names nobody is idle", async () => {
    const notTheirs = await replayCase(src, {
      id: "not-to-brand",
      units: {},
      request,
      calls: [
        claim,
        sendsRead([]),
        threadRead,
        team,
        { name: "crm.whatsapp.reach", args: reachArgs, answer: ok({ reachable: false, code: "stated_not_to_brand", error: "The brand stated this person is not theirs." }) },
        { name: "lead.followup.record", args: { params: { id: "row-1" }, body: { kind: "stopped", reason: "founder_hello_whatsapp_stated_not_to_brand" } }, answer: ok({}) },
      ],
      expect: { fails: "person_not_admitted: stated_not_to_brand" },
    });
    expect(notTheirs.diffs).toEqual([]);
    const idle = await replayCase(src, { id: "idle", units: {}, request: { ...request, trigger: { eventId: "ev-2", item: {} } }, calls: [], expect: { nothing: true } });
    expect(idle.diffs).toEqual([]);
  });
});
