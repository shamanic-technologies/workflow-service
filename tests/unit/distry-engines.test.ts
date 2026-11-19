import { describe, it, expect } from "vitest";
import { replayCase, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { SERVICE_DOOR_VENDORS, TO_PERSON_DOORS } from "../../src/lib/scripts/vendors.js";
import { notCallableReason } from "../../src/lib/scripts/engine-calls.js";
import {
  buildCompanyCheckSource,
  buildDraftSource,
  buildEmailCheckSource,
  buildIndustryVideoSource,
  buildPathSource,
  buildPhoneRevealSource,
  buildReplySource,
  DRAFTS,
  ENGINE_REASONS,
  PATHS,
  PRODUCERS,
  REPLIES,
} from "../../scripts/engine-ports/distry-engines.js";

// DISTRY-ENGINES-1119: every Engine of the catalogue holds a runnable script (or a stated reason), so Distry can ask it.
const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const now = "2026-11-19T14:00:00.000Z";
const brandIds = ["brand-reed"];
const profile = { name: "Reed", domain: "reed.example" };
const completion = (json: Record<string, unknown>) => ({ answer: { json }, llm: { provider: "deepseek", model: "flash" } });

const ALL = [
  ...PATHS.map((p) => ({ ...p, code: buildPathSource(p.asks) })),
  ...DRAFTS.map((d) => ({ ...d, code: buildDraftSource() })),
  ...REPLIES.map((r) => ({ ...r, code: buildReplySource() })),
  ...PRODUCERS.map((p) => ({ ...p, code: p.build() })),
];

describe("the scripts that make every Engine callable", () => {
  it("cover every gap Engine once, each a valid script that never names its own outcome, a model or a template", async () => {
    const covered = new Set(ALL.map((s) => s.outcome));
    for (const o of ["conversation", "form_submitted", "signup", "purchase", "website_visit", "lead_visited", "whatsapp_number_given", "post_viewed", "post_engaged", "google_search_click", "x_post_drafted", "linkedin_post_drafted", "linkedin_comment_drafted", "newsletter_drafted", "x_reply_published", "linkedin_comment_published", "email_checked", "phone_found", "company_researched", "industry_update_video"]) {
      expect(covered.has(o), o).toBe(true);
    }
    for (const o of Object.keys(ENGINE_REASONS)) expect(covered.has(o), o).toBe(false);
    const seen = new Set<string>();
    for (const s of ALL) {
      const key = `${s.outcome}/${s.dynasty}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
      const read = await validateSource(s.code);
      // What it reads is what it asks (never a material nobody hands it).
      const asks = ((s.tactics.asks as string[] | undefined) ?? []).slice().sort();
      expect(read.materials.slice().sort(), key).toEqual(asks);
      for (const v of read.vendors) expect(v in SERVICE_DOOR_VENDORS || v === "brand.profile", `${key} ${v}`).toBe(true);
      // None of them writes to a person: no writing proof gate applies.
      for (const v of read.vendors) expect(v in TO_PERSON_DOORS, `${key} ${v}`).toBe(false);
      expect(s.code, key).not.toContain(`"${s.outcome}"`);
      expect(s.code, key).not.toMatch(/claude|haiku|opus|sonnet|gpt-|deepseek/i);
      expect(s.tactics, key).not.toHaveProperty("llm");
      expect(s.tactics, key).not.toHaveProperty("template");
      expect(s.name.length, key).toBeLessThanOrEqual(40);
      expect(`${s.name} ${s.description}`, key).not.toMatch(/[—–_]|agency/i);
    }
    for (const reason of Object.values(ENGINE_REASONS)) expect(reason).not.toMatch(/[—–]/);
  });

  it("the new doors are the owning services' own org routes", () => {
    expect(SERVICE_DOOR_VENDORS["apollo.email.verifications"]).toMatchObject({ service: "apollo", method: "POST", path: "/email-verifications", asRun: true });
    expect(SERVICE_DOOR_VENDORS["social.reply"]).toMatchObject({ service: "social", method: "POST", path: "/orgs/social/accounts/{id}/replies", asRun: true, outcomeInBody: "outcomeKey" });
    expect(SERVICE_DOOR_VENDORS["lead.company.preview"]).toMatchObject({ service: "lead", method: "POST", path: "/orgs/brands/{brandId}/offers/{offerId}/qualification/previews", asRun: true });
    expect(SERVICE_DOOR_VENDORS["content.debrief.render"]).toMatchObject({ service: "content-generation", method: "POST", path: "/industry-debrief-videos", asRun: true });
  });
});

describe("a path toward a person's act", () => {
  const signup = PATHS.find((p) => p.outcome === "signup")!;
  const views = PATHS.find((p) => p.dynasty === "dy_post_views_x")!;
  const request = { now, brandIds, campaignId: "camp-1" };

  it("asks the answerer with its goal, recorded by the sender, and answers what it answered", async () => {
    const c: ReplayCase = {
      id: "signup",
      units: { message_sent: { decision: "write", channel: "email" } },
      request,
      tactics: signup.tactics,
      calls: [],
      asks: [{ units: {}, request: { ...request, goal: signup.tactics.goal }, recordedBy: "sender" }],
      expect: { content: { asked: "message_sent", unit: { decision: "write", channel: "email" } } },
    };
    expect((await replayCase(buildPathSource(signup.asks), c)).diffs).toEqual([]);
  });

  it("asks a post Engine with the run's Request as it is (no goal), recorded by social-service", async () => {
    const c: ReplayCase = {
      id: "views",
      units: { x_post_published: { end: { success: true } } },
      request,
      tactics: views.tactics,
      calls: [],
      asks: [{ units: {}, request, recordedBy: "social" }],
      expect: { content: { asked: "x_post_published", unit: { end: { success: true } } } },
    };
    expect((await replayCase(buildPathSource(views.asks), c)).diffs).toEqual([]);
    expect(() => buildPathSource("bad key")).toThrow(/not an outcome key/);
  });
});

describe("a draft", () => {
  const xDraft = DRAFTS.find((d) => d.outcome === "x_post_drafted")!;
  it("asks the LLM completion Engine and answers the draft, dashes rewritten", async () => {
    const c: ReplayCase = {
      id: "draft",
      units: { llm_completion: completion({ title: "", text: "Revenue made easy — one meeting a day." }) },
      request: { now, brandIds, topic: "Why one meeting a day beats ten cold calls" },
      tactics: xDraft.tactics,
      calls: [{ name: "brand.profile", args: { params: { id: "brand-reed" } }, answer: ok(profile) }],
      expect: { content: { title: "", text: "Revenue made easy, one meeting a day.", format: xDraft.tactics.format, writtenWith: { provider: "deepseek", model: "flash" } } },
    };
    expect((await replayCase(buildDraftSource(), c)).diffs).toEqual([]);
  });

  it("writes nothing when it is told nothing to write about", async () => {
    const c: ReplayCase = { id: "nothing", units: {}, request: { now, brandIds: [] }, tactics: xDraft.tactics, calls: [], expect: { fails: "nothing_to_write_about" } };
    const src = buildDraftSource();
    expect((await replayCase(src.replace('str(ctx.brand)', '""'), c)).diffs).toEqual([]);
  });
});

describe("a reply under someone else's post", () => {
  const xReply = REPLIES.find((r) => r.outcome === "x_reply_published")!;
  const target = "https://x.com/someone/status/1234567890";
  it("writes the reply, then publishes it from the brand's Pro (AI) account", async () => {
    const c: ReplayCase = {
      id: "reply",
      units: { llm_completion: completion({ text: "We saw the same: replies double when the first line names their result." }) },
      request: { now, brandIds, campaignId: "camp-1", target, postText: "Cold email is dead." },
      tactics: xReply.tactics,
      calls: [
        { name: "social.accounts", args: { query: { brandId: "brand-reed", network: "x" } }, answer: ok({ accounts: [{ id: "acc-1", username: "reed", publishable: true, accountType: "pro_ai", health: "connected" }] }) },
        { name: "brand.profile", answer: ok(profile) },
        {
          name: "social.reply",
          args: { params: { id: "acc-1" }, body: { target, text: "We saw the same: replies double when the first line names their result.", idempotencyKey: `x-reply:camp-1:${target}` } },
          answer: ok({ publication: { id: "pub-1" }, created: true }),
        },
      ],
      expect: { content: { target, text: "We saw the same: replies double when the first line names their result.", account: "reed", publication: { id: "pub-1" } } },
    };
    expect((await replayCase(buildReplySource(), c)).diffs).toEqual([]);
  });

  it("names what is missing: no target, no post text, no account software may reply from", async () => {
    const src = buildReplySource();
    const base = { id: "x", units: {}, tactics: xReply.tactics };
    expect((await replayCase(src, { ...base, request: { now, brandIds }, calls: [], expect: { fails: "no_target" } })).diffs).toEqual([]);
    expect((await replayCase(src, { ...base, request: { now, brandIds, target }, calls: [], expect: { fails: "no_post_text" } })).diffs).toEqual([]);
    const none: ReplayCase = {
      ...base,
      request: { now, brandIds, target, postText: "x" },
      calls: [{ name: "social.accounts", answer: ok({ accounts: [{ id: "a", username: "kevin", publishable: false, accountType: "personal", notPublishableReason: "a personal account" }] }) }],
      expect: { fails: "no_publishable_account: no x account of the brand may reply by software: kevin (a personal account)" },
    };
    expect((await replayCase(src, none)).diffs).toEqual([]);
  });
});

describe("the producer calls", () => {
  it("checks one address with apollo-service", async () => {
    const c: ReplayCase = {
      id: "email",
      units: {},
      request: { now, email: "Kevin+Check@Hidistribute.com" },
      calls: [{ name: "apollo.email.verifications", args: { body: { emails: ["kevin+check@hidistribute.com"], source: "engine" } }, answer: ok({ results: [{ email: "kevin+check@hidistribute.com", verdict: "valid", reused: false }] }) }],
      expect: { content: { email: "kevin+check@hidistribute.com", verdict: "valid", reused: false } },
    };
    expect((await replayCase(buildEmailCheckSource(), c)).diffs).toEqual([]);
    expect((await replayCase(buildEmailCheckSource(), { id: "none", units: {}, request: { now }, calls: [], expect: { fails: "no_email" } })).diffs).toEqual([]);
  });

  it("reveals a phone only when none is known, and waits on Apollo's answer", async () => {
    const src = buildPhoneRevealSource();
    expect((await replayCase(src, { id: "known", units: {}, request: { now, phone: "+33600000000", apolloPersonId: "p1" }, calls: [], expect: { fails: "phone_already_known" } })).diffs).toEqual([]);
    const c: ReplayCase = {
      id: "reveal",
      units: {},
      request: { now, apolloPersonId: "p1" },
      calls: [
        { name: "apollo.phone.reveal", args: { params: { apolloPersonId: "p1" }, body: {} }, answer: ok({ status: "pending" }) },
        { name: "apollo.phone.read", args: { params: { apolloPersonId: "p1" }, pollWhile: { field: "status", equals: "pending", intervalSeconds: 5, timeoutSeconds: 90 } }, answer: ok({ status: "found", mobilePhone: "+15550001111", doNotCall: false, dncStatus: null }) },
      ],
      expect: { content: { apolloPersonId: "p1", phone: "+15550001111", doNotCall: false, dncStatus: null, reused: false } },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
  });

  it("researches a company on the offer's checks, and says when the offer states none", async () => {
    const src = buildCompanyCheckSource();
    const preview = { id: "pv-1", status: "completed", run: { id: "r" }, companies: [{ domain: "acme.com" }] };
    const c: ReplayCase = {
      id: "company",
      units: {},
      request: { now, brandIds, offerId: "offer-1", domain: "Acme.com" },
      calls: [
        { name: "lead.company.preview", args: { params: { brandId: "brand-reed", offerId: "offer-1" }, body: { companies: [{ domain: "acme.com", name: "acme.com" }] } }, answer: ok({ preview: { ...preview, status: "running" } }) },
        { name: "lead.company.preview.read", answer: ok({ preview }) },
      ],
      expect: { content: { domain: "acme.com", preview } },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
    const noChecks: ReplayCase = {
      id: "nochecks",
      units: {},
      request: { now, brandIds, offerId: "offer-1", domain: "acme.com" },
      calls: [{ name: "lead.company.preview", answer: ok({ preview: { id: "pv", status: "completed", run: null } }) }],
      expect: { fails: "no_checks" },
    };
    expect((await replayCase(src, noChecks)).diffs).toEqual([]);
    expect((await replayCase(src, { id: "nooffer", units: {}, request: { now, brandIds, domain: "acme.com" }, calls: [], expect: { fails: "no_offer" } })).diffs).toEqual([]);
  });

  it("renders the day's industry video from the watch's posts, and says when there are too few", async () => {
    const video = PRODUCERS.find((p) => p.outcome === "industry_update_video")!;
    const src = buildIndustryVideoSource();
    const items = [
      { url: "https://x.com/a/status/111111", text: "We tripled replies with one line.", score: 9, author: "A" },
      { url: "https://www.linkedin.com/posts/b_x-activity-7390000000000000000-abc", text: "Our test: 2x meetings.", score: 7 },
      { url: "https://example.com/blog", text: "not showable", score: 10 },
    ];
    const story = (index: number) => ({ index, spotlight: "We tripled replies with one line.", kicker: "Acme", headline: "Acme triples replies", relation: "own", role: "CEO, Acme", about: "Sales software", why: "Short openers win", note: "One test", take: "Clear beats clever" });
    const c: ReplayCase = {
      id: "video",
      units: { industry_news_found: { scanned: true, items }, llm_completion: completion({ stories: [story(0), story(1), story(0)] }) },
      request: { now, brandIds, campaignId: "camp-1" },
      tactics: video.tactics,
      calls: [
        { name: "brand.profile", answer: ok(profile) },
        { name: "content.debrief.render", answer: ok({ id: "vid-1", status: "queued" }) },
        { name: "content.debrief.read", args: { params: { id: "vid-1" }, query: { waitSeconds: "240" } }, answer: ok({ id: "vid-1", status: "done", videoUrl: "https://cdn/v.mp4", durationSeconds: 42 }) },
      ],
      expect: { content: { videoId: "vid-1", videoUrl: "https://cdn/v.mp4", durationSeconds: 42, stories: 2 } },
    };
    expect((await replayCase(src, c)).diffs).toEqual([]);
    const thin: ReplayCase = { id: "thin", units: { industry_news_found: { items: [items[0]] } }, request: { now, brandIds }, tactics: video.tactics, calls: [], expect: { fails: "not_enough_stories" } };
    expect((await replayCase(src, thin)).diffs).toEqual([]);
  });
});

describe("the Engine list's reasons", () => {
  it("a stated reason wins; an Engine whose retired scripts live on elsewhere says where", () => {
    expect(notCallableReason({ scripts: 0, live: 0, unprovenPorts: 0, awaitingWriterProof: 0, stated: ENGINE_REASONS.ad_shown })).toBe(ENGINE_REASONS.ad_shown);
    expect(notCallableReason({ scripts: 1, live: 0, unprovenPorts: 0, awaitingWriterProof: 0, movedTo: ["Email queued"] })).toBe(
      "Its scripts moved to Email queued, which make this work now: ask that Engine instead.",
    );
    expect(notCallableReason({ scripts: 1, live: 0, unprovenPorts: 0, awaitingWriterProof: 0, movedTo: [] })).toBe("Every script of this outcome is retired (1 stored).");
  });
});
