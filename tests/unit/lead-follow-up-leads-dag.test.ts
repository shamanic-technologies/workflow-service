import { describe, it, expect } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import { descriptionProblem } from "../../src/lib/plain-description.js";
import { FOLLOW_UP_END_KINDS, buildFollowUpReactiveDag, READ_STATE_CODE, COMPOSE_FOLLOW_UP_CODE, LEAD_FOLLOW_UP_GAME, composeFollowUpCode } from "../../scripts/engine-ports/follow-up-steps.js";
import { buildClientCheckInDag, isClientCheckInDag } from "../../scripts/engine-ports/client-check-in-steps.js";
import {
  FOLLOW_UP_REACTIVE_LEADS_DESCRIPTION,
  LEADS_ONLY_LEG_KEYS,
  LEADS_ONLY_POLICY,
  RESOLVE_LEAD_CODE,
  buildLeadFollowUpLeadsOnlyDag,
  isLeadsOnlyFollowUpDag,
} from "../../scripts/engine-ports/lead-follow-up-leads-steps.js";
import { COPILOT_TURN_PLAN_CODE, isCopilotTurn } from "../../src/lib/copilot-turn-node.js";

/**
 * LEAD-EVENT-LEADS-ONLY-1024 (owner 2026-10-24): the Lead event pipe's lead follow-up answers LEADS only (never a
 * current client, a personal contact, the brand's team or staff); its clients have their own check-in dynasty.
 */
function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

const node = (dag: ReturnType<typeof buildLeadFollowUpLeadsOnlyDag>, id: string) => dag.nodes.find((n) => n.id === id);

describe("the leads-only lead follow-up DAG", () => {
  const dag = buildLeadFollowUpLeadsOnlyDag({ readFigures: false });
  const plain = buildFollowUpReactiveDag({ readFigures: false });

  it("is valid, converts, and has an end-run per end kind, its two claim ends included", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    expect(() => dagToOpenFlow(dag, "lead-follow-up-leads")).not.toThrow();
    for (const kind of [...FOLLOW_UP_END_KINDS, "not_admitted", "pending", "idle", "unclaimed", "other_person"]) {
      const id = `end-run-${kind.replace(/_/g, "-")}`;
      expect(dag.nodes.some((n) => n.id === id)).toBe(true);
    }
    expect(node(dag, "end-run-not-admitted")?.inputMapping).toEqual({ "body.personNotAdmitted": "$ref:resolve-person.output.notAdmitted" });
    expect(node(dag, "end-run-pending")?.config).toMatchObject({ body: { noWorkAvailable: true } });
  });

  it("states leads only as a LITERAL on the claim (the tactic Answers leads only reads it)", () => {
    expect(LEADS_ONLY_POLICY).toBe("pure_prospect");
    expect(node(dag, "claim-followup")?.config).toMatchObject({ body: { relationships: "pure_prospect" } });
    expect(isLeadsOnlyFollowUpDag(dag)).toBe(true);
    expect(isLeadsOnlyFollowUpDag(plain)).toBe(false);
    expect(isLeadsOnlyFollowUpDag(buildClientCheckInDag())).toBe(false);
    expect(isClientCheckInDag(dag)).toBe(false);
  });

  it("only the claim, its read and the writer differ from the lead follow-up: same state read, same game", () => {
    expect(node(dag, "read-state")?.config).toEqual({ code: READ_STATE_CODE });
    // The same game, plus what the occurrence carries (a booked meeting's time, MEETING-REMINDER-1103).
    expect(node(dag, "compose")?.config).toEqual({ code: composeFollowUpCode({ ...LEAD_FOLLOW_UP_GAME, occurrenceItem: true }) });
    expect(node(plain, "compose")?.config).toEqual({ code: COMPOSE_FOLLOW_UP_CODE });
    const differing = dag.nodes.filter((n) => JSON.stringify(n) !== JSON.stringify(plain.nodes.find((p) => p.id === n.id))).map((n) => n.id);
    expect(differing.sort()).toEqual(["claim-followup", "compose", "copilot-turn-plan", "draft", "end-run-not-admitted", "end-run-pending", "resolve-person"].sort());
  });

  it("writes through the COPILOT: one AI, its own model and voice, the composed prompt as context (ONE-AI-CONVERSES-1029)", () => {
    const draft = node(dag, "draft");
    expect(draft?.config).toMatchObject({ service: "chat", method: "POST", path: "/internal/copilot/lead-turns" });
    expect(isCopilotTurn(dag, "draft")).toBe(true);
    expect(isCopilotTurn(plain, "draft")).toBe(false);
    const body = draft?.config?.body as Record<string, unknown>;
    for (const k of ["provider", "model", "responseFormat", "temperature", "maxTokens"]) expect(body).not.toHaveProperty(k);
    expect(body.responseSchema).toBeTruthy();
    expect(draft?.inputMapping).toEqual({
      "body.message": "$ref:compose.output.message",
      "body.systemPrompt": "$ref:compose.output.systemPrompt",
      skip: "$ref:compose.output.skip",
      "body.brandId": "$ref:resolve-person.output.brandId",
      "body.medium": "$ref:copilot-turn-plan.output.medium",
      "body.recipient": "$ref:copilot-turn-plan.output.recipient",
      "body.assistant": "$ref:copilot-turn-plan.output.assistant",
      "body.messageField": "$ref:copilot-turn-plan.output.messageField",
      "body.idempotencyKey": "$ref:copilot-turn-plan.output.idempotencyKey",
      "body.occurrenceItem": "$ref:copilot-turn-plan.output.occurrenceItem",
    });
    // The plan reads the run's trigger: the occurrence's own crm record reaches the Copilot (SOPHIE-WA-HUMAN-1106).
    expect(node(dag, "copilot-turn-plan")?.inputMapping).toMatchObject({ trigger: "$ref:flow_input.trigger" });
    // No second brain left on the call: no leg LLM pick, no spliced voice (the Copilot reads the skill itself).
    for (const id of ["llm-pick", "llm-plan", "read-client-comms", "client-comms-voice"]) expect(node(dag, id)).toBeUndefined();
    expect(dag.edges).toEqual(expect.arrayContaining([{ from: "compose", to: "copilot-turn-plan" }, { from: "copilot-turn-plan", to: "draft" }]));
    expect(dag.edges.filter((e) => e.to === "draft")).toHaveLength(1);
  });

  it("states the medium, the person, the sending line's persona, the text field and one key per occurrence", async () => {
    const plan = loadMain(COPILOT_TURN_PLAN_CODE);
    const person = { email: "kevin+t@x.io", phone: "+33600000000", brandId: "b", sendKey: "follow-up:event:ev1", lead: { firstName: "Ann", lastName: "Lee" } };
    const wa = await plan(person, { channel: "whatsapp", email: "kevin+t@x.io", phone: "+33611111111", persona: { name: "Sophie", role: "AI assistant", instructions: null } });
    expect(wa).toEqual({
      skip: false,
      medium: "whatsapp",
      recipient: { email: "kevin+t@x.io", phone: "+33611111111", name: "Ann Lee" },
      assistant: { name: "Sophie", role: "AI assistant", instructions: null },
      messageField: "message",
      idempotencyKey: "copilot-lead-turn:follow-up:event:ev1",
      occurrenceItem: null,
    });
    const em = await plan(person, { channel: "email", email: "kevin+t@x.io", phone: null });
    expect(em).toMatchObject({ medium: "email", messageField: "bodyHtml", assistant: null, recipient: { phone: "+33600000000" } });
    expect(await plan(person, { channel: null, skipModel: true })).toEqual({ skip: true });
    await expect(plan({ ...person, sendKey: null }, { channel: "email" })).rejects.toThrow(/send key/);
  });

  it("hands the Copilot the occurrence's own crm record, exactly as crm stated it, else null (SOPHIE-WA-HUMAN-1106)", async () => {
    const plan = loadMain(COPILOT_TURN_PLAN_CODE);
    const person = { email: null, phone: "+33600000000", brandId: "b", sendKey: "follow-up:event:ev1", lead: {} };
    const ch = { channel: "whatsapp", phone: "+33600000000" };
    const item = { kind: "message", thread: [{ eventId: "$a", text: "hi" }], messages: [{ eventId: "$b", quote: { eventId: "$a", direction: "outbound", at: null, text: "hi" }, photo: null }] };
    expect((await plan(person, ch, { type: "lead_event", item })).occurrenceItem).toEqual(item);
    for (const trigger of [undefined, null, {}, { item: null }, { item: "text" }, { item: [1] }]) {
      expect((await plan(person, ch, trigger)).occurrenceItem).toBeNull();
    }
  });

  it("is its own signature, never a twin of the lead follow-up or the client check-in", () => {
    const sig = computeDAGSignature(dag);
    expect(sig).not.toBe(computeDAGSignature(plain));
    expect(sig).not.toBe(computeDAGSignature(buildClientCheckInDag()));
  });

  it("sits on the Lead event pipe only", () => {
    expect(LEADS_ONLY_LEG_KEYS).toEqual(["start_to_paid_client"]);
  });

  it("its description passes the plain-description rules and states who it answers", () => {
    expect(descriptionProblem(FOLLOW_UP_REACTIVE_LEADS_DESCRIPTION)).toBeNull();
    expect(FOLLOW_UP_REACTIVE_LEADS_DESCRIPTION).toMatch(/leads only/);
  });
});

describe("the leads-only claim read", () => {
  const resolve = loadMain(RESOLVE_LEAD_CODE);
  const trigger = { eventId: "ev-1", person: { email: "Ana@Client.com" } };

  it("a refused person the occurrence names ends final with lead-service's reason", async () => {
    const claim = { found: false, reason: "relationship_refused", relationships: { refused: [{ email: "ana@client.com", reason: "not_a_lead", tags: ["customer"] }], pending: [] } };
    expect(await resolve(claim, null, trigger)).toMatchObject({ ok: false, endKind: "not_admitted", notAdmitted: { reason: "not_a_lead" } });
    const staff = { ...claim, relationships: { refused: [{ email: "ana@client.com", reason: "staff" }], pending: [] } };
    expect(await resolve(staff, null, trigger)).toMatchObject({ endKind: "not_admitted", notAdmitted: { reason: "staff" } });
  });

  it("a pending person ends idle (redelivered), kept off the queue ends final", async () => {
    const pending = { found: false, reason: "relationship_pending", relationships: { refused: [], pending: [{ email: "ana@client.com", reason: "human_unknown" }] } };
    expect(await resolve(pending, null, trigger)).toMatchObject({ endKind: "pending" });
    expect(await resolve({ found: false, reason: "nothing_due" }, null, trigger)).toMatchObject({ endKind: "not_admitted", notAdmitted: { reason: "nothing_due" } });
  });

  it("someone else refused leaves the occurrence unclaimed; no occurrence = idle", async () => {
    const other = { found: false, reason: "relationship_refused", relationships: { refused: [{ email: "bob@x.com", reason: "staff" }], pending: [] } };
    expect(await resolve(other, null, trigger)).toMatchObject({ endKind: "unclaimed" });
    expect(await resolve({ found: false, reason: "nothing_due" }, null, null)).toMatchObject({ endKind: "idle" });
  });
});
