import { describe, it, expect, vi, afterEach } from "vitest";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  buildAiMeetingBookingDag,
  readBookingSlotsCode,
  COMPOSE_REPLY_PROMPT_CODE,
  RESOLVE_NEXT_DUE_CODE,
  SLOT_CANDIDATES,
  SLOTS_PER_DAY,
  SLOT_LOOKAHEAD_DAYS,
  FEATURE_SLUG,
  PREDECESSOR_READ,
  PREDECESSOR_CAMPAIGN_REF,
  NAME_MISSING_PREDECESSOR_CODE,
  CLASSIFY_SEND_CODE,
  REPLY_RESPONSE_SCHEMA,
  NAME_NO_REPLY_OWED_CODE,
  NO_REPLY_OWED_REASON,
  BOOKING_CONFIRMED_REASON,
  COMPOSE_QUESTIONS_PROMPT_CODE,
  QUESTIONS_RESPONSE_SCHEMA,
  PLAN_LOOKUPS_CODE,
  GATHER_FACTS_CODE,
  GROUND_DRAFT_CODE,
  ACQUISITION_QUESTIONS_PLAYBOOK,
  PLAYBOOKS,
  CLOSED_WITH_THANKS_REASON,
  OFFER_OVERVIEW_KEY,
  STANCES,
  CHAT_STEP_MAX_TOKENS,
} from "../../src/lib/ai-meeting-booking-dag.js";

const DAG_OPTS = { provider: "google", model: "pro" } as const;

/** Loads a `script` node's rawscript body so the shipped code itself is exercised. */
function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, unknown>> {
  const body = code.replace(/^export async function main/, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, unknown>>;
}

const INSIDER = { stance: "insider", evidence: "I'm Sam at Acme." };

/**
 * Runs compose-prompt. Callers that predate the identity stance pass up to the
 * facts argument; they get an insider thread, which is the voice they assert.
 * Callers that predate the playbook get `none`, the thread they assert.
 */
function composeReply(...args: unknown[]): Promise<Record<string, unknown>> {
  const a = [...args];
  while (a.length < 9) a.push(undefined);
  if (a.length < 10) a.push(INSIDER);
  if (a.length < 11) a.push("none");
  return loadMain(COMPOSE_REPLY_PROMPT_CODE)(...a);
}

/** Every node reachable from `start`, following edges forward. */
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

describe("ai-meeting-booking DAG", () => {
  // Regression: list-questions shipped maxTokens 800 and Gemini 3.1 Pro (a
  // thinking model, thought tokens count against the cap) died on MAX_TOKENS,
  // so an interested prospect went unanswered (Legistai, 2026-10-05).
  it("gives every chat step an output budget a thinking model can fit in", () => {
    expect(CHAT_STEP_MAX_TOKENS).toBeGreaterThanOrEqual(16_000);
    const chat = buildAiMeetingBookingDag(DAG_OPTS).nodes.filter(
      (n) => (n.config as { service?: string } | undefined)?.service === "chat",
    );
    expect(chat.map((n) => n.id).sort()).toEqual(["draft-reply", "list-questions"]);
    for (const n of chat) {
      const body = (n.config as { body: { maxTokens?: number } }).body;
      expect(body.maxTokens, n.id).toBeGreaterThanOrEqual(CHAT_STEP_MAX_TOKENS);
    }
  });

  const dag = buildAiMeetingBookingDag(DAG_OPTS);
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));

  it("is a valid DAG", () => {
    const result = validateDAG(dag);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("translates to Windmill OpenFlow, and every script exports main", () => {
    const flow = dagToOpenFlow(dag, `${FEATURE_SLUG}-test`);
    expect(flow.value.modules.length).toBeGreaterThan(0);
    for (const node of dag.nodes) {
      if (node.type !== "script") continue;
      expect(node.config?.code).toContain("export async function main");
    }
  });

  it("claims the next person from lead-service and does not re-implement claiming", () => {
    const claim = byId.get("claim-followup");
    expect(claim?.config).toMatchObject({
      service: "lead",
      method: "POST",
      path: "/orgs/campaigns/{campaignId}/followups/claim-next",
    });
    // Exactly one claim per run, and nothing here orders, filters or stops.
    const claims = dag.nodes.filter((n) => String(n.config?.path ?? "").includes("claim-next"));
    expect(claims).toHaveLength(1);
  });

  it("answers exactly one prospect — no loop anywhere in the flow", () => {
    expect(dag.nodes.some((n) => n.type === "for-each")).toBe(false);
    const sends = dag.nodes.filter((n) => n.config?.path === "/orgs/replies");
    expect(sends).toHaveLength(1);
  });

  it("a run that claims nobody cannot reach the send", () => {
    // Two concurrent runs never answer the same person: lead-service hands the
    // row out with an atomic conditional UPDATE, so at most one run sees
    // found=true. The other takes the false edge — and from there the send is
    // structurally unreachable, so it cannot answer anyone at all.
    const nobody = dag.edges.find((e) => e.from === "check-claim" && e.condition?.includes("== false"));
    expect(nobody?.to).toBe("end-run-nobody-due");
    const reachedWithoutAClaim = descendants(dag, nobody?.to as string);
    expect(reachedWithoutAClaim.has("send-reply")).toBe(false);
    expect(reachedWithoutAClaim.has("record-followup")).toBe(false);

    const claimed = dag.edges.find((e) => e.from === "check-claim" && e.condition?.includes("== true"));
    expect(descendants(dag, claimed?.to as string).has("send-reply")).toBe(true);
  });

  it("sends the answer as a reply in the existing thread, supplying no sender", () => {
    const send = byId.get("send-reply");
    expect(send?.config).toMatchObject({
      service: "instantly",
      method: "POST",
      path: "/orgs/replies",
      validateResponse: { field: "success", equals: true },
    });
    // The mailbox is instantly-service's to resolve; supplying one would let a
    // reply arrive from a mailbox the prospect has never heard from.
    const keys = Object.keys(send?.inputMapping ?? {});
    expect(keys.some((k) => /from|account|mailbox|sender/i.test(k))).toBe(false);
    expect(dag.nodes.filter((n) => n.config?.service === "email-gateway")).toHaveLength(0);
  });

  it("records the follow-up strictly AFTER the send, never before", () => {
    const afterSend = descendants(dag, "send-reply");
    expect(afterSend.has("record-followup")).toBe(true);
    // and never the other way round
    expect(descendants(dag, "record-followup").has("send-reply")).toBe(false);

    const record = byId.get("record-followup");
    expect(record?.config).toMatchObject({
      service: "lead",
      method: "POST",
      path: "/orgs/leads/{id}/followups",
      body: { kind: "acted" },
    });
    // The row the queue handed out, not the person: the follow-up debt is per
    // (lead, campaign) membership row.
    expect(record?.inputMapping?.["params.id"]).toBe("$ref:claim-followup.output.followup.id");
    expect(record?.inputMapping?.["body.nextDueAt"]).toBe("$ref:resolve-next-due.output.nextDueAt");
  });

  it("reads the booking link and the offer's name off the campaign's own OFFER", () => {
    expect(byId.get("campaign-detail")?.config).toMatchObject({ service: "campaign", path: "/campaigns/{id}" });
    expect(byId.get("offer-economics")?.config).toMatchObject({
      service: "brand",
      method: "GET",
      path: "/internal/offers/{offerId}/economics",
    });
    expect(byId.get("offer-economics")?.inputMapping).toEqual({
      "params.offerId": "$ref:campaign-detail.output.campaign.offerId",
    });
    expect(byId.get("booking-slots")?.inputMapping?.bookingUrl).toBe("$ref:offer-economics.output.bookingUrl");
    expect(byId.get("compose-prompt")?.inputMapping?.offer).toBe("$ref:offer-economics.output");
  });

  it("carries no sales-funnel vocabulary at all (wave C3)", () => {
    // brand-service drops the frozen funnel read and campaign-service drops
    // Campaign.funnelKey once no caller remains; this DAG was one of them.
    expect(JSON.stringify(dag)).not.toMatch(/funnel/i);
  });

  it("reads what the prospect wrote and what we already sent", () => {
    expect(byId.get("conversation")?.config).toMatchObject({
      service: "instantly",
      method: "GET",
      path: "/orgs/conversations",
    });
    expect(byId.get("conversation")?.inputMapping).toEqual({
      "query.campaign_id": PREDECESSOR_CAMPAIGN_REF,
      "query.email": "$ref:claim-followup.output.followup.email",
    });
    expect(byId.get("prior-generation")?.config).toMatchObject({
      service: "content-generation",
      path: "/generations/by-lead/{leadId}",
    });
    const compose = byId.get("compose-prompt")?.inputMapping ?? {};
    expect(compose.conversation).toBe("$ref:conversation.output");
    expect(compose.priorGeneration).toBe("$ref:prior-generation.output");
  });

  it("resolves the preceding leg's campaign itself, before it claims anyone", () => {
    // Scheduled runs have no trigger to hand the predecessor over, and most runs
    // are scheduled — so the flow asks campaign-service for it.
    const pred = byId.get("predecessor-campaign");
    expect(pred?.config).toMatchObject({
      service: PREDECESSOR_READ.service,
      method: PREDECESSOR_READ.method,
      path: PREDECESSOR_READ.path,
    });
    expect(pred?.inputMapping).toEqual({ "params.campaignId": "$ref:flow_input.campaignId" });
    // and it runs before the claim can
    expect(descendants(dag, "predecessor-campaign").has("claim-followup")).toBe(true);
    expect(descendants(dag, "claim-followup").has("predecessor-campaign")).toBe(false);
  });

  it("every lead-facing hop names the PREDECESSOR's campaign, never this run's", () => {
    // The person, their thread and the debt are all filed under the leg that
    // cold-emailed them. Asking this workflow's own campaign finds nobody.
    expect(byId.get("claim-followup")?.inputMapping?.["params.campaignId"]).toBe(
      PREDECESSOR_CAMPAIGN_REF,
    );
    expect(byId.get("lead-detail")?.inputMapping?.["query.campaignId"]).toBe(
      PREDECESSOR_CAMPAIGN_REF,
    );
    expect(byId.get("conversation")?.inputMapping?.["query.campaign_id"]).toBe(
      PREDECESSOR_CAMPAIGN_REF,
    );
    expect(byId.get("send-reply")?.inputMapping?.["body.campaign_id"]).toBe(
      PREDECESSOR_CAMPAIGN_REF,
    );
  });

  it("keeps the gate and the run accounting on the campaign that was dispatched", () => {
    // Money belongs to the leg that spends it: nothing about funding, gating or
    // scheduling moves onto the predecessor.
    for (const id of ["gate-check", "start-run", "end-run", "end-run-nobody-due", "end-run-error", "end-run-no-predecessor", "end-run-escalated", "end-run-human-took-over"]) {
      const node = byId.get(id);
      expect(node?.config?.service).toBe("campaign");
      // No lead-facing hop's campaign leaks into the accounting calls.
      const refs = Object.values(node?.inputMapping ?? {});
      expect(refs.some((r) => String(r).includes("predecessor-campaign"))).toBe(false);
    }
    // The offer and funnel being SOLD are this campaign's, not the predecessor's.
    expect(byId.get("campaign-detail")?.inputMapping?.["params.id"]).toBe(
      "$ref:flow_input.campaignId",
    );
  });

  it("a run with no predecessor names why, sends nothing, and never falls back to its own campaign", () => {
    const none = dag.edges.find(
      (e) => e.from === "check-predecessor" && e.condition?.includes("== null"),
    );
    expect(none?.to).toBe("name-missing-predecessor");
    const reached = descendants(dag, none?.to as string);
    expect(reached.has("claim-followup")).toBe(false);
    expect(reached.has("send-reply")).toBe(false);
    expect(reached.has("record-followup")).toBe(false);
    // It ends as a failure, not as an idle tick — a campaign that cannot resolve
    // its predecessor is misconfigured, and calling it idle is what hid this.
    expect(reached.has("end-run-no-predecessor")).toBe(true);
    expect(byId.get("end-run-no-predecessor")?.config?.body).toEqual({
      success: false,
      stopCampaign: false,
    });
    // and it never stops the campaign — that is the customer's statement.
    expect(byId.get("end-run-no-predecessor")?.config?.path).toBe("/end-run");

    // No node anywhere substitutes this run's own campaign for the predecessor.
    const leadFacing = ["claim-followup", "lead-detail", "conversation", "send-reply"];
    for (const id of leadFacing) {
      const refs = Object.values(byId.get(id)?.inputMapping ?? {});
      expect(refs.some((r) => String(r) === "$ref:flow_input.campaignId")).toBe(false);
    }
  });

  it("names the absence reason in the log rather than swallowing it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const main = loadMain(NAME_MISSING_PREDECESSOR_CODE);
    const out = await main({ predecessor: null, absence: "no_campaign_for_preceding_leg" }, "camp-1");
    expect(out).toEqual({ absence: "no_campaign_for_preceding_leg", campaignId: "camp-1" });
    expect(spy.mock.calls[0]?.[0]).toContain("no_campaign_for_preceding_leg");
    expect(spy.mock.calls[0]?.[0]).toContain("camp-1");
  });

  it("the nothing-to-do branch cannot throw on a run that never claimed", () => {
    // On the no-predecessor path `results.claim_followup` does not exist, so both
    // arms of check-claim must read false rather than raise.
    for (const e of dag.edges.filter((x) => x.from === "check-claim")) {
      expect(e.condition).toContain("results['claim-followup']?.");
    }
    // check-claim converges rather than nesting inside the predecessor branch —
    // a condition node inside a branch body is built as an ordinary module and
    // silently does nothing.
    const incoming = dag.edges.filter((e) => e.to === "check-claim").map((e) => e.from);
    expect(incoming).toContain("predecessor-campaign");
    expect(incoming).toContain("claim-followup");
  });

  it("goes through chat-service for the LLM call, which declares the spend", () => {
    const draft = byId.get("draft-reply");
    expect(draft?.config).toMatchObject({ service: "chat", method: "POST", path: "/complete" });
    const body = draft?.config?.body as Record<string, unknown>;
    expect(body.provider).toBe("google");
    expect(body.model).toBe("pro");
    expect(body.responseSchema).toBeTruthy();
    // No provider SDK. Exactly two LLM hops, both on chat-service /complete:
    // listing the questions, then drafting. Never anthropic/haiku.
    const chat = dag.nodes.filter((n) => n.config?.service === "chat");
    expect(chat.map((n) => n.id).sort()).toEqual(["draft-reply", "list-questions"]);
    for (const n of chat) {
      expect(n.config).toMatchObject({ method: "POST", path: "/complete" });
      expect((n.config?.body as Record<string, unknown>).model).not.toBe("haiku");
    }
  });

  it("never calls the api gateway", () => {
    expect(dag.nodes.some((n) => n.config?.service === "api")).toBe(false);
  });

  it("does not stop the campaign when nobody is due", () => {
    // Nothing due right now is contention or an empty queue, not a finished
    // campaign — the queue fills again as prospects reply.
    expect(byId.get("end-run-nobody-due")?.config?.body).toEqual({
      success: true,
      stopCampaign: false,
      noWorkAvailable: true,
    });
  });

  it("tells campaign-service the run had no work only when nobody was due", () => {
    // The idle cadence belongs to campaign-service; this DAG only states the
    // fact. A run that answered somebody, and a run that errored, say nothing.
    expect(byId.get("end-run")?.config?.body).toEqual({ success: true, stopCampaign: false });
    expect(byId.get("end-run-error")?.config?.body).toEqual({ success: false, stopCampaign: false });
  });
});

describe("reading the booking page", () => {
  afterEach(() => vi.unstubAllGlobals());

  const okLookup = { uuid: "ET-123" };
  const okRange = {
    days: [
      {
        date: "2026-09-04",
        spots: [
          { status: "available", start_time: "2026-09-04T10:00:00+02:00" },
          { status: "unavailable", start_time: "2026-09-04T11:00:00+02:00" },
          { status: "available", start_time: "2026-09-04T14:00:00+02:00" },
        ],
      },
    ],
  };

  function stubFetch(handler: (url: string) => { ok: boolean; status?: number; body?: unknown; text?: string }) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      const r = handler(String(url));
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 500),
        json: async () => r.body,
        text: async () => r.text ?? JSON.stringify(r.body ?? ""),
      } as unknown as Response;
    });
    return calls;
  }

  /** A GoHighLevel booking page, as it is actually served: the calendar id is
   *  NOT adjacent to its own key, it sits further along the flattened payload. */
  const ghlPage =
    '<html><script src="https://stcdn.leadconnectorhq.com/x.js"></script>' +
    '<script>{"nodeId":181,"calendarId":184},{"value":185},' +
    '"zJEXTXZCVIai1P1Dai3c","Free Event Marketing Consultation"</script></html>';

  const ghlSlots = {
    "2026-09-22": { slots: ["2026-09-22T09:30:00-05:00", "2026-09-22T10:00:00-05:00"] },
    "2026-09-23": { slots: ["2026-09-23T09:30:00-05:00"] },
    traceId: "not-a-day",
  };

  const googlePage =
    '<html>...<a href="/calendar/appointments/AcZssZ0Rp1Bj5qjc3SgNQS5xkjJbfoCOQIL_zdCI2SA=">book</a>...</html>';

  /** The service definition is positional protobuf-JSON; the id is field 7. */
  const googleDefs = [[[null, "15min", "", "Kevin Lourd", [], [[15]], "SVC-123"]], null, 0];

  /** 2026-09-22T10:30:00Z and the two quarter-hours after it. */
  const googleSlots = [[[[["1790073000"], 15]], [[["1790073900"], 15]], [[["1790074800"], 15]]]];

  it("resolves calendly.com/<user>/<event> and returns slots in the prospect's timezone", async () => {
    const calls = stubFetch((url) => ({ ok: true, body: url.includes("lookup") ? okLookup : okRange }));
    const main = loadMain(readBookingSlotsCode());

    const out = await main("https://calendly.com/acme-sales/30min", "Europe/Paris");

    expect(out.degraded).toBe(false);
    expect(out.slots).toEqual(["2026-09-04T10:00:00+02:00", "2026-09-04T14:00:00+02:00"]);
    expect(calls[0]).toContain("event_type_slug=30min");
    expect(calls[0]).toContain("profile_slug=acme-sales");
    // The timezone is what converts the slots — there is no arithmetic our side.
    expect(calls[1]).toContain("timezone=Europe%2FParis");
    expect(calls[1]).toContain("/event_types/ET-123/calendar/range");
  });

  it("resolves the short calendly.com/d/xxx form too", async () => {
    const calls = stubFetch((url) => ({ ok: true, body: url.includes("lookup") ? okLookup : okRange }));
    const main = loadMain(readBookingSlotsCode());

    const out = await main("https://calendly.com/d/abc-def-ghi", "America/New_York");

    expect(out.degraded).toBe(false);
    expect(calls[0]).toContain("event_type_uuid=abc-def-ghi");
  });

  it("hands over at most the candidate count, so the model picks two from a real set", async () => {
    const many = {
      days: Array.from({ length: 40 }, (_, d) => ({
        spots: Array.from({ length: 10 }, (_, i) => ({
          status: "available",
          start_time: new Date(Date.UTC(2026, 9, 1 + d, 8 + i)).toISOString().replace(".000Z", "Z"),
        })),
      })),
    };
    stubFetch((url) => ({ ok: true, body: url.includes("lookup") ? okLookup : many }));
    const out = await loadMain(readBookingSlotsCode())("https://calendly.com/a/b", "UTC");
    expect((out.slots as string[]).length).toBe(SLOT_CANDIDATES);
  });

  it("spreads the candidates across the days instead of clustering them on the first open day (Doc Dinners, 2026-09-28)", async () => {
    // The shape that stranded a prospect who wrote "I can't till next week":
    // a GoHighLevel calendar with a dozen open slots every weekday. Taken
    // earliest-first, the first six were all tomorrow and next week was absent.
    const days = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
    const payload: Record<string, unknown> = { traceId: "t" };
    for (const day of days) {
      payload[day] = {
        slots: Array.from({ length: 13 }, (_, i) => {
          const minutes = 8 * 60 + i * 30;
          return `${day}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00-05:00`;
        }),
      };
    }
    stubFetch((url) =>
      url.includes("leadconnectorhq.com/calendars")
        ? { ok: true, body: payload }
        : { ok: true, text: ghlPage },
    );
    const out = await loadMain(readBookingSlotsCode())("https://book.acme.com/page", "America/Chicago");
    const slots = out.slots as string[];

    expect(out.degraded).toBe(false);
    // Every open day is represented, next week included, a few times each.
    const perDay = new Map<string, number>();
    for (const s of slots) perDay.set(s.slice(0, 10), (perDay.get(s.slice(0, 10)) ?? 0) + 1);
    expect([...perDay.keys()]).toEqual(days);
    for (const n of perDay.values()) expect(n).toBe(SLOTS_PER_DAY);
    // Spaced out over the day, not bunched at its start.
    const oct6 = slots.filter((s) => s.startsWith("2026-10-06"));
    expect(oct6[0]).toBe("2026-10-06T08:00:00-05:00");
    expect(oct6[oct6.length - 1]).toBe("2026-10-06T14:00:00-05:00");
  });

  it("prefers working hours in the prospect's own timezone within a day", async () => {
    const range = {
      days: [
        {
          spots: ["01:00", "02:00", "03:00", "09:00", "13:00", "16:00", "22:00"].map((t) => ({
            status: "available",
            start_time: `2026-10-05T${t}:00-05:00`,
          })),
        },
      ],
    };
    stubFetch((url) => ({ ok: true, body: url.includes("lookup") ? okLookup : range }));
    const out = await loadMain(readBookingSlotsCode())("https://calendly.com/a/b", "America/Chicago");
    expect(out.slots).toEqual(["2026-10-05T09:00:00-05:00", "2026-10-05T13:00:00-05:00", "2026-10-05T16:00:00-05:00"]);
  });

  it("reads far enough ahead that a later window can be served", () => {
    expect(SLOT_LOOKAHEAD_DAYS).toBeGreaterThanOrEqual(21);
    // GoHighLevel's free-slots call 404s on a range over ~31 days.
    expect(SLOT_LOOKAHEAD_DAYS).toBeLessThanOrEqual(30);
  });

  it("degrades — never throws — when the brand has no booking link for this funnel", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await loadMain(readBookingSlotsCode())(null, "UTC");
    expect(out).toMatchObject({ degraded: true, degradedReason: "no_booking_url", slots: [] });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("degrades when the booking page cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => ({ ok: false }));
    const out = await loadMain(readBookingSlotsCode())("https://calendly.com/a/b", "UTC");
    expect(out.degraded).toBe(true);
    expect(String(out.degradedReason)).toContain("event_type_lookup_http_500");
    expect(out.slots).toEqual([]);
    vi.restoreAllMocks();
  });

  it("reads a GoHighLevel page on the client's own domain, in the prospect's timezone", async () => {
    const calls = stubFetch((url) =>
      url.includes("leadconnectorhq.com/calendars")
        ? { ok: true, body: ghlSlots }
        : { ok: true, text: ghlPage },
    );

    const out = await loadMain(readBookingSlotsCode())(
      "https://web.docdinners.com/appointment-booking-page",
      "America/Chicago",
    );

    expect(out.degraded).toBe(false);
    // traceId is a sibling of the day keys and must not be walked as one.
    expect(out.slots).toEqual([
      "2026-09-22T09:30:00-05:00",
      "2026-09-22T10:00:00-05:00",
      "2026-09-23T09:30:00-05:00",
    ]);
    expect(calls[0]).toBe("https://web.docdinners.com/appointment-booking-page");
    expect(calls[1]).toContain("/calendars/zJEXTXZCVIai1P1Dai3c/free-slots");
    expect(calls[1]).toContain("timezone=America%2FChicago");
    // The vendor applies the calendar's own duration; sending one would guess.
    expect(calls[1]).not.toContain("duration=");
  });

  it("degrades when a GoHighLevel page carries no calendar id", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => ({ ok: true, text: "<html>leadconnectorhq but nothing else</html>" }));
    const out = await loadMain(readBookingSlotsCode())("https://web.docdinners.com/x", "UTC");
    expect(out).toMatchObject({ degraded: true, degradedReason: "gohighlevel_calendar_id_not_found" });
    vi.restoreAllMocks();
  });

  it("degrades when the GoHighLevel slots call fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch((url) =>
      url.includes("leadconnectorhq.com/calendars")
        ? { ok: false, status: 404 }
        : { ok: true, text: ghlPage },
    );
    const out = await loadMain(readBookingSlotsCode())("https://web.docdinners.com/x", "UTC");
    expect(out).toMatchObject({ degraded: true, degradedReason: "gohighlevel_free_slots_http_404" });
    vi.restoreAllMocks();
  });

  it("degrades when a GoHighLevel calendar has nothing free in the range", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch((url) =>
      url.includes("leadconnectorhq.com/calendars")
        ? { ok: true, body: { traceId: "t" } }
        : { ok: true, text: ghlPage },
    );
    const out = await loadMain(readBookingSlotsCode())("https://web.docdinners.com/x", "UTC");
    expect(out).toMatchObject({ degraded: true, degradedReason: "gohighlevel_no_slots_in_range" });
    vi.restoreAllMocks();
  });

  it("reads a Google appointment schedule and converts epoch seconds into the prospect's timezone", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("ListAppointmentServiceDefinitions")) return { ok: true, body: googleDefs };
      if (url.includes("ListAvailableSlots")) return { ok: true, body: googleSlots };
      return { ok: true, text: googlePage };
    });

    const out = await loadMain(readBookingSlotsCode())(
      "https://calendar.app.google/BkmyoA7ujMFFDg1s9",
      "Europe/Paris",
    );

    expect(out.degraded).toBe(false);
    // Google is the ONLY provider that answers raw epoch seconds with no
    // timezone, so this offset is arithmetic we did, not a value it returned.
    expect(out.slots).toEqual([
      "2026-09-22T12:30:00+02:00",
      "2026-09-22T12:45:00+02:00",
      "2026-09-22T13:00:00+02:00",
    ]);
    expect(calls[0]).toBe("https://calendar.app.google/BkmyoA7ujMFFDg1s9");
    expect(calls[1]).toContain("ListAppointmentServiceDefinitions");
  });

  it("converts the same Google instant differently for a different prospect timezone", async () => {
    stubFetch((url) => {
      if (url.includes("ListAppointmentServiceDefinitions")) return { ok: true, body: googleDefs };
      if (url.includes("ListAvailableSlots")) return { ok: true, body: googleSlots };
      return { ok: true, text: googlePage };
    });
    const tokyo = await loadMain(readBookingSlotsCode())(
      "https://calendar.app.google/BkmyoA7ujMFFDg1s9",
      "Asia/Tokyo",
    );
    expect((tokyo.slots as string[])[0]).toBe("2026-09-22T19:30:00+09:00");

    const utc = await loadMain(readBookingSlotsCode())(
      "https://calendar.google.com/calendar/appointments/AcZssZ0=",
      "UTC",
    );
    expect((utc.slots as string[])[0]).toBe("2026-09-22T10:30:00+00:00");
  });

  it("reads calendar.google.com/calendar/appointments/<id> without fetching the page", async () => {
    const calls = stubFetch((url) =>
      url.includes("ListAppointmentServiceDefinitions")
        ? { ok: true, body: googleDefs }
        : { ok: true, body: googleSlots },
    );
    const out = await loadMain(readBookingSlotsCode())(
      "https://calendar.google.com/calendar/appointments/AcZssZ0Rp1Bj5qjc3SgNQS5xkjJbfoCOQIL_zdCI2SA=",
      "UTC",
    );
    expect(out.degraded).toBe(false);
    expect(calls[0]).toContain("ListAppointmentServiceDefinitions");
  });

  it("degrades when a Google short link does not resolve to a schedule", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => ({ ok: true, text: "<html>nothing here</html>" }));
    const out = await loadMain(readBookingSlotsCode())("https://calendar.app.google/zzz", "UTC");
    expect(out).toMatchObject({ degraded: true, degradedReason: "google_schedule_id_not_found" });
    vi.restoreAllMocks();
  });

  it("degrades when the Google slots call fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch((url) => {
      if (url.includes("ListAppointmentServiceDefinitions")) return { ok: true, body: googleDefs };
      if (url.includes("ListAvailableSlots")) return { ok: false, status: 403 };
      return { ok: true, text: googlePage };
    });
    const out = await loadMain(readBookingSlotsCode())("https://calendar.app.google/zzz", "UTC");
    expect(out).toMatchObject({ degraded: true, degradedReason: "google_slots_http_403" });
    vi.restoreAllMocks();
  });

  it("degrades when a Google schedule has no service definition", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch((url) =>
      url.includes("ListAppointmentServiceDefinitions")
        ? { ok: true, body: [[], null, 0] }
        : { ok: true, text: googlePage },
    );
    const out = await loadMain(readBookingSlotsCode())("https://calendar.app.google/zzz", "UTC");
    expect(out).toMatchObject({
      degraded: true,
      degradedReason: "google_service_definitions_returned_no_service",
    });
    vi.restoreAllMocks();
  });

  it("degrades when a Google schedule has nothing free in the range", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch((url) => {
      if (url.includes("ListAppointmentServiceDefinitions")) return { ok: true, body: googleDefs };
      if (url.includes("ListAvailableSlots")) return { ok: true, body: [[]] };
      return { ok: true, text: googlePage };
    });
    const out = await loadMain(readBookingSlotsCode())("https://calendar.app.google/zzz", "UTC");
    expect(out).toMatchObject({ degraded: true, degradedReason: "google_no_slots_in_range" });
    vi.restoreAllMocks();
  });

  it("degrades on a provider we do not read yet, rather than guessing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A GoHighLevel page is only identifiable from the page itself, so an
    // unknown host is fetched — and a page that is not one degrades.
    stubFetch(() => ({ ok: true, text: "<html>Cal.com booking page</html>" }));
    const out = await loadMain(readBookingSlotsCode())("https://cal.com/acme/30min", "UTC");
    expect(out).toMatchObject({ degraded: true, degradedReason: "unsupported_provider" });
    vi.restoreAllMocks();
  });

  it("tells an unreadable page apart from a host we do not read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => ({ ok: false, status: 500 }));
    const out = await loadMain(readBookingSlotsCode())("https://example.com/book", "UTC");
    expect(out).toMatchObject({ degraded: true, degradedReason: "booking_page_fetch_http_500" });
    vi.restoreAllMocks();
  });

  it("degrades when the range holds nothing available", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch((url) => ({
      ok: true,
      body: url.includes("lookup") ? okLookup : { days: [{ spots: [{ status: "unavailable", start_time: "x" }] }] },
    }));
    const out = await loadMain(readBookingSlotsCode())("https://calendly.com/a/b", "UTC");
    expect(out).toMatchObject({ degraded: true, degradedReason: "no_available_spots_in_range" });
    vi.restoreAllMocks();
  });
});

describe("composing the prompt", () => {
  const base = {
    followup: { followup: { id: "row-1", leadId: "lead-1", followupCount: 0 } },
    leadDetail: { leadDetail: { lead: { firstName: "Ada", currentTitle: "CTO", timezone: "Europe/Paris", organization: { name: "Acme" } } } },
    conversation: {
      success: true,
      conversation: {
        transport: "instantly",
        messageCount: 2,
        messages: [
          { direction: "outbound", at: "2026-08-01T09:00:00Z", subject: "Quick question", text: "Would this help your team?" },
          { direction: "inbound", at: "2026-08-02T09:00:00Z", subject: "Re: Quick question", text: "Does it work with our SSO?" },
        ],
      },
    },
    priorGeneration: { generation: { subject: "Quick question" } },
    offer: { offerId: "offer-1", name: "SSO audit", bookingUrl: "https://calendly.com/a/b" },
    brand: { brand: { name: "Acme" } },
    currentDate: "2026-09-02",
  };

  const call = (booking: unknown, followupCount = 0) =>
    composeReply(
      { followup: { ...base.followup.followup, followupCount } },
      base.leadDetail,
      base.conversation,
      base.priorGeneration,
      booking,
      base.offer,
      base.brand,
      base.currentDate,
    );

  it("puts the prospect's own words in front of the model and demands they be answered", async () => {
    const out = await call({ timezone: "Europe/Paris", degraded: false, bookingUrl: "https://calendly.com/a/b", slots: ["2026-09-04T10:00:00+02:00", "2026-09-04T14:00:00+02:00"] });
    const message = out.message as string;
    expect(message).toContain("Does it work with our SSO?");
    expect(message).toContain("Would this help your team?");
    expect(message).toContain("ANSWER THE QUESTION THEY ASKED");
    expect(message).toContain("PROSPECT");
    expect(message).toContain("US");
  });

  it("offers two slots in the prospect's own timezone when the page was read", async () => {
    const out = await call({ timezone: "Europe/Paris", degraded: false, bookingUrl: "https://calendly.com/a/b", slots: ["2026-09-04T10:00:00+02:00"] });
    const message = out.message as string;
    expect(message).toContain("EXACTLY TWO");
    expect(message).toContain("Europe/Paris");
    expect(message).toContain("2026-09-04T10:00:00+02:00");
  });

  it("falls back to the plain link with no slots when the page could not be read", async () => {
    const out = await call({ timezone: "UTC", degraded: true, degradedReason: "calendar_range_http_503", bookingUrl: "https://calendly.com/a/b", slots: [] });
    const message = out.message as string;
    expect(message).toContain("could not be read");
    expect(message).toContain("Do NOT invent times");
    expect(message).toContain("https://calendly.com/a/b");
    expect(message).not.toContain("EXACTLY TWO");
  });

  it("names the offer the campaign sells, and nothing else", async () => {
    const out = await call({ timezone: "UTC", degraded: true, degradedReason: "no_booking_url", bookingUrl: null, slots: [] });
    const message = out.message as string;
    expect(message).toContain("Offer: SSO audit");
    expect(message).not.toMatch(/funnel/i);
  });

  it("refuses to answer when the campaign's offer read carries no name", async () => {
    await expect(
      composeReply(
        base.followup, base.leadDetail, base.conversation, base.priorGeneration,
        { timezone: "UTC", degraded: true, degradedReason: "no_booking_url", bookingUrl: null, slots: [] },
        { offerId: "offer-nameless", name: null }, base.brand, base.currentDate,
      ),
    ).rejects.toThrow(/offer-nameless/);
  });

  it("still answers a prospect whose offer has no booking link", async () => {
    const out = await call({ timezone: "UTC", degraded: true, degradedReason: "no_booking_url", bookingUrl: null, slots: [] });
    const message = out.message as string;
    expect(message).toContain("This offer has no booking link");
    expect(message).toContain("do NOT invent a link");
    // The answer still goes out — the prompt asks for their times instead.
    expect(message).toContain("ANSWER THE QUESTION THEY ASKED");
  });

  it("grows the interval with each follow-up taken, with no cap", async () => {
    const days = async (count: number) => {
      const out = await call({ timezone: "UTC", degraded: true, degradedReason: "no_booking_url", bookingUrl: null, slots: [] }, count);
      return Math.round((Date.parse(out.ladderNextDueAt as string) - Date.now()) / 86400000);
    };
    expect(await days(0)).toBe(3);
    expect(await days(1)).toBe(7);
    expect(await days(2)).toBe(21);
    expect(await days(3)).toBe(60);
    expect(await days(4)).toBe(180);
    // No ceiling on how many follow-ups a prospect gets — the interval is the limit.
    expect(await days(25)).toBe(180);
  });

  it("tells the model to honour a date the prospect asked for", async () => {
    const out = await call({ timezone: "UTC", degraded: true, degradedReason: "no_booking_url", bookingUrl: null, slots: [] });
    expect(out.message as string).toContain("recontact me in January");
  });
});

describe("bounding the next due date", () => {
  const ladder = new Date(Date.now() + 3 * 86400000).toISOString();
  const main = loadMain(RESOLVE_NEXT_DUE_CODE);

  it("honours the date the prospect asked for", async () => {
    const asked = new Date(Date.now() + 120 * 86400000).toISOString();
    const out = await main({ json: { replyHtml: "<p>hi</p>", nextDueAt: asked } }, ladder);
    expect(out).toEqual({ nextDueAt: asked, source: "prospect_stated" });
  });

  it("refuses to let an empty answer reach the prospect, BEFORE the send", async () => {
    // The model said it could answer and returned nothing to send. That is a
    // broken contract rather than a degradation, and this node is the last
    // thing that runs before the irreversible step.
    for (const bad of [undefined, "", "   ", 42]) {
      await expect(
        main({ json: { replyHtml: bad, nextDueAt: new Date(Date.now() + 86400000).toISOString() } }, ladder),
      ).rejects.toThrow(/no reply body/);
    }
  });

  it("falls back loudly rather than letting the record fail after the reply is sent", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const bad of [
      undefined,
      "not a date",
      new Date(Date.now() - 86400000).toISOString(), // lead-service 400s on the past
      new Date(Date.now() + 400 * 86400000).toISOString(), // and on further than a year
    ]) {
      const out = await main({ json: { replyHtml: "<p>hi</p>", nextDueAt: bad } }, ladder);
      expect(out).toEqual({ nextDueAt: ladder, source: "interval_ladder" });
    }
    expect(err).toHaveBeenCalledTimes(4);
    err.mockRestore();
  });
});

describe("declaring the caller, and standing down when a human has taken over", () => {
  const dag = buildAiMeetingBookingDag(DAG_OPTS);
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));

  it("declares every reply as automation on the wire", () => {
    // instantly-service refuses an `automation` reply once a person has
    // answered the thread. Absent resolves to automation today, so declaring it
    // is what keeps the gate true the day a human-facing surface calls the same
    // route.
    expect((byId.get("send-reply")?.config?.body as Record<string, unknown>).sent_by).toBe("automation");
  });

  it("reads the takeover as an outcome and every other refusal as a failure", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const main = loadMain(CLASSIFY_SEND_CODE);

    expect(await main({ success: true, status: "sent" })).toEqual({ outcome: "sent", status: "sent" });
    // Out of the prospect's sending window: queued, still sent as far as this
    // run is concerned, so the follow-up is recorded.
    expect(await main({ success: true, status: "scheduled" })).toEqual({ outcome: "sent", status: "scheduled" });

    expect(
      await main({ ok: false, status: 409, error: JSON.stringify({ error: "x", code: "human_took_over" }) }),
    ).toEqual({ outcome: "human_took_over", status: 409 });

    // A 409 is NOT enough on its own — three other codes share it and all mean
    // the reply could not be sent.
    for (const code of ["no_reply_to_thread", "sending_account_unresolved", "mailbox_credential_unavailable"]) {
      await expect(main({ ok: false, status: 409, error: JSON.stringify({ code }) })).rejects.toThrow(code);
    }
    await expect(main({ ok: false, status: 502, error: "boom" })).rejects.toThrow("502");
    await expect(main({ ok: false, status: 0, error: "timeout" })).rejects.toThrow("timeout");
    err.mockRestore();
  });

  it("records no follow-up when a human took the thread over", () => {
    const takenOver = dag.edges.find(
      (e) => e.from === "check-sent" && e.condition?.includes("human_took_over"),
    );
    expect(takenOver?.to).toBe("end-run-human-took-over");
    const reached = descendants(dag, takenOver?.to as string);
    expect(reached.has("record-followup")).toBe(false);
    // Standing down is not a failed run.
    expect(byId.get("end-run-human-took-over")?.config?.body).toEqual({ success: true, stopCampaign: false });

    const sent = dag.edges.find(
      (e) => e.from === "check-sent" && e.condition?.includes("'sent'") && e.condition?.includes("== 'answer'"),
    );
    expect(sent?.to).toBe("record-followup");
  });

  it("both arms of the send outcome read POSITIVE evidence, never the absence of a refusal", () => {
    // On the escalation path `classify-send` never ran. An "anything but a 409"
    // arm would then record a follow-up for a reply that was never sent.
    for (const e of dag.edges.filter((x) => x.from === "check-sent")) {
      expect(e.condition).toContain("results['classify-send']?.outcome ==");
    }
    // and it converges rather than nesting inside check-answerable's branch.
    expect(dag.edges.filter((e) => e.to === "check-sent").map((e) => e.from)).toContain("draft-reply");
  });
});

describe("handing an unanswerable question to a human", () => {
  const dag = buildAiMeetingBookingDag(DAG_OPTS);
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));

  it("lets the model decline — the reply body is no longer required", () => {
    expect(REPLY_RESPONSE_SCHEMA.required).toContain("decision");
    expect(REPLY_RESPONSE_SCHEMA.required).toContain("question");
    // Requiring a reply body is what left the model no move but a deflection.
    expect(REPLY_RESPONSE_SCHEMA.required).not.toContain("replyHtml");
    expect(REPLY_RESPONSE_SCHEMA.required).not.toContain("nextDueAt");
  });

  it("decides answerability in the model, with no keyword or regex pre-filter", () => {
    const answerable = dag.edges.find(
      (e) => e.from === "check-answerable" && e.condition?.includes("== 'answer'"),
    );
    const cannot = dag.edges.find(
      (e) => e.from === "check-answerable" && e.condition?.includes("== 'escalate'"),
    );
    expect(answerable?.to).toBe("resolve-next-due");
    expect(cannot?.to).toBe("escalate-unanswerable");
    for (const e of dag.edges.filter((x) => x.from === "check-answerable")) {
      expect(e.condition).toContain("results['ground-draft']?.json?.decision ==");
    }
    // Nothing anywhere inspects the prospect's own text to decide.
    const scripts = dag.nodes.filter((n) => n.type === "script").map((n) => String(n.config?.code));
    expect(scripts.some((c) => /answerable\s*=\s*\/|test\(.*price|includes\("price/i.test(c))).toBe(false);

    // It converges rather than nesting inside check-claim's branch body.
    expect(dag.edges.filter((e) => e.to === "check-answerable").map((e) => e.from)).toContain("claim-followup");
  });

  it("sends the prospect nothing and escalates with the question in their own words", () => {
    const esc = byId.get("escalate-unanswerable");
    expect(esc?.config).toMatchObject({
      service: "instantly",
      method: "POST",
      path: "/orgs/replies/escalate",
      validateResponse: { field: "success", equals: true },
    });
    expect(esc?.inputMapping).toEqual({
      "body.campaign_id": PREDECESSOR_CAMPAIGN_REF,
      "body.email": "$ref:claim-followup.output.followup.email",
      "body.question": "$ref:ground-draft.output.json.question",
    });

    const reached = descendants(dag, "escalate-unanswerable");
    // No reply, no holding message, no placeholder.
    expect(reached.has("send-reply")).toBe(false);
    // and nothing is recorded as acted: the schedule is emptied, not advanced.
    expect(reached.has("record-followup")).toBe(false);
    expect(reached.has("end-run-escalated")).toBe(true);
    expect(byId.get("end-run-escalated")?.config?.body).toEqual({ success: true, stopCampaign: false });
  });

  it("does not stop the ladder itself — the escalate route already did", () => {
    // The escalation path touches no lead-service write: instantly-service's
    // escalate route empties the schedule itself.
    const reached = descendants(dag, "escalate-unanswerable");
    const leadWrites = dag.nodes.filter(
      (n) => reached.has(n.id) && n.config?.service === "lead",
    );
    expect(leadWrites).toEqual([]);
  });

  it("tells the model to hand over rather than deflect back to the call", async () => {
    const out = await composeReply(
      { followup: { id: "row-1", leadId: "lead-1", followupCount: 0 } },
      { leadDetail: { lead: { firstName: "Ada", timezone: "UTC" } } },
      { conversation: { messages: [{ direction: "inbound", text: "What does it cost for 5 seats?" }] } },
      null,
      { timezone: "UTC", degraded: true, degradedReason: "no_booking_url", bookingUrl: null, slots: [] },
      { offerId: "offer-1", name: "SSO audit", bookingUrl: null },
      { brand: { name: "Acme" } },
      "2026-09-02",
    );
    const message = out.message as string;
    expect(message).toContain("WHEN YOU CANNOT ANSWER");
    expect(message).toContain("set decision to escalate");
    expect(message).toContain("no deflection back to the call");
    expect(message).toContain("question: what they asked, in their own words");
    expect(out.systemPrompt as string).toContain("hand over");
  });
});


describe("a last message that needs no reply at all", () => {
  const dag = buildAiMeetingBookingDag(DAG_OPTS);
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));

  it("is a third exit the model chooses, beside answer and escalate", () => {
    const decision = REPLY_RESPONSE_SCHEMA.properties.decision;
    expect(decision.enum).toEqual(["answer", "escalate", "no_reply_owed", "confirm_booking", "close_with_thanks"]);
    expect(REPLY_RESPONSE_SCHEMA.required).toContain("reason");
    const arm = dag.edges.find(
      (e) => e.from === "check-answerable" && e.condition === "results['ground-draft']?.json?.decision == 'no_reply_owed'",
    );
    expect(arm?.to).toBe("name-no-reply-owed");
    // Exactly one arm per decision.
    expect(dag.edges.filter((e) => e.from === "check-answerable")).toHaveLength(3);
  });

  it("sends nothing, escalates nothing, stops the follow-ups, and ends clean", () => {
    const reached = descendants(dag, "name-no-reply-owed");
    expect(reached.has("send-reply")).toBe(false);
    expect(reached.has("escalate-unanswerable")).toBe(false);
    expect(reached.has("record-followup")).toBe(false);
    expect(reached.has("stop-followups")).toBe(true);
    expect(reached.has("end-run-no-reply-owed")).toBe(true);

    const stop = byId.get("stop-followups");
    expect(stop?.config).toMatchObject({
      service: "lead",
      method: "POST",
      path: "/orgs/leads/{id}/followups",
      body: { kind: "stopped", reason: NO_REPLY_OWED_REASON },
    });
    expect(stop?.inputMapping).toEqual({ "params.id": "$ref:claim-followup.output.followup.id" });
    expect(byId.get("end-run-no-reply-owed")?.config?.body).toEqual({ success: true, stopCampaign: false });
  });

  it("emits the three arms in ONE top-level branchone, with the stop inside the no-reply arm", () => {
    const flow = dagToOpenFlow(dag, `${FEATURE_SLUG}-test`);
    type M = { id: string; value: { type: string; branches?: Array<{ expr: string; modules: M[] }> } };
    const top = flow.value.modules as unknown as M[];
    const check = top.find((m) => m.id === "check_answerable");
    expect(check?.value.type).toBe("branchone");
    const branches = check?.value.branches ?? [];
    expect(branches).toHaveLength(3);
    const noReply = branches.find((b) => b.expr.includes("no_reply_owed"));
    expect(noReply?.modules.map((m) => m.id)).toEqual([
      "name_no_reply_owed",
      "stop_followups",
      "end_run_no_reply_owed",
    ]);
    const escalate = branches.find((b) => b.expr.includes("'escalate'"));
    expect(escalate?.modules.map((m) => m.id)).toEqual(["escalate_unanswerable", "end_run_escalated"]);
  });

  it("says why in the log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await loadMain(NAME_NO_REPLY_OWED_CODE)(
      { json: { decision: "no_reply_owed", question: "not interested at this time", reason: "They declined." } },
      "cynthia@example.com",
    );
    expect(out).toEqual({ outcome: "no_reply_owed", reason: "They declined.", said: "not interested at this time" });
    expect(String(log.mock.calls[0]?.[0])).toContain("no reply owed to cynthia@example.com");
    log.mockRestore();
  });

  it("tells the model a refusal or goodbye is not a question to escalate", async () => {
    const out = await composeReply(
      { followup: { id: "row-1", leadId: "lead-1", followupCount: 1 } },
      { leadDetail: { lead: { firstName: "Cynthia", timezone: "UTC" } } },
      { conversation: { messages: [{ direction: "inbound", text: "Apologies, my previous email was sent in error. We are not interested at this time. Thank you for your time." }] } },
      null,
      { timezone: "UTC", degraded: true, degradedReason: "no_booking_url", bookingUrl: null, slots: [] },
      { offerId: "offer-1", name: "SSO audit", bookingUrl: null },
      { brand: { name: "Acme" } },
      "2026-09-28",
    );
    const message = out.message as string;
    expect(message).toContain("FIRST: IS A REPLY OWED AT ALL");
    expect(message).toContain("Set decision to no_reply_owed");
    expect(message).toContain("that is no_reply_owed, never escalate");
    expect(out.systemPrompt as string).toContain("you send nothing and hand nothing over");
    // The model decides; no keyword pre-filter exists anywhere in the flow.
    const scripts = dag.nodes.filter((n) => n.type === "script").map((n) => String(n.config?.code));
    // The prompt TEXT names these cases for the model; no script MATCHES on them.
    expect(
      scripts.some((c) => /(\.test\(|\.includes\(|\.match\()[^\n]*(interested|stop|error|thank|goodbye)/i.test(c)),
    ).toBe(false);
  });
});


describe("a prospect who tells us the meeting is booked", () => {
  const dag = buildAiMeetingBookingDag(DAG_OPTS);
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const JOANIE = "Scheduled a call for Friday! Thank you";

  async function composeFor(lastMessage: string) {
    return composeReply(
      { followup: { id: "row-1", leadId: "lead-1", followupCount: 0 } },
      { leadDetail: { lead: { firstName: "Joanie", timezone: "America/New_York" } } },
      {
        conversation: {
          messages: [
            { direction: "outbound", text: "Would a short call help?" },
            { direction: "inbound", text: lastMessage },
          ],
        },
      },
      null,
      { timezone: "America/New_York", degraded: true, degradedReason: "no_booking_url", bookingUrl: null, slots: [] },
      { offerId: "offer-1", name: "Doc Dinners", bookingUrl: null },
      { brand: { name: "Doc Dinners" } },
      "2026-09-28",
    );
  }

  it("is a fourth exit the model chooses, with its own reply body", () => {
    expect(REPLY_RESPONSE_SCHEMA.properties.decision.enum).toContain("confirm_booking");
    expect(REPLY_RESPONSE_SCHEMA.properties.decision.description).toContain("confirm_booking:");
    expect(REPLY_RESPONSE_SCHEMA.properties.replyHtml.description).toContain("confirm_booking");
  });

  it("puts a booking confirmation in front of the model, and no longer files a thank-you under goodbyes", async () => {
    const out = await composeFor(JOANIE);
    const message = out.message as string;
    expect(message).toContain(JOANIE);
    expect(message).toContain("WHEN THEY TELL US THE MEETING IS BOOKED");
    expect(message).toContain("Set decision to confirm_booking");
    expect(message).toContain("no question, no pitch");
    // "thanks" was what filed "Scheduled a call! Thank you" under no_reply_owed.
    expect(message).not.toContain("(thanks, goodbye)");
    // Declines still get nothing.
    expect(message).toContain("Set decision to no_reply_owed");
    expect(out.systemPrompt as string).toContain("the meeting is booked");
  });

  it("rides the same send as an answer, then STOPS the follow-ups instead of advancing them", () => {
    const toSend = dag.edges.find((e) => e.from === "check-answerable" && e.to === "resolve-next-due");
    expect(toSend?.condition).toContain("decision == 'confirm_booking'");
    expect(toSend?.condition).toContain("decision == 'answer'");
    // Still exactly one arm per branch of the decision container.
    expect(dag.edges.filter((e) => e.from === "check-answerable")).toHaveLength(3);

    const booked = dag.edges.find((e) => e.from === "check-sent" && e.to === "stop-followups-booked");
    expect(booked?.condition).toBe(
      "results['classify-send']?.outcome == 'sent' && results['ground-draft']?.json?.decision == 'confirm_booking'",
    );
    const reached = descendants(dag, "stop-followups-booked");
    expect(reached.has("record-followup")).toBe(false);
    expect(reached.has("end-run-booking-confirmed")).toBe(true);
    expect(byId.get("stop-followups-booked")?.config).toMatchObject({
      service: "lead",
      method: "POST",
      path: "/orgs/leads/{id}/followups",
      body: { kind: "stopped", reason: BOOKING_CONFIRMED_REASON },
    });
    expect(byId.get("end-run-booking-confirmed")?.config?.body).toEqual({ success: true, stopCampaign: false });
    // A human takeover still records nothing on either path.
    const takeover = dag.edges.find((e) => e.from === "check-sent" && e.condition?.includes("human_took_over"));
    expect(takeover?.to).toBe("end-run-human-took-over");
    expect(validateDAG(dag).valid).toBe(true);
  });

  it("emits the booked arm inside check-sent's top-level branchone", () => {
    const flow = dagToOpenFlow(dag, `${FEATURE_SLUG}-test`);
    type M = { id: string; value: { type: string; branches?: Array<{ expr: string; modules: M[] }> } };
    const top = flow.value.modules as unknown as M[];
    const check = top.find((m) => m.id === "check_sent");
    expect(check?.value.type).toBe("branchone");
    const booked = (check?.value.branches ?? []).find((b) => b.expr.includes("confirm_booking"));
    expect(booked?.expr).toContain("results.ground_draft?.json?.decision");
    expect(booked?.modules.map((m) => m.id)).toEqual(["stop_followups_booked", "end_run_booking_confirmed"]);
  });

  it("does not resolve a next due date for a confirmation, and still refuses an empty body", async () => {
    const main = loadMain(RESOLVE_NEXT_DUE_CODE);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await main({ json: { decision: "confirm_booking", replyHtml: "<p>Thanks Joanie, see you Friday.</p>" } }, "2026-10-01T00:00:00.000Z"),
    ).toEqual({ nextDueAt: null, source: "booking_confirmed" });
    expect(err).not.toHaveBeenCalled();
    await expect(main({ json: { decision: "confirm_booking" } }, "2026-10-01T00:00:00.000Z")).rejects.toThrow("no reply body");
    err.mockRestore();
  });
});

describe("a prospect who tells us when they are free", () => {
  const stellaThread = {
    success: true,
    conversation: {
      transport: "instantly",
      messageCount: 2,
      messages: [
        { direction: "outbound", at: "2026-09-28T13:00:00Z", text: "Would tomorrow at 8:00 or 8:30 AM work for a quick call?" },
        { direction: "inbound", at: "2026-09-28T15:00:00Z", text: "Unfortunately I can't till next week" },
      ],
    },
  };
  const compose = (slots: string[]) =>
    composeReply(
      { followup: { id: "row-1", leadId: "lead-1", followupCount: 0 } },
      { leadDetail: { lead: { firstName: "Stella", timezone: "America/Chicago" } } },
      stellaThread,
      null,
      { timezone: "America/Chicago", degraded: false, bookingUrl: "https://web.docdinners.com/appointment-booking-page", slots },
      { offerId: "offer-1", name: "Doc Dinners", bookingUrl: "https://web.docdinners.com/appointment-booking-page" },
      { brand: { name: "Doc Dinners" } },
      "2026-09-28",
    );

  it("labels every slot with its weekday so a stated window can be matched", async () => {
    const out = await compose(["2026-10-05T08:00:00-05:00", "2026-10-08T15:30:00-05:00"]);
    const message = out.message as string;
    expect(message).toContain("- Monday 2026-10-05 08:00 (2026-10-05T08:00:00-05:00)");
    expect(message).toContain("- Thursday 2026-10-08 15:30 (2026-10-08T15:30:00-05:00)");
  });

  it("tells the model a timing preference is answered with times inside it, never escalated", async () => {
    const out = await compose(["2026-10-05T08:00:00-05:00"]);
    const message = out.message as string;
    expect(message).toContain("WHEN THEY SAY WHEN THEY ARE FREE");
    expect(message).toContain("A timing preference is never a reason to escalate");
    expect(message).toContain("both times MUST fall inside what they said");
    // With nothing inside their window: the link, not an escalation.
    expect(message).toContain("give them the link to pick one in their window");
    expect(REPLY_RESPONSE_SCHEMA.properties.decision.description).toContain("When they can meet is never a reason to escalate");
  });

  it("no longer lists a date as something that cannot be answered", async () => {
    const out = await compose([]);
    expect(out.message as string).not.toContain("commitment to a date");
  });
});


describe("answering an information request from brand-service facts (Dr. Joe, Doc Dinners, 2026-10-01)", () => {
  const dag = buildAiMeetingBookingDag(DAG_OPTS);
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const quiet = () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  };
  afterEach(() => vi.restoreAllMocks());

  const conversation = {
    conversation: {
      messages: [
        { direction: "outbound", text: "Would a hosted dinner for local chiropractors help you get referrals?" },
        { direction: "inbound", text: "Send me more information on how it works." },
      ],
    },
  };
  const offer = { offerId: "offer-1", name: "Doctor referral dinners", bookingUrl: "https://calendly.com/a/b" };

  it("runs the three fixed steps in order: list questions, read brand-service, draft, then the grounding guard", () => {
    const order = [
      "prior-generation", "compose-questions-prompt", "list-questions", "plan-lookups",
      "offer-answers", "offer-user-fields", "brand-user-fields", "extract-answers", "gather-facts",
      "compose-prompt", "draft-reply", "ground-draft", "check-answerable",
    ];
    for (let i = 0; i < order.length - 1; i++) {
      expect(dag.edges.some((e) => e.from === order[i] && e.to === order[i + 1])).toBe(true);
    }
    // No dynamic loop: no for-each, and nothing points back upstream.
    expect(dag.nodes.some((n) => n.type === "for-each")).toBe(false);
    expect(validateDAG(dag).valid).toBe(true);
  });

  it("lists the questions with the model on chat-service, never by a rule", async () => {
    const node = byId.get("list-questions");
    expect(node?.config).toMatchObject({ service: "chat", method: "POST", path: "/complete" });
    expect((node?.config?.body as Record<string, unknown>).responseSchema).toBe(QUESTIONS_RESPONSE_SCHEMA);
    const out = await loadMain(COMPOSE_QUESTIONS_PROMPT_CODE)(conversation, offer);
    expect(out.message as string).toContain("Send me more information on how it works.");
    expect(out.message as string).toContain("request for information");
    expect(out.message as string).toContain("Do NOT list: when they can meet");
  });

  it("reads what the customer STATED, then extracts from the site in one call, naming brand and offer", () => {
    expect(byId.get("offer-answers")?.config).toMatchObject({
      service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/answers",
    });
    expect(byId.get("offer-user-fields")?.config?.path).toBe("/orgs/brands/{brandId}/offers/{offerId}/user-fields");
    expect(byId.get("brand-user-fields")?.config?.path).toBe("/orgs/brands/{brandId}/user-fields");
    const extract = byId.get("extract-answers");
    expect(extract?.config).toMatchObject({
      service: "brand", method: "POST", path: "/orgs/brands/extract-fields",
      // extract returns "Unknown" when the site is silent; suggest would invent.
      body: { mode: "extract" },
    });
    expect(extract?.inputMapping).toEqual({
      "headers.x-brand-id": "$ref:claim-followup.output.followup.brandId",
      "body.fields": "$ref:plan-lookups.output.fields",
      "body.offerId": "$ref:campaign-detail.output.campaign.offerId",
    });
  });

  it("asks the site one field per question, plus how the offer works", async () => {
    const out = await loadMain(PLAN_LOOKUPS_CODE)({ json: { questions: [{ question: "How does it work?" }, { question: " " }], identity: INSIDER, playbook: "none" } }, offer);
    expect(out.questions).toEqual([{ key: "q1", question: "How does it work?" }]);
    const fields = out.fields as Array<{ key: string; description: string }>;
    expect(fields.map((f) => f.key)).toEqual([OFFER_OVERVIEW_KEY, "q1"]);
    expect(fields[1].description).toContain("How does it work?");
    expect(fields[1].description).toContain("return Unknown");
  });

  it("refuses to draft when the question-listing step returned no list", async () => {
    await expect(loadMain(PLAN_LOOKUPS_CODE)({ json: {} }, offer)).rejects.toThrow(/no questions array/);
  });

  const plan = { questions: [{ key: "q1", question: "How does it work?" }, { key: "q2", question: "What does it cost?" }] };
  const offerAnswers = {
    stated: true,
    answers: [{ question: "How does it work?", answer: "We host a dinner for 20 local doctors; you present for 15 minutes." }],
  };
  const offerFields = {
    fields: {
      services: { value: "Hosted referral dinners", provenance: "confirmed" },
      dreamOutcome: { value: "A steady flow of referrals", provenance: "suggested" },
      urgency: { value: null, provenance: "suggested" },
    },
  };
  const brandFields = { fields: { services: { value: "Hosted referral dinners", provenance: "confirmed" } } };
  const extracted = {
    fields: {
      [OFFER_OVERVIEW_KEY]: { value: "Doc Dinners organises dinners where doctors meet referral partners." },
      q1: { value: "Dinners are held monthly in your city." },
      q2: { value: "Unknown" },
    },
  };

  it("tags every fact with its provenance, and drops what the site does not say", async () => {
    quiet();
    const facts = await loadMain(GATHER_FACTS_CODE)(plan, offerAnswers, offerFields, brandFields, extracted);
    expect(facts.exact).toEqual([
      { id: "E1", source: "offer-answers", label: "How does it work?", value: "We host a dinner for 20 local doctors; you present for 15 minutes." },
      { id: "E2", source: "offer-user-fields", label: "services", value: "Hosted referral dinners" },
    ]);
    const interpreted = facts.interpreted as Array<Record<string, unknown>>;
    expect(interpreted).toContainEqual({ id: "I1", source: "site-prefill", label: "dreamOutcome", value: "A steady flow of referrals" });
    expect(interpreted).toContainEqual({ id: "I2", source: "site-extraction", label: "how the offer works", value: "Doc Dinners organises dinners where doctors meet referral partners." });
    expect(interpreted).toContainEqual({ id: "I3", source: "site-extraction", label: "How does it work?", value: "Dinners are held monthly in your city.", questionKey: "q1" });
    expect(facts.withheld).toEqual([]);
    // "Unknown" is a missing fact, never a fact.
    expect(JSON.stringify(facts)).not.toContain("Unknown");
    expect(facts.questions).toEqual([
      { key: "q1", question: "How does it work?", siteAnswer: "Dinners are held monthly in your city." },
      { key: "q2", question: "What does it cost?", siteAnswer: null },
    ]);
    // The provenance is in the run's logs, so a person can audit why a fact was said.
    expect(String((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])).toContain("exact = stated by the customer");
  });

  const compose = (facts: unknown, lead: Record<string, unknown> = { firstName: "Joe", timezone: "America/Chicago" }) =>
    composeReply(
      { followup: { id: "row-1", leadId: "lead-1", followupCount: 0 } },
      { leadDetail: { lead } },
      conversation,
      null,
      { timezone: "America/Chicago", degraded: false, bookingUrl: "https://calendly.com/a/b", slots: ["2026-10-06T10:00:00-05:00"] },
      offer,
      { brand: { name: "Doc Dinners" } },
      "2026-10-01",
      facts,
    );

  it("puts the customer's stated facts in front of the model as EXACT, and site reads as INTERPRETED", async () => {
    quiet();
    const facts = await loadMain(GATHER_FACTS_CODE)(plan, offerAnswers, offerFields, brandFields, extracted);
    const message = (await compose(facts)).message as string;
    expect(message).toContain("- q1: How does it work?");
    expect(message).toContain("EXACT FACTS");
    expect(message).toContain("- E1 How does it work?: We host a dinner for 20 local doctors; you present for 15 minutes.");
    expect(message).toContain("INTERPRETED FACTS");
    expect(message).toContain("- I2 how the offer works: Doc Dinners organises dinners");
    expect(message).toContain("set decision to escalate and put exactly the unanswered question(s)");
    // Booking behaviour is untouched.
    expect(message).toContain("EXACTLY TWO");
  });

  it("leaves the prompt without a facts section when they asked nothing", async () => {
    const message = (await compose({ questions: [], exact: [], interpreted: [] })).message as string;
    expect(message).not.toContain("WHAT THEY ASKED");
    expect(message).not.toContain("EXACT FACTS");
  });

  it("hands the model the whole person and company record, omitting what is absent", async () => {
    const message = (await compose({ questions: [], exact: [], interpreted: [] }, {
      firstName: "Joe", lastName: "Smith", currentTitle: "Owner", headline: "Chiropractor, Chiro Health Spa",
      seniority: "owner", departments: ["medical"], city: "Austin", state: "Texas", country: "United States",
      timezone: "America/Chicago", linkedinUrl: null, functions: [],
      employmentHistory: [{ title: "Associate", organizationName: "Spine Co", startDate: "2010-01-01", endDate: "2014-01-01", current: false }],
      organization: { name: "Chiro Health Spa", industry: "health, wellness & fitness", estimatedNumEmployees: 8, city: "Austin", shortDescription: "Chiropractic clinic", foundedYear: null, keywords: [] },
    })).message as string;
    expect(message).toContain("Name: Joe Smith");
    expect(message).toContain("Headline: Chiropractor, Chiro Health Spa");
    expect(message).toContain("Based in: Austin, Texas, United States");
    expect(message).toContain("Earlier roles: Associate at Spine Co (2010-01-01 to 2014-01-01)");
    expect(message).toContain("THEIR COMPANY");
    expect(message).toContain("Employees: 8");
    expect(message).toContain("About: Chiropractic clinic");
    // Absent fields are omitted, never blank labels.
    expect(message).not.toMatch(/^(LinkedIn|Functions|Founded|Keywords|Funding):\s*$/m);
    expect(message).not.toContain("LinkedIn:");
    expect(message).not.toContain("Founded:");
  });

  it("requires the draft to say where each answer came from", () => {
    expect(REPLY_RESPONSE_SCHEMA.required).toContain("answers");
    expect(REPLY_RESPONSE_SCHEMA.properties.answers.items.properties.source.enum).toEqual(["exact", "interpreted", "booking", "playbook", "none"]);
    expect(REPLY_RESPONSE_SCHEMA.properties.answers.items.required).toContain("facts");
  });

  const factsWithBoth = {
    questions: plan.questions.map((q) => ({ ...q, siteAnswer: null })),
    exact: [{ id: "E1", source: "offer-answers", label: "How does it work?", value: "..." }],
    interpreted: [],
  };

  it("lets an answer through when every question has a source that holds facts", async () => {
    quiet();
    const draft = { json: { decision: "answer", question: "q", reason: "r", replyHtml: "<p>Hi</p>", answers: [{ key: "q1", source: "exact", facts: ["E1"] }, { key: "q2", source: "exact", facts: ["E1"] }] } };
    const out = await loadMain(GROUND_DRAFT_CODE)(draft, factsWithBoth);
    expect(out.overridden).toBe(false);
    expect(out.json).toEqual(draft.json);
  });

  it("escalates with the precise unanswered question when no fact covers it — nothing is sent", async () => {
    quiet();
    const draft = { json: { decision: "answer", question: "q", reason: "r", replyHtml: "<p>It costs $99</p>", answers: [{ key: "q1", source: "exact", facts: ["E1"] }, { key: "q2", source: "none", facts: [] }] } };
    const out = await loadMain(GROUND_DRAFT_CODE)(draft, factsWithBoth);
    expect(out.overridden).toBe(true);
    const json = out.json as Record<string, unknown>;
    expect(json.decision).toBe("escalate");
    expect(json.question).toBe("What does it cost?");
    expect(json.replyHtml).toBeUndefined();
  });

  it("treats a question the draft did not account for, or a source that holds nothing, as unanswered", async () => {
    quiet();
    // q2 missing; q1 claims `interpreted` while no site fact exists.
    const draft = { json: { decision: "answer", question: "q", reason: "r", replyHtml: "<p>x</p>", answers: [{ key: "q1", source: "interpreted", facts: ["E1"] }] } };
    const out = await loadMain(GROUND_DRAFT_CODE)(draft, factsWithBoth);
    expect((out.json as Record<string, unknown>).decision).toBe("escalate");
    expect((out.json as Record<string, unknown>).question).toBe("How does it work? / What does it cost?");
  });

  it("leaves every other decision untouched", async () => {
    quiet();
    for (const decision of ["escalate", "no_reply_owed", "confirm_booking"]) {
      const draft = { json: { decision, question: "q", reason: "r", answers: [] } };
      const out = await loadMain(GROUND_DRAFT_CODE)(draft, factsWithBoth);
      expect(out.json).toEqual(draft.json);
    }
  });

  describe("owning the information, never pointing at a site (Dr. Joe, 2026-10-02)", () => {
    it("no longer licenses attributing a fact to a site, a page or a source", async () => {
      quiet();
      const facts = await loadMain(GATHER_FACTS_CODE)(plan, offerAnswers, offerFields, brandFields, extracted);
      const out = await compose(facts);
      const text = `${out.message as string}\n${out.systemPrompt as string}`;
      expect(text).not.toMatch(/as far as I can see/i);
      expect(text).not.toMatch(/our site describes/i);
      expect(text).not.toMatch(/phrase them with (care|caution)/i);
      expect(text).not.toMatch(/\[site-(extraction|prefill)\]/);
      expect(text).toContain("State every fact in the first person, as our own knowledge");
      expect(text).toContain("never point to a website, a page, a brochure");
      expect(text).toContain("Lead with what our client stated");
    });

    it("holds a cited fact id to an existing fact of that kind: an invented id is no source", async () => {
      quiet();
      const draft = { json: { decision: "answer", question: "q", reason: "r", replyHtml: "<p>x</p>", answers: [
        { key: "q1", source: "exact", facts: ["E9"] }, { key: "q2", source: "exact", facts: [] },
      ] } };
      const out = await loadMain(GROUND_DRAFT_CODE)(draft, factsWithBoth);
      expect((out.json as Record<string, unknown>).decision).toBe("escalate");
      expect((out.json as Record<string, unknown>).question).toBe("How does it work? / What does it cost?");
    });
  });

  describe("an operator PLACEHOLDER is no answer (Doc Dinners offer answers, 2026-10-02)", () => {
    const placeholderAnswers = {
      stated: true,
      answers: [
        { question: "How much is it?", answer: "PLACEHOLDER — not a real answer, do not quote this to anyone. Doc Dinners has not stated its pricing yet; the operator replaces this line with what the dinners actually cost." },
        { question: "What is included?", answer: "PLACEHOLDER — not a real answer, do not quote this to anyone. The operator replaces this line with what a guest gets for the price." },
        { question: "How many appointments?", answer: "10 to 30+ new high-value patient appointments per event." },
      ],
    };
    const pricePlan = { questions: [{ key: "q1", question: "How much is it?" }] };
    const noSite = { fields: { [OFFER_OVERVIEW_KEY]: { value: "Unknown" }, q1: { value: "Unknown" } } };

    it("never files a placeholder as a fact; it is withheld and named as not answered yet", async () => {
      quiet();
      const facts = await loadMain(GATHER_FACTS_CODE)(pricePlan, placeholderAnswers, { fields: {} }, { fields: {} }, noSite);
      expect(facts.exact).toEqual([
        { id: "E1", source: "offer-answers", label: "How many appointments?", value: "10 to 30+ new high-value patient appointments per event." },
      ]);
      expect(JSON.stringify(facts.exact)).not.toMatch(/placeholder/i);
      expect(JSON.stringify(facts.interpreted)).not.toMatch(/placeholder/i);
      expect(facts.withheld).toEqual([
        { source: "offer-answers", label: "How much is it?" },
        { source: "offer-answers", label: "What is included?" },
      ]);
      const message = (await compose(facts)).message as string;
      expect(message).not.toMatch(/PLACEHOLDER|do not quote this/);
      expect(message).toContain("NOT ANSWERED BY OUR CLIENT YET");
      expect(message).toContain("- How much is it?");
    });

    it("withholds a placeholder user-field too", async () => {
      quiet();
      const facts = await loadMain(GATHER_FACTS_CODE)(
        pricePlan, { answers: [] },
        { fields: { pricing: { value: "Placeholder: operator to fill", provenance: "confirmed" } } },
        { fields: {} }, noSite,
      );
      expect(facts.exact).toEqual([]);
      expect(facts.withheld).toEqual([{ source: "offer-user-fields", label: "pricing" }]);
    });

    it("escalates a question only a placeholder covered, even when the draft claims an exact source", async () => {
      quiet();
      const facts = await loadMain(GATHER_FACTS_CODE)(pricePlan, placeholderAnswers, { fields: {} }, { fields: {} }, noSite);
      // The draft can only cite ids that exist; the placeholder has none. Citing
      // the unrelated appointments fact under `exact` would pass the id check, so
      // the model is told to mark it none; a draft that cites nothing escalates.
      const draft = { json: { decision: "answer", question: "How much is it?", reason: "r", replyHtml: "<p>It is free</p>", answers: [{ key: "q1", source: "exact", facts: [] }] } };
      const out = await loadMain(GROUND_DRAFT_CODE)(draft, facts);
      expect(out.overridden).toBe(true);
      expect((out.json as Record<string, unknown>).decision).toBe("escalate");
      expect((out.json as Record<string, unknown>).question).toBe("How much is it?");
      expect((out.json as Record<string, unknown>).replyHtml).toBeUndefined();
    });
  });

  it("routes the grounded decision, not the raw draft, to the send and the escalation", () => {
    expect(byId.get("escalate-unanswerable")?.inputMapping?.["body.question"]).toBe("$ref:ground-draft.output.json.question");
    expect(byId.get("send-reply")?.inputMapping?.["body.body_html"]).toBe("$ref:ground-draft.output.json.replyHtml");
    expect(byId.get("resolve-next-due")?.inputMapping?.draft).toBe("$ref:ground-draft.output");
    for (const e of dag.edges.filter((x) => x.condition)) {
      expect(e.condition).not.toContain("draft-reply");
    }
    const flow = dagToOpenFlow(dag, `${FEATURE_SLUG}-test`);
    const top = flow.value.modules.map((m) => m.id);
    expect(top).toContain("check_answerable");
    expect(top).toContain("check_sent");
  });
});

describe("the reply keeps the identity the thread gave the prospect (Dr. Joe, Doc Dinners, 2026-10-02)", () => {
  const dag = buildAiMeetingBookingDag(DAG_OPTS);
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  afterEach(() => vi.restoreAllMocks());
  const quiet = () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  };

  const brand = { brand: { name: "Doc Dinners", domain: "docdinners.com", url: "https://www.docdinners.com" } };
  const offer = { offerId: "offer-1", name: "Dinner with Docs", bookingUrl: "https://web.docdinners.com/appointment-booking-page" };
  const conversation = {
    conversation: {
      messages: [
        { direction: "outbound", text: "I work with Doc Dinners. We run end-to-end educational dinner events for chiropractors.\n--\nRoger Lee\nDistribute.you | Marketing Agency" },
        { direction: "inbound", text: "Send me more information on how it works." },
      ],
    },
  };
  const facts = {
    questions: [{ key: "q1", question: "How does it work?", siteAnswer: null }],
    exact: [{ id: "E1", source: "offer-user-fields", label: "results", value: "10 to 30+ new patient appointments per event" }],
    interpreted: [],
    withheld: [],
  };
  const booking = { timezone: "America/New_York", degraded: false, bookingUrl: offer.bookingUrl, slots: ["2026-10-06T10:00:00-04:00"] };
  const composeFor = (identity: unknown, b: unknown = booking) =>
    composeReply({ followup: { followupCount: 0 } }, { leadDetail: { lead: { firstName: "Joe" } } }, conversation, null, b, offer, brand, "2026-10-02", facts, identity);
  const text = (out: Record<string, unknown>) => `${out.message as string}\n${out.systemPrompt as string}`;

  it("names the stance on the same model read that lists the questions, from the messages WE sent", async () => {
    expect(QUESTIONS_RESPONSE_SCHEMA.required).toContain("identity");
    expect(QUESTIONS_RESPONSE_SCHEMA.properties.identity.properties.stance.enum).toEqual(["insider", "external", "blind", "unclear"]);
    expect(byId.get("compose-questions-prompt")?.inputMapping?.brand).toBe("$ref:brand-profile.output");
    const out = await loadMain(COMPOSE_QUESTIONS_PROMPT_CODE)(conversation, offer, brand);
    const message = out.message as string;
    expect(message).toContain("read the messages WE sent (marked US), signatures included");
    expect(message).toContain("our client, Doc Dinners");
    for (const stance of STANCES) expect(message).toContain(`- ${stance}:`);
    expect(message).toContain("I work with Doc Dinners.");
  });

  it("refuses to plan when the model named no stance", async () => {
    await expect(loadMain(PLAN_LOOKUPS_CODE)({ json: { questions: [] } }, offer)).rejects.toThrow(/no identity stance/);
    await expect(loadMain(PLAN_LOOKUPS_CODE)({ json: { questions: [], identity: { stance: "friendly", evidence: "" } } }, offer)).rejects.toThrow(/no identity stance/);
    quiet();
    const out = await loadMain(PLAN_LOOKUPS_CODE)({ json: { questions: [], identity: { stance: "external", evidence: "I work with Doc Dinners." }, playbook: "none" } }, offer);
    expect(out.identity).toEqual({ stance: "external", evidence: "I work with Doc Dinners." });
    expect(byId.get("compose-prompt")?.inputMapping?.identity).toBe("$ref:plan-lookups.output.identity");
    expect(byId.get("ground-draft")?.inputMapping).toMatchObject({
      identity: "$ref:plan-lookups.output.identity", offer: "$ref:offer-economics.output", brand: "$ref:brand-profile.output",
    });
  });

  it("refuses to draft without a stance", async () => {
    await expect(composeReply({ followup: { followupCount: 0 } }, { leadDetail: { lead: {} } }, conversation, null, booking, offer, brand, "2026-10-02", facts, null))
      .rejects.toThrow(/no identity stance/);
  });

  it("insider: speaks AS the client, first person", async () => {
    const t = text(await composeFor({ stance: "insider", evidence: "I'm Sam at Doc Dinners." }));
    expect(t).toContain("in this thread we have written as Doc Dinners itself");
    expect(t).toContain("\"we\" is Doc Dinners");
    expect(t).toContain("State every fact in the first person, as our own knowledge");
    expect(t).not.toContain("We are not Doc Dinners");
  });

  it("external: \"I work with X\" voice, X in the third person, never \"our system\"", async () => {
    const out = await composeFor({ stance: "external", evidence: "I work with Doc Dinners." });
    const t = text(out);
    expect(out.stance).toBe("external");
    expect(t).toContain("we have presented ourselves as working WITH Doc Dinners, from outside it. We are not Doc Dinners.");
    expect(t).toContain("Our own words in this thread: \"I work with Doc Dinners.\"");
    expect(t).toContain("Name Doc Dinners in the third person");
    expect(t).toContain("never \"our system\", \"our events\"");
    // The insider licence is not in front of the model.
    expect(t).not.toContain("State every fact in the first person");
    expect(t).not.toContain("You speak as the team that runs");
    // Ownership from #481 stays: plain facts, never a site.
    expect(t).toContain("never point to a website, a page, a brochure");
    expect(t).toContain("never hedge a fact");
    // Booking unchanged: two slots and the link.
    expect(t).toContain("Propose EXACTLY TWO");
    expect(t).toContain(offer.bookingUrl);
  });

  it("blind: the client name, the offer name and any link of theirs are forbidden, and no booking link is given", async () => {
    const t = text(await composeFor({ stance: "blind", evidence: "" }));
    expect(t).toContain("we have NEVER named our client, on purpose");
    expect(t).toContain("Never write Doc Dinners, never write the offer's name (\"Dinner with Docs\")");
    expect(t).toContain("Do NOT give any link");
    expect(t).not.toContain("give the link so they can pick another");
    expect(t).not.toContain(offer.bookingUrl);
    expect(t).not.toContain("State every fact in the first person");
    const degraded = text(await composeFor({ stance: "blind", evidence: "" }, { timezone: "UTC", degraded: true, degradedReason: "unreadable", bookingUrl: offer.bookingUrl, slots: [] }));
    expect(degraded).not.toContain(offer.bookingUrl);
    expect(degraded).toContain("say you will send an invite");
  });

  it("unclear: tells the model to escalate rather than guess", async () => {
    const t = text(await composeFor({ stance: "unclear", evidence: "" }));
    expect(t).toContain("Do not guess an identity. If a reply is owed, set decision to escalate");
  });

  const answered = (replyHtml: string, decision = "answer") => ({
    json: { decision, question: "How does it work?", reason: "r", replyHtml, nextDueAt: "2026-10-09T00:00:00Z", answers: [{ key: "q1", source: "exact", facts: ["E1"] }] },
  });

  it("unclear: any reply that would be sent becomes an escalation; nothing is sent", async () => {
    quiet();
    for (const decision of ["answer", "confirm_booking"]) {
      const out = await loadMain(GROUND_DRAFT_CODE)(answered("<p>Hi</p>", decision), facts, { stance: "unclear", evidence: "" }, offer, brand);
      const json = out.json as Record<string, unknown>;
      expect(out.overridden).toBe(true);
      expect(json.decision).toBe("escalate");
      expect(json.question).toBe("How does it work?");
      expect(json.replyHtml).toBeUndefined();
      expect(String(json.reason)).toContain("identity in this thread is unclear");
    }
    // A message that needs no reply still needs none.
    const none = { json: { decision: "no_reply_owed", question: "q", reason: "r", answers: [] } };
    expect((await loadMain(GROUND_DRAFT_CODE)(none, facts, { stance: "unclear", evidence: "" }, offer, brand)).json).toEqual(none.json);
  });

  it("blind: a draft naming the client, the offer, or a domain of theirs is never sent", async () => {
    quiet();
    const blind = { stance: "blind", evidence: "" };
    for (const leak of ["<p>Doc Dinners runs it</p>", "<p>Our Dinner with Docs works</p>", "<p>see docdinners.com</p>", "<p>book at https://web.docdinners.com/x</p>"]) {
      const out = await loadMain(GROUND_DRAFT_CODE)(answered(leak), facts, blind, offer, brand);
      expect(out.overridden).toBe(true);
      expect((out.json as Record<string, unknown>).decision).toBe("escalate");
      expect((out.json as Record<string, unknown>).replyHtml).toBeUndefined();
    }
    const clean = answered("<p>The team I work with books 10 to 30+ new patient appointments per event.</p>");
    const out = await loadMain(GROUND_DRAFT_CODE)(clean, facts, blind, offer, brand);
    expect(out.overridden).toBe(false);
    expect(out.json).toEqual(clean.json);
  });

  it("insider and external drafts that name the client pass", async () => {
    quiet();
    for (const stance of ["insider", "external"]) {
      const draft = answered("<p>Doc Dinners books 10 to 30+ new patient appointments per event.</p>");
      const out = await loadMain(GROUND_DRAFT_CODE)(draft, facts, { stance, evidence: "x" }, offer, brand);
      expect(out.overridden).toBe(false);
      expect(out.json).toEqual(draft.json);
    }
  });
});

describe("no em dash or en dash ever reaches a prospect (Dr. Joe draft, 2026-10-02)", () => {
  afterEach(() => vi.restoreAllMocks());
  const facts = { questions: [], exact: [], interpreted: [], withheld: [] };
  const run = async (replyHtml: string, decision = "answer") => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const draft = { json: { decision, question: "q", reason: "r", replyHtml, answers: [] } };
    return (await loadMain(GROUND_DRAFT_CODE)(draft, facts, { stance: "external", evidence: "x" }, null, null)).json as Record<string, unknown>;
  };

  it("rewrites every dash in the reply before anything is sent", async () => {
    const json = await run("<p>They offer a guarantee\u2014if it does not work, they keep going. Events bring 10\u201330 patients &mdash; every time &ndash; and 5 &#8211; 7 more &#x2014; ok.</p>");
    const html = json.replyHtml as string;
    expect(html).not.toMatch(/[\u2013\u2014]/);
    expect(html).not.toMatch(/&(mdash|ndash);|&#(8212|8211|x2014|x2013);/i);
    expect(html).toBe("<p>They offer a guarantee, if it does not work, they keep going. Events bring 10-30 patients, every time, and 5-7 more, ok.</p>");
  });

  it("does it on a booking confirmation too, and leaves a clean reply untouched", async () => {
    expect((await run("<p>Thanks \u2014 see you Friday.</p>", "confirm_booking")).replyHtml).toBe("<p>Thanks, see you Friday.</p>");
    expect((await run("<p>Plain reply - with a hyphen.</p>")).replyHtml).toBe("<p>Plain reply - with a hyphen.</p>");
  });

  it("bans the dash in the reply prompt, and the prompt models none itself", async () => {
    const out = await composeReply(
      { followup: { followupCount: 0 } }, { leadDetail: { lead: { firstName: "Joe" } } },
      { conversation: { messages: [{ direction: "inbound", text: "How does it work?" }] } }, null,
      { timezone: "UTC", degraded: true, degradedReason: "no_booking_url", bookingUrl: null, slots: [] },
      { name: "Dinner with Docs" }, { brand: { name: "Doc Dinners" } }, "2026-10-02",
    );
    expect(out.message as string).toContain("Never use an em dash or an en dash.");
    expect(`${out.message as string}${out.systemPrompt as string}`).not.toMatch(/[\u2013\u2014]/);
    expect(JSON.stringify(REPLY_RESPONSE_SCHEMA)).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("a thread opened by the acquisition-questions sequence plays its game (owner, 2026-10-03)", () => {
  afterEach(() => vi.restoreAllMocks());
  const dag = buildAiMeetingBookingDag(DAG_OPTS);
  const nodes = new Map(dag.nodes.map((n) => [n.id, n]));
  const quietLogs = () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  };
  const offer = { offerId: "o1", name: "Missed-call AI receptionist", bookingUrl: "https://book.example.com/x" };
  const brand = { brand: { name: "CallCatch", domain: "callcatch.ai" } };
  const blind = { stance: "blind", evidence: "I work on patient acquisition for clinics like yours." };
  const opener = {
    direction: "outbound",
    text: "Hey Sophie,\n\nI work on patient acquisition for dental clinics.\n\nIf I sent you 10 people for whitening, what would you charge per person?\n\nWhen someone calls while you're with a patient, do they reach voicemail, a receptionist, or an AI?",
  };
  const thread = (...rest: Array<{ direction: string; text: string }>) => ({ conversation: { messages: [opener, ...rest] } });
  const booking = { timezone: "America/New_York", degraded: false, bookingUrl: offer.bookingUrl, slots: ["2026-10-06T10:00:00-04:00"] };
  const composeGame = (conv: unknown, playbook = "acquisition_questions") =>
    composeReply({ followup: { followupCount: 0 } }, { leadDetail: { lead: { firstName: "Sophie" } } }, conv, null, booking, offer, brand, "2026-10-03", undefined, blind, playbook);

  it("step 1 names the outreach off the messages we sent, and the plan refuses a thread without one", async () => {
    expect(PLAYBOOKS).toEqual(["acquisition_questions", "none"]);
    expect(QUESTIONS_RESPONSE_SCHEMA.required).toContain("playbook");
    const step1 = await loadMain(COMPOSE_QUESTIONS_PROMPT_CODE)(thread({ direction: "inbound", text: "$250. Voicemail." }), offer, brand);
    expect(step1.message as string).toContain("- acquisition_questions:");
    expect(step1.message as string).toContain("what they would charge per person if we sent them a group");
    await expect(loadMain(PLAN_LOOKUPS_CODE)({ json: { questions: [], identity: blind } }, offer)).rejects.toThrow(/no playbook/);
    quietLogs();
    const out = await loadMain(PLAN_LOOKUPS_CODE)({ json: { questions: [], identity: blind, playbook: "acquisition_questions" } }, offer);
    expect(out.playbook).toBe("acquisition_questions");
    expect(nodes.get("compose-prompt")?.inputMapping?.playbook).toBe("$ref:plan-lookups.output.playbook");
    expect(nodes.get("ground-draft")?.inputMapping?.playbook).toBe("$ref:plan-lookups.output.playbook");
  });

  it("gives the model the strategy, not a script, and only in such a thread", async () => {
    const game = await composeGame(thread({ direction: "inbound", text: "We'd charge $250 a head. Calls go to voicemail when we're busy." }));
    const message = game.message as string;
    expect(message).toContain("THE GAME THIS THREAD IS IN");
    for (const line of ACQUISITION_QUESTIONS_PLAYBOOK) expect(message).toContain(line);
    expect(message).toContain("their price x the few of that group they would lose");
    expect(message).toContain("Stay inside the hypothetical our first email set up");
    expect(message).toContain("Always conditional (would), never past tense");
    expect(message).toContain("COULD catch more of them (could, never will)");
    expect(message).not.toMatch(/be straight/i);
    expect(message).not.toContain("We do not hold a group");
    expect(message).not.toContain("they already call");
    expect(message).toContain("close_with_thanks");
    expect(message).toContain("this is our reply to it");
    expect(`${message}${game.systemPrompt as string}`).not.toMatch(/[\u2013\u2014]/);
    const plain = await composeGame(thread({ direction: "inbound", text: "Tell me more." }), "none");
    expect(plain.message as string).not.toContain("THE GAME THIS THREAD IS IN");
    await expect(composeGame(thread(), "bogus")).rejects.toThrow(/no playbook/);
  });

  it("follows up twice when they go quiet, then stops", async () => {
    const reply = { direction: "inbound", text: "$250. Voicemail." };
    const ours = { direction: "outbound", text: "x" };
    const first = (await composeGame(thread(reply, ours))).message as string;
    expect(first).toContain("Write follow-up 1 of 2");
    const second = (await composeGame(thread(reply, ours, ours))).message as string;
    expect(second).toContain("Write follow-up 2 of 2");
    const done = (await composeGame(thread(reply, ours, ours, ours))).message as string;
    expect(done).toContain("that is every follow-up this game allows. Set decision to no_reply_owed");
  });

  it("accepts a playbook answer only in a thread that sequence opened", async () => {
    quietLogs();
    const facts = { questions: [{ key: "q1", question: "Who are you?" }, { key: "q2", question: "Can you send the patients?" }], exact: [], interpreted: [], withheld: [] };
    const draft = {
      json: {
        decision: "answer", question: "Who are you?", reason: "r",
        replyHtml: "<p>Fair question. We don't hold a group of patients today; the ones I mean already call you.</p>",
        answers: [{ key: "q1", source: "playbook", facts: [] }, { key: "q2", source: "playbook", facts: [] }],
      },
    };
    const played = await loadMain(GROUND_DRAFT_CODE)(draft, facts, blind, offer, brand, "acquisition_questions");
    expect((played.json as Record<string, unknown>).decision).toBe("answer");
    const elsewhere = await loadMain(GROUND_DRAFT_CODE)(draft, facts, blind, offer, brand, "none");
    expect((elsewhere.json as Record<string, unknown>).decision).toBe("escalate");
  });

  it("thanks a prospect who already has it solved through the same send, then stops their follow-ups", async () => {
    quietLogs();
    const arm = dag.edges.find((e) => e.from === "check-answerable" && e.to === "resolve-next-due");
    expect(arm?.condition).toContain("'close_with_thanks'");
    const resolved = await loadMain(RESOLVE_NEXT_DUE_CODE)({ json: { decision: "close_with_thanks", replyHtml: "<p>Thanks Sophie.</p>" } }, "2026-10-06T00:00:00Z");
    expect(resolved).toEqual({ nextDueAt: null, source: "closed_with_thanks" });
    const sent = dag.edges.find((e) => e.from === "check-sent" && e.to === "stop-followups-closed");
    expect(sent?.condition).toContain("results['classify-send']?.outcome == 'sent'");
    expect(sent?.condition).toContain("'close_with_thanks'");
    expect(nodes.get("stop-followups-closed")?.config?.body).toEqual({ kind: "stopped", reason: CLOSED_WITH_THANKS_REASON });
    expect(dag.edges).toContainEqual({ from: "stop-followups-closed", to: "end-run-closed-with-thanks" });
    const record = dag.edges.find((e) => e.from === "check-sent" && e.to === "record-followup");
    expect(record?.condition).not.toContain("close_with_thanks");
    // A thank-you is a written reply: a blind thread still never names the client in it.
    const leak = { json: { decision: "close_with_thanks", question: "We have an AI", reason: "r", replyHtml: "<p>Thanks, CallCatch would not add much then.</p>", answers: [] } };
    expect(((await loadMain(GROUND_DRAFT_CODE)(leak, { questions: [] }, blind, offer, brand, "acquisition_questions")).json as Record<string, unknown>).decision).toBe("escalate");
  });

  it("compiles to a flow whose new branches converge at top level", () => {
    const flow = dagToOpenFlow(dag, `${FEATURE_SLUG}-test`);
    const ids = JSON.stringify(flow.value.modules);
    expect(ids).toContain("stop_followups_closed");
    expect(ids).toContain("end_run_closed_with_thanks");
  });
});

describe("a second model cell on the same pipe (owner 2026-10-10: compare ROIs)", () => {
  const chatBodies = (dag: DAG) =>
    dag.nodes
      .filter((n) => (n.config as { service?: string } | undefined)?.service === "chat")
      .map((n) => ({ id: n.id, body: (n.config as { body: Record<string, unknown> }).body }));

  it("keeps the Gemini cell's temperatures exactly as they were", () => {
    const bodies = chatBodies(buildAiMeetingBookingDag({ provider: "google", model: "pro" }));
    expect(bodies.map((b) => [b.id, b.body.temperature])).toEqual([
      ["list-questions", 0],
      ["draft-reply", 0.4],
    ]);
  });

  it("drops temperature from both chat steps when the model refuses sampling", () => {
    const bodies = chatBodies(buildAiMeetingBookingDag({ provider: "anthropic", model: "opus", omitTemperature: true }));
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b.body).not.toHaveProperty("temperature");
      expect(b.body.provider).toBe("anthropic");
      expect(b.body.model).toBe("opus");
      expect(b.body.responseSchema).toBeTruthy();
    }
  });

  it("differs from the Gemini DAG in the two chat bodies and nowhere else", () => {
    const gemini = buildAiMeetingBookingDag({ provider: "google", model: "pro" });
    const opus = buildAiMeetingBookingDag({ provider: "anthropic", model: "opus", omitTemperature: true });
    const strip = (dag: DAG) =>
      JSON.stringify({
        ...dag,
        nodes: dag.nodes.map((n) =>
          (n.config as { service?: string } | undefined)?.service === "chat"
            ? { ...n, config: { ...(n.config as object), body: null } }
            : n,
        ),
      });
    expect(strip(opus)).toBe(strip(gemini));
    expect(JSON.stringify(opus)).not.toBe(JSON.stringify(gemini));
  });
});
