import { describe, it, expect } from "vitest";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  COLD_WHATSAPP_OUTREACH_LEG_KEYS,
  COMPOSE_MESSAGE_PROMPT_CODE,
  CRM_WHATSAPP_SEND,
  FINALIZE_MESSAGE_CODE,
  MESSAGE_RESPONSE_SCHEMA,
  PICK_PERSON_CODE,
  RECORD_PLAN_CODE,
  WHATSAPP_FOLLOW_UP_SENT_REASON,
  WHATSAPP_REFUSAL_CODES,
  buildColdWhatsappOutreachDag,
  coldWhatsappPipeIdOf,
} from "../../src/lib/cold-whatsapp-outreach-dag.js";

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

type Mod = { id: string; value: { type: string; branches?: { modules: Mod[] }[]; input_transforms?: Record<string, { type: string; value?: unknown; expr?: string }> } };

function allModules(mods: Mod[]): Mod[] {
  return mods.flatMap((m) => [m, ...(m.value.branches ?? []).flatMap((b) => allModules(b.modules))]);
}

describe("cold-whatsapp-outreach DAG", () => {
  const dag = buildColdWhatsappOutreachDag();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const flow = dagToOpenFlow(dag, "cold-whatsapp-outreach-test");
  const mods = allModules(flow.value.modules as Mod[]);

  it("serves both pipes of its channel", () => {
    expect(COLD_WHATSAPP_OUTREACH_LEG_KEYS.map(coldWhatsappPipeIdOf)).toEqual([
      "cold-whatsapp-outreach|lead_found_to_conversation",
      "cold-whatsapp-outreach|lead_found_to_website_visit",
    ]);
  });

  it("is a valid DAG that translates to Windmill, every script exporting main", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    for (const n of dag.nodes.filter((x) => x.type === "script")) {
      expect(n.config?.code).toContain("export async function main");
    }
  });

  it("emits its three decisions as top-level branchones, none nested where it would silently do nothing", () => {
    const top = (flow.value.modules as Mod[]).filter((m) => m.value.type === "branchone");
    expect(top.map((m) => m.id)).toEqual(["check_due", "check_person", "check_record"]);
    expect(dag.edges.filter((e) => e.to === "pick-person").map((e) => e.from)).toContain("claim-followup");
    expect(dag.edges.filter((e) => e.to === "check-record").map((e) => e.from)).toContain("pick-person");
    for (const e of dag.edges.filter((x) => x.condition)) expect(e.condition).toContain("?.");
  });

  it("answers a due follow-up first, and only then serves a new person", () => {
    const due = dag.edges.find((e) => e.from === "check-due" && e.to === "lead-detail")!;
    const fresh = dag.edges.find((e) => e.from === "check-due" && e.to === "serve-lead")!;
    expect(holds(due.condition!, { "claim-followup": { found: true } })).toBe(true);
    expect(holds(fresh.condition!, { "claim-followup": { found: true } })).toBe(false);
    expect(holds(fresh.condition!, { "claim-followup": { found: false, reason: "nothing_due" } })).toBe(true);
    expect(byId.get("claim-followup")?.inputMapping?.["params.campaignId"]).toBe("$ref:flow_input.campaignId");
    expect(byId.get("serve-lead")?.config).toMatchObject({ service: "lead", path: "/orgs/buffer/next" });
  });

  it("nobody due and nobody served ends on the no-lead end-run, which the converter scopes to audience_exhausted", () => {
    const nobody = dag.edges.find((e) => e.from === "check-person" && e.to === "end-run-no-lead")!;
    expect(holds(nobody.condition!, { "pick-person": { kind: "nobody" } })).toBe(true);
    expect(descendants(dag, "end-run-no-lead").size).toBe(0);
    const endNoLead = mods.find((m) => m.id === "end_run_no_lead")!;
    expect(endNoLead.value.input_transforms?.body?.expr).toContain('stopCampaign: results.serve_lead?.reason === "audience_exhausted"');
  });

  it("sends once, on WhatsApp through crm-service, keyed per person per step, with named refusals tolerated", () => {
    const sends = dag.nodes.filter((n) => n.config?.service === CRM_WHATSAPP_SEND.service);
    expect(sends.map((n) => n.id)).toEqual(["send-whatsapp"]);
    expect(dag.nodes.some((n) => n.config?.service === "email-gateway")).toBe(false);
    const send = mods.find((m) => m.id === "send_whatsapp")!;
    expect(send.value.input_transforms?.skipOnRefusalCodes).toEqual({ type: "static", value: [...WHATSAPP_REFUSAL_CODES] });
    expect(byId.get("send-whatsapp")?.retries).toBe(0);
    expect(byId.get("send-whatsapp")?.config).toMatchObject({ service: "crm", method: "POST", path: "/orgs/whatsapp/messages" });
    expect(byId.get("send-whatsapp")?.inputMapping).toMatchObject({
      "body.email": "$ref:pick-person.output.email",
      "body.skipIfReplied": "$ref:finalize-message.output.skipIfReplied",
    });
  });

  it("records strictly AFTER the send: a first message schedules the follow-up, a follow-up hands the row over", () => {
    expect(descendants(dag, "send-whatsapp")).toEqual(
      new Set(["record-plan", "check-record", "schedule-followup", "record-followup", "end-run-unreachable", "end-run", "end-run-followup"]),
    );
    expect(descendants(dag, "schedule-followup").has("send-whatsapp")).toBe(false);
    expect(byId.get("schedule-followup")?.config?.path).toBe("/orgs/campaigns/{campaignId}/followups/schedule-by-email");
    expect(byId.get("record-followup")?.inputMapping?.["params.id"]).toBe("$ref:pick-person.output.rowId");
  });

  it("writes through chat-service /complete on Opus with a strict schema, never Haiku", () => {
    const chat = dag.nodes.filter((n) => n.config?.service === "chat");
    expect(chat.map((n) => n.id)).toEqual(["draft-message"]);
    expect(chat[0].config?.body).toMatchObject({ provider: "anthropic", model: "opus", responseFormat: "json" });
    expect(MESSAGE_RESPONSE_SCHEMA.additionalProperties).toBe(false);
    expect([...MESSAGE_RESPONSE_SCHEMA.required].sort()).toEqual(Object.keys(MESSAGE_RESPONSE_SCHEMA.properties).sort());
    expect(JSON.stringify(dag)).not.toMatch(/haiku/i);
  });
});

describe("picking the person", () => {
  const pick = loadMain(PICK_PERSON_CODE);

  it("a claimed follow-up wins and carries its queue row", async () => {
    const out = await pick(
      { found: true, followup: { id: "row-1", leadId: "l-1", email: "a@x.com", brandId: "b-1" } },
      { leadDetail: { lead: { firstName: "Ana" } } },
      undefined,
    );
    expect(out).toMatchObject({ kind: "followup", step: 2, rowId: "row-1", email: "a@x.com", brandId: "b-1" });
  });

  it("otherwise the served lead, as a first message", async () => {
    const out = await pick(
      { found: false, reason: "nothing_due" },
      undefined,
      { found: true, lead: { leadId: "l-2", email: "b@x.com", brandIds: ["b-2"], data: { firstName: "Ben" } } },
    );
    expect(out).toMatchObject({ kind: "first", step: 1, rowId: null, email: "b@x.com", brandId: "b-2", lead: { firstName: "Ben" } });
  });

  it("nobody, with lead-service's reason", async () => {
    const out = await pick({ found: false, reason: "nothing_due" }, undefined, { found: false, reason: "audience_exhausted" });
    expect(out).toEqual({ kind: "nobody", reason: "audience_exhausted" });
  });
});

describe("composing the message", () => {
  const offer = { name: "Revenue made easy" };
  const brand = { brand: { name: "Distribute.you" } };
  const rep = { salesRepFirstName: "Kevin", salesRepRole: null };
  const facts = { exact: [{ id: "E1", label: "pricing", value: "The platform is free" }], neverGive: [] };
  const first = { kind: "first", step: 1, email: "a@x.com", lead: { firstName: "Ana", organization: { name: "Acme" } } };

  it("explains the game, follows the instruction verbatim, and signs as the brand's rep", async () => {
    const out = await loadMain(COMPOSE_MESSAGE_PROMPT_CODE)(first, "Ask what they tried to grow signups.", offer, brand, rep, facts, "2026-10-12");
    const system = out.systemPrompt as string;
    expect(system).toContain("THE GAME");
    expect(system).toContain("Kevin, founder of Distribute.you");
    expect(system).toContain("ONE easy question");
    expect(system).toContain("Never use an em dash");
    expect(system).not.toMatch(/[–—]/);
    const message = out.message as string;
    expect(message).toContain("Ask what they tried to grow signups.");
    expect(message).toContain("Name: Ana");
    expect(message).toContain("Company: Acme");
    expect(message).toContain("E1. pricing: The platform is free");
  });

  it("a follow-up says it is the one and only", async () => {
    const out = await loadMain(COMPOSE_MESSAGE_PROMPT_CODE)({ ...first, kind: "followup", step: 2 }, null, offer, brand, rep, facts, "2026-10-12");
    expect(out.systemPrompt as string).toContain("ONE follow-up: we wrote to them 3 days ago");
    expect(out.message as string).toContain("(none: follow THE GAME)");
  });

  it("never writes without a brand name or offer name", async () => {
    await expect(loadMain(COMPOSE_MESSAGE_PROMPT_CODE)(first, null, {}, brand, rep, facts, "x")).rejects.toThrow(/offer/);
    await expect(loadMain(COMPOSE_MESSAGE_PROMPT_CODE)(first, null, offer, {}, rep, facts, "x")).rejects.toThrow(/brand/);
  });
});

describe("finalizing and recording", () => {
  it("strips dashes and keys the send per person per step", async () => {
    const out = await loadMain(FINALIZE_MESSAGE_CODE)({ json: { message: "Hi Ana — quick one, 3–5 people?" } }, { leadId: "l-1", step: 1 }, "c-1");
    expect(out.text).toBe("Hi Ana, quick one, 3-5 people?");
    expect(out.idempotencyKey).toBe("cold-whatsapp-outreach:c-1:l-1:1");
    expect(out.skipIfReplied).toBe(false);
    const again = await loadMain(FINALIZE_MESSAGE_CODE)({ json: { message: "Hi" } }, { kind: "followup", leadId: "l-1", step: 2 }, "c-1");
    expect(again.skipIfReplied).toBe(true);
    await expect(loadMain(FINALIZE_MESSAGE_CODE)({ json: { message: "  " } }, { leadId: "l-1", step: 1 }, "c-1")).rejects.toThrow(/empty/);
  });

  it("a sent first message schedules the one follow-up 3 days out; a refused one records nothing and is named", async () => {
    const plan = loadMain(RECORD_PLAN_CODE);
    const sent = await plan({ kind: "first", email: "a@x.com" }, { ok: true }, "2026-10-12");
    expect(sent.action).toBe("schedule");
    const days = (Date.parse(sent.dueAt as string) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);
    const refused = await plan({ kind: "first", email: "a@x.com" }, { ok: false, skipped: true, code: "no_phone_known" }, "2026-10-12");
    expect(refused).toEqual({ action: "none", outcome: "unreachable", code: "no_phone_known" });
  });

  it("a follow-up is handed over for good, sent or refused, so there is never a second", async () => {
    const plan = loadMain(RECORD_PLAN_CODE);
    const sent = await plan({ kind: "followup", rowId: "r" }, { ok: true }, "x");
    expect(sent).toMatchObject({ action: "record", body: { kind: "handed", reason: WHATSAPP_FOLLOW_UP_SENT_REASON } });
    const replied = await plan({ kind: "followup", rowId: "r" }, { skipped: true, code: "person_replied" }, "x");
    expect(replied).toMatchObject({ action: "record", body: { kind: "handed", reason: "whatsapp_person_replied" } });
  });
});
