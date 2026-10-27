import { describe, it, expect } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import { descriptionProblem } from "../../src/lib/plain-description.js";
import { CHANNEL_PLAN_CODE, FOLLOW_UP_END_KINDS, buildFollowUpReactiveDag } from "../../src/lib/follow-up-dag.js";
import { CURRENT_CLIENTS_POLICY, buildClientCheckInDag } from "../../src/lib/client-check-in-dag.js";
import {
  CLIENT_SATISFIED_DESCRIPTION,
  CLIENT_SATISFIED_PIPE_ID,
  COMPOSE_CLIENT_SATISFIED_CODE,
  WHATSAPP_ONLY_CHANNEL_PLAN_CODE,
  buildClientSatisfiedDag,
  isClientSatisfiedDag,
} from "../../src/lib/client-satisfied-dag.js";
import { buildColdWhatsappOutreachDag } from "../../src/lib/cold-whatsapp-outreach-dag.js";
import { isAgentTurn } from "../../src/lib/agent-turn-node.js";

/**
 * CLIENT-SATISFIED-1027-WF (owner 2026-10-27): the Paid client -> Client Satisfied pipe's workflow writes to a CURRENT
 * CLIENT on WhatsApp only, now, later or nothing, with the owner's client strategy as its game.
 */
function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

const NOW = new Date().toISOString();
const person = { ok: true, entry: "claimed", rowId: "row-1", leadId: "lead-1", email: "ana@client.com", phone: "+33600000000", brandId: "b-1" };

describe("the client satisfied DAG", () => {
  const dag = buildClientSatisfiedDag();

  it("is on the Paid client -> Client Satisfied pipe of the cold WhatsApp channel", () => {
    expect(CLIENT_SATISFIED_PIPE_ID).toBe("cold-whatsapp-outreach|paid_client_to_client_satisfied");
  });

  it("is valid, converts, and has an end-run per end kind, its claim ends included", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    expect(() => dagToOpenFlow(dag, "client-satisfied")).not.toThrow();
    for (const kind of [...FOLLOW_UP_END_KINDS, "not_admitted", "pending"]) {
      expect(dag.nodes.some((n) => n.id === `end-run-${kind.replace(/_/g, "-")}`)).toBe(true);
    }
  });

  it("claims current clients only (a literal the tactic reads), and is told apart by it from the cold WhatsApp writers", () => {
    expect(dag.nodes.find((n) => n.id === "claim-followup")?.config).toMatchObject({ body: { relationships: CURRENT_CLIENTS_POLICY } });
    expect(isClientSatisfiedDag(dag)).toBe(true);
    expect(isClientSatisfiedDag(buildColdWhatsappOutreachDag())).toBe(false);
  });

  it("plans the channel WhatsApp only; the follow-up's own plan is unchanged", () => {
    expect(dag.nodes.find((n) => n.id === "channel-plan")?.config).toEqual({ code: WHATSAPP_ONLY_CHANNEL_PLAN_CODE });
    expect(buildFollowUpReactiveDag({ readFigures: false }).nodes.find((n) => n.id === "channel-plan")?.config).toEqual({ code: CHANNEL_PLAN_CODE });
  });

  it("writes with GLM as an agent turn reading the client's own account (never Opus, never Fable)", () => {
    expect(isAgentTurn(dag, "draft")).toBe(true);
    const plan = dag.nodes.find((n) => n.id === "llm-plan");
    expect(String(plan?.config?.code)).toContain('{"provider":"zai","model":"glm"}');
    expect(JSON.stringify(dag)).not.toMatch(/"model":"(opus|fable)"/);
  });

  it("records every act on lead-service's follow-up ledger (next date, stop, claimed row)", () => {
    const paths = dag.nodes.filter((n) => n.config?.service === "lead").map((n) => `${n.config?.method} ${n.config?.path}`);
    expect(paths).toContain("PUT /orgs/leads/{id}/followup-date");
    expect(paths).toContain("POST /orgs/leads/{id}/followups");
  });

  it("is its own signature (never a twin of the client check-in or the lead follow-up)", () => {
    const sig = computeDAGSignature(dag);
    expect(sig).not.toBe(computeDAGSignature(buildClientCheckInDag()));
    expect(sig).not.toBe(computeDAGSignature(buildFollowUpReactiveDag({ readFigures: false })));
  });

  it("its description passes the plain-description rules", () => {
    expect(descriptionProblem(CLIENT_SATISFIED_DESCRIPTION)).toBeNull();
    expect(CLIENT_SATISFIED_DESCRIPTION).toMatch(/current client/);
    expect(CLIENT_SATISFIED_DESCRIPTION).not.toMatch(/agency/i);
  });
});

describe("the WhatsApp-only channel plan", () => {
  const plan = loadMain(WHATSAPP_ONLY_CHANNEL_PLAN_CODE);
  const owed = { proceed: true };

  it("WhatsApp reaches them: writes there, as the sending account's persona", async () => {
    const out = await plan(person, owed, { reachable: true, to: "+33600000000", fromAccount: "acc-1", persona: { name: "Sophie", role: "AI assistant", instructions: null } }, { items: [] });
    expect(out).toMatchObject({ channel: "whatsapp", skipModel: false, phone: "+33600000000", fromAccount: "acc-1" });
    expect(out.persona).toMatchObject({ name: "Sophie" });
  });

  it("WhatsApp cannot reach them: nothing drafted, never an email", async () => {
    const out = await plan(person, owed, { reachable: false, code: "whatsapp_not_connected" }, { items: [] });
    expect(out).toMatchObject({ channel: null, skipModel: true, noChannel: true });
  });

  it("nothing owed: nothing planned; no reach answer fails loud", async () => {
    expect(await plan(person, { proceed: false }, null, null)).toMatchObject({ skipModel: true });
    await expect(plan(person, owed, null, { items: [] })).rejects.toThrow(/reach check did not answer/);
  });
});

describe("the client satisfied game (owner strategy 2026-10-27)", () => {
  it("states the owner's strategy, and carries no em or en dash", async () => {
    const main = loadMain(COMPOSE_CLIENT_SATISFIED_CODE);
    const out = await main(
      { ...person, lead: { firstName: "Ana" }, timezone: "Europe/Paris" },
      { channel: "whatsapp", phone: "+33600000000", skipModel: false, why: "wa", persona: null },
      { name: "Revenue made easy" },
      { brand: { name: "Distribute.you" } },
      { exact: [], neverGive: [] },
      { lines: [], ourMessages: 1 },
      undefined,
      "",
      { skip: true },
      { skip: true },
      null,
      NOW,
      NOW.slice(0, 10),
      { lines: ["Customer"], threadLines: ["2026-10-20 | Ana: thanks"], strategy: "WHO" },
    );
    expect(out.skip).toBe(false);
    for (const words of [
      "disturbing them as little as possible",
      "doing the maximum for them",
      "telling them only what is useful",
      "they asked for it",
      "they need to know it",
      "good news, positive and optimistic",
      "one improvement",
      "positive return on what they spend AND real outcomes",
    ]) {
      expect(out.systemPrompt).toContain(words);
    }
    expect(COMPOSE_CLIENT_SATISFIED_CODE).not.toMatch(/[–—]/);
    expect(out.systemPrompt).not.toMatch(/[–—]/);
  });
});
