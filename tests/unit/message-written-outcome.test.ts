import { describe, it, expect, vi, afterEach } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import {
  DECLARE_CONSUMED_LEAD_CODE,
  DECLARE_CONSUMED_LEAD_NODE_ID,
  DECLARE_MESSAGE_WRITTEN_CODE,
  DECLARE_MESSAGE_WRITTEN_NODE_ID,
  legFromStep,
  needsConsumedLeadDeclaration,
  needsMessageWrittenDeclaration,
} from "../../src/lib/message-written-outcome.js";
import { buildAiInstantCallDag } from "../../src/lib/ai-instant-call-dag.js";
import { buildFollowUpProactiveDag, buildFollowUpReactiveDag } from "../../src/lib/follow-up-dag.js";
import { buildFormMeetingBookingDag } from "../../src/lib/form-meeting-booking-dag.js";
import { buildAiMeetingBookingDag } from "../../src/lib/ai-meeting-booking-dag.js";
import { buildOfferDocumentReplyDag } from "../../src/lib/offer-document-reply-dag.js";
import { buildColdWhatsappOutreachDag } from "../../src/lib/cold-whatsapp-outreach-dag.js";

/**
 * COST-ACCOUNTING-1023-P1: every workflow step that writes a message for one person through chat-service `/complete`
 * declares `message_written` (consuming `lead_found`) on the workflow's run, subject = the person's lead in
 * lead-service. Writers going through content-generation declare nothing here (content-generation declares its own).
 */
function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, any>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, any>>;
}

type WriterSpec = { after: string; next: string; signal: string; sentWhen: string; leadId: string; consumedAfter: string; consumedNext: string };
const WRITERS: Array<[string, DAG, WriterSpec]> = [
  ["follow-up proactive", buildFollowUpProactiveDag(), { after: "record-row", next: "check-end", signal: "$ref:outcome.output.endKind", sentWhen: "sent", leadId: "$ref:resolve-person.output.leadId", consumedAfter: "now", consumedNext: "followup-state" }],
  ["follow-up reactive", buildFollowUpReactiveDag({ readFigures: true }), { after: "record-row", next: "check-end", signal: "$ref:outcome.output.endKind", sentWhen: "sent", leadId: "$ref:resolve-person.output.leadId", consumedAfter: "now", consumedNext: "followup-state" }],
  ["form meeting booking", buildFormMeetingBookingDag(), { after: "send-whatsapp", next: "end-run", signal: "$ref:send-email.output.success", sentWhen: "true", leadId: "$ref:resolve-form.output.leadId", consumedAfter: "resolve-form", consumedNext: "offer-economics" }],
  ["ai meeting booking", buildAiMeetingBookingDag({ provider: "google", model: "pro" }), { after: "classify-send", next: "check-sent", signal: "$ref:classify-send.output.outcome", sentWhen: "sent", leadId: "$ref:claimed.output.followup.leadId", consumedAfter: "campaign-detail", consumedNext: "offer-economics" }],
];

/** Every node reachable from `from` along the DAG's edges. */
function reachable(dag: DAG, from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of dag.edges) if (e.from === id && !seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
  }
  return seen;
}

describe("every chat writer declares its written message on the ledger", () => {
  for (const [name, dag, spec] of WRITERS) {
    it(`${name}: one declaration, after the send, on the person's lead`, () => {
      expect(validateDAG(dag).errors).toEqual([]);
      expect(() => dagToOpenFlow(dag, `mw-${name.replace(/ /g, "-")}`)).not.toThrow();
      const nodes = dag.nodes.filter((n) => n.id === DECLARE_MESSAGE_WRITTEN_NODE_ID);
      expect(nodes).toHaveLength(1);
      const node = nodes[0];
      expect(node.type).toBe("script");
      expect(node.retries).toBe(0);
      expect(node.inputMapping).toEqual({
        signal: spec.signal,
        sentWhen: spec.sentWhen,
        leadId: spec.leadId,
        campaignRead: "$ref:pipe-of-run.output",
        serviceEnvs: "$ref:flow_input.serviceEnvs",
        orgId: "$ref:flow_input.orgId",
        runId: "$ref:flow_input.runId",
      });
      // the run's pipe is read off its own campaign right before (tolerated), then the declaration
      const pipe = dag.nodes.find((n) => n.id === "pipe-of-run")!;
      expect(pipe.config).toMatchObject({ service: "campaign", method: "GET", path: "/campaigns/{id}", tolerateFailure: true });
      expect(pipe.inputMapping).toEqual({ "params.id": "$ref:flow_input.campaignId" });
      expect(dag.nodes.filter((n) => n.id === "pipe-of-run")).toHaveLength(1);
      expect(dag.edges.filter((e) => e.to === node.id)).toEqual([{ from: spec.after, to: node.id }]);
      expect(dag.edges.filter((e) => e.from === node.id)).toEqual([{ from: node.id, to: spec.next }]);
      expect(needsMessageWrittenDeclaration(dag)).toBe(false);
    });

    it(`${name}: states the lead it acted on right where the lead is known, before any decision`, () => {
      const nodes = dag.nodes.filter((n) => n.id === DECLARE_CONSUMED_LEAD_NODE_ID);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject({ type: "script", retries: 0, config: { code: DECLARE_CONSUMED_LEAD_CODE } });
      expect(nodes[0].inputMapping).toEqual({
        leadId: spec.leadId,
        campaignRead: "$ref:pipe-of-run.output",
        serviceEnvs: "$ref:flow_input.serviceEnvs",
        orgId: "$ref:flow_input.orgId",
        runId: "$ref:flow_input.runId",
      });
      expect(dag.edges.filter((e) => e.to === "pipe-of-run")).toEqual([{ from: spec.consumedAfter, to: "pipe-of-run" }]);
      expect(dag.edges.filter((e) => e.to === DECLARE_CONSUMED_LEAD_NODE_ID)).toEqual([{ from: "pipe-of-run", to: DECLARE_CONSUMED_LEAD_NODE_ID }]);
      expect(dag.edges.filter((e) => e.from === DECLARE_CONSUMED_LEAD_NODE_ID)).toEqual([{ from: DECLARE_CONSUMED_LEAD_NODE_ID, to: spec.consumedNext }]);
      // runs before the written message is declared (which reads the same pipe)
      expect(reachable(dag, DECLARE_CONSUMED_LEAD_NODE_ID).has(DECLARE_MESSAGE_WRITTEN_NODE_ID)).toBe(true);
      expect(needsConsumedLeadDeclaration(dag)).toBe(false);
    });
  }

  it("ai meeting booking: a run that decides NOT to write (escalate, no reply owed, refused) has already named its lead", () => {
    const dag = buildAiMeetingBookingDag({ provider: "google", model: "pro" });
    const after = reachable(dag, DECLARE_CONSUMED_LEAD_NODE_ID);
    for (const end of ["escalate-unanswerable", "name-no-reply-owed", "end-run-escalated", "end-run-no-reply-owed", "end-run-human-took-over", "draft-reply"]) {
      expect(after.has(end)).toBe(true);
    }
    // and it sits after the claim found someone, never on the nobody-due path
    expect(reachable(dag, "campaign-detail").has(DECLARE_CONSUMED_LEAD_NODE_ID)).toBe(true);
    expect(reachable(dag, "end-run-nobody-due").has(DECLARE_CONSUMED_LEAD_NODE_ID)).toBe(false);
  });

  it("ai instant call states the lead it acted on too, before it decides to ring", () => {
    const dag = buildAiInstantCallDag();
    expect(validateDAG(dag).errors).toEqual([]);
    expect(() => dagToOpenFlow(dag, "mw-instant-call")).not.toThrow();
    const node = dag.nodes.find((n) => n.id === DECLARE_CONSUMED_LEAD_NODE_ID)!;
    expect(node.inputMapping?.leadId).toBe("$ref:claim-followup.output.followup.leadId");
    expect(dag.edges.filter((e) => e.to === "pipe-of-run")).toEqual([{ from: "lead-detail", to: "pipe-of-run" }]);
    for (const end of ["record-no-rep", "ring-rep"]) expect(reachable(dag, DECLARE_CONSUMED_LEAD_NODE_ID).has(end)).toBe(true);
  });

  it("the offer-document copy inherits it from its parent", () => {
    const dag = buildOfferDocumentReplyDag({ provider: "anthropic", model: "opus" } as never);
    expect(dag.nodes.filter((n) => n.id === DECLARE_MESSAGE_WRITTEN_NODE_ID)).toHaveLength(1);
  });

  it("cold WhatsApp writes through content-generation, which declares itself: nothing declared here", () => {
    const dag = buildColdWhatsappOutreachDag();
    expect(dag.nodes.some((n) => n.id === DECLARE_MESSAGE_WRITTEN_NODE_ID)).toBe(false);
  });

  it("a stored writer that does not state the lead it consumed is stale for the seed", () => {
    const dag = buildAiMeetingBookingDag({ provider: "google", model: "pro" });
    expect(needsMessageWrittenDeclaration({ nodes: dag.nodes.filter((n) => n.id !== DECLARE_CONSUMED_LEAD_NODE_ID) })).toBe(true);
    expect(
      needsMessageWrittenDeclaration({
        nodes: dag.nodes.map((n) => (n.id === DECLARE_CONSUMED_LEAD_NODE_ID ? { ...n, config: { code: "old" } } : n)),
      }),
    ).toBe(true);
  });

  it("a stored writer without it (or with an older script) is stale for the seed", () => {
    const dag = buildFormMeetingBookingDag();
    expect(needsMessageWrittenDeclaration({ nodes: dag.nodes.filter((n) => n.id !== DECLARE_MESSAGE_WRITTEN_NODE_ID) })).toBe(true);
    expect(
      needsMessageWrittenDeclaration({
        nodes: dag.nodes.map((n) => (n.id === DECLARE_MESSAGE_WRITTEN_NODE_ID ? { ...n, config: { code: "old" } } : n)),
      }),
    ).toBe(true);
  });
});

const LEAD_FOUND_LEG = { campaign: { legKey: "lead_found_to_conversation" } };

describe("the declaration script", () => {
  const main = loadMain(DECLARE_MESSAGE_WRITTEN_CODE);
  const envs = { RUNS_SERVICE_URL: "http://runs/", RUNS_SERVICE_API_KEY: "k" };
  afterEach(() => vi.unstubAllGlobals());

  it("states message_written produced and lead_found consumed, both on lead-service/<lead id>, on the workflow run", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ recordedCount: 2, alreadyRecordedCount: 0 }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await main("sent", "sent", "lead-1", LEAD_FOUND_LEG, envs, "org-1", "run-1");
    expect(out).toMatchObject({ declared: true, status: 201, recordedCount: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://runs/v1/runs/run-1/outcomes");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-org-id"]).toBe("org-1");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    expect(JSON.parse(String(init.body))).toEqual({
      produced: [{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-1" }],
      consumed: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "lead-1" }],
    });
  });

  it("consumes what the run's PIPE starts from, never an invented lead_found (LEDGER-HISTORY-1024)", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response("{}", { status: 201 }); }));
    const lead = { subjectService: "lead-service", subjectId: "lead-1" };
    await main("sent", "sent", "lead-1", { campaign: { legKey: "conversation_to_meeting_booked" } }, envs, "org-1", "run-1");
    await main("sent", "sent", "lead-1", { campaign: { legKey: "form_submitted_to_meeting_booked" } }, envs, "org-1", "run-1");
    await main("sent", "sent", "lead-1", { campaign: { legKey: "start_to_paid_client" } }, envs, "org-1", "run-1");
    expect(bodies.map((b) => b.consumed)).toEqual([
      [{ outcomeKey: "conversation", ...lead }],
      [{ outcomeKey: "form_submitted", ...lead }],
      [],
    ]);
    expect(bodies.every((b) => b.produced[0].outcomeKey === "message_written")).toBe(true);
  });

  it("an unreadable pipe declares NOTHING, loudly (never a guessed input)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const read of [{ ok: false, status: 502 }, { campaign: { legKey: null } }, undefined]) {
      expect(await main("sent", "sent", "lead-1", read, envs, "org-1", "run-1")).toMatchObject({ declared: false, why: "pipe unreadable" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err.mock.calls[0][0]).toContain("DECLARATION FAILED");
    err.mockRestore();
  });

  it("legFromStep reads the leg's from step, Start = no input", () => {
    expect(legFromStep("conversation_to_meeting_booked")).toBe("conversation");
    expect(legFromStep("lead_found_to_website_visit")).toBe("lead_found");
    expect(legFromStep("start_to_signup")).toBeNull();
    expect(legFromStep("")).toBeUndefined();
    expect(legFromStep(undefined)).toBeUndefined();
  });

  it("a replay is read as declared (runs-service answers already_recorded with 200)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ recordedCount: 0, alreadyRecordedCount: 2 }), { status: 200 })));
    expect(await main("sent", "sent", "lead-1", LEAD_FOUND_LEG, envs, "org-1", "run-1")).toMatchObject({ declared: true, alreadyRecordedCount: 2 });
  });

  it("declares nothing when no message went out (later, stop, refused, escalated)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const signal of ["later", "stopped", "refused_kept", undefined, null]) {
      expect((await main(signal, "sent", "lead-1", LEAD_FOUND_LEG, envs, "org-1", "run-1")).declared).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a boolean signal compares as text (the form arm reads the send's success)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 201 })));
    expect((await main(true, "true", "lead-1", LEAD_FOUND_LEG, envs, "org-1", "run-1")).declared).toBe(true);
  });

  it("a sent message with no lead id is logged loudly, never an invented id", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main("sent", "sent", null, LEAD_FOUND_LEG, envs, "org-1", "run-1")).toMatchObject({ declared: false, why: "no lead id" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err.mock.calls[0][0]).toContain("DECLARATION MISSING");
    err.mockRestore();
  });

  it("never throws: retries a 5xx, then logs loudly and returns", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("down", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = main("sent", "sent", "lead-1", LEAD_FOUND_LEG, envs, "org-1", "run-1");
    await vi.runAllTimersAsync();
    expect(await p).toMatchObject({ declared: false });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(err.mock.calls.at(-1)?.[0]).toContain("DECLARATION FAILED");
    err.mockRestore();
    vi.useRealTimers();
  });

  it("does not retry a 4xx (a refusal another try cannot change)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "unknown_outcome_key" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await main("sent", "sent", "lead-1", LEAD_FOUND_LEG, envs, "org-1", "run-1")).declared).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("recovers when a retry succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const p = main("sent", "sent", "lead-1", LEAD_FOUND_LEG, envs, "org-1", "run-1");
    await vi.runAllTimersAsync();
    expect((await p).declared).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("the consumed-lead script (LEAD-STATES-1024-MEETING-WRITES)", () => {
  const main = loadMain(DECLARE_CONSUMED_LEAD_CODE);
  const envs = { RUNS_SERVICE_URL: "http://runs/", RUNS_SERVICE_API_KEY: "k" };
  afterEach(() => vi.unstubAllGlobals());

  it("a run that decides 'not now' for lead L still declares L: the conversation its pipe starts from, consumed, nothing produced", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ recordedCount: 1, alreadyRecordedCount: 0 }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await main("lead-L", { campaign: { legKey: "conversation_to_meeting_booked" } }, envs, "org-1", "run-1");
    expect(out).toMatchObject({ declared: true, consumed: "conversation", recordedCount: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://runs/v1/runs/run-1/outcomes");
    expect((init.headers as Record<string, string>)["x-org-id"]).toBe("org-1");
    expect(JSON.parse(String(init.body))).toEqual({
      consumed: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "lead-L" }],
    });
  });

  it("the key is the run's own leg, never a per-pipe case", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response("{}", { status: 201 }); }));
    for (const legKey of ["form_submitted_to_meeting_booked", "lead_found_to_conversation", "signup_to_paid_client"]) {
      await main("lead-L", { campaign: { legKey } }, envs, "org-1", "run-1");
    }
    expect(bodies.map((b) => b.consumed[0].outcomeKey)).toEqual(["form_submitted", "lead_found", "signup"]);
  });

  it("no lead acted on, or a Start leg: nothing declared, never an invented lead_found", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await main(null, { campaign: { legKey: "conversation_to_meeting_booked" } }, envs, "org-1", "run-1")).toMatchObject({ declared: false });
    expect(await main("  ", { campaign: { legKey: "conversation_to_meeting_booked" } }, envs, "org-1", "run-1")).toMatchObject({ declared: false });
    expect(await main("lead-L", { campaign: { legKey: "start_to_lead_found" } }, envs, "org-1", "run-1")).toMatchObject({ declared: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unreadable pipe declares nothing, loudly", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main("lead-L", { ok: false, status: 502 }, envs, "org-1", "run-1")).toMatchObject({ declared: false, why: "pipe unreadable" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err.mock.calls[0][0]).toContain("DECLARATION FAILED");
    err.mockRestore();
  });

  it("never throws: retries a 5xx, then logs and returns", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = main("lead-L", { campaign: { legKey: "conversation_to_meeting_booked" } }, envs, "org-1", "run-1");
    await vi.runAllTimersAsync();
    expect(await p).toMatchObject({ declared: false });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    err.mockRestore();
    vi.useRealTimers();
  });
});
