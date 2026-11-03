import { describe, it, expect, vi } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { validateDAG } from "../../src/lib/dag-validator.js";
import {
  BUSINESS_ROLE_CODE,
  BUSINESS_ROLE_NODE_IDS,
  BUSINESS_ROLE_PLAN_CODE,
  BUSINESS_SITE_PLAN_CODE,
} from "../../src/lib/business-role.js";
import {
  COMPOSE_FOLLOW_UP_CODE,
  COMPOSE_FOLLOW_UP_REP_ALERT_CODE,
  FINALIZE_FOLLOW_UP_CODE,
  FOLLOW_UP_RESPONSE_SCHEMA,
  OUTCOME_CODE,
} from "../../src/lib/follow-up-dag.js";
import { buildLeadFollowUpLeadsOnlyDag } from "../../src/lib/lead-follow-up-leads-dag.js";

/**
 * MERCHANT-DEMO-LINE-1103 (owner 2026-11-03): a brand's AI line whose stated persona asks to answer as the business of
 * the lead writing answers as that business, from its site read live; a question nobody can answer is handed to the
 * brand's sales rep phone on WhatsApp; the answer is in the language the person wrote in.
 */
function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

const NOW = new Date().toISOString();
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();
const DEMO_INSTRUCTIONS = "You are a demo. When a merchant writes, answer as THEIR business's assistant, from their own site.";
const waChannel = (instructions: string | null) => ({
  channel: "whatsapp",
  skipModel: false,
  email: null,
  phone: "+34600000001",
  why: "The brand's WhatsApp reaches them",
  persona: { name: "Ana", role: "AI assistant", instructions },
});
const person = {
  ok: true,
  entry: "claimed",
  rowId: "row-1",
  leadId: "lead-1",
  email: null,
  phone: "+34600000001",
  brandId: "brand-1",
  lead: { firstName: "Lucia", organization: { name: "Panaderia Sol" } },
  timezone: "Europe/Madrid",
  sendKey: "follow-up:event:ev-1",
  eventId: "ev-1",
};
const timeline = {
  person: { name: "Lucia", organizations: [{ name: "Panaderia Sol", domain: "https://www.panaderiasol.es/" }] },
  items: [{ kind: "message", direction: "inbound", channel: "whatsapp", source: "matrix", at: NOW, text: "Hola, ¿a qué hora abren el domingo?" }],
};
const who = {
  lines: ["Judged: nothing shows the brand knows this person yet."],
  threadLines: [NOW.slice(0, 16) + " | whatsapp | THEM: Hola, ¿a qué hora abren el domingo?"],
  strategy: "WHO",
};
const composeArgs = (channel: unknown, business: unknown) => [
  person,
  channel,
  { name: "Agent Base WhatsApp AI" },
  { brand: { name: "Agent Base" } },
  { exact: [{ id: "E1", label: "Price", value: "$20/month" }], neverGive: [] },
  { lines: [], ourMessages: 1 },
  undefined,
  "",
  { skip: true },
  { skip: true },
  { eventId: "ev-1" },
  NOW,
  NOW.slice(0, 10),
  who,
  business,
];

describe("the line answers as the writer's business", () => {
  it("the Lead event DAG reads the business between who-they-are and compose, and converts", () => {
    const dag = buildLeadFollowUpLeadsOnlyDag({ readFigures: false });
    expect(validateDAG(dag).errors).toEqual([]);
    expect(() => dagToOpenFlow(dag, "lead-event-merchant-demo")).not.toThrow();
    const order = dag.edges.map((e) => `${e.from}>${e.to}`);
    expect(order).toContain("who-they-are>business-role-plan");
    expect(order).toContain("business-role>compose");
    for (const id of BUSINESS_ROLE_NODE_IDS) expect(dag.nodes.some((n) => n.id === id)).toBe(true);
    const read = dag.nodes.find((n) => n.id === "business-site-read");
    expect(read?.config).toMatchObject({ service: "scraping", path: "/scrape", body: { enrich: false } });
    expect(dag.nodes.find((n) => n.id === "compose")?.inputMapping?.business).toBe("$ref:business-role.output");
  });

  it("asks Jev only on a WhatsApp line stating instructions, for a lead whose website is known", async () => {
    const plan = loadMain(BUSINESS_ROLE_PLAN_CODE);
    const yes = await plan(waChannel(DEMO_INSTRUCTIONS), timeline, null, person);
    expect(yes.skip).toBe(false);
    expect(yes.domain).toBe("panaderiasol.es");
    expect(yes.questions.role.type).toBe("noul");
    expect(yes.state.instructions).toBe(DEMO_INSTRUCTIONS);
    expect((await plan(waChannel(null), timeline, null, person)).skip).toBe(true);
    expect((await plan({ ...waChannel(DEMO_INSTRUCTIONS), channel: "email" }, timeline, null, person)).skip).toBe(true);
    const noSite = await plan(waChannel(DEMO_INSTRUCTIONS), { person: { organizations: [] }, items: [] }, null, { ...person, lead: {} });
    expect(noSite.skip).toBe(true);
    // Lead-service's relationship company domain also names it.
    const viaRel = await plan(waChannel(DEMO_INSTRUCTIONS), { person: {}, items: [] }, { company: { domain: "sol.es" } }, { ...person, lead: {} });
    expect(viaRel.domain).toBe("sol.es");
  });

  it("reads the site only on Jev's yes, and gives the writer its content read at run time", async () => {
    const plan = await loadMain(BUSINESS_ROLE_PLAN_CODE)(waChannel(DEMO_INSTRUCTIONS), timeline, null, person);
    const sitePlan = loadMain(BUSINESS_SITE_PLAN_CODE);
    const no = await sitePlan(plan, { answers: { role: { noul: 0.1 } } }, "brand-1");
    expect(no).toMatchObject({ read: false, skip: true });
    const site = await sitePlan(plan, { answers: { role: { noul: 0.93 } } }, "brand-1");
    expect(site).toMatchObject({ read: true, skip: false, url: "https://panaderiasol.es", brandIds: ["brand-1"] });
    await expect(sitePlan(plan, { answers: {} }, "brand-1")).rejects.toThrow(/Jev returned no answer/);

    const business = await loadMain(BUSINESS_ROLE_CODE)(site, { ok: true, result: { rawMarkdown: "# Panaderia Sol\nOpen Sunday 8:00 to 14:00. Pan de masa madre 3,50 EUR." } });
    expect(business).toMatchObject({ active: true, domain: "panaderiasol.es" });

    const out = await loadMain(COMPOSE_FOLLOW_UP_CODE)(...composeArgs(waChannel(DEMO_INSTRUCTIONS), business));
    expect(out.message).toContain("THEIR BUSINESS (panaderiasol.es");
    expect(out.message).toContain("Open Sunday 8:00 to 14:00");
    expect(out.systemPrompt).toContain("you are that business's assistant");
    expect(out.systemPrompt).toContain("never sell our offer in this message");

    // An unreadable site is said, never a blank.
    const unread = await loadMain(BUSINESS_ROLE_CODE)(site, { ok: false, status: 502 });
    const out2 = await loadMain(COMPOSE_FOLLOW_UP_CODE)(...composeArgs(waChannel(DEMO_INSTRUCTIONS), unread));
    expect(out2.message).toContain("the site could not be read");
  });

  it("without the line instruction the prompt is byte for byte the one of before", async () => {
    const inactive = await loadMain(BUSINESS_ROLE_CODE)({ read: false, skip: true }, { notCalled: true });
    expect(inactive).toEqual({ active: false });
    const compose = loadMain(COMPOSE_FOLLOW_UP_CODE);
    const off = await compose(...composeArgs(waChannel(null), inactive));
    const absent = await compose(...composeArgs(waChannel(null), undefined));
    expect(off).toEqual(absent);
    expect(off.systemPrompt).not.toContain("THEIR BUSINESS");
    expect(off.message).not.toContain("THEIR BUSINESS");
  });
});

describe("a question nobody can answer is handed to the brand's sales rep phone", () => {
  it("the schema offers escalate with the question, and finalize sends nothing to them", async () => {
    expect(FOLLOW_UP_RESPONSE_SCHEMA.properties.decision.enum).toContain("escalate");
    expect(FOLLOW_UP_RESPONSE_SCHEMA.required).toContain("question");
    const fin = await loadMain(FINALIZE_FOLLOW_UP_CODE)(
      { json: { decision: "escalate", question: "Do you deliver to Toledo?", subject: "", bodyHtml: "", message: "", nextFollowUpAt: inDays(2), nextFollowUpWhy: "team answers", reason: "no delivery fact" } },
      person,
      waChannel(null),
      "camp-1",
    );
    expect(fin).toMatchObject({ decision: "escalate", question: "Do you deliver to Toledo?", skipWhatsapp: true, skipEmail: true });
    await expect(
      loadMain(FINALIZE_FOLLOW_UP_CODE)({ json: { decision: "escalate", question: " ", nextFollowUpAt: inDays(2), nextFollowUpWhy: "x" } }, person, waChannel(null), "camp-1"),
    ).rejects.toThrow(/no question/);

    const out = await loadMain(OUTCOME_CODE)(person, { proceed: true, kind: "owed" }, waChannel(null), fin, { notCalled: true }, { notCalled: true }, NOW);
    expect(out.endKind).toBe("escalated");
    expect(out.delivery).toBeNull();
    expect(out.setDateBody.reason).toContain("Do you deliver to Toledo?");
    expect(out.rowBody).toEqual({ kind: "stopped", reason: "follow_up_escalated" });
  });

  it("the alert goes to the brand's sales rep phone on WhatsApp with what they asked", async () => {
    const final = { decision: "escalate", question: "Do you deliver to Toledo?" };
    const alert = await loadMain(COMPOSE_FOLLOW_UP_REP_ALERT_CODE)(final, person, waChannel(null), { brand: { salesRepPhone: "+33600000000" } }, timeline);
    expect(alert.skip).toBe(false);
    expect(alert.phone).toBe("+33600000000");
    expect(alert.text).toContain('They asked: "Do you deliver to Toledo?"');
    expect(alert.text).toContain("Lucia (+34600000001) wrote on whatsapp");
    expect(alert.text).toContain("I sent them nothing");
    expect(alert.idempotencyKey).toBe("follow-up:event:ev-1:rep-alert");

    const dag = buildLeadFollowUpLeadsOnlyDag({ readFigures: false });
    const send = dag.nodes.find((n) => n.id === "alert-rep");
    expect(send?.config).toMatchObject({ service: "crm", method: "POST", path: "/orgs/whatsapp/messages", omitHeaders: ["x-campaign-id"] });
    expect(send?.inputMapping?.["body.phone"]).toBe("$ref:compose-rep-alert.output.phone");
    expect(dag.nodes.some((n) => n.id === "end-run-escalated")).toBe(true);
  });

  it("no sales rep phone = said loudly, nothing sent; any other decision = nothing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const alert = loadMain(COMPOSE_FOLLOW_UP_REP_ALERT_CODE);
    const none = await alert({ decision: "escalate", question: "Q?" }, person, waChannel(null), { brand: { salesRepPhone: null } }, timeline);
    expect(none).toEqual({ skip: true, reason: "no_sales_rep_phone" });
    expect(err.mock.calls.some((c) => String(c[0]).includes("NOBODY was alerted"))).toBe(true);
    err.mockRestore();
    expect(await alert({ decision: "write" }, person, waChannel(null), { brand: { salesRepPhone: "+33600000000" } }, timeline)).toEqual({ skip: true });
  });

  it("the prompt tells the writer to escalate rather than guess", async () => {
    const out = await loadMain(COMPOSE_FOLLOW_UP_CODE)(...composeArgs(waChannel(null), undefined));
    expect(out.systemPrompt).toContain("set decision to escalate");
    expect(out.systemPrompt).toContain("never guess and never stall");
  });
});

describe("the answer is in the language the person wrote in", () => {
  it("a Spanish first message gets the instruction to answer in their own language, first message included", async () => {
    const out = await loadMain(COMPOSE_FOLLOW_UP_CODE)(...composeArgs(waChannel(null), undefined));
    expect(out.systemPrompt).toContain("Write in the language of the person's own last message to us, their very first message included");
    expect(out.message).toContain("THEM: Hola, ¿a qué hora abren el domingo?");
  });
});
