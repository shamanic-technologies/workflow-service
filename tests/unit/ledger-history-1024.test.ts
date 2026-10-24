import { describe, expect, it } from "vitest";
import { buildIndustryUpdateVideoDag } from "../../src/lib/industry-update-video-dag.js";
import {
  DECLARE_INDUSTRY_UPDATE_VIDEO_CODE,
  DECLARE_INDUSTRY_UPDATE_VIDEO_NODE_ID,
} from "../../src/lib/industry-update-video-outcome.js";
import { isFormItem, pastLegEvidence } from "../../src/lib/past-leg-outcomes.js";
import { batchOutcomeRuns } from "../../src/lib/past-run-outcomes.js";
import { validateDAG } from "../../src/lib/dag-validator.js";

const RUN_CALL = "aaaaaaaa-0000-4000-8000-000000000001";
const RUN_CALL_FORM = "aaaaaaaa-0000-4000-8000-000000000002";
const RUN_CALL_REFUSED = "aaaaaaaa-0000-4000-8000-000000000003";
const RUN_CALL_TWO_LEADS = "aaaaaaaa-0000-4000-8000-000000000004";
const RUN_VIDEO = "aaaaaaaa-0000-4000-8000-000000000005";
const RUN_VIDEO_DRY = "aaaaaaaa-0000-4000-8000-000000000006";
const RUN_OTHER = "aaaaaaaa-0000-4000-8000-000000000007";
const LEAD_1 = "bbbbbbbb-0000-4000-8000-000000000001";
const LEAD_2 = "bbbbbbbb-0000-4000-8000-000000000002";
const VIDEO = "cccccccc-0000-4000-8000-000000000001";
const VIDEO_DRY = "cccccccc-0000-4000-8000-000000000002";

const base = () => ({
  runFeatures: new Map([
    [RUN_CALL, "ai-instant-call"],
    [RUN_CALL_FORM, "ai-instant-call"],
    [RUN_CALL_REFUSED, "ai-instant-call"],
    [RUN_CALL_TWO_LEADS, "ai-instant-call"],
    [RUN_VIDEO, "social-post"],
    [RUN_VIDEO_DRY, "social-post"],
    [RUN_OTHER, "ai-meeting-booking"],
  ]),
  runTriggerItems: new Map<string, unknown>([
    [RUN_CALL, { replyText: "yes, call me" }],
    [RUN_CALL_FORM, { formId: "f", answers: [{ key: "k", label: "l", value: "v" }] }],
  ]),
  followupActions: [
    { runId: RUN_CALL, leadId: LEAD_1, action: "claimed" },
    { runId: RUN_CALL_FORM, leadId: LEAD_2, action: "claimed" },
    { runId: RUN_CALL_REFUSED, leadId: LEAD_1, action: "claimed" },
    { runId: RUN_CALL_TWO_LEADS, leadId: LEAD_1, action: "claimed" },
    { runId: RUN_CALL_TWO_LEADS, leadId: LEAD_2, action: "claimed" },
  ],
  calls: [
    { parentRunId: RUN_CALL, callSid: "CA1" },
    { parentRunId: RUN_CALL_FORM, callSid: "CA2" },
    { parentRunId: RUN_CALL_REFUSED, callSid: null },
    { parentRunId: RUN_CALL_TWO_LEADS, callSid: "CA3" },
    // a call another workflow asked for is not this pipe's
    { parentRunId: RUN_OTHER, callSid: "CA4" },
  ],
  videos: [
    { id: VIDEO, parentRunId: RUN_VIDEO, status: "done" },
    { id: VIDEO_DRY, parentRunId: RUN_VIDEO_DRY, status: "done" },
  ],
  posts: [
    { parentRunId: RUN_VIDEO, platform: "x", status: "published" },
    { parentRunId: RUN_VIDEO, platform: "linkedin", status: "failed" },
  ],
});

describe("LEDGER-HISTORY-1024: past instant calls and industry videos", () => {
  it("a placed call produced booking_call for the claimed lead, consuming the reply or the form that made it due", () => {
    const { runs } = pastLegEvidence(base());
    expect(runs.filter((r) => r.produced[0].outcomeKey === "booking_call")).toEqual([
      {
        runId: RUN_CALL,
        occurredAt: "run_started_at",
        produced: [{ outcomeKey: "booking_call", subjectService: "lead-service", subjectId: LEAD_1 }],
        consumed: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: LEAD_1 }],
      },
      {
        runId: RUN_CALL_FORM,
        occurredAt: "run_started_at",
        produced: [{ outcomeKey: "booking_call", subjectService: "lead-service", subjectId: LEAD_2 }],
        consumed: [{ outcomeKey: "form_submitted", subjectService: "lead-service", subjectId: LEAD_2 }],
      },
    ]);
  });

  it("a call Twilio refused rang nobody, and a person not named is reported, never guessed", () => {
    const { runs, unnamed } = pastLegEvidence(base());
    expect(runs.map((r) => r.runId)).not.toContain(RUN_CALL_REFUSED);
    expect(runs.map((r) => r.runId)).not.toContain(RUN_OTHER);
    expect(unnamed).toEqual([{ runId: RUN_CALL_TWO_LEADS, featureSlug: "ai-instant-call", why: "claimed 2 leads" }]);
  });

  it("a published bulletin produced ONE industry_update_video, the video; a video never published produced nothing", () => {
    const { runs } = pastLegEvidence(base());
    expect(runs.filter((r) => r.produced[0].outcomeKey === "industry_update_video")).toEqual([
      {
        runId: RUN_VIDEO,
        occurredAt: "run_started_at",
        produced: [{ outcomeKey: "industry_update_video", subjectService: "content-generation", subjectId: VIDEO }],
        consumed: [],
      },
    ]);
  });

  it("reads a form by the DAG's own shape", () => {
    expect(isFormItem({ answers: [] })).toBe(true);
    expect(isFormItem({ formName: "x" })).toBe(true);
    expect(isFormItem({ replyText: "x" })).toBe(false);
    expect(isFormItem(undefined)).toBe(false);
  });

  it("batches refuse a run stated twice or producing two keys", () => {
    const { runs } = pastLegEvidence(base());
    expect(() => batchOutcomeRuns([runs[0], runs[0]])).toThrow(/stated twice/);
    const two = { ...runs[0], produced: [...runs[0].produced, { ...runs[0].produced[0], outcomeKey: "message_written" }] };
    expect(() => batchOutcomeRuns([two])).toThrow(/several outcome keys/);
  });
});

describe("LEDGER-HISTORY-1024: the bulletin declares its video once its X post is published", () => {
  const dag = buildIndustryUpdateVideoDag();

  it("splices the declaration between wait-x and the X owner line, mapping the rendered video id", () => {
    const node = dag.nodes.find((n) => n.id === DECLARE_INDUSTRY_UPDATE_VIDEO_NODE_ID)!;
    expect(node.config?.code).toBe(DECLARE_INDUSTRY_UPDATE_VIDEO_CODE);
    expect(node.inputMapping?.videoId).toBe("$ref:render-start.output.id");
    expect(dag.edges).toContainEqual({ from: "wait-x", to: DECLARE_INDUSTRY_UPDATE_VIDEO_NODE_ID });
    expect(dag.edges).toContainEqual({ from: DECLARE_INDUSTRY_UPDATE_VIDEO_NODE_ID, to: "compose-notify-x" });
    expect(dag.edges.filter((e) => e.from === "wait-x")).toHaveLength(1);
    expect(validateDAG(dag).valid).toBe(true);
  });

  it("states industry_update_video on the run, subject the video, consuming nothing, and never throws", () => {
    expect(DECLARE_INDUSTRY_UPDATE_VIDEO_CODE).toContain('outcomeKey: "industry_update_video", subjectService: "content-generation"');
    expect(DECLARE_INDUSTRY_UPDATE_VIDEO_CODE).not.toContain("consumed");
    expect(DECLARE_INDUSTRY_UPDATE_VIDEO_CODE).not.toMatch(/\bthrow\b/);
  });
});

describe("LEDGER-HISTORY-1024: the hot-lead proposal marks its run support copilot once the turn is asked", () => {
  it("splices the mark between ask-copilot and classify-ask, on the run itself, through the owner door", async () => {
    const { buildAiLeadProposalDag, AI_LEAD_PROPOSAL_SUPPORT_REASON } = await import("../../src/lib/ai-lead-proposal-dag.js");
    const { MARK_SUPPORT_CODE, MARK_SUPPORT_NODE_ID } = await import("../../src/lib/run-support-mark.js");
    const dag = buildAiLeadProposalDag();
    const node = dag.nodes.find((n) => n.id === MARK_SUPPORT_NODE_ID)!;
    expect(node.config?.code).toBe(MARK_SUPPORT_CODE);
    expect(node.inputMapping).toMatchObject({ kind: "copilot", reason: AI_LEAD_PROPOSAL_SUPPORT_REASON, runId: "$ref:flow_input.runId" });
    expect(dag.edges).toContainEqual({ from: "ask-copilot", to: MARK_SUPPORT_NODE_ID });
    expect(dag.edges).toContainEqual({ from: MARK_SUPPORT_NODE_ID, to: "classify-ask" });
    expect(dag.edges.filter((e) => e.from === "ask-copilot")).toHaveLength(1);
    expect(MARK_SUPPORT_CODE).toContain("/v1/platform-runs/support-marks/apply");
    expect(MARK_SUPPORT_CODE).toContain('"x-service-name": "workflow"');
    expect(MARK_SUPPORT_CODE).not.toMatch(/\bthrow\b/);
    expect(validateDAG(dag).valid).toBe(true);
  });

  it("the mark never throws and states the run, the function and who decided", async () => {
    const { MARK_SUPPORT_CODE } = await import("../../src/lib/run-support-mark.js");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const mod = await import(`data:text/javascript,${encodeURIComponent(MARK_SUPPORT_CODE)}`);
      const out = await mod.main("copilot", "why", "who", { RUNS_SERVICE_URL: "http://runs/", RUNS_SERVICE_API_KEY: "k" }, "run-1");
      expect(out).toEqual({ marked: true, status: 200, kind: "copilot" });
      expect(calls[0].url).toBe("http://runs/v1/platform-runs/support-marks/apply");
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ kind: "copilot", reason: "why", markedBy: "who", runIds: ["run-1"] });
      const missing = await mod.main("copilot", "why", "who", {}, "run-1");
      expect(missing.marked).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
