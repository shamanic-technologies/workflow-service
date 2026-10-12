import { describe, it, expect } from "vitest";
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
    const sends = dag.nodes.filter((n) => n.config?.service === CRM_WHATSAPP_SEND.service && n.config?.method === "POST");
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
    );
    expect(out).toMatchObject({ kind: "first", step: 1, rowId: null, email: "b@x.com", brandId: "b-2", lead: { firstName: "Ben" } });
  });

  it("nobody, with lead-service's reason", async () => {
    const out = await pick({ found: false, reason: "nothing_due" }, undefined, { found: false, reason: "audience_exhausted" });
    expect(out).toEqual({ kind: "nobody", reason: "audience_exhausted" });
  });
});

describe("reading the history before writing", () => {
  const dag = buildColdWhatsappOutreachDag();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const brandId = "bbbbbbbb-1111-4111-8111-000000000001";
  const person = { kind: "first", step: 1, email: "Damien@X.com", brandId, lead: { firstName: "Damien" } };

  it("reads the person's thread, our sends to them, and the owner's other conversations BEFORE the writer, inside the person branch", () => {
    const before = [...descendants(dag, "gather-facts")];
    for (const id of ["voice-people", "history-plan", "person-thread", "person-sends", "read-history"]) expect(before).toContain(id);
    expect(descendants(dag, "read-history").has("compose-message")).toBe(true);
    expect(descendants(dag, "compose-message").has("read-history")).toBe(false);
    expect(byId.get("compose-message")?.inputMapping?.history).toBe("$ref:read-history.output");
    expect(byId.get("person-thread")?.config).toMatchObject({ service: "crm", method: "GET", path: "/orgs/people/timeline" });
    // The person's own thread is never tolerated: unreadable = the person fails loud.
    expect(byId.get("person-thread")?.config?.tolerateFailure).toBeUndefined();
    expect(byId.get("person-sends")?.config?.tolerateFailure).toBeUndefined();
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
  const compose = loadMain(COMPOSE_MESSAGE_PROMPT_CODE);

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

  it("a follow-up says it is the one and only", async () => {
    const out = await compose({ ...first, kind: "followup", step: 2 }, null, offer, brand, rep, facts, talked, "2026-10-12");
    expect(out.systemPrompt as string).toContain("3 days ago, got no answer. This is the ONE follow-up");
    expect(out.message as string).toContain("(none: follow the strategy)");
  });

  it("never writes without a brand name, an offer name, or the history", async () => {
    await expect(compose(first, null, {}, brand, rep, facts, fresh, "x")).rejects.toThrow(/offer/);
    await expect(compose(first, null, offer, {}, rep, facts, fresh, "x")).rejects.toThrow(/brand/);
    await expect(compose(first, null, offer, brand, rep, facts, undefined, "x")).rejects.toThrow(/blind/);
    await expect(compose(first, null, offer, brand, rep, facts, { ...fresh, voiceLines: [] }, "x")).rejects.toThrow(/blind/);
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
    const refused = await plan({ kind: "first", email: "a@x.com" }, { ok: false, skipped: true, code: "whatsapp_not_linked" }, "2026-10-12");
    expect(refused).toEqual({ action: "none", outcome: "unreachable", code: "whatsapp_not_linked" });
  });

  it("a first message refused about the CHANNEL releases the person to the brand's pipes that can reach them", async () => {
    const plan = loadMain(RECORD_PLAN_CODE);
    for (const code of ["no_phone_known", "not_on_whatsapp"]) {
      const out = await plan({ kind: "first", email: "a@x.com" }, { ok: false, skipped: true, code }, "2026-10-12");
      expect(out).toEqual({ action: "release", outcome: "unreachable", code, email: "a@x.com" });
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

  it("a follow-up is handed over for good, sent or refused, so there is never a second", async () => {
    const plan = loadMain(RECORD_PLAN_CODE);
    const sent = await plan({ kind: "followup", rowId: "r" }, { ok: true }, "x");
    expect(sent).toMatchObject({ action: "record", body: { kind: "handed", reason: WHATSAPP_FOLLOW_UP_SENT_REASON } });
    const replied = await plan({ kind: "followup", rowId: "r" }, { skipped: true, code: "person_replied" }, "x");
    expect(replied).toMatchObject({ action: "record", body: { kind: "handed", reason: "whatsapp_person_replied" } });
  });
});
