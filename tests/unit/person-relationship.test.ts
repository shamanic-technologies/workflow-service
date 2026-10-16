import { describe, it, expect } from "vitest";
import { dagToOpenFlow, withPersonRelationshipStep, RELATIONSHIP_VARIABLE } from "../../src/lib/dag-to-openflow.js";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import {
  KNOWN_RELATIONSHIP_TAGS,
  PERSON_RELATIONSHIP_STRATEGY,
  RELATIONSHIP_TAGS,
  PERSON_THREAD_QUERY_CODE,
  WHO_THEY_ARE_CODE,
  needsPersonRelationship,
} from "../../src/lib/person-relationship.js";
import { buildColdWhatsappOutreachDag, COMPOSE_MESSAGE_PROMPT_CODE } from "../../src/lib/cold-whatsapp-outreach-dag.js";
import { buildAiMeetingBookingDag, COMPOSE_REPLY_PROMPT_CODE } from "../../src/lib/ai-meeting-booking-dag.js";
import { buildAiFollowUpEmailDag, COMPOSE_EMAIL_PROMPT_CODE } from "../../src/lib/ai-follow-up-email-dag.js";
import { buildFormMeetingBookingDag, COMPOSE_ANSWER_PROMPT_CODE } from "../../src/lib/form-meeting-booking-dag.js";
import {
  BUSINESS_ONLY_CHANGES,
  buildSourcingDag,
  servesBusinessOnly,
  sourcingTargetOf,
} from "../../src/lib/sourcing-dag.js";
import { applyDagPatch, type DagPatchOperation } from "../../src/lib/dag-patch.js";

/**
 * RELATIONSHIP-TAGS-1014: every writer reads who the person is to the brand (lead-service tags) and their whole
 * merged thread (crm-service) before writing, through ONE shared step, so a friend is never written to as a
 * stranger (owner 2026-10-13: « TU NE DEVRAIT JAMAIS ASSUME QUE JE NE LES CONNAIS PAS »).
 */

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, unknown> | null> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, unknown> | null>;
}

const who = loadMain(WHO_THEY_ARE_CODE);

function relationship(over: Record<string, unknown> = {}) {
  return {
    humanId: "h-1",
    company: { id: null, name: "Mush KPG", domain: null, source: "person" },
    tags: [],
    unsureTags: [],
    judgedAt: "2026-10-14T09:00:00Z",
    details: [],
    ...over,
  };
}

/** lead-service `GET /orgs/leads/{id}/relationship`. */
const leadRead = (rel: unknown) => ({ leadId: "l-1", brandId: "b-1", relationship: rel });

const timeline = (items: unknown[] = []) => ({
  person: { personId: "p-1" },
  items,
  sources: [{ source: "matrix", status: "ok" }],
});

const WA_MESSAGE = { kind: "message", direction: "inbound", source: "matrix", channel: "whatsapp", at: "2026-09-02T10:00:00Z", text: "See you at the workshop on Friday!" };

describe("who this person is to the brand (shared step)", () => {
  it("a friend of the owner is KNOWN, named as such, with the strategy that forbids a cold intro", async () => {
    const out = await who(
      leadRead(relationship({
        tags: ["personal", "prospect"],
        details: [{ tag: "personal", level: "human", state: "yes", basis: "judgment", confidence: 0.93, evidence: "They talk about a workshop they both attended.", at: "2026-10-14T09:00:00Z" }],
      })),
      undefined,
      timeline([WA_MESSAGE]),
    );
    expect(out?.state).toBe("known");
    expect(out?.known).toBe(true);
    const lines = (out?.lines as string[]).join("\n");
    expect(lines).toContain("ALREADY KNOWS");
    expect(lines).toContain("a personal contact of the owner");
    expect(lines).toContain("prospect");
    expect(lines).toContain("workshop they both attended");
    expect(out?.threadLines).toEqual(["2026-09-02 10:00 | whatsapp | THEM: See you at the workshop on Friday!"]);
    expect(out?.strategy).toBe(PERSON_RELATIONSHIP_STRATEGY);
    expect(PERSON_RELATIONSHIP_STRATEGY).toContain("Never a cold introduction");
    expect(PERSON_RELATIONSHIP_STRATEGY).toContain("I came across your profile");
    expect(PERSON_RELATIONSHIP_STRATEGY).not.toMatch(/[–—]/);
  });

  it("every known tag of the vocabulary reads as known", async () => {
    for (const tag of KNOWN_RELATIONSHIP_TAGS) {
      const out = await who(leadRead(relationship({ tags: [tag] })), undefined, timeline());
      expect(out?.state, tag).toBe("known");
    }
    for (const tag of ["prospect", "other_professional", "journalist"]) {
      const out = await who(leadRead(relationship({ tags: [tag] })), undefined, timeline());
      expect(out?.state, tag).toBe("not_known");
    }
  });

  it("a journalist is named in plain words, never as a raw tag, and the strategy says they are never sold to", async () => {
    expect(RELATIONSHIP_TAGS).toContain("journalist");
    expect(KNOWN_RELATIONSHIP_TAGS as readonly string[]).not.toContain("journalist");
    const out = await who(leadRead(relationship({ tags: ["journalist"] })), undefined, timeline());
    const lines = (out?.lines as string[]).join("\n");
    expect(lines).toContain("Also: a journalist the brand pitches for press coverage (never a buyer).");
    const unsure = await who(leadRead(relationship({ unsureTags: ["journalist"] })), undefined, timeline());
    expect((unsure?.lines as string[]).join("\n")).toContain("Possibly (not confirmed): a journalist the brand pitches for press coverage");
    expect(PERSON_RELATIONSHIP_STRATEGY).toContain("A journalist is someone the brand pitches for press coverage, never a buyer");
  });

  it("a person never judged is POSSIBLY known, never a stranger, even with no relationship served at all", async () => {
    const unjudged = await who(leadRead(relationship({ judgedAt: null })), undefined, timeline());
    expect(unjudged?.state).toBe("possibly_known");
    expect((unjudged?.lines as string[]).join(" ")).toContain("treat them as possibly known");
    const noBlock = await who(leadRead(null), undefined, timeline());
    expect(noBlock?.state).toBe("possibly_known");
    const notFound = await who({ ok: false, status: 404, error: "Lead not found" }, undefined, timeline());
    expect(notFound?.state).toBe("possibly_known");
  });

  it("an unsure known tag, or any message on record, is possibly known", async () => {
    expect((await who(leadRead(relationship({ unsureTags: ["investor"] })), undefined, timeline()))?.state).toBe("possibly_known");
    expect((await who(leadRead(relationship()), undefined, timeline([WA_MESSAGE])))?.state).toBe("possibly_known");
  });

  it("only a person judged none of them, with no thread, is not known", async () => {
    const out = await who(leadRead(relationship()), undefined, timeline());
    expect(out?.state).toBe("not_known");
    expect((out?.lines as string[]).join(" ")).toContain("No message was ever exchanged");
  });

  it("reads the relationship off a served lead too (lead.data.relationship)", async () => {
    const served = { found: true, lead: { email: "y@example.com", brandIds: ["b-1"], data: { relationship: relationship({ tags: ["customer"] }) } } };
    expect((await who(undefined, served, timeline()))?.state).toBe("known");
  });

  it("a serve that found nobody has nobody to describe", async () => {
    expect(await who(undefined, { found: false, reason: "audience_exhausted" }, { ok: false, skipped: true, notCalled: true })).toBeNull();
  });

  it("a relationship read that broke writes nothing blind", async () => {
    await expect(who({ ok: false, status: 500, error: "boom" }, undefined, timeline())).rejects.toThrow(/nothing is written blind/);
  });

  it("crm-service knowing nobody (404) is no thread; any other failure writes nothing blind", async () => {
    const none = await who(leadRead(relationship()), undefined, { ok: false, status: 404, error: "person_not_found" });
    expect(none?.threadLines).toEqual([]);
    await expect(who(leadRead(relationship()), undefined, { ok: false, status: 502, error: "upstream" })).rejects.toThrow(/nothing is written blind/);
    await expect(
      who(leadRead(relationship()), undefined, { items: [], sources: [{ source: "gmail", status: "failed", error: "token revoked" }] }),
    ).rejects.toThrow(/unreadable/);
  });
});

describe("where the thread is read from", () => {
  const query = loadMain(PERSON_THREAD_QUERY_CODE);

  it("names the person by email, folded, under their brand", async () => {
    expect(await query(" Yuliia@Example.com ", "b-1", undefined)).toEqual({
      skip: false,
      query: { brandId: "b-1", personKey: "email:yuliia@example.com" },
    });
    expect(await query(undefined, undefined, { found: true, lead: { email: "a@b.co", brandIds: ["b-2"] } })).toEqual({
      skip: false,
      query: { brandId: "b-2", personKey: "email:a@b.co" },
    });
  });

  it("skips the read when the serve found nobody, and refuses a person with no email", async () => {
    expect(await query(undefined, undefined, { found: false })).toEqual({ skip: true, query: {} });
    await expect(query(undefined, "b-1", undefined)).rejects.toThrow(/no email/);
  });
});

type Mod = { id: string; value: { type: string; branches?: Array<{ modules: Mod[] }>; default?: Mod[]; modules?: Mod[]; input_transforms?: Record<string, { type: string; expr?: string; value?: unknown }> } };

/** The module ids of the scope (top level, or one branch body) each module sits in. */
function scopes(mods: Mod[], path = "top"): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of mods) {
    out.set(m.id, path);
    (m.value.branches ?? []).forEach((b, i) => scopes(b.modules, `${path}/${m.id}[${i}]`).forEach((v, k) => out.set(k, v)));
    if (m.value.default) scopes(m.value.default, `${path}/${m.id}[default]`).forEach((v, k) => out.set(k, v));
    if (m.value.modules) scopes(m.value.modules, `${path}/${m.id}[loop]`).forEach((v, k) => out.set(k, v));
  }
  return out;
}

function descendants(dag: DAG, start: string): Set<string> {
  const out = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const id = queue.shift() as string;
    for (const e of dag.edges) if (e.from === id && !out.has(e.to)) { out.add(e.to); queue.push(e.to); }
  }
  return out;
}

describe("every writer runs the shared step before writing, the same way", () => {
  const writers: Array<{ name: string; dag: DAG; compose: string }> = [
    { name: "cold-whatsapp-outreach", dag: buildColdWhatsappOutreachDag(), compose: "compose-message" },
    { name: "ai-meeting-booking", dag: buildAiMeetingBookingDag({ provider: "anthropic", model: "opus" } as never), compose: "compose-prompt" },
    { name: "ai-follow-up-email", dag: buildAiFollowUpEmailDag(), compose: "compose-email" },
    { name: "form-meeting-booking", dag: buildFormMeetingBookingDag(), compose: "compose-answer" },
  ];

  for (const w of writers) {
    it(`${w.name}: who-they-are reads the lead and the whole thread, runs before the writer, in the writer's scope`, () => {
      expect(validateDAG(w.dag).valid).toBe(true);
      expect(needsPersonRelationship(w.dag)).toBe(false);
      const step = w.dag.nodes.find((n) => n.id === "who-they-are");
      expect(step?.config?.code).toBe(WHO_THEY_ARE_CODE);
      expect(step?.inputMapping?.timeline).toMatch(/^\$ref:person-(thread|timeline)\.output$/);
      const thread = w.dag.nodes.find((n) => `$ref:${n.id}.output` === step?.inputMapping?.timeline);
      expect(thread?.config).toMatchObject({ service: "crm", method: "GET", path: "/orgs/people/timeline" });
      expect(step?.inputMapping?.relationshipRead).toBe("$ref:relationship-read.output");
      const read = w.dag.nodes.find((n) => n.id === "relationship-read");
      expect(read?.config).toMatchObject({ service: "lead", method: "GET", path: "/orgs/leads/{id}/relationship", tolerateFailure: true });
      // Same lead row the writer's lead detail reads.
      expect(read?.inputMapping?.["params.id"]).toBe(w.dag.nodes.find((n) => n.id === "lead-detail")?.inputMapping?.["params.id"]);
      expect(descendants(w.dag, "relationship-read").has("who-they-are")).toBe(true);
      expect(descendants(w.dag, "who-they-are").has(w.compose)).toBe(true);
      expect(w.dag.nodes.find((n) => n.id === w.compose)?.inputMapping?.who).toBe("$ref:who-they-are.output");
      const flow = dagToOpenFlow(w.dag, w.name);
      const where = scopes(flow.value.modules as unknown as Mod[]);
      expect(where.get("who_they_are")).toBe(where.get(w.compose.replace(/-/g, "_")));
      // The writers run the step themselves: conversion adds nothing.
      expect(withPersonRelationshipStep(w.dag)).toBe(w.dag);
    });
  }

  it("a stored writer DAG without the step is stale (its seed upgrades it)", () => {
    expect(needsPersonRelationship({ nodes: [{ id: "compose-email" }] })).toBe(true);
  });
});

describe("every writer puts who they are to us in front of the model", () => {
  const known = {
    state: "known",
    known: true,
    judged: true,
    tags: ["personal"],
    unsureTags: [],
    lines: ["The brand ALREADY KNOWS this person. They are a personal contact of the owner (a friend, someone he knows outside work)."],
    hasThread: false,
    threadLines: [],
    olderMessagesOmitted: 0,
    eventLines: [],
    strategy: PERSON_RELATIONSHIP_STRATEGY,
  };
  const offer = { name: "Revenue made easy", bookingUrl: null };
  const brand = { brand: { name: "Distribute.you" } };
  const facts = { exact: [], neverGive: [] };

  async function prompt(code: string, args: unknown[]): Promise<string> {
    const out = await loadMain(code)(...args);
    return `${out?.systemPrompt}\n${out?.message}`;
  }

  it("cold WhatsApp outreach: a known person with no thread is never introduced as a stranger", async () => {
    const person = { kind: "first", step: 1, email: "y@example.com", brandId: "b-1", lead: { firstName: "Yuliia" } };
    const history = { hasHistory: false, threadLines: [], eventLines: [], lastMessage: null, olderMessagesOmitted: 0, voiceLines: ["to someone else, whatsapp: hey!"] };
    const text = await prompt(COMPOSE_MESSAGE_PROMPT_CODE, [person, "", offer, brand, {}, facts, history, "2026-10-14", undefined, undefined, known]);
    expect(text).toContain("WHO THEY ARE TO US:");
    expect(text).toContain("a personal contact of the owner");
    expect(text).toContain(PERSON_RELATIONSHIP_STRATEGY);
    expect(text).toContain("never an introduction");
    expect(text).not.toContain("This is a FIRST message");
  });

  it("follow-up email: the relationship, the strategy and the thread", async () => {
    const withThread = { ...known, threadLines: ["2026-09-02 10:00 | whatsapp | THEM: See you Friday!"] };
    const text = await prompt(COMPOSE_EMAIL_PROMPT_CODE, [
      "Tell them their balance.", { followup: { id: "r", email: "y@example.com" } }, { leadDetail: { lead: {} } },
      offer, brand, facts, { figures: [], missing: null }, "2026-10-14", undefined, undefined, withThread,
    ]);
    expect(text).toContain("WHO THEY ARE TO US:");
    expect(text).toContain(PERSON_RELATIONSHIP_STRATEGY);
    expect(text).toContain("THEM: See you Friday!");
  });

  it("form responder: the relationship, the strategy and the thread", async () => {
    const text = await prompt(COMPOSE_ANSWER_PROMPT_CODE, [{ email: "y@example.com", form: null }, offer, brand, {}, facts, "2026-10-14", known]);
    expect(text).toContain("WHO THEY ARE TO US:");
    expect(text).toContain(PERSON_RELATIONSHIP_STRATEGY);
    expect(text).toContain("THE THREAD with this person");
  });

  it("conversation responder: the relationship and the strategy", async () => {
    const booking = { timezone: "UTC", slots: [], bookingUrl: null, degradedReason: "no booking link" };
    const text = await prompt(COMPOSE_REPLY_PROMPT_CODE, [
      { followup: { email: "y@example.com", step: 1 } }, { leadDetail: { lead: { firstName: "Yuliia" } } },
      { messages: [] }, null, booking, { name: "Revenue made easy" }, brand, "2026-10-14", facts,
      { stance: "insider", evidence: "" }, "none", undefined, known,
    ]);
    expect(text).toContain("WHO THEY ARE TO US");
    expect(text).toContain(PERSON_RELATIONSHIP_STRATEGY);
  });

  it("every writer refuses to write without the step", async () => {
    await expect(loadMain(COMPOSE_EMAIL_PROMPT_CODE)("x", {}, {}, offer, brand, facts, { figures: [] }, "d", undefined)).rejects.toThrow(/nothing is written blind/);
    await expect(loadMain(COMPOSE_ANSWER_PROMPT_CODE)({ email: "a@b.c" }, offer, brand, {}, facts, "d", undefined)).rejects.toThrow(/nothing is written blind/);
  });
});

describe("a cold email written by content-generation runs the same step (added at conversion)", () => {
  function coldEmailDag(): DAG {
    return {
      nodes: [
        { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
        { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" } },
        { id: "check-found", type: "condition", config: {} },
        {
          id: "email-generate",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email-v30", model: "pro" } },
          inputMapping: { "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName" },
        },
        { id: "end-run-no-lead", type: "http.call", config: { service: "campaign", method: "POST", path: "/end-run", body: { stopCampaign: true } } },
      ],
      edges: [
        { from: "start-run", to: "fetch-lead" },
        { from: "fetch-lead", to: "check-found" },
        { from: "check-found", to: "email-generate", condition: "results['fetch-lead'].found == true" },
        { from: "check-found", to: "end-run-no-lead", condition: "results['fetch-lead'].found == false" },
      ],
    };
  }

  it("splices the read after the served lead, and hands its output to the writer as leadRelationship", () => {
    const stored = coldEmailDag();
    const dag = withPersonRelationshipStep(stored);
    expect(stored.nodes).toHaveLength(5);
    expect(validateDAG(dag).valid).toBe(true);
    expect(dag.edges).toContainEqual({ from: "fetch-lead", to: "person-thread-query" });
    expect(dag.edges).toContainEqual({ from: "who-they-are", to: "check-found" });
    expect(dag.edges.some((e) => e.from === "fetch-lead" && e.to === "check-found")).toBe(false);

    const flow = dagToOpenFlow(stored, "cold email");
    const top = (flow.value.modules as unknown as Mod[]).map((m) => m.id);
    expect(top).toEqual(["start_run", "fetch_lead", "person_thread_query", "person_thread", "who_they_are", "check_found"]);
    const generate = (flow.value.modules as unknown as Mod[])[5].value.branches![0].modules[0];
    const body = generate.value.input_transforms!.body;
    const sent = (whoOut: unknown) =>
      JSON.parse(JSON.stringify(new Function("results", "flow_input", `return (${body.expr});`)(
        { fetch_lead: { found: true, lead: { data: { firstName: "Yuliia" } } }, start_run: {}, who_they_are: whoOut }, {},
      )));
    expect(sent({ state: "known", lines: ["x"] }).variables[RELATIONSHIP_VARIABLE]).toEqual({ state: "known", lines: ["x"] });
    expect(sent(null).variables).not.toHaveProperty(RELATIONSHIP_VARIABLE);
  });

  it("leaves a DAG that writes nothing alone (every sourcing DAG)", () => {
    const sourcing = buildSourcingDag();
    expect(withPersonRelationshipStep(sourcing)).toBe(sourcing);
  });
});

describe("the business-contacts-only sourcing play (CRM contacts pipe)", () => {
  it("is the default sourcing DAG plus ONE stated change on the serve", () => {
    const forked = applyDagPatch(buildSourcingDag(), BUSINESS_ONLY_CHANGES as unknown as DagPatchOperation[]);
    expect(forked).toEqual(buildSourcingDag({ businessOnly: true }));
    expect(servesBusinessOnly(forked)).toBe(true);
    expect(servesBusinessOnly(buildSourcingDag())).toBe(false);
    // The seed never flattens it back to the default play on upgrade.
    expect(sourcingTargetOf(forked)).toEqual({ dag: forked, stated: true });
    expect(forked.nodes.find((n) => n.id === "serve-lead")?.config).toEqual({
      service: "lead",
      method: "POST",
      path: "/orgs/buffer/next",
      body: { relationships: "business_only" },
    });
  });
});
