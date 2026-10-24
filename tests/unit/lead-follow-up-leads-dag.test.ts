import { describe, it, expect } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import { descriptionProblem } from "../../src/lib/plain-description.js";
import { FOLLOW_UP_END_KINDS, buildFollowUpReactiveDag, READ_STATE_CODE, COMPOSE_FOLLOW_UP_CODE } from "../../src/lib/follow-up-dag.js";
import { buildClientCheckInDag, isClientCheckInDag } from "../../src/lib/client-check-in-dag.js";
import {
  FOLLOW_UP_REACTIVE_LEADS_DESCRIPTION,
  LEADS_ONLY_LEG_KEYS,
  LEADS_ONLY_POLICY,
  RESOLVE_LEAD_CODE,
  buildLeadFollowUpLeadsOnlyDag,
  isLeadsOnlyFollowUpDag,
} from "../../src/lib/lead-follow-up-leads-dag.js";

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

  it("only the claim and its read differ from the lead follow-up: same state read, same writer", () => {
    expect(node(dag, "read-state")?.config).toEqual({ code: READ_STATE_CODE });
    expect(node(dag, "compose")?.config ?? null).toEqual(node(plain, "compose")?.config ?? null);
    expect(COMPOSE_FOLLOW_UP_CODE).toBeTruthy();
    const differing = dag.nodes.filter((n) => JSON.stringify(n) !== JSON.stringify(plain.nodes.find((p) => p.id === n.id))).map((n) => n.id);
    expect(differing.sort()).toEqual(["claim-followup", "end-run-not-admitted", "end-run-pending", "resolve-person"].sort());
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
