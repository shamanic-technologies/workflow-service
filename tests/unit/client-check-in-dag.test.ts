import { describe, it, expect } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import { descriptionProblem } from "../../src/lib/plain-description.js";
import { FOLLOW_UP_END_KINDS, buildFollowUpReactiveDag, COMPOSE_FOLLOW_UP_CODE } from "../../src/lib/follow-up-dag.js";
import {
  CLIENT_CHECK_IN_DESCRIPTION,
  COMPOSE_CLIENT_CHECK_IN_CODE,
  CURRENT_CLIENTS_POLICY,
  READ_CLIENT_STATE_CODE,
  RESOLVE_CLIENT_CODE,
  buildClientCheckInDag,
  isClientCheckInDag,
} from "../../src/lib/client-check-in-dag.js";

/**
 * CLIENT-CHECKIN-ON-LEAD-EVENT-1024 (owner 2026-10-24): every Unibox event of a current client starts a reactive run
 * that writes a check-in / value help now, or sets a later follow-up date.
 */
function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

const NOW = new Date().toISOString();
const person = { ok: true, entry: "claimed", rowId: "row-1", leadId: "lead-1", email: "ana@client.com", brandId: "b-1" };
const state = (owed: Record<string, unknown>, queued: Record<string, unknown> = { emailSequence: false, followups: [] }) => ({
  owed,
  followupDate: { nextFollowupAt: NOW },
  queued,
});

describe("the client check-in DAG", () => {
  const dag = buildClientCheckInDag();

  it("is valid, converts, and has an end-run per end kind, its two claim ends included", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    expect(() => dagToOpenFlow(dag, "client-check-in")).not.toThrow();
    for (const kind of [...FOLLOW_UP_END_KINDS, "not_admitted", "pending", "idle", "unclaimed", "other_person"]) {
      const id = `end-run-${kind.replace(/_/g, "-")}`;
      expect(dag.nodes.some((n) => n.id === id)).toBe(true);
      expect(dag.edges).toContainEqual({ from: "check-end", to: id, condition: `results['outcome']?.endKind == '${kind}'` });
    }
    expect(dag.nodes.find((n) => n.id === "end-run-not-admitted")?.inputMapping).toEqual({
      "body.personNotAdmitted": "$ref:resolve-person.output.notAdmitted",
    });
    expect(dag.nodes.find((n) => n.id === "end-run-pending")?.config).toMatchObject({ body: { noWorkAvailable: true } });
  });

  it("states the current clients policy as a LITERAL on the claim (the tactic reads it), and is told apart by it", () => {
    const claim = dag.nodes.find((n) => n.id === "claim-followup");
    expect(claim?.config).toMatchObject({ body: { relationships: CURRENT_CLIENTS_POLICY } });
    expect(isClientCheckInDag(dag)).toBe(true);
    expect(isClientCheckInDag(buildFollowUpReactiveDag({ readFigures: false }))).toBe(false);
    expect(isClientCheckInDag(buildFollowUpReactiveDag({ readFigures: true }))).toBe(false);
  });

  it("is its own signature (never a twin of the lead follow-up)", () => {
    expect(computeDAGSignature(dag)).not.toBe(computeDAGSignature(buildFollowUpReactiveDag({ readFigures: false })));
  });

  it("the lead follow-up claim states no policy (unchanged)", () => {
    const claim = buildFollowUpReactiveDag({ readFigures: false }).nodes.find((n) => n.id === "claim-followup");
    expect((claim?.config as { body?: unknown }).body).toBeUndefined();
  });

  it("its description passes the plain-description rules and states who it serves", () => {
    expect(descriptionProblem(CLIENT_CHECK_IN_DESCRIPTION)).toBeNull();
    expect(CLIENT_CHECK_IN_DESCRIPTION).toMatch(/current client/);
  });
});

describe("the client game", () => {
  it("replaces only the four game lines of the lead writer, and carries no em or en dash", () => {
    expect(COMPOSE_CLIENT_CHECK_IN_CODE).not.toBe(COMPOSE_FOLLOW_UP_CODE);
    expect(COMPOSE_CLIENT_CHECK_IN_CODE).toContain("current client");
    expect(COMPOSE_CLIENT_CHECK_IN_CODE).toContain("a reload before their credit runs dry");
    // A client's own question is answered the same day, weekend included (staff replay 2026-10-24: a Saturday help
    // request was put off to Monday).
    expect(COMPOSE_CLIENT_CHECK_IN_CODE).toContain("is waiting for us right now: write NOW, on any day");
    expect(COMPOSE_CLIENT_CHECK_IN_CODE).not.toContain("We follow up every lead");
    expect(COMPOSE_CLIENT_CHECK_IN_CODE).not.toMatch(/[–—]/);
    expect(COMPOSE_FOLLOW_UP_CODE).toContain("We follow up every lead");
  });

  it("builds a prompt that runs (the generated script parses and returns the client game)", async () => {
    const main = loadMain(COMPOSE_CLIENT_CHECK_IN_CODE);
    const out = await main(
      { ...person, lead: { firstName: "Ana" }, timezone: "Europe/Paris" },
      { channel: "email", email: "ana@client.com", skipModel: false, why: "email" },
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
    expect(out.systemPrompt).toContain("You look after ONE current client of Distribute.you");
    expect(out.systemPrompt).toContain("THE GAME. A client stays and grows");
  });

  it("shows the writer what the event carries (a form's words); the lead writer never does", async () => {
    const args = (trigger: unknown) => [
      { ...person, lead: { firstName: "Ana" }, timezone: "Europe/Paris" },
      { channel: "email", email: "ana@client.com", skipModel: false, why: "email" },
      { name: "Revenue made easy" },
      { brand: { name: "Distribute.you" } },
      { exact: [], neverGive: [] },
      { lines: [], ourMessages: 1 },
      undefined,
      "",
      { skip: true },
      { skip: true },
      trigger,
      NOW,
      NOW.slice(0, 10),
      { lines: ["Customer"], threadLines: [], strategy: "WHO" },
    ];
    const trigger = { eventId: "ev-1", item: { formName: "Support", answers: [{ question: "Ask", answer: "How do I get more meetings?" }] } };
    const client = await loadMain(COMPOSE_CLIENT_CHECK_IN_CODE)(...args(trigger));
    expect(client.message).toContain("WHAT THE EVENT CARRIES");
    expect(client.message).toContain("How do I get more meetings?");
    const none = await loadMain(COMPOSE_CLIENT_CHECK_IN_CODE)(...args({ eventId: "ev-2" }));
    expect(none.message).not.toContain("WHAT THE EVENT CARRIES");
    const lead = await loadMain(COMPOSE_FOLLOW_UP_CODE)(...args(trigger));
    expect(lead.message).not.toContain("WHAT THE EVENT CARRIES");
  });
});

describe("the client claim", () => {
  const main = loadMain(RESOLVE_CLIENT_CODE);
  const trigger = { eventId: "ev-1", person: { email: "Ana@Client.com" } };

  it("a person lead-service refuses (not a current client) ends final, named", async () => {
    const out = await main({ found: false, reason: "relationship_refused", relationships: { refused: [{ email: "ana@client.com", reason: "not_a_client" }], pending: [] } }, null, trigger);
    expect(out).toMatchObject({ ok: false, endKind: "not_admitted", notAdmitted: { reason: "not_a_client" } });
  });

  it("a person lead-service cannot judge yet ends idle", async () => {
    const out = await main({ found: false, reason: "relationship_pending", relationships: { refused: [], pending: [{ email: "ana@client.com", reason: "relationship_not_judged" }] } }, null, trigger);
    expect(out).toMatchObject({ ok: false, endKind: "pending" });
  });

  it("kept off the queue on purpose: final", async () => {
    const out = await main({ found: false, reason: "nothing_due" }, null, trigger);
    expect(out).toMatchObject({ endKind: "not_admitted", notAdmitted: { reason: "nothing_due" } });
  });

  it("no occurrence and nobody due: idle, as the lead follow-up", async () => {
    expect(await main({ found: false, reason: "nothing_due" }, null, null)).toMatchObject({ endKind: "idle" });
  });

  it("a claimed client is the follow-up's own person", async () => {
    const out = await main(
      { found: true, followup: { id: "row-1", leadId: "lead-1", brandId: "b-1", email: "ana@client.com", dueAt: NOW } },
      { leadDetail: { lead: { firstName: "Ana" } } },
      trigger,
    );
    expect(out).toMatchObject({ ok: true, rowId: "row-1", sendKey: "follow-up:event:ev-1" });
  });
});

describe("the client follow-up state", () => {
  const main = loadMain(READ_CLIENT_STATE_CODE);

  it("what a client IS (customer, booked, replied, not a pure prospect) is owed, never a stop", async () => {
    const out = await main(person, state({ kind: "stop", reasons: ["customer", "meeting_attended", "not_pure_prospect", "not_brand_lead"] }), NOW);
    expect(out).toMatchObject({ proceed: true, kind: "owed" });
  });

  it("their own stops hold: opted out, unsubscribed, team", async () => {
    for (const r of ["opted_out", "unsubscribed", "bounced", "do_not_contact", "team_member"]) {
      const out = await main(person, state({ kind: "stop", reasons: ["customer", r] }), NOW);
      expect(out).toMatchObject({ proceed: false, kind: "stop", reason: r });
    }
  });

  it("an unknown reason is a stop, never a yes", async () => {
    expect(await main(person, state({ kind: "stop", reasons: ["something_new"] }), NOW)).toMatchObject({ kind: "stop" });
  });

  it("a queued email step or another campaign's follow-up: nothing written, a later date", async () => {
    const a = await main(person, state({ kind: "not_yet", reasons: ["customer", "sequence_running"], retryAfter: NOW }), NOW);
    expect(a).toMatchObject({ proceed: false, kind: "queued" });
    const due = new Date(Date.now() + 86400000).toISOString();
    const b = await main(person, state({ kind: "owed", reasons: [] }, { emailSequence: false, followups: [{ leadCampaignId: "other", dueAt: due }] }), NOW);
    expect(b.kind).toBe("queued");
    expect(Date.parse(b.nextFollowUpAt)).toBeGreaterThan(Date.parse(due));
  });

  it("no kind fails loud", async () => {
    await expect(main(person, state({}), NOW)).rejects.toThrow();
  });
});
