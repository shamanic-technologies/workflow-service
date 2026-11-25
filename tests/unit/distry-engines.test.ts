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
  ANSWERS_NOBODY_REFUSAL,
  buildPathSource,
  firstEmailPaths,
  publicActPaths,
  FIRST_EMAIL_DYNASTY,
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

// The active scripts asking Message sent on 2026-11-25 (prod), plus scripts that must not count.
const LIVE = [
  { outcome: "paid_client", tactics: { asks: ["message_sent"] , recorded_by: "lead" } },
  { outcome: "paid_client", tactics: { asks: ["email_sent", "message_sent", "llm_completion"], recorded_by: "billing" } },
  { outcome: "paid_client", tactics: { relationships: "current_client" } },
  { outcome: "meeting_booked", tactics: { asks: ["message_sent"], recorded_by: "crm" } },
  { outcome: "meeting_attended", tactics: { asks: ["message_sent"], recorded_by: "crm" } },
  { outcome: "signup", tactics: { asks: ["message_sent"], recorded_by: "lead" } },
  { outcome: "signup", tactics: { asks: ["threads_post_published"], recorded_by: "lead" } },
  { outcome: "conversation", tactics: { asks: ["message_sent"], recorded_by: "instantly" } },
  { outcome: "conversation", tactics: { asks: ["email_sent"], askRecordedBy: "instantly", recorded_by: "instantly" } },
  { outcome: "email_sent", tactics: { asks: ["message_written"] } },
  { outcome: "x_post_published", tactics: null },
];

const ALL = [
  ...PATHS.map((p) => ({ ...p, code: buildPathSource(p.asks, { answersNobody: p.answersNobody === true }) })),
  ...firstEmailPaths(LIVE).map((p) => ({ ...p, code: buildPathSource(p.asks, { answersNobody: true }) })),
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

describe("a first cold email path toward every Engine reached by answering a lead (PLAN-RECURSIVE-PER-ENGINE-1124-WF2)", () => {
  const paths = firstEmailPaths(LIVE);
  const request = { now, brandIds, campaignId: "camp-1", trigger: null };

  it("is derived from the live catalogue: one per answering Engine, its owner read off that Engine's answering scripts", () => {
    expect(paths.map((p) => p.outcome)).toEqual(["meeting_attended", "meeting_booked", "paid_client", "signup"]);
    for (const p of paths) {
      expect(p.dynasty).toBe(FIRST_EMAIL_DYNASTY);
      // features-service's opt-in tactic gates scripts stating askRecordedBy: it must stay
      expect(p.tactics).toMatchObject({ asks: ["email_sent"], askRecordedBy: "instantly" });
    }
    expect(paths.find((p) => p.outcome === "meeting_booked")!.tactics.recorded_by).toBe("crm");
    // Positive reply already holds its first email path: none twice
    expect(paths.some((p) => p.outcome === "conversation")).toBe(false);
    expect(() => firstEmailPaths([{ outcome: "x", tactics: { asks: ["message_sent"], recorded_by: "a" } }, { outcome: "x", tactics: { asks: ["message_sent"], recorded_by: "b" } }])).toThrow(/several owner/);
  });

  it("a proactive run asks Email sent with the run's Request as it is, recorded by the mailbox", async () => {
    const p = paths.find((x) => x.outcome === "paid_client")!;
    const c: ReplayCase = {
      id: "first-email",
      units: { email_sent: { sent: true } },
      request,
      tactics: p.tactics,
      calls: [],
      asks: [{ units: {}, request, recordedBy: "instantly" }],
      expect: { content: { asked: "email_sent", unit: { sent: true } } },
    };
    expect((await replayCase(buildPathSource(p.asks, { answersNobody: true }), c)).diffs).toEqual([]);
  });

  it("a run answering an occurrence is refused by WHO (the next script answers), nothing asked", async () => {
    const p = paths.find((x) => x.outcome === "paid_client")!;
    const c: ReplayCase = {
      id: "occurrence",
      units: {},
      request: { ...request, trigger: { eventId: "e1", leadId: "lead-1" } },
      tactics: p.tactics,
      calls: [],
      asks: [],
      expect: { end: { success: true, personNotAdmitted: { reason: ANSWERS_NOBODY_REFUSAL.slice("person_not_admitted: ".length) } } },
    };
    expect((await replayCase(buildPathSource(p.asks, { answersNobody: true }), c)).diffs).toEqual([]);
    expect(ANSWERS_NOBODY_REFUSAL.startsWith("person_not_admitted: ")).toBe(true);
  });

  it("the answerer paths keep answering an occurrence (their code is unchanged)", () => {
    const signup = PATHS.find((x) => x.outcome === "signup" && !x.answersNobody)!;
    expect(buildPathSource(signup.asks, { answersNobody: signup.answersNobody === true })).toBe(buildPathSource(signup.asks));
  });
});

// PLAN-RECURSIVE-PER-ENGINE-1124-WF3 B1: a path through a public act under every Engine reached by answering a lead.
describe("publicActPaths", () => {
  const STEPS = [
    { key: "signup", name: "Signup", subjectKind: "person", lifecycleRung: "signup_or_form", towardStep: null },
    { key: "paid_client", name: "Paid client", subjectKind: "person", lifecycleRung: "paid_client", towardStep: null },
    { key: "website_visit", name: "Website visit", subjectKind: "person", lifecycleRung: "engaged", towardStep: "lead_visited" },
    { key: "x_post_published", name: "X post published", subjectKind: "object", lifecycleRung: "none", towardStep: "paid_client" },
    { key: "threads_post_published", name: "Threads post published", subjectKind: "object", lifecycleRung: "none", towardStep: "paid_client" },
    { key: "post_viewed", name: "Post viewed", subjectKind: "object", lifecycleRung: "none", towardStep: "website_visit" },
    { key: "newsletter_email_sent", name: "Newsletter email sent", subjectKind: "object", lifecycleRung: "contacted", towardStep: "website_visit" },
    { key: "instagram_reel_published", name: "Instagram reel published", subjectKind: "object", lifecycleRung: null, towardStep: "post_viewed" },
    { key: "email_sent", name: "Email sent", subjectKind: null, lifecycleRung: "contacted", towardStep: "conversation" },
  ];
  const ROWS = [
    ...LIVE,
    { outcome: "x_post_published", tactics: { asks: ["industry_news_found", "llm_completion"], recorded_by: "social" } },
    { outcome: "threads_post_published", tactics: { asks: ["llm_completion"], recorded_by: "meta" } },
    { outcome: "post_viewed", tactics: { asks: ["x_post_published"], askRecordedBy: "social", recorded_by: "social" } },
    { outcome: "instagram_reel_published", tactics: { asks: ["hook_added"], recorded_by: "social" } },
  ];
  it("one path per (Target reached by answering, act that makes a public Unit toward the person's ladder), none already held", () => {
    const got = publicActPaths(ROWS, STEPS).map((p) => `${p.outcome}/${p.dynasty}`);
    expect(got).toEqual([
      "conversation/dy_through_threads_post_published",
      "conversation/dy_through_x_post_published",
      "meeting_attended/dy_through_threads_post_published",
      "meeting_attended/dy_through_x_post_published",
      "meeting_booked/dy_through_threads_post_published",
      "meeting_booked/dy_through_x_post_published",
      "paid_client/dy_through_threads_post_published",
      "paid_client/dy_through_x_post_published",
      // Signup already holds a script asking Threads alone.
      "signup/dy_through_x_post_published",
    ]);
  });
  it("asks its act alone, states the Target's owner and no askRecordedBy (the cold email opt-in never gates it), refuses an occurrence", async () => {
    const p = publicActPaths(ROWS, STEPS).find((x) => x.outcome === "signup")!;
    expect(p.tactics).toEqual({ asks: ["x_post_published"], recorded_by: "lead" });
    expect(p.name).toBe("Through X post published");
    expect(p.answersNobody).toBe(true);
    const code = buildPathSource(p.asks, { answersNobody: true });
    const v = await validateSource(code);
    expect(v.materials).toEqual(["x_post_published"]);
    expect(code).toContain(ANSWERS_NOBODY_REFUSAL);
  });
  it("a Target whose answering paths state several owners is refused, never guessed", () => {
    expect(() => publicActPaths([...ROWS, { outcome: "signup", tactics: { asks: ["message_sent"], recorded_by: "crm" } }], STEPS)).toThrow(/several owner/);
  });
});
