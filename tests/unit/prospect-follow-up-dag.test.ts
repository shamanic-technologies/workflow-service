import { describe, it, expect, vi, afterEach } from "vitest";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  COMPOSE_PROSPECT_EMAIL_CODE,
  CONTINUE,
  FINALIZE_PROSPECT_EMAIL_CODE,
  LATER,
  PROSPECT_FOLLOW_UP_LATER_REASON,
  NOT_OWED,
  NOT_YET,
  OPTED_OUT,
  OWED,
  PERSON_HISTORY_CODE,
  PLAN_CLAIM_CODE,
  PROSPECT_EMAIL_RESPONSE_SCHEMA,
  PROSPECT_FOLLOW_UP_TRIGGER_ID,
  READ_VERDICT_CODE,
  RESOLVE_CLAIMED_PERSON_CODE,
  RESOLVE_SERVED_PERSON_CODE,
  SEND_OUTCOME_CODE,
  STOP,
  WRITE,
  buildProspectFollowUpProactiveDag,
  buildProspectFollowUpReactiveDag,
} from "../../src/lib/prospect-follow-up-dag.js";

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, unknown>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, unknown>>;
}

function holds(condition: string, results: Record<string, unknown>): boolean {
  return new Function("results", `return (${condition});`)(results) as boolean;
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

type Module = { id: string; value: { type: string; branches?: Array<{ modules: Module[] }>; default?: Module[] } };

afterEach(() => vi.restoreAllMocks());

const who = { lines: ["Judged: nothing shows the brand knows this person yet."], threadLines: [], eventLines: [], strategy: "WHO THIS PERSON IS TO US decides." };

describe.each([
  ["proactive", buildProspectFollowUpProactiveDag, "serve-lead", 4],
  ["reactive", buildProspectFollowUpReactiveDag, "claim-followup", 5],
] as const)("prospect follow-up %s DAG", (_name, build, anchor, branchones) => {
  const dag = build();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));

  it("is a valid DAG whose conditions are all top-level branchones (none nested in a branch)", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    const flow = dagToOpenFlow(dag, "prospect-follow-up-test");
    const top = (flow.value.modules as Module[]).filter((m) => m.value.type === "branchone");
    expect(top).toHaveLength(branchones);
    for (const id of ["check-owed", "check-decision", "check-sent"]) {
      expect(dag.edges.filter((e) => e.to === id).map((e) => e.from)).toContain(anchor);
    }
  });

  it("reads the stop verdict before any model spend, and the model only when owed", () => {
    const beforeVerdict = new Set(dag.nodes.map((n) => n.id).filter((id) => descendants(dag, id).has("prospect-verdict")));
    for (const id of beforeVerdict) expect(byId.get(id)?.config?.service).not.toBe("chat");
    expect(dag.edges).toContainEqual({ from: "check-owed", to: "offer-economics", condition: OWED });
  });

  it("records the next date strictly after the send, as one dated occurrence of the follow-up trigger", () => {
    expect(descendants(dag, "send-email").has("schedule-next")).toBe(true);
    const next = byId.get("schedule-next");
    expect(next?.config).toMatchObject({ service: "campaign", method: "POST", path: "/internal/trigger-events", body: { triggerId: PROSPECT_FOLLOW_UP_TRIGGER_ID } });
    expect(next?.inputMapping).toMatchObject({
      "body.dueAt": "$ref:finalize-email.output.nextFollowUpAt",
      "body.person.email": "$ref:resolve-person.output.email",
      "body.idempotencyKey": "$ref:resolve-person.output.nextKey",
    });
    expect(dag.edges).toContainEqual({ from: "check-sent", to: "schedule-next", condition: CONTINUE });
  });

  it("writes with Opus through chat-service and states no fixed cadence anywhere", () => {
    expect(byId.get("draft-email")?.config?.body).toMatchObject({ provider: "anthropic", model: "opus", responseSchema: PROSPECT_EMAIL_RESPONSE_SCHEMA });
    expect(JSON.stringify(dag)).not.toMatch(/\b(3|7|21|60|180)\s*days\b/);
  });

  it("sends from our sending infra, a refusal read as an outcome", () => {
    expect(byId.get("send-email")?.config).toMatchObject({
      service: "email-gateway",
      path: "/orgs/send",
      body: { type: "broadcast", followUp: true },
    });
    expect([...(byId.get("send-email")?.config?.skipOnRefusalCodes as string[])].sort()).toEqual(
      ["brand_sequence_queued", "google_send_permission_missing", "lead_not_a_prospect", "lead_opted_out", "recent_brand_contact"],
    );
  });
});

describe("reactive queue records", () => {
  const dag = buildProspectFollowUpReactiveDag();
  it("stops the row (never handed) after the next date is recorded, and on every stop path", () => {
    expect(dag.edges).toContainEqual({ from: "schedule-next", to: "send-outcome" });
    expect(dag.edges).toContainEqual({ from: "send-outcome", to: "record-sent" });
    for (const id of ["record-sent", "record-not-owed", "record-stopped", "record-opted-out"]) {
      expect(dag.nodes.find((n) => n.id === id)?.config?.body).toMatchObject({ kind: "stopped" });
    }
  });
  it("only a run carrying an occurrence claims anyone", async () => {
    const plan = loadMain(PLAN_CLAIM_CODE);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await plan(null)).toEqual({ skip: true });
    expect(await plan({ person: { email: "a@b.co" } })).toEqual({ skip: false });
  });
});

describe("resolve-person", () => {
  it("proactive: keys the send on the campaign and the served row, the next date on the send", async () => {
    const r = await loadMain(RESOLVE_SERVED_PERSON_CODE)(
      { found: true, lead: { leadCampaignId: "row-1", leadId: "lead-1", email: "jo@x.co", brandIds: ["b-1"], data: { firstName: "Jo", timezone: "Europe/Paris" } } },
      "camp-1",
    );
    expect(r).toMatchObject({ ok: true, kind: "first", rowId: "row-1", brandId: "b-1", timezone: "Europe/Paris", sendKey: "prospect-follow-up:camp-1:row-1", nextKey: "prospect-follow-up:camp-1:row-1:next" });
  });
  it("reactive: uses the person only when the occurrence names them, keyed on the occurrence", async () => {
    const run = loadMain(RESOLVE_CLAIMED_PERSON_CODE);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const claim = { found: true, followup: { id: "row-2", leadId: "lead-2", email: "Jo@X.co", brandId: "b-1" } };
    const detail = { leadDetail: { lead: { firstName: "Jo", timezone: "UTC" } } };
    expect(await run(claim, detail, { eventId: "ev-9", person: { email: "jo@x.co" } })).toMatchObject({
      ok: true,
      kind: "next",
      sendKey: "prospect-follow-up:event:ev-9",
    });
    expect(await run(claim, detail, { eventId: "ev-9", person: { email: "someone@else.co" } })).toMatchObject({ ok: false });
  });
});

describe("verdict", () => {
  const run = loadMain(READ_VERDICT_CODE);
  it("fails loud on an answer with no kind, never reads it as owed or as a stop", async () => {
    await expect(run({ owed: true })).rejects.toThrow(/no verdict kind/);
    await expect(run({ kind: "not_yet", owed: false, reason: "sequence_running" })).rejects.toThrow(/without a retryAfter/);
  });
  it("a stop ends the chain; a not-yet keeps it, at lead-service's date", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stop = await run({ kind: "stop", owed: false, reason: "positive_reply", retryAfter: null });
    expect(stop).toMatchObject({ owed: false, kind: "stop", reason: "positive_reply" });
    const later = new Date(Date.now() + 72 * 3600_000).toISOString();
    const notYet = await run({ kind: "not_yet", owed: false, reason: "sequence_running", retryAfter: later });
    expect(notYet).toMatchObject({ kind: "not_yet", retryAfter: later });
    const past = await run({ kind: "not_yet", owed: false, reason: "in_conversation", retryAfter: "2020-01-01T00:00:00Z" });
    expect(Date.parse(String(past.retryAfter))).toBeGreaterThan(Date.now() + 3500_000);
    expect(holds(NOT_OWED, { "resolve-person": { ok: true }, "read-verdict": stop })).toBe(true);
    expect(holds(NOT_YET, { "resolve-person": { ok: true }, "read-verdict": stop })).toBe(false);
    expect(holds(NOT_YET, { "resolve-person": { ok: true }, "read-verdict": notYet })).toBe(true);
    expect(holds(OWED, { "resolve-person": { ok: true }, "read-verdict": notYet })).toBe(false);
  });
  it("reactive: a not-yet re-records the same chain at retryAfter, keyed on the occurrence", () => {
    const dag = buildProspectFollowUpReactiveDag();
    expect(dag.edges).toContainEqual({ from: "check-owed", to: "schedule-retry", condition: NOT_YET });
    expect(dag.nodes.find((n) => n.id === "schedule-retry")?.inputMapping).toMatchObject({
      "body.dueAt": "$ref:read-verdict.output.retryAfter",
      "body.idempotencyKey": "$ref:resolve-person.output.retryKey",
    });
  });
});

describe("person history", () => {
  const run = loadMain(PERSON_HISTORY_CODE);
  it("lists our emails with dates, their words and what they did", async () => {
    const h = await run({
      sources: [{ source: "outreach", status: "ok" }, { source: "mailbox", status: "unavailable" }],
      events: [
        { type: "message", at: "2026-09-01T09:00:00Z", direction: "outbound", subject: "Hi", bodyStatus: "ok", bodyText: "first" },
        { type: "delivery", at: "2026-09-02T10:00:00Z", milestone: "clicked" },
        { type: "conversion", at: "2026-09-03T10:00:00Z", event: "signup", observedBy: "tracker" },
      ],
    });
    expect(h.ourEmails).toBe(1);
    expect(h.lastOursAt).toBe("2026-09-01T09:00:00Z");
    expect((h.lines as string[]).join("\n")).toMatch(/US: \[Hi\] first[\s\S]*email clicked[\s\S]*signup/);
    expect(h.unreadable).toEqual(["mailbox"]);
  });
  it("never decides blind: what we sent or what they did unreadable throws", async () => {
    await expect(run({ sources: [{ source: "delivery", status: "unavailable", reason: "down" }], events: [] })).rejects.toThrow(/never decided blind/);
  });
});

describe("compose", () => {
  it("tells the game, the date rule and the stop rule, with no dash in the prompt", async () => {
    const out = await loadMain(COMPOSE_PROSPECT_EMAIL_CODE)(
      { kind: "next", email: "jo@x.co", lead: { firstName: "Jo" }, timezone: "Europe/Paris" },
      { name: "Product-led" },
      { brand: { name: "Acme" } },
      { exact: [{ id: "E1", label: "Price", value: "$99" }], neverGive: [] },
      { lines: ["2026-09-01 09:00 UTC | email | US: hi"], omitted: 0, ourEmails: 1, lastOursAt: "2026-09-01", lastTheirsAt: null, unreadable: [] },
      null,
      "2026-10-14",
      "2026-10-14T10:00:00.000Z",
      who,
    );
    const all = String(out.systemPrompt) + String(out.message);
    expect(all).not.toMatch(/[–—]/);
    expect(out.systemPrompt).toMatch(/There is no fixed schedule/);
    expect(out.systemPrompt).toMatch(/Silence is never a reason to stop/);
    expect(out.message).toMatch(/E1\. Price: \$99/);
    expect(out.message).toMatch(/NOW: 2026-10-14T10:00:00.000Z/);
  });
  it("refuses to write blind", async () => {
    await expect(loadMain(COMPOSE_PROSPECT_EMAIL_CODE)({}, { name: "x" }, { brand: { name: "y" } }, {}, { lines: [] }, null, null, "now", null)).rejects.toThrow(/written blind/);
  });
});

describe("finalize", () => {
  const run = loadMain(FINALIZE_PROSPECT_EMAIL_CODE);
  const person = { sendKey: "k1" };
  const future = new Date(Date.now() + 5 * 86400_000).toISOString();
  it("rewrites dashes and keeps the model's date", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await run({ json: { decision: "write", subject: "A — B", bodyHtml: "<p>2–3 days — maybe</p>", nextFollowUpAt: future, nextFollowUpWhy: "w", reason: "r" } }, person);
    expect(r).toMatchObject({ decision: "write", subject: "A, B", idempotencyKey: "k1", nextFollowUpAt: new Date(future).toISOString() });
    expect(JSON.stringify(r.sequence)).toContain("2-3 days, maybe");
  });
  it("throws before the send on a next date that is missing or not in the future", async () => {
    await expect(run({ json: { decision: "write", subject: "s", bodyHtml: "<p>b</p>", nextFollowUpAt: "" } }, person)).rejects.toThrow(/not a date/);
    await expect(run({ json: { decision: "write", subject: "s", bodyHtml: "<p>b</p>", nextFollowUpAt: "2020-01-01T00:00:00Z" } }, person)).rejects.toThrow(/not in the future/);
  });
  it("a stop on the person's own words sends nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await run({ json: { decision: "stop", reason: "\"please stop\"" } }, person)).toMatchObject({ decision: "stop" });
    expect(holds(STOP, { "finalize-email": { decision: "stop" } })).toBe(true);
    expect(holds(WRITE, { "finalize-email": { decision: "stop" } })).toBe(false);
  });
});

// RIGHT-MOMENT-OR-LATER-1014: a client was emailed a second time about something the owner had already answered.
describe("the right moment or later", () => {
  const future = new Date(Date.now() + 5 * 86400_000).toISOString();
  it("the prompt asks whether now is the right moment, a hand-written answer of ours counting like an automated one", async () => {
    const out = await loadMain(COMPOSE_PROSPECT_EMAIL_CODE)(
      { kind: "next", email: "jo@x.co", lead: {}, timezone: null },
      { name: "Product-led" },
      { brand: { name: "Acme" } },
      { exact: [], neverGive: [] },
      { lines: [], omitted: 0, ourEmails: 1, lastOursAt: null, lastTheirsAt: null, unreadable: [] },
      null, "2026-10-14", "2026-10-14T10:00:00.000Z", who,
    );
    expect(out.systemPrompt).toMatch(/THE RIGHT MOMENT/);
    expect(out.systemPrompt).toMatch(/a person of our team writing by hand counts exactly like an automated email/);
    expect(out.systemPrompt).toMatch(/later is never the end/);
    expect(PROSPECT_EMAIL_RESPONSE_SCHEMA.properties.decision.enum).toEqual(["write", "later", "stop"]);
  });
  it("later sends nothing and keeps the model's date; a missing date throws", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const run = loadMain(FINALIZE_PROSPECT_EMAIL_CODE);
    const r = await run({ json: { decision: "later", subject: "", bodyHtml: "", nextFollowUpAt: future, nextFollowUpWhy: "we just answered", reason: "r" } }, { sendKey: "k1" });
    expect(r).toEqual({ decision: "later", nextFollowUpAt: new Date(future).toISOString(), nextFollowUpWhy: "we just answered", reason: "r" });
    await expect(run({ json: { decision: "later", nextFollowUpAt: "" } }, { sendKey: "k1" })).rejects.toThrow(/not a date/);
    expect(holds(LATER, { "finalize-email": { decision: "later" } })).toBe(true);
    expect(holds(WRITE, { "finalize-email": { decision: "later" } })).toBe(false);
  });
  it.each([
    ["proactive", buildProspectFollowUpProactiveDag, ["end-run-later"]],
    ["reactive", buildProspectFollowUpReactiveDag, ["record-later", "end-run-later"]],
  ] as const)("%s: later records the same chain at the model's date, never sends", (_n, build, after) => {
    const dag = build();
    expect(dag.edges.find((e) => e.from === "check-decision" && e.to === "schedule-later")?.condition).toBe(LATER);
    const node = dag.nodes.find((n) => n.id === "schedule-later");
    expect(node?.config).toMatchObject({ service: "campaign", method: "POST", path: "/internal/trigger-events", body: { triggerId: PROSPECT_FOLLOW_UP_TRIGGER_ID } });
    expect(node?.inputMapping).toMatchObject({ "body.dueAt": "$ref:finalize-email.output.nextFollowUpAt", "body.idempotencyKey": "$ref:resolve-person.output.laterKey" });
    expect(descendants(dag, "schedule-later")).toEqual(new Set(after));
    expect(dag.nodes.find((n) => n.id === "end-run-later")?.config?.body).toEqual({ success: true, stopCampaign: false });
    if (after.includes("record-later")) {
      expect(dag.nodes.find((n) => n.id === "record-later")?.config?.body).toEqual({ kind: "stopped", reason: PROSPECT_FOLLOW_UP_LATER_REASON });
    }
  });
});

describe("after the send", () => {
  const write = { "finalize-email": { decision: "write" } };
  it("continues the chain when sent, or refused only because the brand talks to them now", () => {
    expect(holds(CONTINUE, { ...write, "send-email": { success: true } })).toBe(true);
    expect(holds(CONTINUE, { ...write, "send-email": { skipped: true, code: "recent_brand_contact" } })).toBe(true);
    expect(holds(OPTED_OUT, { ...write, "send-email": { skipped: true, code: "recent_brand_contact" } })).toBe(false);
  });
  it("a queued step of their sequence is a passing refusal: the chain goes on", () => {
    expect(holds(CONTINUE, { ...write, "send-email": { skipped: true, code: "brand_sequence_queued" } })).toBe(true);
    expect(holds(OPTED_OUT, { ...write, "send-email": { skipped: true, code: "brand_sequence_queued" } })).toBe(false);
    expect(holds(OPTED_OUT, { ...write, "send-email": { skipped: true, code: "lead_not_a_prospect" } })).toBe(true);
  });
  it("the reactive row records what happened, never 'sent' for a refusal", async () => {
    const outcome = loadMain(SEND_OUTCOME_CODE);
    expect(await outcome({ success: true })).toEqual({ reason: "prospect_follow_up_sent" });
    expect(await outcome({ skipped: true, code: "brand_sequence_queued" })).toEqual({ reason: "prospect_follow_up_deferred_brand_sequence_queued" });
    const dag = buildProspectFollowUpReactiveDag();
    expect(dag.nodes.find((n) => n.id === "record-sent")?.inputMapping).toMatchObject({ "body.reason": "$ref:send-outcome.output.reason" });
  });
  it("ends the chain when refused because they opted out", () => {
    expect(holds(CONTINUE, { ...write, "send-email": { skipped: true, code: "lead_opted_out" } })).toBe(false);
    expect(holds(OPTED_OUT, { ...write, "send-email": { skipped: true, code: "lead_opted_out" } })).toBe(true);
  });
  it("does nothing on a path where nothing was written", () => {
    expect(holds(CONTINUE, { "finalize-email": { decision: "stop" } })).toBe(false);
    expect(holds(OPTED_OUT, {})).toBe(false);
  });
});

describe("the contacted-pure-prospects sourcing play (Lead Sourcing pipe)", () => {
  it("is the default sourcing DAG plus ONE stated change on the serve, kept on upgrade", async () => {
    const { applyDagPatch } = await import("../../src/lib/dag-patch.js");
    const sourcing = await import("../../src/lib/sourcing-dag.js");
    const forked = applyDagPatch(sourcing.buildSourcingDag(), sourcing.CONTACTED_PROSPECTS_CHANGES as never);
    expect(sourcing.servesContactedProspects(forked)).toBe(true);
    expect(sourcing.servesContactedProspects(sourcing.buildSourcingDag())).toBe(false);
    expect(sourcing.sourcingTargetOf(forked)).toEqual({ dag: forked, stated: true });
    expect(forked.nodes.find((n) => n.id === "serve-lead")?.config?.body).toEqual({ population: "contacted_pure_prospects" });
    const play = sourcing.SOURCING_FORK_PLAYS.find((p) => p.name === "contacted-pure-prospects");
    expect(play?.channels).toEqual(["lead-sourcing"]);
  });
});
