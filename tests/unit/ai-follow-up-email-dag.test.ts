import { describe, it, expect, vi, afterEach } from "vitest";
import { withWho } from "../helpers/who.js";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  AI_FOLLOW_UP_EMAIL_PIPE_ID,
  COMPOSE_EMAIL_PROMPT_CODE,
  EMAIL_RESPONSE_SCHEMA,
  FINALIZE_EMAIL_CODE,
  DEFERRED,
  FOLLOW_UP_REFUSED_REASON,
  FOLLOW_UP_STOPPED_REASON,
  GATHER_CLIENT_FACTS_CODE,
  INSTRUCTION_NOT_WRITABLE_REASON,
  REFUSED,
  SENT,
  buildAiFollowUpEmailDag,
} from "../../src/lib/ai-follow-up-email-dag.js";
import { OCCURRENCE_PLAN_CODE } from "../../src/lib/occurrence-fact.js";

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, unknown>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, unknown>>;
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

/** Evaluates a DAG edge condition the way Windmill would, against node results keyed by node id. */
function holds(condition: string, results: Record<string, unknown>): boolean {
  return new Function("results", `return (${condition});`)(results) as boolean;
}

afterEach(() => vi.restoreAllMocks());

describe("ai-follow-up-email DAG", () => {
  const dag = buildAiFollowUpEmailDag();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));

  it("lives on the Signup -> Paid client pipe of its channel", () => {
    expect(AI_FOLLOW_UP_EMAIL_PIPE_ID).toBe("ai-follow-up-email|signup_to_paid_client");
  });

  it("is a valid DAG that translates to Windmill, every script exporting main", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    const flow = dagToOpenFlow(dag, "ai-follow-up-email-test");
    expect(flow.value.modules.length).toBeGreaterThan(0);
    for (const n of dag.nodes.filter((x) => x.type === "script")) {
      expect(n.config?.code).toContain("export async function main");
    }
  });

  it("emits all three conditions as top-level branchones (none nested, where they would silently do nothing)", () => {
    const flow = dagToOpenFlow(dag, "ai-follow-up-email-test");
    const top = flow.value.modules.filter((m: { value: { type: string } }) => m.value.type === "branchone");
    expect(top).toHaveLength(3);
  });

  it("reads the instruction off /start-run at run time; every run asks its own queue", async () => {
    expect(byId.get("compose-email")?.inputMapping?.instruction).toBe("$ref:start-run.output.instruction");
    expect(byId.get("occurrence")?.inputMapping).toEqual({ trigger: "$ref:flow_input.trigger", instruction: "$ref:start-run.output.instruction", reactive: "$ref:start-run.output.reactive" });
    // A person is due because an occurrence filed them, an instruction named them, or the date WE set is reached:
    // the queue is asked every run, and nobody due is idle (never a failure, which backs the unit off).
    expect(dag.edges).toContainEqual({ from: "trigger-type", to: "claim-followup" });
    expect(dag.nodes.some((n) => n.id === "check-instruction")).toBe(false);
  });

  it("reads the trigger type the run answers from features-service, and not at all when it answers none", async () => {
    expect(byId.get("trigger-type")?.config).toEqual({ service: "features", method: "GET", path: "/internal/catalogue/triggers/{id}" });
    expect(byId.get("trigger-type")?.inputMapping).toEqual({ "params.id": "$ref:occurrence.output.triggerId", skip: "$ref:occurrence.output.skipTriggerRead" });
    expect(byId.get("compose-email")?.inputMapping).toMatchObject({ occurrence: "$ref:occurrence.output", triggerType: "$ref:trigger-type.output" });
    expect(descendants(dag, "trigger-type").has("claim-followup")).toBe(true);
    const plan = loadMain(OCCURRENCE_PLAN_CODE);
    expect(await plan(undefined, "x")).toMatchObject({ answering: false, triggerId: null, skipTriggerRead: true, skipFigures: false });
    expect(await plan({ eventId: "ev-1", triggerId: "t-1", person: { email: " A@X.com ", phone: "+33 6 12" } }, null))
      .toMatchObject({ answering: true, eventId: "ev-1", triggerId: "t-1", skipTriggerRead: false, skipFigures: true, person: { email: "a@x.com", phone: "+33 6 12" } });
  });

  it("claims from THIS campaign's own queue, once, and never from a predecessor", () => {
    const claims = dag.nodes.filter((n) => String(n.config?.path ?? "").includes("claim-next"));
    expect(claims.map((n) => n.id)).toEqual(["claim-followup"]);
    expect(byId.get("claim-followup")?.inputMapping?.["params.campaignId"]).toBe("$ref:flow_input.campaignId");
    expect(JSON.stringify(dag)).not.toContain("predecessor");
  });

  it("a run that claims nobody ends idle and cannot reach the send", () => {
    const nobody = dag.edges.find((e) => e.from === "check-claim" && e.condition?.includes("== false"));
    expect(nobody?.to).toBe("end-run-nobody-due");
    expect(descendants(dag, nobody!.to).has("send-email")).toBe(false);
    expect(byId.get("end-run-nobody-due")?.config?.body).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
    for (const e of dag.edges.filter((x) => x.from === "check-claim")) {
      expect(e.condition).toContain("results['claim-followup']?.");
    }
  });

  it("sends ONE email as a reply in their last thread through the broadcast send, refusals read as outcomes", () => {
    const sends = dag.nodes.filter((n) => n.config?.service === "email-gateway");
    expect(sends.map((n) => n.id)).toEqual(["send-email"]);
    const send = byId.get("send-email")!;
    expect(send.config).toMatchObject({ method: "POST", path: "/orgs/send", body: { type: "broadcast", followUp: true } });
    expect(send.config?.skipOnRefusalCodes).toEqual(expect.arrayContaining(["lead_opted_out", "lead_not_a_prospect", "recent_brand_contact", "brand_sequence_queued"]));
    expect(send.inputMapping).toMatchObject({
      "body.to": "$ref:claim-followup.output.followup.email",
      "body.sequence": "$ref:finalize-email.output.sequence",
      "body.idempotencyKey": "$ref:finalize-email.output.idempotencyKey",
      "body.campaignId": "$ref:flow_input.campaignId",
    });
    expect(byId.get("finalize-email")?.inputMapping?.trigger).toBe("$ref:flow_input.trigger");
    expect(dag.nodes.some((n) => n.config?.path === "/orgs/replies")).toBe(false);
    expect(dag.nodes.some((n) => n.type === "for-each")).toBe(false);
  });

  // RIGHT-MOMENT-OR-LATER-1014: a client was emailed a second time about something the owner had already answered.
  it("records the next date strictly AFTER the send, never hands the person over (only their own words end it)", () => {
    expect(byId.get("record-sent")?.config?.body).toEqual({ kind: "acted" });
    expect(byId.get("record-sent")?.inputMapping?.["body.nextDueAt"]).toBe("$ref:finalize-email.output.nextFollowUpAt");
    expect(dag.edges).toContainEqual({ from: "send-email", to: "check-sent" });
    expect(dag.edges.find((e) => e.from === "check-sent" && e.to === "record-sent")?.condition).toBe(SENT);
    expect(descendants(dag, "record-sent").has("send-email")).toBe(false);
    expect(dag.nodes.some((n) => (n.config?.body as { kind?: string } | undefined)?.kind === "handed")).toBe(false);
    // check-sent converges, never nested in check-writable's branch.
    expect(dag.edges.filter((e) => e.to === "check-sent").map((e) => e.from)).toContain("claim-followup");
  });

  it("not the right moment sends nothing and makes the person due again at the model's later date", () => {
    const edge = dag.edges.find((e) => e.from === "check-writable" && e.to === "record-later");
    expect(edge?.condition).toContain("'later'");
    expect(descendants(dag, "record-later")).toEqual(new Set(["end-run-later"]));
    expect(byId.get("record-later")?.config?.body).toEqual({ kind: "scheduled" });
    expect(byId.get("record-later")?.inputMapping?.["body.dueAt"]).toBe("$ref:finalize-email.output.nextFollowUpAt");
    expect(byId.get("end-run-later")?.config?.body).toEqual({ success: true, stopCampaign: false });
  });

  it("a stop on the person's own words sends nothing and stops the row; an opt-out refusal stops it too", () => {
    const stop = dag.edges.find((e) => e.from === "check-writable" && e.to === "record-stopped");
    expect(stop?.condition).toContain("'stop'");
    expect(descendants(dag, "record-stopped").has("send-email")).toBe(false);
    expect(byId.get("record-stopped")?.config?.body).toEqual({ kind: "stopped", reason: FOLLOW_UP_STOPPED_REASON });
    expect(byId.get("record-refused")?.config?.body).toEqual({ kind: "stopped", reason: FOLLOW_UP_REFUSED_REASON });
    const write = { "finalize-email": { decision: "write" } };
    const sent = { ...write, "send-email": { ok: true } };
    const queued = { ...write, "send-email": { skipped: true, code: "brand_sequence_queued" } };
    const optedOut = { ...write, "send-email": { skipped: true, code: "lead_opted_out" } };
    expect([holds(SENT, sent), holds(DEFERRED, sent), holds(REFUSED, sent)]).toEqual([true, false, false]);
    expect([holds(SENT, queued), holds(DEFERRED, queued), holds(REFUSED, queued)]).toEqual([false, true, false]);
    expect([holds(SENT, optedOut), holds(DEFERRED, optedOut), holds(REFUSED, optedOut)]).toEqual([false, false, true]);
    // A Gmail thread whose Google grant lacks send access: nothing sent, the person keeps their date.
    const noGmailSend = { ...write, "send-email": { skipped: true, code: "google_send_permission_missing" } };
    expect([holds(SENT, noGmailSend), holds(DEFERRED, noGmailSend), holds(REFUSED, noGmailSend)]).toEqual([false, true, false]);
    // A passing refusal keeps the person followed up at the model's date.
    expect(byId.get("record-deferred")?.config?.body).toEqual({ kind: "scheduled" });
    // Nothing written: no arm fires.
    for (const c of [SENT, DEFERRED, REFUSED]) expect(holds(c, { "finalize-email": { decision: "later" } })).toBe(false);
  });

  it("reads the figures the instruction needs for the PERSON written to, before the email is composed", () => {
    const read = byId.get("read-figures");
    expect(read?.config).toEqual({ service: "workflow", method: "POST", path: "/orgs/figures/read" });
    expect(read?.retries).toBe(2);
    expect(read?.inputMapping).toEqual({
      "body.question": "$ref:start-run.output.instruction",
      "body.recipientEmail": "$ref:claim-followup.output.followup.email",
      skip: "$ref:occurrence.output.skipFigures",
    });
    expect(descendants(dag, "read-figures").has("compose-email")).toBe(true);
    expect(byId.get("compose-email")?.inputMapping?.figures).toBe("$ref:read-figures.output");
    expect(descendants(dag, "read-figures").has("send-email")).toBe(true);
  });

  it("an unwritable instruction sends nothing, releases the claim as stopped, and fails the run", () => {
    const edge = dag.edges.find((e) => e.from === "check-writable" && e.to === "release-unwritable");
    expect(edge?.condition).toContain("'cannot_write'");
    expect(descendants(dag, "release-unwritable")).toEqual(new Set(["end-run-unwritable"]));
    expect(byId.get("release-unwritable")?.config?.body).toEqual({ kind: "stopped", reason: INSTRUCTION_NOT_WRITABLE_REASON });
    expect(byId.get("end-run-unwritable")?.config?.body).toEqual({ success: false, stopCampaign: false });
    // check-writable converges (edge from outside check-claim's branch), never nested.
    expect(dag.edges.filter((e) => e.to === "check-writable").map((e) => e.from)).toContain("claim-followup");
  });

  it("writes through chat-service /complete on Opus with a strict schema, never Haiku", () => {
    const chat = dag.nodes.filter((n) => n.config?.service === "chat");
    expect(chat.map((n) => n.id)).toEqual(["draft-email"]);
    const body = chat[0].config?.body as Record<string, unknown>;
    expect(chat[0].config).toMatchObject({ method: "POST", path: "/complete" });
    expect(body).toMatchObject({ provider: "anthropic", model: "opus", responseFormat: "json" });
    expect(body.temperature).toBeUndefined();
    expect(EMAIL_RESPONSE_SCHEMA.additionalProperties).toBe(false);
    expect([...EMAIL_RESPONSE_SCHEMA.required].sort()).toEqual(Object.keys(EMAIL_RESPONSE_SCHEMA.properties).sort());
  });

  it("never calls the api gateway", () => {
    expect(dag.nodes.some((n) => n.config?.service === "api")).toBe(false);
  });
});

describe("composing the email", () => {
  const followup = { followup: { id: "row-1", leadId: "lead-1", email: "marie@example.com", brandId: "b-1" } };
  const leadDetail = { leadDetail: { lead: { firstName: "Marie", timezone: "Europe/Paris" } } };
  const offer = { name: "Revenue made easy" };
  const brand = { brand: { name: "distribute.you" } };
  const facts = { exact: [{ id: "E1", label: "pricing", value: "The platform is free" }], neverGive: ["discounts"] };

  const noFigures = { figures: [], missing: null };

  it("puts the figures read for the email in front of the model, and what could not be read", async () => {
    const figures = {
      figures: [{ label: "Cost per booked meeting", value: "$38.20", source: "/v1/offers/o-1/revenue" }],
      missing: "The estimate source could not be read.",
    };
    const out = await withWho(loadMain(COMPOSE_EMAIL_PROMPT_CODE), 10)(
      "Give Marie her exact cost per booked meeting and compare it to the $42 estimate.",
      followup, leadDetail, offer, brand, facts, figures, "2026-10-11",
    );
    const message = out.message as string;
    expect(message).toContain("F1. Cost per booked meeting: $38.20 (source: /v1/offers/o-1/revenue)");
    expect(message).toContain("NOT READABLE: The estimate source could not be read.");
    expect(out.systemPrompt as string).toContain("FIGURES");
    expect(out.systemPrompt as string).toContain("never change its value");
    await expect(withWho(loadMain(COMPOSE_EMAIL_PROMPT_CODE), 10)("x", followup, leadDetail, offer, brand, facts, {}, "2026-10-11"))
      .rejects.toThrow(/figures list/);
  });

  it("puts the instruction verbatim, the person, and the client's facts in front of the model", async () => {
    const out = await withWho(loadMain(COMPOSE_EMAIL_PROMPT_CODE), 10)(
      "Give Marie her exact cost per booked meeting: $37. Compare it to the $42 estimate.",
      followup, leadDetail, offer, brand, facts, noFigures, "2026-10-11",
    );
    const message = out.message as string;
    expect(message).toContain("Give Marie her exact cost per booked meeting: $37. Compare it to the $42 estimate.");
    expect(message).toContain("Name: Marie");
    expect(message).toContain("E1. pricing: The platform is free");
    expect(message).toContain("- discounts");
    const system = out.systemPrompt as string;
    expect(system).toContain("cannot_write");
    expect(system).toContain("Never invent a figure");
    // The prompt itself is dash-free: the model copies its style.
    expect(system + message).not.toMatch(/[–—]/);
  });

  it("tells the right-moment game and the next-date rule, dash-free", async () => {
    const out = await withWho(loadMain(COMPOSE_EMAIL_PROMPT_CODE), 10)("x", followup, leadDetail, offer, brand, facts, noFigures, "2026-10-11");
    const system = out.systemPrompt as string;
    expect(system).toContain("THE RIGHT MOMENT");
    expect(system).toContain("a person of our team writing by hand counts exactly like an automated email");
    expect(system).toContain("set decision to later");
    expect(system).toContain("THE NEXT DATE");
    expect(system).toContain("reply in the thread they wrote in last");
    expect(system).toContain("us having already answered them, is never a reason to stop");
    expect(system + (out.message as string)).not.toMatch(/[–—]/);
  });

  it("with neither an instruction nor an occurrence, writes from the date we set; refuses without an offer or a brand name", async () => {
    const main = withWho(loadMain(COMPOSE_EMAIL_PROMPT_CODE), 10);
    const due = await main("  ", followup, leadDetail, offer, brand, facts, { notCalled: true }, "2026-10-11");
    expect(due.message as string).toContain("The follow-up date we set at our last look at this person is reached.");
    await expect(main("x", followup, leadDetail, {}, brand, facts, noFigures, "2026-10-11")).rejects.toThrow(/offer/);
    await expect(main("x", followup, leadDetail, offer, { brand: {} }, facts, noFigures, "2026-10-11")).rejects.toThrow(/brand/);
  });
});

describe("composing the email for a trigger occurrence, with no instruction", () => {
  const person = { email: "kevin@distribute.you", name: "Kevin", phone: null, crmContact: null };
  const trigger = { eventId: "ev-1", triggerId: "signed_up_not_paid_30m", leadId: "l-1", item: null, person };
  const followup = { followup: { id: "row-1", leadId: "l-1", email: "Kevin@distribute.you", brandId: "b-1" } };
  const leadDetail = { leadDetail: { lead: { firstName: "Kevin" } } };
  const offer = { name: "Revenue made easy" };
  const brand = { brand: { name: "distribute.you" } };
  const facts = { exact: [{ id: "E1", label: "pricing", value: "The platform is free" }], neverGive: [] };
  const triggerType = {
    object: "trigger", id: "signed_up_not_paid_30m", name: "Signup Not Paid", line: "Signed up, still not a paid client 30 minutes later.",
    fromStep: "signup", fromStepName: "Signup", kind: "delay", params: { afterStep: "signup", minutes: 30, unlessStep: "paid_client" },
  };
  const compose = withWho(loadMain(COMPOSE_EMAIL_PROMPT_CODE), 10);

  it("writes from the fact and the person's state: why we write now, their thread and events, what the brand sells", async () => {
    const occurrence = await loadMain(OCCURRENCE_PLAN_CODE)(trigger, null);
    const who = { state: "possibly_known", lines: ["Never judged."], threadLines: [], olderMessagesOmitted: 0, eventLines: ["2026-10-14 09:00 | web | EVENT: signup (clerk)"], strategy: "STRATEGY" };
    const out = await withWho(loadMain(COMPOSE_EMAIL_PROMPT_CODE), 10, who)(
      null, followup, leadDetail, offer, brand, facts, { ok: false, skipped: true, notCalled: true }, "2026-10-14", occurrence, triggerType,
    );
    const message = out.message as string;
    const system = out.systemPrompt as string;
    expect(message).toContain("INSTRUCTION:\n(none: write from WHY WE WRITE NOW and where this person stands)");
    expect(message).toContain("WHY WE WRITE NOW:\nTrigger: Signup Not Paid: Signed up, still not a paid client 30 minutes later.");
    expect(message).toContain("It starts when the person reaches: Signup");
    expect(message).toContain("Its settings: afterStep = signup, minutes = 30, unlessStep = paid_client");
    expect(message).toContain("It fired for THIS person just now");
    expect(message).toContain("EVENT: signup (clerk)");
    expect(message).toContain("WHO WE ARE: distribute.you, offer \"Revenue made easy\".");
    expect(message).toContain("FIGURES read for this email (from their own account, or public):\n(none)");
    expect(system).toContain("There is no INSTRUCTION");
    expect(system).toContain("Make the next step easy");
    expect(system).toContain("Never say we watched, tracked or noticed them");
    expect(system + message).not.toMatch(/[–—]/);
  });

  it("an instruction still leads when the campaign carries one, beside the fact", async () => {
    const occurrence = await loadMain(OCCURRENCE_PLAN_CODE)(trigger, "Offer a 15 minute setup call.");
    const out = await compose("Offer a 15 minute setup call.", followup, leadDetail, offer, brand, facts, { figures: [], missing: null }, "2026-10-14", occurrence, triggerType);
    expect(out.systemPrompt as string).toContain("You follow the INSTRUCTION below");
    expect(out.message as string).toContain("Offer a 15 minute setup call.");
    expect(out.message as string).toContain("WHY WE WRITE NOW:");
  });

  it("a person the occurrence does not name is still owed the campaign's fact, never told it fired for them", async () => {
    const occurrence = await loadMain(OCCURRENCE_PLAN_CODE)({ ...trigger, person: { email: "someone@else.com" } }, null);
    const out = await compose(null, followup, leadDetail, offer, brand, facts, { ok: false, skipped: true, notCalled: true }, "2026-10-14", occurrence, triggerType);
    expect(out.message as string).toContain("This person is owed a message because of this same trigger.");
    expect(out.message as string).not.toContain("fired for THIS person");
  });

  it("never writes blind when the trigger type could not be read", async () => {
    const occurrence = await loadMain(OCCURRENCE_PLAN_CODE)(trigger, null);
    await expect(compose(null, followup, leadDetail, offer, brand, facts, { notCalled: true }, "2026-10-14", occurrence, { ok: false, skipped: true, notCalled: true }))
      .rejects.toThrow(/was not read/);
  });
});

describe("a redelivered occurrence sends nothing more", () => {
  it("re-filing re-dues the SAME queue row for the SAME event: the send key names the event, so it is identical", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const main = loadMain(FINALIZE_EMAIL_CODE);
    const draft = { json: { decision: "write", subject: "s", bodyHtml: "<p>b</p>", nextFollowUpAt: "2099-01-01T09:00:00Z", reason: "r" } };
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2098-06-01T00:00:00Z"));
    const trigger = { eventId: "ev-9", person: { email: "Marie@x.com" } };
    const first = await main(draft, { followup: { id: "row-1", email: "marie@x.com", dueAt: "2026-10-14T10:00:00Z" } }, trigger);
    const redelivered = await main(draft, { followup: { id: "row-1", email: "marie@x.com", dueAt: "2026-10-14T10:02:00Z" } }, trigger);
    expect(first.idempotencyKey).toBe("ai-follow-up-email:event:ev-9");
    expect(redelivered.idempotencyKey).toBe(first.idempotencyKey);
    // The NEXT follow-up of the same person (our own date, no occurrence) is its own send.
    const next = await main(draft, { followup: { id: "row-1", email: "marie@x.com", dueAt: "2026-11-02T09:00:00Z" } }, null);
    expect(next.idempotencyKey).toBe("ai-follow-up-email:row-1:2026-11-02T09:00:00Z");
  });
});

describe("finalizing the email", () => {
  const followup = { followup: { id: "row-1" } };
  const inTenDays = new Date(Date.now() + 10 * 86400000).toISOString();
  const main = loadMain(FINALIZE_EMAIL_CODE);

  it("builds a one-step sequence, a key on the row, the next date, with every dash rewritten", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await main({ json: { decision: "write", subject: "Your cost — exact", bodyHtml: "<p>Hi Marie — it was $37 (Oct 1–7).</p>", nextFollowUpAt: inTenDays, nextFollowUpWhy: "w", reason: "r" } }, { followup: { id: "row-1", dueAt: "d" } }, null);
    expect(out).toEqual({
      decision: "write",
      subject: "Your cost, exact",
      sequence: [{ step: 1, bodyHtml: "<p>Hi Marie, it was $37 (Oct 1-7).</p>", daysSinceLastStep: 0 }],
      idempotencyKey: "ai-follow-up-email:row-1:d",
      nextFollowUpAt: inTenDays,
      nextFollowUpWhy: "w",
    });
  });

  it("later sends nothing and keeps the model's date; stop passes the person's words through", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const later = await main({ json: { decision: "later", subject: "", bodyHtml: "", nextFollowUpAt: inTenDays, nextFollowUpWhy: "we just answered", reason: "already answered" } }, followup);
    expect(later).toEqual({ decision: "later", nextFollowUpAt: inTenDays, nextFollowUpWhy: "we just answered", reason: "already answered" });
    expect(later.sequence).toBeUndefined();
    const stop = await main({ json: { decision: "stop", subject: "", bodyHtml: "", nextFollowUpAt: "", nextFollowUpWhy: "", reason: "\"please remove me\"" } }, followup);
    expect(stop).toEqual({ decision: "stop", reason: "\"please remove me\"" });
  });

  it("throws before anything is sent or recorded on a next date missing, past, or over a year out", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const body = { subject: "s", bodyHtml: "<p>b</p>" };
    for (const decision of ["write", "later"]) {
      await expect(main({ json: { decision, ...body, nextFollowUpAt: "" } }, followup)).rejects.toThrow(/not a date/);
      await expect(main({ json: { decision, ...body, nextFollowUpAt: "2001-01-01T00:00:00Z" } }, followup)).rejects.toThrow(/not in the future/);
      const far = new Date(Date.now() + 400 * 86400000).toISOString();
      await expect(main({ json: { decision, ...body, nextFollowUpAt: far } }, followup)).rejects.toThrow(/365 days/);
    }
  });

  it("passes cannot_write through without a sequence", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await main({ json: { decision: "cannot_write", subject: "", bodyHtml: "", reason: "no exact figure" } }, followup);
    expect(out).toEqual({ decision: "cannot_write", reason: "no exact figure" });
  });

  it("throws on a write with an empty body, and on an unknown decision", async () => {
    await expect(main({ json: { decision: "write", subject: "s", bodyHtml: " " } }, followup)).rejects.toThrow(/empty/);
    await expect(main({ json: { decision: "maybe" } }, followup)).rejects.toThrow(/unknown decision/);
  });
});

describe("the client's facts", () => {
  it("reuse ai-meeting-booking's gathering with no question list", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const main = loadMain(GATHER_CLIENT_FACTS_CODE);
    const out = await main(
      { answers: [{ question: "Price?", answer: "Free" }] },
      { fields: {} },
      { fields: { tone: { value: "plain", provenance: "confirmed" }, site: { value: "x", provenance: "suggested" } } },
    );
    expect(out.questions).toEqual([]);
    expect((out.exact as Array<{ label: string }>).map((f) => f.label)).toEqual(["Price?", "tone"]);
  });

  // Regression (staff probe 2026-10-11, run 8c45b238): distribute.you sells 4 offers, so the brand-scoped
  // user-fields read 409s SEVERAL_OFFERS by design and every run died on the error branch.
  it("reads a SEVERAL_OFFERS refusal of the brand-scoped read as no brand-level fields", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const main = loadMain(GATHER_CLIENT_FACTS_CODE);
    const out = await main(
      { answers: [] },
      { fields: { urgency: { value: "Starts this week", provenance: "confirmed" } } },
      { ok: false, status: 409, error: '{"code":"SEVERAL_OFFERS"}' },
    );
    expect((out.exact as Array<{ label: string }>).map((f) => f.label)).toEqual(["urgency"]);
    const node = buildAiFollowUpEmailDag().nodes.find((n) => n.id === "brand-user-fields");
    expect(node?.config?.tolerateFailure).toBe(true);
  });

  it("still fails loud on any other failure of the brand-scoped read", async () => {
    const main = loadMain(GATHER_CLIENT_FACTS_CODE);
    await expect(main({ answers: [] }, { fields: {} }, { ok: false, status: 500, error: "boom" })).rejects.toThrow(/500/);
    await expect(main({ answers: [] }, { fields: {} }, { ok: false, status: 409, error: "other" })).rejects.toThrow(/409/);
  });
});
