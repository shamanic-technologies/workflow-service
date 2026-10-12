import { describe, it, expect, vi, afterEach } from "vitest";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  AI_FOLLOW_UP_EMAIL_PIPE_ID,
  COMPOSE_EMAIL_PROMPT_CODE,
  EMAIL_RESPONSE_SCHEMA,
  FINALIZE_EMAIL_CODE,
  FOLLOW_UP_SENT_REASON,
  GATHER_CLIENT_FACTS_CODE,
  HAS_INSTRUCTION,
  INSTRUCTION_NOT_WRITABLE_REASON,
  NAME_MISSING_INSTRUCTION_CODE,
  buildAiFollowUpEmailDag,
} from "../../src/lib/ai-follow-up-email-dag.js";

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

  it("reads the instruction off /start-run at run time, and refuses to claim anyone without one", () => {
    expect(byId.get("compose-email")?.inputMapping?.instruction).toBe("$ref:start-run.output.instruction");
    const toClaim = dag.edges.find((e) => e.from === "check-instruction" && e.to === "claim-followup");
    expect(toClaim?.condition).toBe(HAS_INSTRUCTION);
    const none = dag.edges.find((e) => e.from === "check-instruction" && e.to === "name-missing-instruction");
    expect(descendants(dag, none!.to)).toEqual(new Set(["end-run-no-instruction"]));
    expect(byId.get("end-run-no-instruction")?.config?.body).toEqual({ success: false, stopCampaign: false });

    for (const instruction of [null, undefined, "", "   "]) {
      expect(holds(toClaim!.condition!, { "start-run": { instruction } })).toBe(false);
      expect(holds(none!.condition!, { "start-run": { instruction } })).toBe(true);
    }
    expect(holds(toClaim!.condition!, { "start-run": { instruction: "Tell Marie her cost" } })).toBe(true);
    expect(holds(none!.condition!, { "start-run": { instruction: "Tell Marie her cost" } })).toBe(false);
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
    });
    expect(dag.edges).toContainEqual({ from: "read-figures", to: "compose-email" });
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
    const out = await loadMain(COMPOSE_EMAIL_PROMPT_CODE)(
      "Give Marie her exact cost per booked meeting and compare it to the $42 estimate.",
      followup, leadDetail, offer, brand, facts, figures, "2026-10-11",
    );
    const message = out.message as string;
    expect(message).toContain("F1. Cost per booked meeting: $38.20 (source: /v1/offers/o-1/revenue)");
    expect(message).toContain("NOT READABLE: The estimate source could not be read.");
    expect(out.systemPrompt as string).toContain("FIGURES");
    expect(out.systemPrompt as string).toContain("never change its value");
    await expect(loadMain(COMPOSE_EMAIL_PROMPT_CODE)("x", followup, leadDetail, offer, brand, facts, {}, "2026-10-11"))
      .rejects.toThrow(/figures list/);
  });

  it("puts the instruction verbatim, the person, and the client's facts in front of the model", async () => {
    const out = await loadMain(COMPOSE_EMAIL_PROMPT_CODE)(
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

  it("refuses to compose without an instruction, an offer name or a brand name", async () => {
    const main = loadMain(COMPOSE_EMAIL_PROMPT_CODE);
    await expect(main("  ", followup, leadDetail, offer, brand, facts, noFigures, "2026-10-11")).rejects.toThrow(/instruction/);
    await expect(main("x", followup, leadDetail, {}, brand, facts, noFigures, "2026-10-11")).rejects.toThrow(/offer/);
    await expect(main("x", followup, leadDetail, offer, { brand: {} }, facts, noFigures, "2026-10-11")).rejects.toThrow(/brand/);
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
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await loadMain(NAME_MISSING_INSTRUCTION_CODE)("camp-1");
    expect(out).toEqual({ outcome: "no_instruction", campaignId: "camp-1" });
    expect(spy.mock.calls[0]?.[0]).toContain("camp-1");
  });
});
