import { describe, it, expect } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { descriptionProblem } from "../../src/lib/plain-description.js";
import {
  ADMISSION_CODE,
  COMPOSE_CODE,
  FINALIZE_CODE,
  FOUNDER_HELLO_DESCRIPTION,
  FOUNDER_HELLO_ENDS,
  FOUNDER_HELLO_PIPE_ID,
  ONBOARDING_RECORD_SOURCE,
  ONBOARDING_RECORD_STEP,
  OUTCOME_CODE,
  PICK_PERSON_CODE,
  PLAN_CLAIM_CODE,
  REACH_PLAN_CODE,
  REACH_VERDICT_CODE,
  VOICE_PLAN_CODE,
  buildFounderHelloDag,
} from "../../src/lib/founder-hello-dag.js";
import { FOUNDER_HELLO_TEMPLATE, FOUNDER_HELLO_TEMPLATE_VARIABLES } from "../../src/lib/founder-hello-template.js";

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

const BRAND = "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb";
const CAMPAIGN = "camp-1";
const trigger = {
  eventId: "ev-1",
  triggerId: "whatsapp_number_given",
  leadId: "lead-1",
  person: { email: "chaim@beyondlogic.tech", name: "Chaim Tesser", phone: "+18485257858" },
  item: { kind: "phone_given", phone: "+18485257858", firstName: "Chaim", lastName: "Tesser" },
};
const claim = { found: true, followup: { id: "row-1", leadId: "lead-1", email: "chaim@beyondlogic.tech", brandId: BRAND } };

const record = {
  kind: "event",
  source: ONBOARDING_RECORD_SOURCE,
  channel: "account",
  direction: null,
  event: { step: ONBOARDING_RECORD_STEP, dateBasis: "latest_setup_change" },
  at: "2026-10-27T17:45:39.000Z",
  text: [
    "Website: beyondlogic.tech",
    "Offer: Fixed-Price Software Build (custom software delivered in 30 days for a fixed fee, full code ownership)",
    "Audience: Founders/CEOs, Service Firms (US service businesses, 10 to 100 employees)",
    "Budget: $10 per month",
    "Campaign: live",
    "Booking link: none",
  ].join("\n"),
};
const thread = {
  person: { personId: "p-1", phones: ["+18485257858"] },
  sources: [{ source: "matrix", status: "ok" }, { source: "onboarding", status: "ok" }],
  items: [
    { kind: "event", source: "posthog", text: "Get started step done · step: audience · who_they_sell_to: Founders, CEOs ..." },
    { kind: "message", source: "transactional", channel: "email", direction: "outbound", sentBy: "automation", at: "2026-10-27T17:38:27Z", text: "Revenue made easy. You run your business." },
    record,
  ],
};

describe("founder hello DAG", () => {
  const dag = buildFounderHelloDag();

  it("is a valid DAG that converts to OpenFlow and writes with the leg's best template and LLM", () => {
    expect(validateDAG(dag).valid).toBe(true);
    expect(() => dagToOpenFlow(dag, "f/founder_hello")).not.toThrow();
    const writer = dag.nodes.find((n) => n.id === "draft-message")!;
    expect(writer.inputMapping?.["body.model"]).toBe("$ref:writer-plan.output.model");
    expect(writer.inputMapping?.["body.type"]).toBe("$ref:template-head.output.template.type");
    expect(JSON.stringify(writer.config)).not.toMatch(/"model"|"type"/);
    expect(FOUNDER_HELLO_PIPE_ID).toBe("founder-hello|start_to_conversation");
  });

  it("states no brand, org or phone of ours anywhere (no per-brand special case, never the personal number)", () => {
    const text = JSON.stringify(dag);
    expect(text).not.toContain(BRAND);
    expect(text).not.toContain("f0420eb5");
    expect(text).not.toContain("+33770657585");
    expect(text).not.toMatch(/distribute\.you/i);
  });

  it("has one end-run arm per outcome kind, and nothing follows the hello", () => {
    const arms = dag.edges.filter((e) => e.from === "check-end").map((e) => e.condition);
    expect(arms).toHaveLength(FOUNDER_HELLO_ENDS.length);
    for (const k of FOUNDER_HELLO_ENDS) expect(arms).toContain(`results['outcome']?.endKind == '${k}'`);
    expect(JSON.stringify(dag)).not.toMatch(/schedule-by-email|nextDueAt|followup-date/);
  });

  it("plain description", () => {
    expect(descriptionProblem(FOUNDER_HELLO_DESCRIPTION)).toBeNull();
  });
});

describe("founder hello template", () => {
  it("declares exactly the tokens it uses", () => {
    expect([...new Set([...FOUNDER_HELLO_TEMPLATE.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort()).toEqual(FOUNDER_HELLO_TEMPLATE_VARIABLES.map((v) => v.name).sort());
  });

  it("never takes our own proposals or our earlier messages as their facts", () => {
    expect(FOUNDER_HELLO_TEMPLATE).toMatch(/suggested, not confirmed by them/);
    expect(FOUNDER_HELLO_TEMPLATE).toMatch(/Those messages are never facts/);
    expect(FOUNDER_HELLO_TEMPLATE).toMatch(/a campaign's stored name/);
  });

  it("holds ONE stance on introductions and never asks them to answer a question", () => {
    expect(FOUNDER_HELLO_TEMPLATE).not.toMatch(/never introduce yourself|NOT a first contact/i);
    expect(FOUNDER_HELLO_TEMPLATE).not.toMatch(/ask ONE question|one question mark/i);
    expect(FOUNDER_HELLO_TEMPLATE).not.toMatch(/[–—]/);
    expect(FOUNDER_HELLO_TEMPLATE).not.toMatch(/agency/i);
  });

  it("hands them to the assistant line when the brand has one, the founder staying reachable (owner 2026-10-28)", () => {
    expect(FOUNDER_HELLO_TEMPLATE).toMatch(/When THE ASSISTANT LINE names one/);
    expect(FOUNDER_HELLO_TEMPLATE).toMatch(/run their whole service through her directly/);
    expect(FOUNDER_HELLO_TEMPLATE).toMatch(/right here on this number if they ever need you/);
  });
});

describe("pick-person", () => {
  const pick = loadMain(PICK_PERSON_CODE);
  const plan = loadMain(PLAN_CLAIM_CODE);

  it("claims only when the trigger names someone", async () => {
    expect(await plan({ person: null }, undefined)).toEqual({ dryRun: false, skip: true });
    expect(await plan({ person: { email: "a@b.c" } }, undefined)).toEqual({ dryRun: false, skip: false });
    expect(await plan({ person: { email: "a@b.c" } }, true)).toEqual({ dryRun: true, skip: true });
  });

  it("greets the claimed person the trigger names, with the phone the trigger states", async () => {
    const p = await pick({ dryRun: false, skip: false }, claim, trigger, BRAND);
    expect(p).toMatchObject({ go: true, skip: false, rowId: "row-1", email: "chaim@beyondlogic.tech", phone: "+18485257858", firstName: "Chaim" });
    expect(p.timelineQuery).toEqual({ brandId: BRAND, personKey: "email:chaim@beyondlogic.tech" });
  });

  it("leaves another person's row alone", async () => {
    const other = { found: true, followup: { id: "row-2", email: "someone@else.com", brandId: BRAND } };
    expect(await pick({ dryRun: false, skip: false }, other, trigger, BRAND)).toMatchObject({ go: false, skip: true, end: "other_person" });
  });

  it("a run naming nobody is idle, a run whose person was not claimable fails", async () => {
    expect((await pick({ skip: true }, { notCalled: true }, null, BRAND)).end).toBe("nobody_due");
    expect((await pick({ skip: false }, { found: false }, trigger, BRAND)).end).toBe("unclaimed");
  });

  it("a dry run takes the trigger's person and claims nothing", async () => {
    const p = await pick({ dryRun: true, skip: true }, { notCalled: true }, trigger, BRAND);
    expect(p).toMatchObject({ go: true, dryRun: true, rowId: null, leadId: "lead-1", email: "chaim@beyondlogic.tech" });
  });
});

describe("admission", () => {
  const admission = loadMain(ADMISSION_CODE);
  const reachPlan = loadMain(REACH_PLAN_CODE);
  const person = { go: true, email: "chaim@beyondlogic.tech", phone: "+18485257858", brandId: BRAND };

  it("never greets twice", async () => {
    const sends = { sends: [{ campaignId: CAMPAIGN, status: "sent", sentAt: "2026-10-27T18:00:00Z" }] };
    expect(await admission(person, sends, thread, CAMPAIGN)).toMatchObject({ go: false, code: "already_greeted" });
  });

  it("a dry run reports the refusal and still writes, asking crm-service nothing that would block it", async () => {
    const talking = { ...thread, items: [...thread.items, { kind: "message", source: "matrix", direction: "outbound", text: "hi" }] };
    const a = await admission({ ...person, dryRun: true }, { sends: [] }, talking, CAMPAIGN);
    expect(a).toMatchObject({ go: true, skipTeam: true, notAdmitted: null, wouldNotAdmit: { reason: expect.stringMatching(/^already_talking/) } });
    expect((await reachPlan({ ...person, dryRun: true }, a, null)).reachBody.skipIfReplied).toBe(false);
  });

  it("never greets someone already talking with the brand on WhatsApp", async () => {
    const talking = { ...thread, items: [...thread.items, { kind: "message", source: "matrix", direction: "inbound", text: "hi" }] };
    expect(await admission(person, { sends: [] }, talking, CAMPAIGN)).toMatchObject({ go: false, code: "already_talking" });
  });

  it("asks crm-service about our staff and the brand's team, and skips both", async () => {
    const a = await admission(person, { sends: [] }, thread, CAMPAIGN);
    expect(a).toMatchObject({ go: true, skipTeam: false, teamBody: { brandId: BRAND, email: person.email, phone: person.phone } });
    expect(await reachPlan(person, a, { staff: true, ownTeam: false, matches: [] })).toMatchObject({ skip: true, code: "staff" });
    expect(await reachPlan(person, a, { staff: false, ownTeam: true, matches: [] })).toMatchObject({ skip: true, code: "own_team" });
    await expect(reachPlan(person, a, { notCalled: true })).rejects.toThrow(/staff/);
    const ok = await reachPlan(person, a, { staff: false, ownTeam: false });
    expect(ok).toMatchObject({ skip: false, reachBody: { brandId: BRAND, fromLine: "founder", email: person.email, phone: person.phone, skipIfReplied: true } });
  });
});

describe("reach-verdict", () => {
  const verdict = loadMain(REACH_VERDICT_CODE);
  const check = { reachable: false, code: "human_in_conversation", error: "Someone typed by hand", persona: { name: "Kevin", role: "Founder" } };

  it("a refusal ends a real run before any draft", async () => {
    expect(await verdict({ skip: false }, check, { dryRun: false })).toEqual({ skip: true, refused: { code: "human_in_conversation", reason: "Someone typed by hand" } });
  });

  it("a reachable answer carries the brand's assistant line (SOPHIE-SENDS-1028), or null when the brand states none", async () => {
    const ok = { reachable: true, fromAccount: "+33680478702", persona: { name: "Kevin", role: "Founder" } };
    const withAssistant = { ...ok, assistantLine: { phone: "+77776879632", persona: { name: "Sophie", role: "Distribute.you Assistant", instructions: null } } };
    expect(await verdict({ skip: false }, withAssistant, {})).toMatchObject({ skip: false, assistantLine: { phone: "+77776879632", name: "Sophie", role: "Distribute.you Assistant" } });
    expect(await verdict({ skip: false }, { ...ok, assistantLine: null }, {})).toMatchObject({ skip: false, assistantLine: null });
  });

  it("a dry run reports it and writes as the sending persona", async () => {
    expect(await verdict({ skip: false }, check, { dryRun: true })).toMatchObject({ skip: false, wouldRefuse: { code: "human_in_conversation" }, persona: { name: "Kevin" } });
  });
});

describe("voice-plan", () => {
  const voicePlan = loadMain(VOICE_PLAN_CODE);
  const person = { go: true, email: "chaim@beyondlogic.tech", phone: "+18485257858", brandId: BRAND };
  const tag = (...t: string[]) => t.map((x) => ({ tag: x }));
  const p = (id: string, tags: string[], outbound: number, extra = {}) => ({
    personId: id,
    emails: [`${id}@x.com`],
    phones: [],
    connectionTags: tag(...tags),
    presences: [{ source: "matrix", outboundCount: outbound }],
    ...extra,
  });

  it("copies the founder's rhythm from business contacts only, never a personal chat, a staff tie or the person greeted", async () => {
    const people = {
      people: [
        p("self", ["professional_to_brand"], 10, { emails: ["chaim@beyondlogic.tech"] }),
        p("friend", ["personal_to_user"], 30),
        p("kevin", ["personal_not_to_user", "professional_to_brand"], 80),
        p("not-biz", ["professional_to_brand"], 10, { notBusiness: true }),
        p("quiet", ["professional_to_brand"], 1),
        p("client-a", ["professional_to_brand"], 7),
        p("client-b", ["professional_to_brand", "professional_not_to_brand"], 12),
      ],
    };
    const { samples } = await voicePlan(person, people, { skip: false });
    expect(samples.filter((s: any) => !s.skip).map((s: any) => s.query.personId)).toEqual(["client-a", "client-b"]);
    expect(samples[0].teamBody).toEqual({ brandId: BRAND, email: "client-a@x.com" });
    expect(samples).toHaveLength(3);
    expect(samples[2]).toEqual({ skip: true, query: null, teamBody: null });
  });

  it("reads nothing when the person is not greeted (the people index was not called)", async () => {
    const { samples } = await voicePlan(person, { ok: false, skipped: true, notCalled: true }, { skip: true });
    expect(samples.every((s: any) => s.skip)).toBe(true);
  });
});

describe("compose", () => {
  const compose = loadMain(COMPOSE_CODE);
  const person = { go: true, email: "chaim@beyondlogic.tech", firstName: "Chaim", brandId: BRAND };
  const verdict = { skip: false, persona: { name: "Kevin", role: "Founder", instructions: null } };
  const brand = { brand: { name: "Distribute.you" } };

  it("writes from THEIR onboarding record only, never analytics lines, and labels our automated emails", async () => {
    const voice = {
      items: [
        { kind: "message", source: "matrix", direction: "outbound", at: "2026-10-27T18:00:50Z", text: "Good, I see that everything is setup perfectly", sentBy: "person" },
        { kind: "message", source: "matrix", direction: "outbound", at: "2026-10-27T19:01:12Z", text: "Feel free to reach out to me anytime", sentBy: "person" },
        { kind: "message", source: "matrix", direction: "outbound", at: "2026-10-27T20:00:00Z", text: "Automated bubble", sentBy: "automation" },
        { kind: "message", source: "matrix", direction: "outbound", at: "2026-10-27T21:00:00Z", text: "Voice message.ogg", sentBy: "person" },
      ],
    };
    const tests = {
      items: [{ kind: "message", source: "matrix", direction: "outbound", at: "2026-10-27T10:00:00Z", text: "Hi Sophie, how many campaigns run?", sentBy: "person" }],
    };
    const outsider = { staff: false, ownTeam: false };
    const out = await compose(person, verdict, thread, brand, null, "2026-10-27", voice, tests, null, outsider, { staff: true, ownTeam: false }, null);
    expect(out.message).not.toContain("Hi Sophie");
    expect(out.skip).toBe(false);
    expect(out.message).toContain("Offer: Fixed-Price Software Build");
    expect(out.message).toContain("Audience: Founders/CEOs, Service Firms");
    expect(out.message).not.toContain("who_they_sell_to");
    expect(out.message).toContain("US [automated email]: Revenue made easy.");
    expect(out.message).toContain("- Good, I see that everything is setup perfectly");
    expect(out.message).not.toContain("Automated bubble");
    expect(out.message).not.toContain("Voice message.ogg");
    expect(out.message).not.toMatch(/FACTS our client told us/);
    expect(out.variables).toMatchObject({ founderName: "Kevin", brandName: "Distribute.you" });
    expect(out.variables.writerRole).toContain("Kevin, Founder of Distribute.you");
    expect(out.message).toContain("THE ASSISTANT LINE: none");
  });

  it("names the brand's assistant line in the context when crm-service serves one", async () => {
    const v = { ...verdict, assistantLine: { phone: "+77776879632", name: "Sophie", role: "Distribute.you Assistant" } };
    const out = await compose(person, v, thread, brand, null, "2026-10-28", null, null, null);
    expect(out.message).toContain("THE ASSISTANT LINE: Sophie, Distribute.you Assistant, writes to them from +77776879632");
  });

  it("never writes a hello that cannot name what they set up", async () => {
    const bare = { ...thread, items: thread.items.filter((i) => i.source !== ONBOARDING_RECORD_SOURCE) };
    await expect(compose(person, verdict, bare, brand, null, "2026-10-27", null, null, null)).rejects.toThrow(/no onboarding record/);
    const failed = { ...thread, sources: [{ source: "onboarding", status: "failed", error: "client-service down" }] };
    await expect(compose(person, verdict, failed, brand, null, "2026-10-27", null, null, null)).rejects.toThrow(/could not read what/);
  });

  it("writes nothing for a person not admitted or not reachable", async () => {
    expect(await compose(person, { skip: true }, thread, brand, null, "2026-10-27", null, null, null)).toEqual({ skip: true, variables: null, message: null });
  });
});

describe("finalize + outcome", () => {
  const finalize = loadMain(FINALIZE_CODE);
  const outcome = loadMain(OUTCOME_CODE);
  const person = { go: true, rowId: "row-1", leadId: "lead-1", email: "chaim@beyondlogic.tech", phone: "+18485257858", brandId: BRAND };
  const draft = { decision: "write", message: "Hey Chaim, Kevin from Distribute.you\n\nSaw your campaign to founders of service firms — nice" };

  it("keys the send on the campaign and the PERSON, splits the bubbles, strips dashes", async () => {
    const f = await finalize({ skip: false }, draft, person, CAMPAIGN);
    expect(f.idempotencyKey).toBe(`founder-hello:${CAMPAIGN}:lead-1`);
    expect(f.sendBody.messages).toEqual(["Hey Chaim, Kevin from Distribute.you", "Saw your campaign to founders of service firms, nice"]);
    expect(f.sendBody).toMatchObject({ brandId: BRAND, fromLine: "founder", email: person.email, phone: person.phone, skipIfReplied: true });
  });

  it("a dry run writes and sends nothing", async () => {
    const f = await finalize({ skip: false }, draft, { ...person, dryRun: true }, CAMPAIGN);
    expect(f).toMatchObject({ skipSend: true, written: true, dryRun: true, sendBody: null });
    expect(await outcome({ ...person, dryRun: true }, {}, {}, f, { notCalled: true, skipped: true }, { wouldNotAdmit: { reason: "already_talking: x" } })).toMatchObject({
      endKind: "dry_run",
      skipRecord: true,
      wouldNotAdmit: { reason: "already_talking: x" },
    });
  });

  it("sent closes the row for good; a refusal is stated, never a failed run", async () => {
    const f = await finalize({ skip: false }, draft, person, CAMPAIGN);
    expect(await outcome(person, { skip: false }, { skip: false }, f, { ok: true })).toMatchObject({
      endKind: "sent",
      delivery: { state: "delivered" },
      rowReason: "founder_hello_sent",
      skipRecord: false,
    });
    expect(await outcome(person, { skip: false }, { skip: false }, f, { ok: false, skipped: true, code: "not_on_whatsapp", refusal: { error: "Not on WhatsApp" } })).toMatchObject({
      endKind: "refused",
      delivery: { state: "refused", code: "not_on_whatsapp" },
    });
    expect(await outcome(person, { skip: true, code: "staff", notAdmitted: { reason: "staff: x" } }, { skip: true }, { skipSend: true }, { notCalled: true, skipped: true })).toMatchObject({
      endKind: "not_admitted",
      notAdmitted: { reason: "staff: x" },
      rowReason: "founder_hello_staff",
    });
    expect(await outcome({ go: false, end: "other_person" }, null, null, null, null)).toMatchObject({ endKind: "other_person", skipRecord: true });
  });
});
