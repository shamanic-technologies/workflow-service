import { describe, it, expect, vi } from "vitest";
import { withWho } from "../helpers/who.js";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  COLD_WHATSAPP_OUTREACH_LEG_KEYS,
  COMPOSE_MESSAGE_PROMPT_CODE,
  CRM_WHATSAPP_SEND,
  FINALIZE_MESSAGE_CODE,
  HISTORY_PLAN_CODE,
  MESSAGE_RESPONSE_SCHEMA,
  READ_HISTORY_CODE,
  VOICE_SAMPLE_PEOPLE,
  PICK_PERSON_CODE,
  REACH_PLAN_CODE,
  RECORD_PLAN_CODE,
  PRIOR_CONTACT_CODE,
  WHATSAPP_FOLLOW_UP_STOPPED_REASON,
  WHATSAPP_OCCURRENCE_SENT_REASON,
  WHATSAPP_REFUSAL_CODES,
  buildColdWhatsappOutreachDag,
  coldWhatsappPipeIdOf,
} from "../../src/lib/cold-whatsapp-outreach-dag.js";
import { OCCURRENCE_PLAN_CODE } from "../../src/lib/occurrence-fact.js";
import { WHATSAPP_MEDIUM, nextDateStrategy, rightMomentStrategy } from "../../src/lib/right-moment.js";

const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

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
    const proactive = { serveNewLead: true };
    expect(holds(fresh.condition!, { "claim-followup": { found: false, reason: "nothing_due" }, occurrence: proactive })).toBe(true);
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
    const sends = dag.nodes.filter((n) => n.config?.service === CRM_WHATSAPP_SEND.service && n.config?.method === "POST");
    expect(sends.map((n) => n.id)).toEqual(["send-whatsapp"]);
    expect(dag.nodes.some((n) => n.config?.service === "email-gateway")).toBe(false);
    const send = mods.find((m) => m.id === "send_whatsapp")!;
    expect(send.value.input_transforms?.skipOnRefusalCodes).toEqual({ type: "static", value: [...WHATSAPP_REFUSAL_CODES] });
    expect(byId.get("send-whatsapp")?.retries).toBe(0);
    expect(byId.get("send-whatsapp")?.config).toMatchObject({ service: "crm", method: "POST", path: "/orgs/whatsapp/messages" });
    expect(byId.get("send-whatsapp")?.inputMapping).toEqual({
      body: "$ref:finalize-message.output.sendBody",
      skip: "$ref:finalize-message.output.skipSend",
    });
  });

  it("records strictly AFTER the send: a first message schedules the follow-up, a follow-up hands the row over", () => {
    expect(descendants(dag, "send-whatsapp")).toEqual(
      new Set(["record-plan", "check-record", "schedule-followup", "record-followup", "release-person", "end-run-unreachable", "end-run", "end-run-followup"]),
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
      { serveNewLead: true },
    );
    expect(out).toMatchObject({ kind: "first", step: 1, rowId: null, email: "b@x.com", brandId: "b-2", lead: { firstName: "Ben" } });
  });

  it("nobody, with lead-service's reason", async () => {
    const out = await pick({ found: false, reason: "nothing_due" }, undefined, { found: false, reason: "audience_exhausted" }, { serveNewLead: true });
    expect(out).toEqual({ kind: "nobody", skipSends: true, reason: "audience_exhausted" });
  });
});

describe("reading the history before writing", () => {
  const dag = buildColdWhatsappOutreachDag();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const brandId = "bbbbbbbb-1111-4111-8111-000000000001";
  const person = { kind: "first", step: 1, email: "Damien@X.com", brandId, lead: { firstName: "Damien" } };

  it("reads the person's thread, our sends to them, and the owner's other conversations BEFORE the writer, inside the person branch", () => {
    const before = [...descendants(dag, "gather-facts")];
    for (const id of ["voice-people", "history-plan", "person-thread", "read-history"]) expect(before).toContain(id);
    // What we already sent them is read once, before anything is paid for, and reused as the writer's history.
    expect(byId.get("read-history")?.inputMapping?.sends).toBe("$ref:prior-sends.output");
    expect(descendants(dag, "read-history").has("compose-message")).toBe(true);
    expect(descendants(dag, "compose-message").has("read-history")).toBe(false);
    expect(byId.get("compose-message")?.inputMapping?.history).toBe("$ref:read-history.output");
    expect(byId.get("person-thread")?.config).toMatchObject({ service: "crm", method: "GET", path: "/orgs/people/timeline" });
    // The person's own thread is never tolerated: unreadable = the person fails loud.
    expect(byId.get("person-thread")?.config?.tolerateFailure).toBeUndefined();
    expect(byId.get("prior-sends")?.config?.tolerateFailure).toBeUndefined();
    for (let n = 1; n <= VOICE_SAMPLE_PEOPLE; n++) {
      expect(byId.get(`voice-thread-${n}`)?.config).toMatchObject({ path: "/orgs/people/timeline", tolerateFailure: true });
      expect(byId.get("read-history")?.inputMapping?.[`v${n}`]).toBe(`$ref:voice-thread-${n}.output`);
    }
    const flow = dagToOpenFlow(dag, "cold-whatsapp-outreach-test");
    const branch = (flow.value.modules as Mod[]).find((m) => m.id === "check_person")!;
    const inBranch = allModules(branch.value.branches!.flatMap((b) => b.modules)).map((m) => m.id);
    for (const id of ["voice_people", "history_plan", "person_thread", "voice_thread_4", "read_history", "compose_message"]) expect(inBranch).toContain(id);
  });

  it("plans the reads: this person by email, the owner's real conversations as voice samples, free slots on this person", async () => {
    const recent = {
      people: [
        { personId: "p-self", emails: ["damien@x.com"], presences: [{ source: "matrix", outboundCount: 30 }] },
        { personId: "p-a", emails: ["a@y.com"], phones: [], presences: [{ source: "matrix", outboundCount: 12 }] },
        { personId: "p-cold", emails: ["c@y.com"], presences: [{ source: "matrix", outboundCount: 1 }] },
        { personId: "p-b", emails: [], phones: ["+15550001111"], presences: [{ source: "matrix", outboundCount: 3 }, { source: "matrix", outboundCount: 4 }] },
      ],
    };
    const out = (await loadMain(HISTORY_PLAN_CODE)(person, recent)) as { thread: unknown; sends: unknown; samples: { personId: string | null; timelineQuery: unknown; sendsQuery: unknown }[] };
    expect(out.thread).toEqual({ brandId, personKey: "email:damien@x.com" });
    expect(out.sends).toEqual({ brandId, email: "damien@x.com" });
    expect(out.samples).toHaveLength(VOICE_SAMPLE_PEOPLE);
    expect(out.samples.map((x) => x.personId)).toEqual(["p-a", "p-b", null, null]);
    expect(out.samples[0]).toMatchObject({ timelineQuery: { brandId, personId: "p-a" }, sendsQuery: { brandId, email: "a@y.com" } });
    expect(out.samples[1].sendsQuery).toEqual({ brandId, phone: "+15550001111" });
    expect(out.samples[2].timelineQuery).toEqual(out.thread);
    await expect(loadMain(HISTORY_PLAN_CODE)(person, {})).rejects.toThrow(/people list/);
  });

  const msg = (at: string, source: string, direction: string, text: string, extra: Record<string, unknown> = {}) => ({
    at, source, channel: source === "gmail" || source === "instantly" ? "email" : "whatsapp", kind: "message", direction, text, subject: null, ref: {}, ...extra,
  });
  const ok = [{ source: "gmail", status: "ok" }, { source: "matrix", status: "ok" }];

  it("gives the writer the whole thread, labels what our software sent, and learns the voice only from what the owner typed", async () => {
    const thread = {
      person: { personId: "p-self" },
      sources: [...ok, { source: "posthog", status: "failed" }],
      items: [
        msg("2026-10-06T13:01:20Z", "matrix", "inbound", "Pour l'instant j'ai aucune reponse positive"),
        msg("2026-10-06T13:03:07Z", "matrix", "outbound", "T'as dépensé combien ?"),
        { at: "2026-10-07T10:00:00Z", source: "clerk", channel: "web", kind: "event", direction: null, text: null, event: { step: "signup" } },
        msg("2026-10-08T09:00:00Z", "instantly", "outbound", "Quick question about growth"),
        msg("2026-10-12T14:42:17Z", "matrix", "outbound", "Hi Damien, Kevin here, founder of Distribute.you.", { ref: { eventId: "$bot" } }),
      ],
    };
    const sends = { sends: [{ eventId: "$bot", text: "Hi Damien, Kevin here, founder of Distribute.you." }] };
    const other = { person: { personId: "p-a" }, sources: ok, items: [msg("2026-10-01T00:00:00Z", "matrix", "outbound", "yo ça dit quoi"), msg("2026-10-01T00:01:00Z", "matrix", "inbound", "bien"), msg("2026-10-02T00:00:00Z", "gmail", "outbound", "Dear Sir, please find attached")] };
    const out = await loadMain(READ_HISTORY_CODE)(thread, sends, other, { sends: [] }, thread, sends, undefined, undefined, { ok: false, status: 500 }, undefined);
    expect(out.hasHistory).toBe(true);
    const lines = (out.threadLines as string[]).join("\n");
    expect(lines).toContain("THEM: Pour l'instant j'ai aucune reponse positive");
    expect(lines).toContain("OWNER: T'as dépensé combien ?");
    expect(lines).toContain("US [automated cold email]: Quick question about growth");
    expect(lines).toContain("US [automated WhatsApp]: Hi Damien, Kevin here");
    expect(out.eventLines).toEqual(["2026-10-07 10:00 | web | EVENT: signup (clerk)"]);
    expect(out.lastMessage).toMatchObject({ from: "US [automated WhatsApp]" });
    // His voice: what he typed in chat, this person first, then the others once each; never what our software sent,
    // and not his emails while he has chat messages.
    expect(out.voiceLines).toEqual(["to this person, whatsapp: T'as dépensé combien ?", "to someone else, whatsapp: yo ça dit quoi"]);
  });

  it("fails the person loud when the thread is unreadable, or when the owner's voice cannot be learned", async () => {
    const read = loadMain(READ_HISTORY_CODE);
    await expect(read(undefined, {})).rejects.toThrow(/thread did not come back/);
    await expect(read({ items: [], sources: [{ source: "matrix", status: "failed", error: "db down" }] }, {})).rejects.toThrow(/unreadable \(matrix: db down\)/);
    await expect(read({ items: [msg("2026-10-01T00:00:00Z", "matrix", "inbound", "hello")], sources: ok }, {})).rejects.toThrow(/voice/);
  });

  it("a person nobody ever wrote to has no history, and still gets the owner's voice from his other conversations", async () => {
    const other = { person: { personId: "p-a" }, sources: ok, items: [msg("2026-10-01T00:00:00Z", "gmail", "outbound", "Hey, thanks for the call")] };
    const out = await loadMain(READ_HISTORY_CODE)({ person: { personId: "p-new" }, sources: ok, items: [] }, { sends: [] }, other, { sends: [] });
    expect(out).toMatchObject({ hasHistory: false, ownerWroteThem: false, lastMessage: null, threadLines: [] });
    expect(out.voiceLines).toEqual(["to someone else, email: Hey, thanks for the call"]);
  });
});

describe("composing the message", () => {
  const offer = { name: "Revenue made easy" };
  const brand = { brand: { name: "Distribute.you" } };
  const rep = { salesRepFirstName: "Kevin", salesRepRole: null };
  const facts = { exact: [{ id: "E1", label: "pricing", value: "The platform is free" }], neverGive: [] };
  const first = { kind: "first", step: 1, email: "a@x.com", lead: { firstName: "Ana", organization: { name: "Acme" } } };
  const fresh = { hasHistory: false, threadLines: [], eventLines: [], lastMessage: null, olderMessagesOmitted: 0, voiceLines: ["to someone else, whatsapp: yo ça dit quoi"] };
  const talked = {
    hasHistory: true,
    threadLines: ["2026-10-06 13:01 | whatsapp | THEM: Pour l'instant j'ai aucune reponse positive", "2026-10-06 13:03 | whatsapp | OWNER: T'as dépensé combien ?"],
    eventLines: ["2026-10-07 10:00 | web | EVENT: signup (clerk)"],
    lastMessage: { at: "2026-10-06T13:03:07Z", from: "OWNER", text: "T'as dépensé combien ?" },
    olderMessagesOmitted: 12,
    voiceLines: ["to this person, whatsapp: T'as dépensé combien ?"],
  };
  const compose = withWho(loadMain(COMPOSE_MESSAGE_PROMPT_CODE), 10);

  it("explains the strategy, follows the instruction verbatim, and writes as the brand's rep", async () => {
    const out = await compose(first, "Ask what they tried to grow signups.", offer, brand, rep, facts, fresh, "2026-10-12");
    const system = out.systemPrompt as string;
    expect(system).toContain("WHAT KEVIN WANTS FROM THIS CONVERSATION");
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

  it("a person never written to gets a first message, still in the owner's voice", async () => {
    const out = await compose(first, null, offer, brand, rep, facts, fresh, "2026-10-12");
    expect(out.systemPrompt as string).toContain("This is a FIRST message");
    expect(out.systemPrompt as string).not.toContain("NOT a first contact");
    expect(out.message as string).toContain("(no message ever exchanged)");
    expect(out.message as string).toContain("HIS OWN MESSAGES (how Kevin writes):\n- to someone else, whatsapp: yo ça dit quoi");
  });

  it("a person with a prior thread gets a continuation from where it stopped, never a re-introduction", async () => {
    const out = await compose(first, null, offer, brand, rep, facts, talked, "2026-10-12");
    const system = out.systemPrompt as string;
    expect(system).toContain("This is NOT a first contact: never introduce yourself");
    expect(system).toContain("Pick the conversation back up from where it stopped");
    expect(system).toContain("Write in the language he uses with THIS person");
    expect(system).not.toContain("This is a FIRST message");
    const message = out.message as string;
    expect(message).toContain("THE THREAD with this person");
    expect(message).toContain("(12 older messages not shown)");
    expect(message).toContain("OWNER: T'as dépensé combien ?");
    expect(message).toContain("THE CONVERSATION STOPPED HERE: OWNER wrote last, 2026-10-06: T'as dépensé combien ?");
    expect(message).toContain("- to this person, whatsapp: T'as dépensé combien ?");
    expect(message).toContain("EVENT: signup (clerk)");
  });

  it("a follow-up look plays the shared right-moment game: no fixed count, no fixed delay, stop only on their words", async () => {
    const out = await compose({ ...first, kind: "followup", step: 2 }, null, offer, brand, rep, facts, talked, "2026-10-12");
    const system = out.systemPrompt as string;
    expect(system).toContain("THIS IS A FOLLOW-UP LOOK");
    expect(system).toContain(rightMomentStrategy(WHATSAPP_MEDIUM));
    expect(system).toContain(nextDateStrategy(WHATSAPP_MEDIUM));
    expect(system).toContain("Never stop on silence");
    expect(system).not.toContain("ONE follow-up");
    expect(system).not.toContain("no other message after this one");
    expect(system).not.toMatch(/[–—]/);
    expect(out.message as string).toContain("(none: follow the strategy)");
    expect(out.message as string).toMatch(/\nNOW: \d{4}-\d{2}-\d{2}T/);
  });

  it("a first message writes and states the first follow-up look's date", async () => {
    const out = await compose(first, null, offer, brand, rep, facts, fresh, "2026-10-12");
    expect(out.systemPrompt as string).toContain("Set decision to write: this message goes out now.");
    expect(out.systemPrompt as string).toContain("That date is the first follow-up look");
    expect(out.systemPrompt as string).not.toContain("THIS IS A FOLLOW-UP LOOK");
  });

  it("never writes without a brand name, an offer name, or the history", async () => {
    await expect(compose(first, null, {}, brand, rep, facts, fresh, "x")).rejects.toThrow(/offer/);
    await expect(compose(first, null, offer, {}, rep, facts, fresh, "x")).rejects.toThrow(/brand/);
    await expect(compose(first, null, offer, brand, rep, facts, undefined, "x")).rejects.toThrow(/blind/);
    await expect(compose(first, null, offer, brand, rep, facts, { ...fresh, voiceLines: [] }, "x")).rejects.toThrow(/blind/);
  });
});

describe("finalizing and recording", () => {
  it("strips dashes, checks the next date before the send, and keys a first message per person", async () => {
    const fin = loadMain(FINALIZE_MESSAGE_CODE);
    const next = inDays(4);
    const out = await fin({ json: { decision: "write", message: "Hi Ana — quick one, 3–5 people?", nextFollowUpAt: next, nextFollowUpWhy: "w" } }, { kind: "first", leadId: "l-1", step: 1 }, "c-1");
    expect(out.text).toBe("Hi Ana, quick one, 3-5 people?");
    expect(out.idempotencyKey).toBe("cold-whatsapp-outreach:c-1:l-1:1");
    expect(out.skipIfReplied).toBe(false);
    expect(out.skipSend).toBe(false);
    expect(out.nextFollowUpAt).toBe(next);
    await expect(fin({ json: { decision: "write", message: "  ", nextFollowUpAt: inDays(4) } }, { kind: "first", leadId: "l-1", step: 1 }, "c-1")).rejects.toThrow(/empty/);
    // No usable next date: thrown BEFORE the send, never a message whose next look cannot be recorded.
    await expect(fin({ json: { decision: "write", message: "Hi", nextFollowUpAt: "" } }, { kind: "first", leadId: "l-1", step: 1 }, "c-1")).rejects.toThrow(/not a date/);
    await expect(fin({ json: { decision: "write", message: "Hi", nextFollowUpAt: inDays(-1) } }, { kind: "first", leadId: "l-1", step: 1 }, "c-1")).rejects.toThrow(/not in the future/);
    await expect(fin({ json: { decision: "write", message: "Hi", nextFollowUpAt: inDays(400) } }, { kind: "first", leadId: "l-1", step: 1 }, "c-1")).rejects.toThrow(/365/);
    // Only a follow-up look may wait or stop.
    await expect(fin({ json: { decision: "later", message: "", nextFollowUpAt: inDays(4) } }, { kind: "first", leadId: "l-1", step: 1 }, "c-1")).rejects.toThrow(/only a follow-up/);
  });

  it("a sent first message schedules the first follow-up look at the model's date; a refused one records nothing and is named", async () => {
    const plan = loadMain(RECORD_PLAN_CODE);
    const at = new Date(Date.parse(inDays(5))).toISOString();
    const sent = await plan({ kind: "first", email: "a@x.com" }, { ok: true }, "2026-10-12", { skip: false }, { decision: "write", nextFollowUpAt: at });
    expect(sent).toMatchObject({ action: "schedule", dueAt: at, email: "a@x.com" });
    await expect(plan({ kind: "first", email: "a@x.com" }, { ok: true }, "x", { skip: false }, {})).rejects.toThrow(/no next follow-up date/);
    const refused = await plan({ kind: "first", email: "a@x.com" }, { ok: false, skipped: true, code: "whatsapp_not_linked" }, "2026-10-12");
    expect(refused).toEqual({
      action: "none",
      outcome: "unreachable",
      code: "whatsapp_not_linked",
      delivery: { state: "refused", code: "whatsapp_not_linked", reason: "whatsapp_not_linked" },
    });
    expect(sent.delivery).toEqual({ state: "delivered" });
  });

  it("a first message refused about the CHANNEL releases the person to the brand's pipes that can reach them", async () => {
    const plan = loadMain(RECORD_PLAN_CODE);
    for (const code of ["no_phone_known", "not_on_whatsapp"]) {
      const out = await plan({ kind: "first", email: "a@x.com" }, { ok: false, skipped: true, code }, "2026-10-12");
      expect(out).toEqual({ action: "release", outcome: "unreachable", code, email: "a@x.com", delivery: { state: "refused", code, reason: code } });
    }
    const release = buildColdWhatsappOutreachDag().nodes.find((n) => n.id === "release-person");
    expect(release?.config).toMatchObject({
      service: "lead",
      method: "POST",
      path: "/orgs/campaigns/{campaignId}/leads/channel-refusals",
    });
    expect(release?.inputMapping).toMatchObject({
      "body.email": "$ref:record-plan.output.email",
      "body.code": "$ref:record-plan.output.code",
    });
  });

  it("a refused follow-up about the PERSON is handed over; about the BRAND's WhatsApp it stays followed up", async () => {
    const plan = loadMain(RECORD_PLAN_CODE);
    const at = new Date(Date.parse(inDays(3))).toISOString();
    const final = { decision: "write", nextFollowUpAt: at };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const replied = await plan({ kind: "followup", rowId: "r" }, { skipped: true, code: "person_replied" }, "x", { skip: false }, final);
    expect(replied).toMatchObject({ action: "record", body: { kind: "handed", reason: "whatsapp_person_replied" } });
    for (const code of ["whatsapp_not_linked", "whatsapp_not_connected"]) {
      const down = await plan({ kind: "followup", rowId: "r" }, { skipped: true, code }, "x", { skip: false }, final);
      expect(down).toMatchObject({ action: "record", outcome: "deferred", body: { kind: "scheduled", dueAt: at } });
    }
    spy.mockRestore();
  });
});

describe("answering a trigger occurrence (signed up, still not paid 24 hours later)", () => {
  const dag = buildColdWhatsappOutreachDag();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const person = { email: "kevin@distribute.you", name: "Kevin", phone: "+33600000000", crmContact: null };
  const trigger = { eventId: "ev-1", triggerId: "signed_up_not_paid_24h", leadId: "l-1", item: null, person };
  const claim = { found: true, followup: { id: "row-1", leadId: "l-1", email: "Kevin@distribute.you", brandId: "b-1", dueAt: "2026-10-14T10:00:00Z" } };
  const detail = { leadDetail: { lead: { firstName: "Kevin" } } };
  const plan = loadMain(OCCURRENCE_PLAN_CODE);
  const pick = loadMain(PICK_PERSON_CODE);

  it("an occurrence run never serves a new lead: nobody due ends idle", async () => {
    const answering = await plan(trigger, null);
    const fresh = dag.edges.find((e) => e.from === "check-due" && e.to === "serve-lead")!;
    expect(holds(fresh.condition!, { "claim-followup": { found: false }, occurrence: answering })).toBe(false);
    expect(holds(fresh.condition!, { "claim-followup": { found: false }, occurrence: await plan(undefined, null, false) })).toBe(true);
    const out = await pick({ found: false, reason: "nothing_due" }, undefined, undefined, answering);
    expect(out).toEqual({ kind: "nobody_due", skipSends: true, reason: "nothing_due" });
    const idle = dag.edges.find((e) => e.from === "check-person" && e.to === "end-run-nobody-due")!;
    expect(holds(idle.condition!, { "pick-person": out })).toBe(true);
    expect(byId.get("end-run-nobody-due")?.config?.body).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
  });

  it("the claimed person is owed ONE message, never treated as a follow-up, with the phone the occurrence names", async () => {
    const out = await pick(claim, detail, undefined, await plan(trigger, null));
    expect(out).toMatchObject({ kind: "occurrence", step: 1, rowId: "row-1", email: "Kevin@distribute.you", phone: "+33600000000", dueAt: "2026-10-14T10:00:00Z" });
    const write = dag.edges.find((e) => e.from === "check-person" && e.to === "offer-economics")!;
    expect(holds(write.condition!, { "pick-person": out, "prior-contact": { alreadyWritten: false } })).toBe(true);
    // The occurrence names someone else: no phone carried over.
    const other = await pick(claim, detail, undefined, await plan({ ...trigger, person: { email: "x@y.com", phone: "+1" } }, null));
    expect(other).toMatchObject({ kind: "occurrence", phone: null });
  });

  it("writes from the fact, says it is the only message, and keys the send on the occurrence", async () => {
    const triggerType = { name: "Signup Not Paid", line: "Signed up, still not a paid client 24 hours later.", fromStepName: "Signup", params: { afterStep: "signup", minutes: 1440, unlessStep: "paid_client" } };
    const p = await pick(claim, detail, undefined, await plan(trigger, null));
    const fresh = { hasHistory: false, threadLines: [], eventLines: [], lastMessage: null, olderMessagesOmitted: 0, voiceLines: ["to someone else, whatsapp: yo"] };
    const out = await withWho(loadMain(COMPOSE_MESSAGE_PROMPT_CODE), 10)(
      p, null, { name: "Revenue made easy" }, { brand: { name: "Distribute.you" } }, { salesRepFirstName: "Kevin" }, { exact: [], neverGive: [] }, fresh, "2026-10-14", await plan(trigger, null), triggerType,
    );
    expect(out.message as string).toContain("WHY WE WRITE NOW:\nTrigger: Signup Not Paid");
    expect(out.message as string).toContain("minutes = 1440");
    expect(out.systemPrompt as string).toContain("This is the ONE message this fact gets");
    expect(out.systemPrompt as string).not.toContain("This is the ONE follow-up");
    expect((out.systemPrompt as string) + (out.message as string)).not.toMatch(/[–—]/);

    const fin = loadMain(FINALIZE_MESSAGE_CODE);
    const sent = await fin({ json: { decision: "write", message: "Hi Kevin", nextFollowUpAt: "" } }, p, "c-1", { skip: false }, trigger);
    expect(sent).not.toHaveProperty("nextFollowUpAt");
    expect(sent.idempotencyKey).toBe("cold-whatsapp-outreach:event:ev-1");
    expect(sent.skipIfReplied).toBe(false);
    expect(sent.sendBody).toEqual({ email: "Kevin@distribute.you", brandId: "b-1", text: "Hi Kevin", idempotencyKey: "cold-whatsapp-outreach:event:ev-1", skipIfReplied: false, phone: "+33600000000" });
    // A redelivery re-files the person with a new due date: same occurrence, same key, nothing sent twice.
    const again = await fin({ json: { decision: "write", message: "Hi Kevin again" } }, { ...p, dueAt: "2026-10-14T10:02:00Z" }, "c-1", { skip: false }, trigger);
    expect(again.idempotencyKey).toBe(sent.idempotencyKey);
    // No phone named: the body carries none (crm-service refuses a null), crm-service reads the CRM's.
    const noPhone = await fin({ json: { decision: "write", message: "Hi" } }, { ...p, phone: null }, "c-1", { skip: false }, trigger);
    expect(noPhone.sendBody).not.toHaveProperty("phone");
  });

  it("is handed for good once sent; refused, it is stopped (a later occurrence may reach them) and the run ends normally", async () => {
    const record = loadMain(RECORD_PLAN_CODE);
    const p = { kind: "occurrence", rowId: "row-1", email: "kevin@distribute.you" };
    expect(await record(p, { ok: true }, "x", { skip: false })).toEqual({ action: "record", outcome: "sent", body: { kind: "handed", reason: WHATSAPP_OCCURRENCE_SENT_REASON }, delivery: { state: "delivered" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The occurrence's truth on /end-run (PUSHED-TRUTH-1015): crm-service's refusal, its sentence verbatim.
    const refusedSend = { ok: false, skipped: true, code: "not_on_whatsapp", reason: "+336 is not on WhatsApp" };
    expect(await record(p, refusedSend, "x", { skip: false }))
      .toEqual({
        action: "record",
        outcome: "unreachable",
        code: "not_on_whatsapp",
        body: { kind: "stopped", reason: "whatsapp_not_on_whatsapp" },
        delivery: { state: "refused", code: "not_on_whatsapp", reason: "+336 is not on WhatsApp" },
      });
    spy.mockRestore();
    expect(dag.edges).toContainEqual({ from: "record-followup", to: "end-run-followup" });
    for (const id of ["end-run", "end-run-followup", "end-run-unreachable"]) {
      expect(dag.nodes.find((n) => n.id === id)?.inputMapping).toEqual({ "body.delivery": "$ref:record-plan.output.delivery" });
    }
  });
});

describe("no phone known: nothing is drafted, nothing is sent", () => {
  const dag = buildColdWhatsappOutreachDag();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const reach = loadMain(REACH_PLAN_CODE);

  it("decides before the model writes, from the occurrence's phone or the CRM person's", async () => {
    expect(descendants(dag, "reach-plan").has("draft-message")).toBe(true);
    expect(byId.get("draft-message")?.inputMapping?.skip).toBe("$ref:reach-plan.output.skip");
    expect(byId.get("send-whatsapp")?.inputMapping?.skip).toBe("$ref:finalize-message.output.skipSend");
    expect(byId.get("reach-plan")?.inputMapping).toEqual({
      person: "$ref:pick-person.output",
      thread: "$ref:person-thread.output",
      sends: "$ref:prior-sends.output",
      campaignId: "$ref:flow_input.campaignId",
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reach({ email: "a@x.com" }, { person: { phones: [] } })).toMatchObject({ skip: true, code: "no_phone_known" });
    expect(spy.mock.calls[0]?.[0]).toContain("no_phone_known");
    spy.mockRestore();
    expect(await reach({ email: "a@x.com", phone: "+33600000000" }, { person: { phones: [] } })).toEqual({ skip: false, code: null, skipIfReplied: false });
    expect(await reach({ email: "a@x.com" }, { person: { phones: ["+33600000000"] } })).toEqual({ skip: false, code: null, skipIfReplied: false });
    // A thread read stating no phone list decides nothing: crm-service answers.
    expect(await reach({ email: "a@x.com" }, { person: {} })).toEqual({ skip: false, code: null, skipIfReplied: false });
  });

  it("records exactly what crm-service's own refusal would: a first message releases the person, an occurrence stops the row", async () => {
    const notCalled = { ok: false, skipped: true, notCalled: true };
    const fin = await loadMain(FINALIZE_MESSAGE_CODE)({ ok: false, skipped: true, notCalled: true }, { kind: "first", leadId: "l-1", step: 1 }, "c-1", { skip: true, code: "no_phone_known" });
    expect(fin).toMatchObject({ skipped: true, sendBody: null });
    const record = loadMain(RECORD_PLAN_CODE);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await record({ kind: "first", email: "a@x.com" }, notCalled, "x", { skip: true, code: "no_phone_known", reason: "No phone." }))
      .toEqual({ action: "release", outcome: "unreachable", code: "no_phone_known", email: "a@x.com", delivery: { state: "refused", code: "no_phone_known", reason: "No phone." } });
    expect(await record({ kind: "occurrence", rowId: "r", email: "a@x.com" }, notCalled, "x", { skip: true, code: "no_phone_known" }))
      .toMatchObject({ action: "record", body: { kind: "stopped", reason: "whatsapp_no_phone_known" } });
    spy.mockRestore();
  });
});

// WA-SPENT-NOTHING-SENT-1014: lead-service re-served the same 8 people 16 to 18 times each on campaign 4af21454 and
// every re-serve paid a full read + an Opus draft that crm-service then answered as a duplicate: 147 drafts, 8 messages.
describe("a person this campaign already wrote to is never read or written again", () => {
  const dag = buildColdWhatsappOutreachDag();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const campaignId = "4af21454-ae93-4d62-8528-cc95081145ac";
  const prior = loadMain(PRIOR_CONTACT_CODE);
  const first = { kind: "first", step: 1, email: "imenez@gmail.com", brandId: "b" };
  const sent = { sendId: "s1", status: "sent", campaignId, sentAt: "2026-10-12T14:43:32.913Z" };

  it("reads crm-service's sends right after the person is picked, before anything paid", () => {
    expect(byId.get("prior-sends")?.config).toMatchObject({ service: "crm", method: "GET", path: "/orgs/whatsapp/messages" });
    expect(byId.get("prior-sends")?.inputMapping).toMatchObject({
      "query.brandId": "$ref:pick-person.output.brandId",
      "query.email": "$ref:pick-person.output.email",
      skip: "$ref:pick-person.output.skipSends",
    });
    expect(dag.edges).toContainEqual({ from: "pick-person", to: "prior-sends" });
    expect(dag.edges).toContainEqual({ from: "prior-contact", to: "check-person" });
    const paid = descendants(dag, "offer-economics");
    expect(paid.has("draft-message")).toBe(true);
    expect(descendants(dag, "prior-contact").has("draft-message")).toBe(true);
    expect(validateDAG(dag).valid).toBe(true);
  });

  it("a first message to someone this campaign already wrote to (sent or sending) ends the run idle, nothing drafted", async () => {
    for (const status of ["sent", "sending"]) {
      expect(await prior(first, { sends: [{ ...sent, status }] }, campaignId)).toMatchObject({ alreadyWritten: true, sendId: "s1" });
    }
    const results = { "pick-person": first, "prior-contact": { alreadyWritten: true } };
    const arms = dag.edges.filter((e) => e.from === "check-person");
    expect(arms.filter((e) => holds(e.condition!, results)).map((e) => e.to)).toEqual(["end-run-already-written"]);
    const end = byId.get("end-run-already-written")?.config?.body;
    expect(end).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
  });

  it("writes when the only sends are another campaign's, refused or failed, or none", async () => {
    const other = [
      { ...sent, campaignId: "other" },
      { ...sent, status: "refused" },
      { ...sent, status: "failed" },
    ];
    expect(await prior(first, { sends: other }, campaignId)).toEqual({ alreadyWritten: false });
    expect(await prior(first, { sends: [] }, campaignId)).toEqual({ alreadyWritten: false });
    const results = { "pick-person": first, "prior-contact": { alreadyWritten: false } };
    const arms = dag.edges.filter((e) => e.from === "check-person");
    expect(arms.filter((e) => holds(e.condition!, results)).map((e) => e.to)).toEqual(["offer-economics"]);
  });

  it("a follow-up is never a re-serve: its own first message is what made it due", async () => {
    const followup = { ...first, kind: "followup", step: 2 };
    expect(await prior(followup, { sends: [sent] }, campaignId)).toEqual({ alreadyWritten: false });
    const arms = dag.edges.filter((e) => e.from === "check-person");
    const results = { "pick-person": followup, "prior-contact": { alreadyWritten: false } };
    expect(arms.filter((e) => holds(e.condition!, results)).map((e) => e.to)).toEqual(["offer-economics"]);
  });

  it("nobody served: the sends read is skipped and the run ends on the no-lead end-run", () => {
    const results = { "pick-person": { kind: "nobody", skipSends: true }, "prior-contact": { alreadyWritten: false } };
    const arms = dag.edges.filter((e) => e.from === "check-person");
    expect(arms.filter((e) => holds(e.condition!, results)).map((e) => e.to)).toEqual(["end-run-no-lead"]);
  });

  it("an unreadable sends answer fails loud rather than writing blind", async () => {
    await expect(prior(first, { ok: false }, campaignId)).rejects.toThrow(/no sends list/);
  });
});

describe("a reactive (or unknown) unit never buys a stranger", () => {
  const dag = buildColdWhatsappOutreachDag();
  const plan = loadMain(OCCURRENCE_PLAN_CODE);
  const pick = loadMain(PICK_PERSON_CODE);
  const fresh = dag.edges.find((e) => e.from === "check-due" && e.to === "serve-lead")!;
  const idle = dag.edges.find((e) => e.from === "check-person" && e.to === "end-run-nobody-due")!;

  it("reads campaign-service's verdict off /start-run", () => {
    expect(dag.nodes.find((n) => n.id === "occurrence")?.inputMapping?.reactive).toBe("$ref:start-run.output.reactive");
  });

  it("only reactive === false serves a new person; true, null or absent end idle with nobody due", async () => {
    for (const [reactive, serves] of [[false, true], [true, false], [null, false], [undefined, false]] as const) {
      const occurrence = await plan(undefined, null, reactive);
      expect(occurrence.serveNewLead).toBe(serves);
      expect(holds(fresh.condition!, { "claim-followup": { found: false, reason: "nothing_due" }, occurrence })).toBe(serves);
      if (!serves) {
        const out = await pick({ found: false, reason: "nothing_due" }, undefined, undefined, occurrence);
        expect(out).toEqual({ kind: "nobody_due", skipSends: true, reason: "nothing_due" });
        expect(holds(idle.condition!, { "pick-person": out })).toBe(true);
      }
    }
    expect(dag.nodes.find((n) => n.id === "end-run-nobody-due")?.config?.body).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
  });

  it("a person due on the unit's own queue is still answered, reactive or not", async () => {
    const due = dag.edges.find((e) => e.from === "check-due" && e.to === "lead-detail")!;
    expect(holds(due.condition!, { "claim-followup": { found: true } })).toBe(true);
    const out = await pick({ found: true, followup: { id: "r", email: "a@x.com" } }, { leadDetail: { lead: {} } }, undefined, await plan(undefined, null, true));
    expect(out).toMatchObject({ kind: "followup" });
  });
});

// WA-FOLLOWUP-LOOP-1015 (owner 2026-10-15): « une campagne qui output non seulement un message à envoyer mais une date
// de followup. Puis sur trigger de ce followup, check la conv et décide s'il écrit ou s'arrête car déjà répondu. Si pas
// répondu, alors écrit et choisit une autre date de followup. Ainsi de suite jusqu'à l'infini. »
describe("a WhatsApp conversation is followed up until the person answers, like email", () => {
  const dag = buildColdWhatsappOutreachDag();
  const pick = loadMain(PICK_PERSON_CODE);
  const reach = loadMain(REACH_PLAN_CODE);
  const fin = loadMain(FINALIZE_MESSAGE_CODE);
  const record = loadMain(RECORD_PLAN_CODE);
  const noOccurrence = { answering: false, serveNewLead: true };
  const detail = { leadDetail: { lead: { firstName: "Ana" } } };
  const campaignId = "c-1";
  const firstSentAt = "2026-10-10T09:00:00.000Z";
  const sends = { sends: [{ sendId: "s-1", campaignId, status: "sent", sentAt: firstSentAt, text: "Hey Ana" }] };
  const ourFirst = { kind: "message", direction: "outbound", source: "matrix", channel: "whatsapp", at: firstSentAt, text: "Hey Ana" };
  const quietThread = { person: { phones: ["+33600000000"] }, items: [ourFirst] };

  /** One look: claim a due row, read, decide, send (or not), record. Returns what lead-service is told. */
  async function look(dueAt: string, thread: unknown, draftJson: Record<string, unknown> | null) {
    const claim = { found: true, followup: { id: "row-1", leadId: "l-1", email: "ana@x.com", brandId: "b-1", dueAt } };
    const person = await pick(claim, detail, undefined, noOccurrence);
    const r = await reach(person, thread, sends, campaignId);
    // draft-message is skipped when reach-plan says so (http.call answers notCalled).
    const draft = r.skip === true ? { ok: false, skipped: true, notCalled: true } : { json: draftJson };
    const final = await fin(draft, person, campaignId, r, undefined);
    const send = final.skipSend === true ? { ok: false, skipped: true, notCalled: true } : { ok: true, status: "sent" };
    const rec = await record(person, send, "2026-10-15", r, final);
    return { person, reach: r, final, send, record: rec };
  }

  it("a follow-up look carries its due date from the queue claim", async () => {
    const p = await pick({ found: true, followup: { id: "row-1", leadId: "l-1", email: "ana@x.com", brandId: "b-1", dueAt: "2026-10-13T09:00:00Z" } }, detail, undefined, noOccurrence);
    expect(p).toMatchObject({ kind: "followup", rowId: "row-1", dueAt: "2026-10-13T09:00:00Z" });
  });

  it("write: sends in the same WhatsApp conversation, outputs the next date, and re-arms the row (acted, due again)", async () => {
    const next = inDays(4);
    const out = await look("2026-10-13T09:00:00.000Z", quietThread, { decision: "write", message: "Still curious, Ana?", reason: "r", nextFollowUpAt: next, nextFollowUpWhy: "w" });
    expect(out.final).toMatchObject({ decision: "write", skipSend: false, skipIfReplied: true });
    expect(out.final.sendBody).toMatchObject({ email: "ana@x.com", brandId: "b-1", text: "Still curious, Ana?", skipIfReplied: true });
    expect(out.record).toEqual({
      action: "record",
      outcome: "sent",
      body: { kind: "acted", nextDueAt: new Date(Date.parse(next)).toISOString() },
      delivery: { state: "delivered" },
    });
    const toRecord = dag.edges.find((e) => e.from === "check-record" && e.to === "record-followup")!;
    expect(holds(toRecord.condition!, { "record-plan": out.record })).toBe(true);
    expect(dag.nodes.find((n) => n.id === "record-followup")?.inputMapping).toEqual({ "params.id": "$ref:pick-person.output.rowId", body: "$ref:record-plan.output.body" });
  });

  it("a second and a third look follow, each its own send (keyed on the row AND its due date), with no count anywhere", async () => {
    const msg = (m: string, days: number) => ({ decision: "write", message: m, reason: "r", nextFollowUpAt: inDays(days), nextFollowUpWhy: "w" });
    const second = await look("2026-10-13T09:00:00.000Z", quietThread, msg("Second", 6));
    const later = { ...quietThread, items: [...quietThread.items, { ...ourFirst, at: "2026-10-13T09:01:00.000Z", text: "Second" }] };
    const third = await look(second.record.body.nextDueAt as string, later, msg("Third", 14));
    const fourth = await look(third.record.body.nextDueAt as string, later, msg("Fourth", 40));
    for (const l of [second, third, fourth]) expect(l.record).toMatchObject({ action: "record", outcome: "sent", body: { kind: "acted" } });
    const keys = [second, third, fourth].map((l) => l.final.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe("cold-whatsapp-outreach:c-1:l-1:followup:row-1:2026-10-13T09:00:00.000Z");
    // A retried look (same row, same due date) is the same key: crm-service sends nothing twice.
    const retried = await look("2026-10-13T09:00:00.000Z", quietThread, msg("Second, redrafted", 6));
    expect(retried.final.idempotencyKey).toBe(keys[0]);
    // No fixed cadence, no fixed count in the DAG.
    const text = JSON.stringify(dag);
    expect(text).not.toMatch(/FOLLOW_UP_AFTER_DAYS|ONE follow-up|no other message after this one|whatsapp_follow_up_sent/);
  });

  it("later: nothing is sent and the row is due again at the model's date", async () => {
    const at = inDays(2);
    const out = await look("2026-10-13T09:00:00.000Z", quietThread, { decision: "later", message: "", reason: "we wrote yesterday", nextFollowUpAt: at, nextFollowUpWhy: "w" });
    expect(out.final).toMatchObject({ decision: "later", skipSend: true, sendBody: null });
    expect(out.send.notCalled).toBe(true);
    expect(out.record).toEqual({ action: "record", outcome: "later", body: { kind: "scheduled", dueAt: new Date(Date.parse(at)).toISOString() } });
    await expect(look("2026-10-13T09:00:00.000Z", quietThread, { decision: "later", message: "", nextFollowUpAt: "soon" })).rejects.toThrow(/not a date/);
  });

  it("stop (their own words): nothing is sent and the row is stopped", async () => {
    const out = await look("2026-10-13T09:00:00.000Z", quietThread, { decision: "stop", message: "", reason: "asked us to stop", nextFollowUpAt: "", nextFollowUpWhy: "" });
    expect(out.final).toMatchObject({ decision: "stop", skipSend: true });
    expect(out.record).toEqual({ action: "record", outcome: "stopped", body: { kind: "stopped", reason: WHATSAPP_FOLLOW_UP_STOPPED_REASON } });
  });

  it("they answered since the campaign first wrote, on ANY channel: no automated message for that look, nothing drafted, row handed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const answer of [
      { kind: "message", direction: "inbound", source: "matrix", channel: "whatsapp", at: "2026-10-11T08:00:00.000Z", text: "Hey!" },
      { kind: "message", direction: "inbound", source: "gmail", channel: "email", at: "2026-10-11T08:00:00.000Z", text: "Saw your WhatsApp" },
      { kind: "message", direction: "inbound", source: "instantly", channel: "email", at: "2026-10-12T08:00:00.000Z", text: "Re: hi" },
    ]) {
      const out = await look("2026-10-13T09:00:00.000Z", { ...quietThread, items: [ourFirst, answer] }, null);
      expect(out.reach).toMatchObject({ skip: true, code: "person_replied" });
      expect(out.final).toMatchObject({ skipSend: true, sendBody: null });
      expect(out.send.notCalled).toBe(true);
      expect(out.record).toMatchObject({ action: "record", body: { kind: "handed", reason: "whatsapp_person_replied" } });
    }
    // The model is never called: draft-message is skipped on reach-plan's verdict.
    expect(dag.nodes.find((n) => n.id === "draft-message")?.inputMapping?.skip).toBe("$ref:reach-plan.output.skip");
    // Product use (Copilot, API) is no answer.
    const copilot = await reach(await pick({ found: true, followup: { id: "r", email: "ana@x.com", brandId: "b-1", dueAt: "d" } }, detail, undefined, noOccurrence),
      { ...quietThread, items: [ourFirst, { kind: "message", direction: "inbound", source: "copilot", at: "2026-10-11T08:00:00.000Z", text: "how much?" }] }, sends, campaignId);
    expect(copilot.skip).toBe(false);
    log.mockRestore();
    err.mockRestore();
  });

  it("someone who talked with us BEFORE the campaign wrote is still followed up; crm-service's ever-replied guard is then not asked", async () => {
    const before = { kind: "message", direction: "inbound", source: "matrix", channel: "whatsapp", at: "2026-09-01T08:00:00.000Z", text: "old chat" };
    const out = await look("2026-10-13T09:00:00.000Z", { ...quietThread, items: [before, ourFirst] }, { decision: "write", message: "Hi again", reason: "r", nextFollowUpAt: inDays(3), nextFollowUpWhy: "w" });
    expect(out.reach).toMatchObject({ skip: false, skipIfReplied: false });
    expect(out.final.sendBody).toMatchObject({ skipIfReplied: false });
    expect(out.record).toMatchObject({ outcome: "sent", body: { kind: "acted" } });
  });

  it("the model's answer carries a decision and the next date, the shared right-moment contract", () => {
    expect(MESSAGE_RESPONSE_SCHEMA.properties.decision.enum).toEqual(["write", "later", "stop"]);
    expect(MESSAGE_RESPONSE_SCHEMA.required).toEqual(expect.arrayContaining(["decision", "nextFollowUpAt", "nextFollowUpWhy"]));
  });
});
