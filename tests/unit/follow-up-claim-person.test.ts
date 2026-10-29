import { describe, it, expect } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { CLAIM_PERSON_CODE, buildFollowUpReactiveDag } from "../../src/lib/follow-up-dag.js";
import { buildClientCheckInDag } from "../../src/lib/client-check-in-dag.js";
import { buildLeadFollowUpLeadsOnlyDag } from "../../src/lib/lead-follow-up-leads-dag.js";

/**
 * CLAIM-OCCURRENCE-PERSON-1025: a reactive follow-up run answering an occurrence claims THAT person's row (lead-service
 * `person` on claim-next), never the campaign's oldest due one (Lead Follow-up f1ab54e3, 2026-10-24: a burst of
 * occurrences made every run claim someone else, end other_person and fail).
 */
function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

describe("the claim states the occurrence's person", () => {
  const run = loadMain(CLAIM_PERSON_CODE);

  it("names the person by email, phone and lead id; no occurrence = null (queue order)", async () => {
    expect(await run({ eventId: "e", person: { email: " Ana@x.com ", phone: null }, leadId: "l-1" })).toEqual({
      person: { email: "Ana@x.com", phone: null, leadId: "l-1" },
      skipClaim: false,
    });
    expect(await run({ eventId: "e", person: { phone: "+33612345678" } })).toEqual({
      person: { email: null, phone: "+33612345678", leadId: null },
      skipClaim: false,
    });
    expect(await run(null)).toEqual({ person: null, skipClaim: false });
  });

  // OCCURRENCE-NAMES-NOBODY-1029: a nameless hot lead (no email, phone or lead) claimed Olive's row and the writer
  // reasoned on that other person's inbound message.
  it("an occurrence naming nobody claims nobody (skipClaim), never the queue's next row", async () => {
    expect(await run({ eventId: "e", person: {} })).toEqual({ person: null, skipClaim: true });
    expect(await run({ eventId: "e", person: { name: "Distribute.you", email: null, phone: null } })).toEqual({ person: null, skipClaim: true });
  });

  for (const [name, dag] of [
    ["lead follow-up", buildFollowUpReactiveDag({ readFigures: false })],
    ["leads-only", buildLeadFollowUpLeadsOnlyDag({ readFigures: false })],
    ["client check-in", buildClientCheckInDag()],
  ] as const) {
    it(`${name}: claim-person feeds body.person of the claim, before it, and the DAG converts`, () => {
      expect(validateDAG(dag).errors).toEqual([]);
      expect(() => dagToOpenFlow(dag, "x")).not.toThrow();
      const claim = dag.nodes.find((n) => n.id === "claim-followup");
      expect(claim?.inputMapping).toMatchObject({ "body.person": "$ref:claim-person.output.person", skip: "$ref:claim-person.output.skipClaim" });
      expect(dag.edges).toContainEqual({ from: "check-end", to: "end-run-names-nobody", condition: "results['outcome']?.endKind == 'names_nobody'" });
      expect(dag.edges).toContainEqual({ from: "trigger-type", to: "claim-person" });
      expect(dag.edges).toContainEqual({ from: "claim-person", to: "claim-followup" });
    });
  }

  it("a claim skipped for a nameless occurrence ends final, never answering a queued person", async () => {
    const { RESOLVE_CLAIMED_PERSON_CODE } = await import("../../src/lib/follow-up-dag.js");
    const resolve = loadMain(RESOLVE_CLAIMED_PERSON_CODE);
    expect(await resolve({ ok: false, skipped: true, notCalled: true }, null, { eventId: "e", person: {} })).toMatchObject({
      endKind: "names_nobody",
      notAdmitted: { reason: "occurrence_names_nobody" },
    });
    // No occurrence: still the queue's idle.
    expect(await resolve({ found: false }, null, null)).toMatchObject({ endKind: "idle" });
  });

  it("the policy body survives beside the mapped person", () => {
    const flow = JSON.stringify(dagToOpenFlow(buildLeadFollowUpLeadsOnlyDag({ readFigures: false }), "x"));
    expect(flow).toContain("pure_prospect");
    expect(flow).toContain("claim_person");
  });
});
