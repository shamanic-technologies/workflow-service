import { describe, it, expect, vi, afterEach } from "vitest";
import { LEG_BEST_LLM_MODEL_REF, LEG_BEST_LLM_PROVIDER_REF } from "../../src/lib/leg-best-writer.js";
import { withWho } from "../helpers/who.js";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  ANSWER_RESPONSE_SCHEMA,
  COMPOSE_ANSWER_PROMPT_CODE,
  FINALIZE_ANSWER_CODE,
  FORM_ANSWERED_REASON,
  FORM_EMAIL_REFUSED_REASON,
  FORM_MEETING_BOOKING_PIPE_ID,
  FORM_NO_REPLY_OWED_REASON,
  REFUSED,
  RESOLVE_FORM_CODE,
  SENT,
  buildFormMeetingBookingDag,
} from "../../src/lib/form-meeting-booking-dag.js";

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

function holds(condition: string, results: Record<string, unknown>): boolean {
  return new Function("results", `return (${condition});`)(results) as boolean;
}

afterEach(() => vi.restoreAllMocks());

const claim = { found: true, followup: { id: "row-1", leadId: "lead-1", email: "Jo@Example.com", brandId: "b-1", dueAt: "2026-10-12T15:00:00.000Z" } };
const trigger = {
  eventId: "ev-1",
  triggerId: "form_submitted",
  leadId: "lead-1",
  person: { name: "Jo Smith", email: "jo@example.com", phone: "+15550001111", crmContact: { provider: "gohighlevel", contactId: "c-1" } },
  item: {
    source: "gohighlevel",
    submissionId: "s-1",
    formId: "f-1",
    formName: "Private dinner request",
    submittedAt: "2026-10-12T14:58:00.000Z",
    answers: [
      { key: "guests", label: "How many guests?", value: 12 },
      { key: "date", label: "Preferred date", value: "Late November" },
      { key: "diet", label: "Dietary needs", value: ["vegetarian", "gluten free"] },
    ],
    crmContactId: "c-1",
  },
};

describe("form -> meeting booked DAG", () => {
  const dag = buildFormMeetingBookingDag();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));

  it("lives on the Form submitted -> Meeting booked pipe of the AI meeting booking channel", () => {
    expect(FORM_MEETING_BOOKING_PIPE_ID).toBe("ai-meeting-booking|form_submitted_to_meeting_booked");
  });

  it("is a valid DAG that translates to Windmill, every script exporting main", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    const flow = dagToOpenFlow(dag, "form-meeting-booking-test");
    expect(flow.value.modules.length).toBeGreaterThan(0);
    for (const n of dag.nodes.filter((x) => x.type === "script")) {
      expect(n.config?.code).toContain("export async function main");
    }
  });

  it("emits all three conditions as top-level branchones (none nested, where they would silently do nothing)", () => {
    const flow = dagToOpenFlow(dag, "form-meeting-booking-test");
    const top = flow.value.modules.filter((m: { value: { type: string } }) => m.value.type === "branchone");
    expect(top).toHaveLength(3);
    for (const id of ["check-decision", "check-sent"]) {
      expect(dag.edges.filter((e) => e.to === id).map((e) => e.from)).toContain("claim-followup");
    }
  });

  it("claims from THIS campaign's own queue, once; nobody due ends idle and cannot reach a send", () => {
    const claims = dag.nodes.filter((n) => String(n.config?.path ?? "").includes("claim-next"));
    expect(claims.map((n) => n.id)).toEqual(["claim-followup"]);
    const nobody = dag.edges.find((e) => e.from === "check-claim" && e.to === "end-run-nobody-due");
    expect(holds(nobody!.condition!, { "claim-followup": { found: false } })).toBe(true);
    expect(descendants(dag, "end-run-nobody-due").size).toBe(0);
    expect(byId.get("end-run-nobody-due")?.config?.body).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
  });

  it("reads the form off the trigger campaign-service dispatches", () => {
    expect(byId.get("resolve-form")?.inputMapping?.trigger).toBe("$ref:flow_input.trigger");
  });

  it("sends the email as a new thread keyed on the queue row, then records it, then WhatsApp", () => {
    const send = byId.get("send-email")!;
    expect(send.config).toMatchObject({ method: "POST", path: "/orgs/send", body: { type: "broadcast" } });
    // "*": any code the sender names on a 409 is a refusal no retry changes (PUSHED-TRUTH-1015).
    expect(send.config?.skipOnRefusalCodes).toEqual(["recent_brand_contact", "lead_opted_out", "*"]);
    expect(send.inputMapping).toMatchObject({
      "body.to": "$ref:resolve-form.output.email",
      "body.idempotencyKey": "$ref:finalize-answer.output.idempotencyKey",
    });
    expect(dag.edges).toContainEqual({ from: "check-sent", to: "record-answered", condition: SENT });
    expect(dag.edges).toContainEqual({ from: "record-answered", to: "send-whatsapp" });
    expect(byId.get("record-answered")?.config?.body).toEqual({ kind: "stopped", reason: FORM_ANSWERED_REASON });
    const wa = byId.get("send-whatsapp")!;
    expect(wa.config).toMatchObject({ service: "crm", method: "POST", path: "/orgs/whatsapp/messages" });
    expect(wa.config?.skipOnRefusalCodes).toEqual(expect.arrayContaining(["whatsapp_not_linked", "no_phone_known", "not_on_whatsapp"]));
    // Never handed: the same person filling a form again is answered again.
    expect(dag.nodes.some((n) => (n.config?.body as { kind?: string } | undefined)?.kind === "handed")).toBe(false);
  });

  it("an email the gateway refuses sends nothing anywhere and stops the row with that reason", () => {
    expect(dag.edges).toContainEqual({ from: "check-sent", to: "record-refused", condition: REFUSED });
    expect(descendants(dag, "record-refused")).toEqual(new Set(["end-run-refused"]));
    expect(byId.get("record-refused")?.config?.body).toEqual({ kind: "stopped", reason: FORM_EMAIL_REFUSED_REASON });
    // The occurrence's truth on /end-run (PUSHED-TRUTH-1015): refused verbatim off the send, delivered once answered.
    expect(byId.get("end-run-refused")?.inputMapping).toEqual({ "body.delivery": "$ref:send-email.output.delivery" });
    expect(byId.get("end-run-refused")?.config?.body).toEqual({ success: true, stopCampaign: false });
    expect(byId.get("end-run")?.config?.body).toEqual({ success: true, stopCampaign: false, delivery: { state: "delivered" } });
    expect(byId.get("end-run-error")?.config?.body).toEqual({ success: false, stopCampaign: false });
    const answer = { "finalize-answer": { decision: "answer" } };
    expect(holds(SENT, { ...answer, "send-email": { success: true } })).toBe(true);
    expect(holds(REFUSED, { ...answer, "send-email": { success: true } })).toBe(false);
    expect(holds(SENT, { ...answer, "send-email": { ok: false, skipped: true, code: "lead_opted_out" } })).toBe(false);
    expect(holds(REFUSED, { ...answer, "send-email": { ok: false, skipped: true, code: "lead_opted_out" } })).toBe(true);
    // On the no-reply path the send never ran: neither arm.
    for (const c of [SENT, REFUSED]) expect(holds(c, { "finalize-answer": { decision: "no_reply_owed" } })).toBe(false);
    for (const c of [SENT, REFUSED]) expect(holds(c, {})).toBe(false);
  });

  it("no reply owed sends nothing and stops the row", () => {
    expect(descendants(dag, "record-no-reply")).toEqual(new Set(["end-run-no-reply"]));
    expect(byId.get("record-no-reply")?.config?.body).toEqual({ kind: "stopped", reason: FORM_NO_REPLY_OWED_REASON });
  });

  it("writes through chat-service /complete on Opus with a strict schema", () => {
    const chat = dag.nodes.filter((n) => n.config?.service === "chat" && n.config?.path === "/complete");
    expect(chat.map((n) => n.id)).toEqual(["draft-answer"]);
    // BEST-TPL-LLM-1022: the writer states no LLM; each run writes with the leg's best (features-service).
    expect(chat[0].config?.body).toMatchObject({ responseFormat: "json" });
    expect(chat[0].config?.body).not.toHaveProperty("model");
    expect(chat[0].inputMapping).toMatchObject({ "body.model": LEG_BEST_LLM_MODEL_REF, "body.provider": LEG_BEST_LLM_PROVIDER_REF });
    expect(ANSWER_RESPONSE_SCHEMA.additionalProperties).toBe(false);
    expect([...ANSWER_RESPONSE_SCHEMA.required].sort()).toEqual(Object.keys(ANSWER_RESPONSE_SCHEMA.properties).sort());
  });
});

describe("resolving the form", () => {
  const main = loadMain(RESOLVE_FORM_CODE);

  it("takes the form from the trigger when it names the claimed person (case-folded)", async () => {
    const out = await main(claim, trigger, { leadDetail: { lead: {} } });
    expect(out).toMatchObject({ rowId: "row-1", email: "Jo@Example.com", fullName: "Jo Smith", firstName: "Jo", eventId: "ev-1" });
    expect((out.form as { formName: string }).formName).toBe("Private dinner request");
    expect((out.form as { answers: unknown[] }).answers).toHaveLength(3);
  });

  it("never writes from another person's form, and says so", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const other = { ...trigger, person: { ...trigger.person, email: "someone@else.com" } };
    const out = await main(claim, other, { leadDetail: { lead: { firstName: "Jo", lastName: "S" } } });
    expect(out.form).toBeNull();
    expect(out.eventId).toBeNull();
    expect(out.fullName).toBe("Jo S");
    expect(spy.mock.calls[0]?.[0]).toContain("without their form answers");
    const none = await main(claim, "", { leadDetail: { lead: {} } });
    expect(none.form).toBeNull();
  });

  it("throws on a claim with no row", async () => {
    await expect(main({ found: true, followup: {} }, trigger, null)).rejects.toThrow(/no id or email/);
  });
});

describe("composing the answer", () => {
  const offer = { name: "Private dinners", bookingUrl: "https://cal.example.com/doc" };
  const brand = { brand: { name: "Doc Dinners" } };
  const rep = { salesRepFirstName: "Joe" };
  const facts = { exact: [{ id: "E1", label: "Group size", value: "8 to 40 guests" }], neverGive: ["discounts"] };

  it("puts the form, the booking link and the client's facts in front of the model, dash-free", async () => {
    const person = await loadMain(RESOLVE_FORM_CODE)(claim, trigger, { leadDetail: { lead: {} } });
    const out = await withWho(loadMain(COMPOSE_ANSWER_PROMPT_CODE), 6)(person, offer, brand, rep, facts, "2026-10-12");
    const message = out.message as string;
    const system = out.systemPrompt as string;
    expect(message).toContain("THEIR FORM (\"Private dinner request\")");
    expect(message).toContain("- How many guests?: 12");
    expect(message).toContain("- Dietary needs: vegetarian, gluten free");
    expect(message).toContain("E1. Group size: 8 to 40 guests");
    expect(system).toContain("https://cal.example.com/doc");
    expect(system).toContain("THE GAME");
    // FORM-ANSWER-NOBODY-DUE-1014: the answer opens on what the person did, so they link it to their form.
    expect(system).toContain("OPEN WITH WHAT THEY DID");
    expect(system).toContain("answers the form they just filled in to reach");
    expect(system).toContain("The WhatsApp text opens the same way.");
    expect(system).toContain("A name that differs from the email address, or a request outside the offer, is NOT a reason");
    expect(system).toContain("End it with Joe");
    expect(system).not.toMatch(/agency(?! or a third party)/i);
    expect(system + message).not.toMatch(/[–—]/);
  });

  it("with no booking link, asks them to reply with a time", async () => {
    const out = await withWho(loadMain(COMPOSE_ANSWER_PROMPT_CODE), 6)(
      { email: "jo@example.com", form: null }, { name: "Private dinners", bookingUrl: null }, brand, {}, facts, "2026-10-12",
    );
    expect(out.systemPrompt as string).toContain("There is no booking link");
    expect(out.message as string).toContain("their answers are not available to us");
  });

  it("refuses to compose without an offer name or a brand name", async () => {
    const main = withWho(loadMain(COMPOSE_ANSWER_PROMPT_CODE), 6);
    await expect(main({ email: "a@b.c" }, {}, brand, rep, facts, "d")).rejects.toThrow(/offer/);
    await expect(main({ email: "a@b.c" }, offer, { brand: {} }, rep, facts, "d")).rejects.toThrow(/brand/);
  });
});

describe("finalizing the answer", () => {
  const main = loadMain(FINALIZE_ANSWER_CODE);
  const person = { rowId: "row-1", email: "jo@example.com", dueAt: "2026-10-12T15:00:00.000Z" };

  it("builds a one-step sequence, the WhatsApp text, and keys naming the row and its due date, dashes rewritten", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await main({ json: { decision: "answer", subject: "Your dinner — 12 guests", bodyHtml: "<p>Hi Jo — yes, Nov 20–22 works.</p>", whatsappText: "Hi Jo — book here", reason: "r" } }, person);
    expect(out).toEqual({
      decision: "answer",
      subject: "Your dinner, 12 guests",
      sequence: [{ step: 1, bodyHtml: "<p>Hi Jo, yes, Nov 20-22 works.</p>", daysSinceLastStep: 0 }],
      whatsappText: "Hi Jo, book here",
      idempotencyKey: "form-meeting-booking:row-1:2026-10-12T15:00:00.000Z",
      whatsappIdempotencyKey: "form-meeting-booking:row-1:2026-10-12T15:00:00.000Z:whatsapp",
    });
  });

  it("keys both sends on the OCCURRENCE when the run's trigger names the claimed person: a redelivery re-dues the row, the key holds", async () => {
    const draft = { json: { decision: "answer", subject: "s", bodyHtml: "<p>x</p>", whatsappText: "x", reason: "r" } };
    const first = await main(draft, { ...person, eventId: "evt-1" });
    // campaign-service redelivers the same occurrence after a run that sent then failed: same eventId, NEW due date.
    const redelivered = await main(draft, { ...person, eventId: "evt-1", dueAt: "2026-10-12T15:02:00.000Z" });
    expect(first.idempotencyKey).toBe("form-meeting-booking:event:evt-1");
    expect(first.whatsappIdempotencyKey).toBe("form-meeting-booking:event:evt-1:whatsapp");
    expect(redelivered.idempotencyKey).toBe(first.idempotencyKey);
    expect(redelivered.whatsappIdempotencyKey).toBe(first.whatsappIdempotencyKey);
    // A new form fill by the same person is a new occurrence: answered.
    const next = await main(draft, { ...person, eventId: "evt-2" });
    expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(next.whatsappIdempotencyKey).not.toBe(first.whatsappIdempotencyKey);
  });

  it("passes no_reply_owed through; throws on an empty answer or an unknown decision", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main({ json: { decision: "no_reply_owed", reason: "test entry" } }, person)).toEqual({ decision: "no_reply_owed", reason: "test entry" });
    await expect(main({ json: { decision: "answer", subject: "s", bodyHtml: "<p>x</p>", whatsappText: " " } }, person)).rejects.toThrow(/empty/);
    await expect(main({ json: { decision: "maybe" } }, person)).rejects.toThrow(/unknown decision/);
  });
});
