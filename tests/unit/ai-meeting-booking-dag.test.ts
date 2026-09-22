import { describe, it, expect, vi, afterEach } from "vitest";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  buildAiMeetingBookingDag,
  readBookingSlotsCode,
  COMPOSE_REPLY_PROMPT_CODE,
  RESOLVE_NEXT_DUE_CODE,
  SLOT_CANDIDATES,
  FEATURE_SLUG,
  PREDECESSOR_READ,
  PREDECESSOR_CAMPAIGN_REF,
  NAME_MISSING_PREDECESSOR_CODE,
} from "../../src/lib/ai-meeting-booking-dag.js";

const DAG_OPTS = { provider: "google", model: "pro" } as const;

/** Loads a `script` node's rawscript body so the shipped code itself is exercised. */
function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, unknown>> {
  const body = code.replace(/^export async function main/, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, unknown>>;
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

  it("resolves the booking link per FUNNEL, off the campaign's own offer", () => {
    expect(byId.get("campaign-detail")?.config).toMatchObject({ service: "campaign", path: "/campaigns/{id}" });
    expect(byId.get("offer-funnels")?.config).toMatchObject({
      service: "brand",
      path: "/internal/offers/{offerId}/sales-funnels",
    });
    expect(byId.get("offer-funnels")?.inputMapping?.["params.offerId"]).toBe(
      "$ref:campaign-detail.output.campaign.offerId",
    );
    expect(byId.get("pick-booking-url")?.inputMapping?.funnelKey).toBe(
      "$ref:campaign-detail.output.campaign.funnelKey",
    );
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
    for (const id of ["gate-check", "start-run", "end-run", "end-run-nobody-due", "end-run-error", "end-run-no-predecessor"]) {
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
    // No provider SDK, no other LLM hop.
    expect(dag.nodes.filter((n) => n.config?.service === "chat")).toHaveLength(1);
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
      days: [
        {
          spots: Array.from({ length: 40 }, (_, i) => ({
            status: "available",
            start_time: `2026-09-04T${String(8 + (i % 10)).padStart(2, "0")}:00:00Z`,
          })),
        },
      ],
    };
    stubFetch((url) => ({ ok: true, body: url.includes("lookup") ? okLookup : many }));
    const out = await loadMain(readBookingSlotsCode())("https://calendly.com/a/b", "UTC");
    expect((out.slots as string[]).length).toBe(SLOT_CANDIDATES);
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
    offerFunnels: { funnels: [{ funnelKey: "sales_meetings_from_conversation", name: "Sales Meeting from Conversation", bookingUrl: "https://calendly.com/a/b" }] },
    funnelKey: "sales_meetings_from_conversation",
    brand: { brand: { name: "Acme" } },
    currentDate: "2026-09-02",
  };

  const call = (booking: unknown, followupCount = 0) =>
    loadMain(COMPOSE_REPLY_PROMPT_CODE)(
      { followup: { ...base.followup.followup, followupCount } },
      base.leadDetail,
      base.conversation,
      base.priorGeneration,
      booking,
      base.offerFunnels,
      base.funnelKey,
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

  it("still answers a prospect whose brand has no booking link for that funnel", async () => {
    const out = await call({ timezone: "UTC", degraded: true, degradedReason: "no_booking_url", bookingUrl: null, slots: [] });
    const message = out.message as string;
    expect(message).toContain("no booking link for this funnel");
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
    const out = await main({ json: { nextDueAt: asked } }, ladder);
    expect(out).toEqual({ nextDueAt: asked, source: "prospect_stated" });
  });

  it("falls back loudly rather than letting the record fail after the reply is sent", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const bad of [
      undefined,
      "not a date",
      new Date(Date.now() - 86400000).toISOString(), // lead-service 400s on the past
      new Date(Date.now() + 400 * 86400000).toISOString(), // and on further than a year
    ]) {
      const out = await main({ json: { nextDueAt: bad } }, ladder);
      expect(out).toEqual({ nextDueAt: ladder, source: "interval_ladder" });
    }
    expect(err).toHaveBeenCalledTimes(4);
    err.mockRestore();
  });
});
