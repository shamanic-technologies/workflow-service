import { describe, it, expect, vi, afterEach } from "vitest";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  AI_INSTANT_CALL_PIPE_ID,
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
  buildAiInstantCallDag,
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
