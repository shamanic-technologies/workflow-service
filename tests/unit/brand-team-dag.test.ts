import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import { descriptionProblem } from "../../src/lib/plain-description.js";
import { FOLLOW_UP_END_KINDS, buildFollowUpReactiveDag } from "../../src/lib/follow-up-dag.js";
import { buildClientCheckInDag, isClientCheckInDag } from "../../src/lib/client-check-in-dag.js";
import { buildLeadFollowUpLeadsOnlyDag, isLeadsOnlyFollowUpDag } from "../../src/lib/lead-follow-up-leads-dag.js";
import {
  BRAND_TEAM_DESCRIPTION,
  BRAND_TEAM_PIPE_ID,
  COMPOSE_BRAND_TEAM_CODE,
  OWN_TEAM_POLICY,
  READ_TEAM_STATE_CODE,
  RESOLVE_TEAM_CODE,
  buildBrandTeamDag,
  isBrandTeamDag,
} from "../../src/lib/brand-team-dag.js";
import { isCopilotTurn } from "../../src/lib/copilot-turn-node.js";

/**
 * ONE-AI-CONVERSES-1029 (owner 2026-10-29): every person who writes to the brand gets ONE answer, the brand's own team
 * included. The team is the Lead event pipe's third audience: claim `own_team`, the assistant game, the Copilot writes.
 */
function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

const NOW = new Date().toISOString();
const person = { ok: true, entry: "claimed", rowId: "row-1", leadId: "lead-1", email: "bob@team.com", phone: "+33600000000", brandId: "b-1" };
const state = (owed: Record<string, unknown>) => ({ owed, followupDate: { nextFollowupAt: null }, queued: { followups: [{ leadCampaignId: "other", dueAt: NOW }], emailSequence: true } });

describe("the brand's team DAG", () => {
  const dag = buildBrandTeamDag();

  it("is on the Lead event pipe, beside the leads and the clients", () => {
    expect(BRAND_TEAM_PIPE_ID).toBe("ai-follow-up-email|start_to_paid_client");
  });

  it("is valid, converts, and has an end-run per end kind, its claim ends included", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    expect(() => dagToOpenFlow(dag, "brand-team")).not.toThrow();
    for (const kind of [...FOLLOW_UP_END_KINDS, "not_admitted", "pending"]) {
      expect(dag.nodes.some((n) => n.id === `end-run-${kind.replace(/_/g, "-")}`)).toBe(true);
    }
  });

  it("claims the brand's team only (a literal the tactic reads), told apart from the leads and clients dynasties by it", () => {
    expect(dag.nodes.find((n) => n.id === "claim-followup")?.config).toMatchObject({ body: { relationships: OWN_TEAM_POLICY } });
    expect(OWN_TEAM_POLICY).toBe("own_team");
    expect(isBrandTeamDag(dag)).toBe(true);
    expect(isClientCheckInDag(dag)).toBe(false);
    expect(isLeadsOnlyFollowUpDag(dag)).toBe(false);
    expect(isBrandTeamDag(buildClientCheckInDag())).toBe(false);
    expect(isBrandTeamDag(buildLeadFollowUpLeadsOnlyDag({ readFigures: false }))).toBe(false);
  });

  it("writes through the Copilot, one AI", () => {
    expect(isCopilotTurn(dag, "draft")).toBe(true);
    expect(dag.nodes.find((n) => n.id === "llm-plan")).toBeUndefined();
  });

  it("is its own signature (never a twin of the client check-in or the lead follow-up)", () => {
    const sig = computeDAGSignature(dag);
    expect(sig).not.toBe(computeDAGSignature(buildClientCheckInDag()));
    expect(sig).not.toBe(computeDAGSignature(buildLeadFollowUpLeadsOnlyDag({ readFigures: false })));
    expect(sig).not.toBe(computeDAGSignature(buildFollowUpReactiveDag({ readFigures: false })));
  });

  it("its description passes the plain-description rules", () => {
    expect(descriptionProblem(BRAND_TEAM_DESCRIPTION)).toBeNull();
    expect(BRAND_TEAM_DESCRIPTION).not.toMatch(/agency/i);
  });
});

describe("who the team run answers", () => {
  const resolve = loadMain(RESOLVE_TEAM_CODE);
  it("a person lead-service refuses (a lead, a client) ends not admitted, named not_team", async () => {
    const out = await resolve(
      { found: false, reason: "relationship_refused", relationships: { refused: [{ email: "ana@lead.com", reason: "not_team" }], pending: [] } },
      null,
      { person: { email: "ana@lead.com" } },
    );
    expect(out).toMatchObject({ ok: false, endKind: "not_admitted", notAdmitted: { reason: "not_team" } });
  });
});

describe("the team's follow-up state", () => {
  const read = loadMain(READ_TEAM_STATE_CODE);
  it("what a team member IS (team, no prospect, a test sale, a live conversation, a queued row) never silences them", async () => {
    const out = await read(person, state({ kind: "stop", reasons: ["team_member", "not_pure_prospect", "customer", "in_conversation", "sequence_running"] }), NOW);
    expect(out).toEqual({ proceed: true, kind: "owed", reason: null, skip: false });
    expect(await read(person, state({ kind: "owed", reasons: [] }), NOW)).toMatchObject({ proceed: true });
  });
  it("only their own stops hold", async () => {
    for (const r of ["opted_out", "do_not_contact", "unsubscribed", "bounced"]) {
      expect(await read(person, state({ kind: "stop", reasons: ["team_member", r] }), NOW)).toMatchObject({ proceed: false, kind: "stop", reason: r, skip: true });
    }
  });
  it("fails loud on an unreadable state; nobody claimed = nothing", async () => {
    await expect(read(person, { owed: {} }, NOW)).rejects.toThrow(/no follow-up kind/);
    await expect(read(person, state({ kind: "stop", reasons: [] }), NOW)).rejects.toThrow(/without naming a reason/);
    expect(await read({ ok: false }, null, NOW)).toMatchObject({ proceed: false, skip: true });
  });
});

describe("the team game", () => {
  it("is the assistant's game, never a sale, and carries no em or en dash", async () => {
    const main = loadMain(COMPOSE_BRAND_TEAM_CODE);
    const out = await main(
      { ...person, lead: { firstName: "Bob" }, timezone: "Europe/Paris" },
      { channel: "whatsapp", phone: "+33600000000", skipModel: false, why: "wa", persona: { name: "Sophie", role: "Assistant", instructions: null } },
      { name: "Revenue made easy" },
      { brand: { name: "Distribute.you" } },
      { exact: [], neverGive: [] },
      { lines: [], ourMessages: 1 },
      undefined,
      "",
      { skip: true },
      { skip: true },
      { item: { kind: "reply", text: "Can you draft my Threads post?" } },
      NOW,
      NOW.slice(0, 10),
      { lines: ["Team"], threadLines: ["2026-10-29 | Bob: can you draft my Threads post?"], strategy: "WHO" },
    );
    expect(out.skip).toBe(false);
    for (const words of ["assistant of ONE person on the team at Distribute.you", "Help them with their own work", "never sell to them", "write NOW"]) {
      expect(out.systemPrompt).toContain(words);
    }
    expect(out.message).toContain("Can you draft my Threads post?");
    expect(COMPOSE_BRAND_TEAM_CODE).not.toMatch(/[–—]/);
    expect(out.systemPrompt).not.toMatch(/[–—]/);
  });
});

describe("the seeds", () => {
  it("the follow-up seed never upgrades the team dynasty to the leads DAG; the team seed keeps it on its pipe", () => {
    const followUp = readFileSync(new URL("../../scripts/seed-follow-up-workflows.mjs", import.meta.url), "utf8");
    expect(followUp).toContain("isClientCheckInDag(r.dag) || isBrandTeamDag(r.dag)");
    const team = readFileSync(new URL("../../scripts/seed-brand-team-workflow.mjs", import.meta.url), "utf8");
    expect(team).toContain("isBrandTeamDag(r.dag)");
    expect(team).toContain('"/workflows/upgrade"');
    expect(team).not.toMatch(/fork/i);
  });
});
