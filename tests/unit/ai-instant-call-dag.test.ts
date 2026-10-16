import { describe, it, expect, vi, afterEach } from "vitest";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  AI_INSTANT_CALL_PIPE_ID,
  AI_INSTANT_CALL_PIPE_IDS,
  BUILD_CALL_CODE,
  INSTANT_CALL_PLACED_REASON,
  NOBODY_DUE,
  NO_REP,
  NO_SALES_REP_PHONE_REASON,
  OTHER_PERSON,
  PHONE_REVEAL_WAIT_SECONDS,
  PLAN_CLAIM_CODE,
  REPLY_TEXT_UNAVAILABLE,
  RESOLVE_CALL_CODE,
  RING,
  AI_INSTANT_CALL_DESCRIPTION,
  EMAIL_REPLIES_ONLY_DESCRIPTION,
  NOT_BY_EMAIL,
  NO_REP_EMAIL_ONLY,
  REPLY_CHANNEL_CODE,
  REPLY_CHANNEL_UNKNOWN_REASON,
  REPLY_NOT_BY_EMAIL_REASON,
  RING_EMAIL_ONLY,
  buildAiInstantCallDag,
  ringsOnEmailRepliesOnly,
} from "../../src/lib/ai-instant-call-dag.js";

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

function descendants(dag: DAG, start: string): Set<string> {
  const out = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const id = queue.shift() as string;
    for (const e of dag.edges) {
      if (e.from === id && !out.has(e.to)) {
        out.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return out;
}

function holds(condition: string, results: Record<string, unknown>): boolean {
  return new Function("results", `return (${condition});`)(results) as boolean;
}

afterEach(() => vi.restoreAllMocks());

const claim = { found: true, followup: { id: "row-1", leadId: "lead-1", email: "Jo@Example.com", brandId: "brand-1", dueAt: "2026-10-15T10:00:00.000Z" } };
const rep = { salesRepPhone: "+15550009999", salesRepFirstName: "Marie" };
const brand = { brand: { id: "brand-1", name: "Doc Dinners" } };
const leadDetail = {
  leadDetail: {
    id: "row-1",
    apolloPersonId: "apollo-1",
    lead: {
      firstName: "Jo",
      lastName: "Smith",
      name: "Jo Smith",
      currentTitle: "Head of Ops",
      city: "Leeds",
      state: "",
      country: "United Kingdom",
      organization: { name: "Acme" },
    },
  },
};
const formTrigger = {
  eventId: "ev-form",
  triggerId: "form_submitted",
  person: { email: "jo@example.com", name: "Jo Smith", phone: "+447700900123" },
  item: {
    formName: "Doc Dinners - Meta lead form",
    submittedAt: "2026-10-15T09:58:00.000Z",
    answers: [
      { key: "team_size", label: "How big is your team?", value: "12" },
      { key: "needs", label: "What do you need?", value: ["Dinners", "Events"] },
      { key: "empty", label: "Anything else?", value: "" },
    ],
  },
};
const replyTrigger = {
  eventId: "ev-reply",
  triggerId: "positive_reply_received",
  person: { email: "jo@example.com", name: "Jo Smith" },
  item: {
    replyText: "Yes, interested. Can we talk Thursday?",
    priorMessages: [
      { direction: "outbound", text: "Following up on my note." },
      { direction: "outbound", text: "Hi Jo, quick question." },
      { direction: "sideways", text: "dropped" },
      { direction: "inbound", text: "   " },
    ],
  },
};

describe("AI Instant Call DAG (AIC-COMMON-1015)", () => {
  const dag = buildAiInstantCallDag();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));

  it("lives on the Positive reply -> Booking call pipe", () => {
    expect(AI_INSTANT_CALL_PIPE_ID).toBe("ai-instant-call|conversation_to_booking_call");
  });

  it("one workflow serves both AI Instant Call pipes: a positive reply and a form fill", () => {
    expect(AI_INSTANT_CALL_PIPE_IDS).toEqual([
      "ai-instant-call|conversation_to_booking_call",
      "ai-instant-call|form_submitted_to_booking_call",
    ]);
  });

  it("is a valid DAG that translates to Windmill with two top-level branchones", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    const flow = dagToOpenFlow(dag, "ai-instant-call-test");
    const top = flow.value.modules.filter((m: { value: { type: string } }) => m.value.type === "branchone");
    expect(top).toHaveLength(2);
    expect(dag.edges.filter((e) => e.to === "check-call").map((e) => e.from)).toContain("claim-followup");
  });

  it("runs like every pipe: gate-check, start-run, an end-run on every branch and on error", () => {
    expect(dag.edges[0]).toEqual({ from: "gate-check", to: "start-run" });
    expect(dag.onError).toBe("end-run-error");
    for (const leaf of dag.nodes.filter((n) => !dag.edges.some((e) => e.from === n.id))) {
      expect(leaf.config?.path).toBe("/end-run");
    }
  });

  it("nobody due ends idle (noWorkAvailable) and rings nobody", () => {
    expect(byId.get("end-run-nobody-due")?.config?.body).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
    expect(holds(NOBODY_DUE, { "claim-followup": { found: false } })).toBe(true);
    expect(holds(NOBODY_DUE, { "claim-followup": { ok: false, skipped: true, notCalled: true } })).toBe(true);
    expect(descendants(dag, "end-run-nobody-due").has("ring-rep")).toBe(false);
    // On the nobody path resolve-call never ran: the second branchone takes no arm.
    for (const c of [RING, NO_REP, OTHER_PERSON]) expect(holds(c, { "claim-followup": { found: false } })).toBe(false);
  });

  it("a run carrying no occurrence naming a person claims nobody", async () => {
    const plan = loadMain(PLAN_CLAIM_CODE);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await plan(undefined)).toEqual({ skip: true });
    expect(await plan({ eventId: "x", person: {} })).toEqual({ skip: true });
    expect(await plan(formTrigger)).toEqual({ skip: false });
    expect(byId.get("claim-followup")?.inputMapping?.skip).toBe("$ref:plan-claim.output.skip");
  });

  it("the call goes to twilio-service, never retried, and only the record after it is tolerated", () => {
    const ring = byId.get("ring-rep")!;
    expect(ring.config).toEqual({ service: "twilio", method: "POST", path: "/calls" });
    expect(ring.retries).toBe(0);
    expect(ring.inputMapping).toEqual({ body: "$ref:build-call.output.body" });
    expect(dag.edges).toContainEqual({ from: "ring-rep", to: "record-called" });
    expect(byId.get("record-called")?.config).toMatchObject({ body: { kind: "stopped", reason: INSTANT_CALL_PLACED_REASON }, tolerateFailure: true });
  });

  it("the reveal is asked once then waited for, bounded at 90 s, and a failure costs the bridge, never the call", () => {
    expect(PHONE_REVEAL_WAIT_SECONDS).toBe(90);
    const req = byId.get("request-reveal")!;
    const wait = byId.get("wait-reveal")!;
    expect(req.config).toMatchObject({ service: "apollo", method: "POST", path: "/people/{apolloPersonId}/phone-reveal", tolerateFailure: true });
    expect(wait.config).toMatchObject({
      service: "apollo",
      method: "GET",
      tolerateFailure: true,
      pollWhile: { field: "status", equals: "pending", timeoutSeconds: 90 },
    });
    for (const n of [req, wait]) expect(n.inputMapping?.skip).toBe("$ref:resolve-call.output.skipReveal");
  });

  it("a brand with no rep phone rings nobody and ends cleanly", () => {
    expect(byId.get("record-no-rep")?.config?.body).toEqual({ kind: "stopped", reason: NO_SALES_REP_PHONE_REASON });
    expect(byId.get("end-run-no-rep")?.config?.body).toEqual({ success: true, stopCampaign: false });
    expect(descendants(dag, "record-no-rep").has("ring-rep")).toBe(false);
  });
});

describe("resolve-call", () => {
  const resolve = loadMain(RESOLVE_CALL_CODE);

  it("a form fill: says a form was filled, its answers (array values joined, empty ones dropped), bridges to the given phone", async () => {
    const r = await resolve(claim, formTrigger, leadDetail, rep, brand);
    expect(r.ok).toBe(true);
    expect(r.occasion).toEqual({
      type: "form",
      formName: "Doc Dinners - Meta lead form",
      answers: [
        { question: "How big is your team?", answer: "12" },
        { question: "What do you need?", answer: "Dinners, Events" },
      ],
    });
    expect(r.reply).toEqual({
      name: "Jo Smith",
      company: "Acme",
      firstName: "Jo",
      lastName: "Smith",
      title: "Head of Ops",
      city: "Leeds",
      country: "United Kingdom",
    });
    expect(r.reply.message).toBeUndefined();
    expect(r.knownPhone).toBe("+447700900123");
    expect(r.needsReveal).toBe(false);
    expect(r.skipReveal).toBe(true);
    expect(r.priorMessages).toEqual([]);
    expect(r.salesRepPhone).toBe("+15550009999");
    expect(r.brandName).toBe("Doc Dinners");
    expect(holds(RING, { "resolve-call": r })).toBe(true);
  });

  it("a reply: the reply text and the earlier messages newest-first, cleaned of entries with no words; Apollo reveal asked", async () => {
    const r = await resolve(claim, replyTrigger, leadDetail, rep, brand);
    expect(r.occasion).toBeNull();
    expect(r.reply.message).toBe("Yes, interested. Can we talk Thursday?");
    expect(r.priorMessages).toEqual([
      { direction: "outbound", text: "Following up on my note." },
      { direction: "outbound", text: "Hi Jo, quick question." },
    ]);
    expect(r.knownPhone).toBeNull();
    expect(r.apolloPersonId).toBe("apollo-1");
    expect(r.needsReveal).toBe(true);
    expect(r.skipReveal).toBe(false);
  });

  it("a reply whose words we do not hold still rings, and says so", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await resolve(claim, { ...replyTrigger, item: {} }, leadDetail, rep, brand);
    expect(r.reply.message).toBe(REPLY_TEXT_UNAVAILABLE);
  });

  it("at most 5 earlier messages", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ direction: "outbound", text: `m${i}` }));
    const r = await resolve(claim, { ...replyTrigger, item: { replyText: "yes", priorMessages: many } }, leadDetail, rep, brand);
    expect(r.priorMessages.map((m: { text: string }) => m.text)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("a failed lead read rings about who the occurrence names, unconnected unless it carries a phone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await resolve(claim, replyTrigger, { ok: false, status: 404 }, rep, brand);
    expect(r.reply).toEqual({ name: "Jo Smith", message: "Yes, interested. Can we talk Thursday?" });
    expect(r.needsReveal).toBe(false);
  });

  it("no rep phone: nobody rung, no reveal spent", async () => {
    const r = await resolve(claim, replyTrigger, leadDetail, { salesRepPhone: null }, brand);
    expect(r.hasRep).toBe(false);
    expect(r.needsReveal).toBe(false);
    expect(holds(NO_REP, { "resolve-call": r })).toBe(true);
    expect(holds(RING, { "resolve-call": r })).toBe(false);
  });

  it("an occurrence naming someone else: their row is left alone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await resolve(claim, { ...formTrigger, person: { email: "other@example.com" } }, leadDetail, rep, brand);
    expect(r.ok).toBe(false);
    expect(holds(OTHER_PERSON, { "resolve-call": r })).toBe(true);
    expect(holds(RING, { "resolve-call": r })).toBe(false);
  });
});

describe("a person known ONLY by phone (a WhatsApp writer, REPLY-PHONE-ONLY-1015)", () => {
  const resolve = loadMain(RESOLVE_CALL_CODE);
  const phoneClaim = { found: true, followup: { id: "row-2", leadId: "lead-2", email: null, phone: "+447700900123", brandId: "brand-1" } };
  const waTrigger = {
    eventId: "ev-wa",
    triggerId: "positive_reply_received",
    leadId: "lead-2",
    person: { email: null, phone: "+44 7700 900123", name: "Sam" },
    item: { kind: "reply", channel: "whatsapp", messages: [{ at: "2026-10-15T09:00:00.000Z", text: "Hi" }, { at: "2026-10-15T09:00:05.000Z", text: "is it still on?" }] },
  };

  it("is claimed (the occurrence names them by phone) and rung about, bridged to their phone, with their WhatsApp words", async () => {
    expect(await loadMain(PLAN_CLAIM_CODE)(waTrigger)).toEqual({ skip: false });
    const r = await resolve(phoneClaim, waTrigger, { ok: false, status: 404 }, rep, brand);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(r.ok).toBe(true);
    expect(r.reply).toEqual({ name: "Sam", message: "Hi\nis it still on?" });
    expect(r.knownPhone).toBe("+44 7700 900123");
    expect(holds(RING, { "resolve-call": r })).toBe(true);
  });

  it("an occurrence naming another phone leaves their row alone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await resolve(phoneClaim, { ...waTrigger, person: { phone: "+33612345678" } }, leadDetail, rep, brand);
    expect(r.ok).toBe(false);
  });
});

describe("build-call", () => {
  const resolve = loadMain(RESOLVE_CALL_CODE);
  const build = loadMain(BUILD_CALL_CODE);
  vi.spyOn(console, "log").mockImplementation(() => {});

  it("form: occasion, the given phone, no thread, keyed on the occurrence, parented on this run", async () => {
    const person = await resolve(claim, formTrigger, leadDetail, rep, brand);
    const { body, connectOffered } = await build(person, { ok: false, skipped: true, notCalled: true }, "camp-1", "run-1");
    expect(connectOffered).toBe(true);
    expect(body).toEqual({
      to: "+15550009999",
      reply: person.reply,
      occasion: person.occasion,
      brandName: "Doc Dinners",
      connectTo: "+447700900123",
      parentRunId: "run-1",
      brandId: "brand-1",
      campaignId: "camp-1",
      idempotencyKey: "ai-instant-call:event:ev-form",
    });
  });

  it("reply: the thread, the revealed number when found", async () => {
    const person = await resolve(claim, replyTrigger, leadDetail, rep, brand);
    const { body } = await build(person, { status: "found", mobilePhone: "+15551112222", doNotCall: false }, "camp-1", "run-1");
    expect(body.connectTo).toBe("+15551112222");
    expect(body.occasion).toBeUndefined();
    expect(body.priorMessages).toHaveLength(2);
    expect(body.reply.message).toBe("Yes, interested. Can we talk Thursday?");
  });

  it("a do-not-call, pending, missing or failed reveal never dials: the call says it cannot connect", async () => {
    const person = await resolve(claim, replyTrigger, leadDetail, rep, brand);
    for (const reveal of [
      { status: "found", mobilePhone: "+15551112222", doNotCall: true },
      { status: "pending", mobilePhone: null, pollTimedOut: true },
      { status: "not_found", mobilePhone: null },
      { ok: false, status: 500, error: "boom" },
    ]) {
      const { body, connectOffered } = await build(person, reveal, "camp-1", "run-1");
      expect(body.connectTo).toBeUndefined();
      expect(connectOffered).toBe(false);
    }
  });
});

describe("the email-only copy (INSTANT-CALL-EMAIL-ONLY-1016): rings only on a positive reply received by email", () => {
  const base = buildAiInstantCallDag();
  const dag = buildAiInstantCallDag({ emailRepliesOnly: true });
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const resolve = loadMain(RESOLVE_CALL_CODE);
  const channelOf = loadMain(REPLY_CHANNEL_CODE);
  const emailReply = { ...replyTrigger, item: { ...replyTrigger.item, channel: "email" } };
  const waReply = { ...replyTrigger, item: { ...replyTrigger.item, channel: "whatsapp" } };

  async function route(trigger: unknown, r = rep) {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const resolved = await resolve(claim, trigger, leadDetail, r, brand);
    const channel = await channelOf(trigger);
    const results = { "claim-followup": claim, "resolve-call": resolved, "reply-channel": channel };
    const arms = dag.edges.filter((e) => e.from === "check-call" && e.condition && holds(e.condition, results)).map((e) => e.to);
    return { channel, arms };
  }

  it("the default workflow is untouched: no channel read, same DAG as before", () => {
    expect(ringsOnEmailRepliesOnly(base)).toBe(false);
    expect(base.nodes.some((n) => n.id === "reply-channel")).toBe(false);
    expect(ringsOnEmailRepliesOnly(dag)).toBe(true);
    expect(JSON.stringify(buildAiInstantCallDag({}))).toBe(JSON.stringify(base));
  });

  it("is a valid DAG with the same two top-level branchones, every leaf an end-run", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    const flow = dagToOpenFlow(dag, "ai-instant-call-email-only-test");
    expect(flow.value.modules.filter((m: { value: { type: string } }) => m.value.type === "branchone")).toHaveLength(2);
    for (const leaf of dag.nodes.filter((n) => !dag.edges.some((e) => e.from === n.id))) {
      expect(leaf.config?.path).toBe("/end-run");
    }
    expect(dag.edges).toContainEqual({ from: "resolve-call", to: "reply-channel" });
    expect(dag.edges).toContainEqual({ from: "reply-channel", to: "check-call" });
    expect(dag.edges).not.toContainEqual({ from: "resolve-call", to: "check-call" });
  });

  it("a reply received by email proceeds to the call plan", async () => {
    const { channel, arms } = await route(emailReply);
    expect(channel).toEqual({ allowed: true, channel: "email", occasion: "reply" });
    expect(arms).toEqual(["request-reveal"]);
    expect(descendants(dag, "request-reveal").has("ring-rep")).toBe(true);
  });

  it("a reply received on WhatsApp rings nobody: the row is stopped reply_not_by_email, the run ends person not admitted", async () => {
    const { channel, arms } = await route(waReply);
    expect(channel.allowed).toBe(false);
    expect(channel.stop).toEqual({ kind: "stopped", reason: REPLY_NOT_BY_EMAIL_REASON });
    expect(channel.notAdmitted.reason.startsWith(REPLY_NOT_BY_EMAIL_REASON + ": ")).toBe(true);
    expect(channel.notAdmitted.reason).toContain("whatsapp");
    expect(channel.notAdmitted.reason.length).toBeLessThanOrEqual(200);
    expect(channel.delivery).toBeUndefined();
    expect(arms).toEqual(["record-not-email"]);
    expect(descendants(dag, "record-not-email").has("ring-rep")).toBe(false);
    expect(descendants(dag, "record-not-email").has("request-reveal")).toBe(false);
    expect(byId.get("record-not-email")?.inputMapping).toEqual({
      "params.id": "$ref:resolve-call.output.rowId",
      body: "$ref:reply-channel.output.stop",
    });
    expect(byId.get("end-run-not-email")?.config?.body).toEqual({ success: true, stopCampaign: false });
    expect(byId.get("end-run-not-email")?.inputMapping).toEqual({ "body.personNotAdmitted": "$ref:reply-channel.output.notAdmitted" });
  });

  it("a reply stating NO channel is never assumed to be email: skipped as reply_channel_unknown", async () => {
    const { channel, arms } = await route(replyTrigger);
    expect(channel).toMatchObject({ allowed: false, channel: null, stop: { kind: "stopped", reason: REPLY_CHANNEL_UNKNOWN_REASON } });
    expect(arms).toEqual(["record-not-email"]);
    expect((await channelOf(undefined)).allowed).toBe(false);
    expect((await channelOf({ item: { channel: "  " } })).stop.reason).toBe(REPLY_CHANNEL_UNKNOWN_REASON);
    expect((await channelOf(replyTrigger)).notAdmitted.reason.length).toBeLessThanOrEqual(200);
  });

  it("the channel is case-folded: EMAIL rings", async () => {
    expect((await channelOf({ item: { channel: "EMAIL" } })).allowed).toBe(true);
  });

  it("a form fill is not a reply: it rings as always", async () => {
    const { channel, arms } = await route(formTrigger);
    expect(channel).toEqual({ allowed: true, channel: null, occasion: "form" });
    expect(arms).toEqual(["request-reveal"]);
  });

  it("no rep phone on an email reply still stops the row no_sales_rep_phone; on WhatsApp the channel skip wins", async () => {
    expect((await route(emailReply, { salesRepPhone: null } as typeof rep)).arms).toEqual(["record-no-rep"]);
    expect((await route(waReply, { salesRepPhone: null } as typeof rep)).arms).toEqual(["record-not-email"]);
  });

  it("an occurrence naming someone else still leaves their row alone, whatever its channel", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { arms } = await route({ ...waReply, person: { email: "other@example.com" } });
    expect(arms).toEqual(["end-run-other-person"]);
  });

  it("nobody due takes no arm of check-call", () => {
    for (const c of [RING_EMAIL_ONLY, NO_REP_EMAIL_ONLY, NOT_BY_EMAIL]) expect(holds(c, { "claim-followup": { found: false } })).toBe(false);
  });

  it("its description states the rule plainly (a tactic is judged on it)", () => {
    expect(EMAIL_REPLIES_ONLY_DESCRIPTION.startsWith(AI_INSTANT_CALL_DESCRIPTION)).toBe(true);
    expect(EMAIL_REPLIES_ONLY_DESCRIPTION).toContain("Rings only on a positive reply received by email");
  });
});
