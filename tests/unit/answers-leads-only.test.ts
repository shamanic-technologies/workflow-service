import { describe, it, expect, vi } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  ANSWERS_LEADS_ONLY_POLICY,
  CLAIMED_CODE,
  FEATURE_SLUG,
  buildAiMeetingBookingDag,
  needsLeadsOnlyClaim,
} from "../../src/lib/ai-meeting-booking-dag.js";
import { buildOfferDocumentReplyDag, DESCRIPTION as OFFER_DOC_DESCRIPTION } from "../../src/lib/offer-document-reply-dag.js";

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, unknown>> {
  const body = code.replace(/^export async function main/, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, unknown>>;
}

const notCalled = { ok: false, skipped: true, notCalled: true };
const refusedAda = {
  leadCampaignId: "lc-1", leadId: "lead-ada", campaignId: "resp-1", email: "ada@example.com",
  reason: "not_a_lead", tags: ["personal"], unsureTags: [],
};
const pendingAda = {
  leadCampaignId: "lc-1", leadId: "lead-ada", campaignId: "resp-1", email: "ada@example.com",
  reason: "relationship_not_judged", retryAfterSeconds: 600,
};
const trigger = { eventId: "ev-1", person: { email: "Ada@Example.com", name: "Ada" } };

describe("ai-meeting-booking answers leads only (REPLY-ANY-LEAD-1015)", () => {
  const dag = buildAiMeetingBookingDag({ provider: "google", model: "pro" });
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));

  it("states pure_prospect on EVERY lead-service follow-up claim", () => {
    expect(ANSWERS_LEADS_ONLY_POLICY).toBe("pure_prospect");
    const claims = dag.nodes.filter((n) => n.config?.path === "/orgs/campaigns/{campaignId}/followups/claim-next");
    expect(claims.map((n) => n.id).sort()).toEqual(["claim-followup", "claim-own"]);
    for (const c of claims) expect((c.config?.body as Record<string, unknown>)?.relationships).toBe("pure_prospect");
    expect(byId.get("claimed")?.inputMapping?.trigger).toBe("$ref:flow_input.trigger");
  });

  it("the offer-document responder inherits the policy and says it in its description", () => {
    const doc = buildOfferDocumentReplyDag({ provider: "anthropic", model: "opus", omitTemperature: true });
    const claims = doc.nodes.filter((n) => n.config?.path === "/orgs/campaigns/{campaignId}/followups/claim-next");
    expect(claims).toHaveLength(2);
    for (const c of claims) expect((c.config?.body as Record<string, unknown>)?.relationships).toBe("pure_prospect");
    expect(OFFER_DOC_DESCRIPTION).toContain("pure_prospect");
    expect(needsLeadsOnlyClaim(doc)).toBe(false);
  });

  it("the occurrence's person refused by lead-service = personNotAdmitted with the reason verbatim", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const claimed = loadMain(CLAIMED_CODE);
    const own = { found: false, reason: "relationship_refused", relationships: { policy: "pure_prospect", refused: [refusedAda], pending: [] } };
    const pred = { found: false, reason: "nothing_due", relationships: { policy: "pure_prospect", refused: [], pending: [] } };
    expect(await claimed(own, pred, "resp-1", "pred-1", trigger)).toMatchObject({
      found: false, notAdmitted: { reason: "not_a_lead" }, triggerPersonPending: false,
    });
    // Matched by leadId too.
    expect(await claimed(own, notCalled, "resp-1", "pred-1", { eventId: "ev-2", leadId: "lead-ada" })).toMatchObject({
      notAdmitted: { reason: "not_a_lead" },
    });
  });

  it("someone ELSE refused, a pending person, or no trigger (cadence) = no personNotAdmitted (idle end, redelivered)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const claimed = loadMain(CLAIMED_CODE);
    const own = { found: false, reason: "relationship_refused", relationships: { policy: "pure_prospect", refused: [refusedAda], pending: [] } };
    expect((await claimed(own, notCalled, "resp-1", "pred-1", { person: { email: "bob@example.com" } })).notAdmitted).toBeNull();
    expect((await claimed(own, notCalled, "resp-1", "pred-1", undefined)).notAdmitted).toBeNull();
    const pending = { found: false, reason: "relationship_pending", relationships: { policy: "pure_prospect", refused: [], pending: [pendingAda] } };
    expect(await claimed(pending, notCalled, "resp-1", "pred-1", trigger)).toMatchObject({
      found: false, notAdmitted: null, triggerPersonPending: true,
    });
  });

  it("a claimed prospect is answered as before, whatever was refused alongside", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const claimed = loadMain(CLAIMED_CODE);
    const row = { id: "row-1", leadId: "l1", brandId: "b1", email: "sam@acme.com" };
    const own = { found: true, followup: row, relationships: { policy: "pure_prospect", refused: [refusedAda], pending: [] } };
    expect(await claimed(own, notCalled, "resp-1", "pred-1", trigger)).toMatchObject({
      found: true, queue: "own", notAdmitted: null, followup: row,
    });
  });

  it("check-claim routes a refused occurrence person to its own end-run, stating personNotAdmitted on success", () => {
    const arms = dag.edges.filter((e) => e.from === "check-claim");
    expect(arms.map((e) => [e.to, e.condition])).toEqual([
      ["campaign-detail", "results['claimed']?.found == true"],
      ["end-run-person-not-admitted", "results['claimed']?.found == false && results['claimed']?.notAdmitted != null"],
      ["end-run-nobody-due", "results['claimed']?.found == false && results['claimed']?.notAdmitted == null"],
    ]);
    const end = byId.get("end-run-person-not-admitted");
    expect(end?.config).toMatchObject({ service: "campaign", path: "/end-run", body: { success: true, stopCampaign: false } });
    expect(end?.inputMapping).toEqual({ "body.personNotAdmitted": "$ref:claimed.output.notAdmitted" });
    expect((byId.get("end-run-nobody-due")?.config?.body as Record<string, unknown>)?.noWorkAvailable).toBe(true);

    const flow = dagToOpenFlow(dag, `${FEATURE_SLUG}-test`) as { value: { modules: Array<{ id: string; value: { type: string; branches?: Array<{ modules: Array<{ id: string }> }> } }> } };
    const check = flow.value.modules.find((m) => m.id === "check_claim");
    expect(check?.value.type).toBe("branchone");
    const reached = (check?.value.branches ?? []).map((b) => b.modules.map((m) => m.id)[0]);
    expect(reached).toContain("end_run_person_not_admitted");
    expect(reached).toContain("end_run_nobody_due");
  });

  it("calls a stored DAG without the policy stale, and the current one current", () => {
    expect(needsLeadsOnlyClaim(dag)).toBe(false);
    const noPolicy = {
      ...dag,
      nodes: dag.nodes.map((n) => (n.id === "claim-followup" ? { ...n, config: { ...n.config, body: undefined } } : n)),
    };
    expect(needsLeadsOnlyClaim(noPolicy)).toBe(true);
    const noEnding = { ...dag, nodes: dag.nodes.filter((n) => n.id !== "end-run-person-not-admitted") };
    expect(needsLeadsOnlyClaim(noEnding)).toBe(true);
    expect(needsLeadsOnlyClaim({ nodes: [{ id: "x" }] })).toBe(false);
  });
});
