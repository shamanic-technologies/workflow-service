import { describe, it, expect, vi, afterEach } from "vitest";
import { withWho } from "../helpers/who.js";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  AI_FOLLOW_UP_EMAIL_PIPE_ID,
  COMPOSE_EMAIL_PROMPT_CODE,
  EMAIL_RESPONSE_SCHEMA,
  FINALIZE_EMAIL_CODE,
  FOLLOW_UP_SENT_REASON,
  GATHER_CLIENT_FACTS_CODE,
  HAS_SOMETHING_TO_SAY,
  INSTRUCTION_NOT_WRITABLE_REASON,
  NAME_MISSING_INSTRUCTION_CODE,
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

  it("reads the instruction off /start-run at run time; claims nobody with neither an instruction nor an occurrence", async () => {
    expect(byId.get("compose-email")?.inputMapping?.instruction).toBe("$ref:start-run.output.instruction");
    expect(byId.get("occurrence")?.inputMapping).toEqual({ trigger: "$ref:flow_input.trigger", instruction: "$ref:start-run.output.instruction", reactive: "$ref:start-run.output.reactive" });
    const toClaim = dag.edges.find((e) => e.from === "check-instruction" && e.to === "claim-followup");
    expect(toClaim?.condition).toBe(HAS_SOMETHING_TO_SAY);
    const none = dag.edges.find((e) => e.from === "check-instruction" && e.to === "name-missing-instruction");
    expect(descendants(dag, none!.to)).toEqual(new Set(["end-run-no-instruction"]));
    // The scheduler's cadence run of a funnel unit (no trigger, no instruction) is idle, never a failure:
    // 7 failed runs on prod unit 30b1d192 backed it off and skipped a real occurrence (failure_backoff).
    expect(byId.get("end-run-no-instruction")?.config?.body).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });

    const plan = loadMain(OCCURRENCE_PLAN_CODE);
    const trigger = { eventId: "ev-1", triggerId: "signed_up_not_paid_30m", leadId: "l-1", item: null, person: { email: "Kevin@Distribute.you", name: "Kevin", phone: null, crmContact: null } };
    for (const instruction of [null, undefined, "", "   "]) {
      const results = { occurrence: await plan(undefined, instruction) };
      expect(holds(toClaim!.condition!, results)).toBe(false);
      expect(holds(none!.condition!, results)).toBe(true);
      // The fact alone is reason enough to write.
      const answering = { occurrence: await plan(trigger, instruction) };
      expect(holds(toClaim!.condition!, answering)).toBe(true);
      expect(holds(none!.condition!, answering)).toBe(false);
    }
    const instructed = { occurrence: await plan(null, "Tell Marie her cost") };
    expect(holds(toClaim!.condition!, instructed)).toBe(true);
    expect(holds(none!.condition!, instructed)).toBe(false);
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
    expect(dag.edges.filter((e) => e.to === "check-claim").map((e) => e.from)).toContain("start-run");
  });

  it("sends ONE email as a new thread through the broadcast send, keyed on the person's queue row", () => {
    const sends = dag.nodes.filter((n) => n.config?.service === "email-gateway");
    expect(sends.map((n) => n.id)).toEqual(["send-email"]);
    const send = byId.get("send-email")!;
    expect(send.config).toMatchObject({ method: "POST", path: "/orgs/send", body: { type: "broadcast" } });
    expect(send.inputMapping).toMatchObject({
      "body.to": "$ref:claim-followup.output.followup.email",
      "body.sequence": "$ref:finalize-email.output.sequence",
      "body.idempotencyKey": "$ref:finalize-email.output.idempotencyKey",
      "body.campaignId": "$ref:flow_input.campaignId",
    });
    expect(dag.nodes.some((n) => n.config?.path === "/orgs/replies")).toBe(false);
    expect(dag.nodes.some((n) => n.type === "for-each")).toBe(false);
  });

  it("marks the person handed strictly AFTER the send, so they are never written to twice", () => {
    expect(byId.get("record-sent")?.config?.body).toEqual({ kind: "handed", reason: FOLLOW_UP_SENT_REASON });
    expect(dag.edges).toContainEqual({ from: "send-email", to: "record-sent" });
    expect(descendants(dag, "record-sent").has("send-email")).toBe(false);
    const handed = dag.nodes.filter((n) => (n.config?.body as { kind?: string } | undefined)?.kind === "handed");
    expect(handed.map((n) => n.id)).toEqual(["record-sent"]);
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

  it("refuses to compose with neither an instruction nor an occurrence, or without an offer name or a brand name", async () => {
    const main = withWho(loadMain(COMPOSE_EMAIL_PROMPT_CODE), 10);
    await expect(main("  ", followup, leadDetail, offer, brand, facts, noFigures, "2026-10-11")).rejects.toThrow(/no instruction/);
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
  it("re-filing re-dues the SAME queue row, so the send key is identical, and the handed row is never claimed again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const main = loadMain(FINALIZE_EMAIL_CODE);
    const draft = { json: { decision: "write", subject: "s", bodyHtml: "<p>b</p>", reason: "r" } };
    const first = await main(draft, { followup: { id: "row-1", dueAt: "2026-10-14T10:00:00Z" } });
    const redelivered = await main(draft, { followup: { id: "row-1", dueAt: "2026-10-14T10:02:00Z" } });
    expect(redelivered.idempotencyKey).toBe(first.idempotencyKey);
    const dag = buildAiFollowUpEmailDag();
    expect(dag.edges).toContainEqual({ from: "send-email", to: "record-sent" });
    expect(dag.nodes.find((n) => n.id === "record-sent")?.config?.body).toEqual({ kind: "handed", reason: FOLLOW_UP_SENT_REASON });
  });
});

describe("finalizing the email", () => {
  const followup = { followup: { id: "row-1" } };
  const main = loadMain(FINALIZE_EMAIL_CODE);

  it("builds a one-step sequence and an idempotency key on the queue row, with every dash rewritten", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await main({ json: { decision: "write", subject: "Your cost — exact", bodyHtml: "<p>Hi Marie — it was $37 (Oct 1–7).</p>", reason: "r" } }, followup);
    expect(out).toEqual({
      decision: "write",
      subject: "Your cost, exact",
      sequence: [{ step: 1, bodyHtml: "<p>Hi Marie, it was $37 (Oct 1-7).</p>", daysSinceLastStep: 0 }],
      idempotencyKey: "ai-follow-up-email:row-1",
    });
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

  it("names a missing instruction in the log", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await loadMain(NAME_MISSING_INSTRUCTION_CODE)("camp-1");
    expect(out).toEqual({ outcome: "no_instruction", campaignId: "camp-1" });
    expect(spy.mock.calls[0]?.[0]).toContain("camp-1");
  });
});
