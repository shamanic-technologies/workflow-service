import { describe, it, expect } from "vitest";
import { caseFromFlow, doorFor, windmillCasesSql, type RecordedStep } from "../../src/lib/scripts/windmill-cases.js";
import { replayCase } from "../../src/lib/scripts/replay.js";

// MIGRATE-1105 S1: an old workflow run, as Windmill recorded it, becomes a case in the door vocabulary.
const call = (stepId: string, service: string, method: string, path: string, extra: Record<string, unknown>, result: unknown, status = "success"): RecordedStep => ({
  stepId,
  runnablePath: "f/nodes/http_call",
  args: { service, method, path, serviceEnvs: { CRM_SERVICE_API_KEY: "secret" }, orgId: "o", ...extra },
  status,
  result,
});
const flow = { id: "f1", createdAt: "2026-11-04T13:54:38Z", args: { trigger: { person: { email: "a@b.co" } }, serviceEnvs: { X: "secret" } }, failed: false };

describe("caseFromFlow", () => {
  it("maps call steps to doors, keeps the chassis out, states the end", () => {
    const steps: RecordedStep[] = [
      call("gate_check", "campaign", "POST", "/gate-check", {}, { allowed: true }),
      call("start_run", "campaign", "POST", "/start-run", {}, { runId: "r", brief: "b" }),
      { stepId: "plan", runnablePath: "f/workflows/o/x/plan", args: {}, status: "success", result: { a: 1 } },
      call("thread", "crm", "GET", "/orgs/people/timeline", { query: { personKey: "email:a@b.co" }, params: {} }, { messages: [] }),
      call("draft", "chat", "POST", "/complete", { body: { message: "m", systemPrompt: "s", provider: "anthropic", model: "opus", workflowSlug: "x-v2" } }, { content: "hi", json: { decision: "answer" }, model: "opus", tokensInput: 3, tokensOutput: 4 }),
      call("send", "instantly", "POST", "/orgs/replies", { body: { email: "a@b.co" }, tolerateFailure: true }, { ok: false, status: 409, error: JSON.stringify({ error: "a human answered", code: "human_took_over" }) }),
      call("skipped", "crm", "POST", "/orgs/whatsapp/messages", { skip: true, body: {} }, { ok: false, skipped: true, notCalled: true }),
      call("lead", "lead", "GET", "/orgs/leads/{id}", { params: { id: "l1" } }, { lead: {} }),
      call("end_run", "campaign", "POST", "/end-run", { body: { success: true } }, { status: "completed" }),
    ];
    const out = caseFromFlow(flow, steps, { fromOutcome: "lead_event" });
    if (!("case" in out)) throw new Error(out.excluded);
    expect(out.case.units).toEqual({ lead_event: { person: { email: "a@b.co" } } });
    expect(out.case.request).toEqual({ runId: "r", brief: "b", trigger: { person: { email: "a@b.co" } }, now: "2026-11-04T13:54:38.000Z" });
    expect((caseFromFlow(flow, steps) as { case: { units: unknown } }).case.units).toEqual({});
    expect(out.case.calls.map((c) => c.name)).toEqual(["crm.person.thread", "llm.complete", "instantly.reply.send", "lead.detail"]);
    expect(out.case.calls[0]!.args).toEqual({ query: { personKey: "email:a@b.co" } });
    expect(out.case.calls[1]!.args).toEqual({ message: "m", systemPrompt: "s", provider: "anthropic", model: "opus" });
    expect(out.case.calls[1]!.answer.data).toEqual({ content: "hi", json: { decision: "answer" }, model: "opus", tokensInput: 3, tokensOutput: 4 });
    expect(out.case.calls[2]!.answer).toEqual({ ok: false, data: { error: "a human answered", status: 409, code: "human_took_over", body: { error: "a human answered", code: "human_took_over" } } });
    expect(out.case.calls[3]!.args).toEqual({ params: { id: "l1" } });
    expect(out.case.expect).toEqual({ content: { end: { success: true } } });
    expect(JSON.stringify(out.case)).not.toContain("secret");
  });

  it("excludes a run calling a route no door serves (named), a cut step, a run with no end", () => {
    expect(caseFromFlow(flow, [call("x", "billing", "POST", "/charge", {}, {})])).toEqual({ excluded: "calls billing POST /charge, which no door serves" });
    expect(caseFromFlow(flow, [call("x", "lead", "GET", "/orgs/leads/{id}", {}, null, null as unknown as string)])).toEqual({ excluded: "a step still running when it was read" });
    expect(caseFromFlow(flow, [])).toEqual({ excluded: "the run states no end" });
    expect(caseFromFlow({ ...flow, failed: true, error: "boom" }, [])).toMatchObject({ case: { expect: { fails: "boom" } } });
  });

  it("names doors by producer, method and path template; the SQL refuses an unsafe pattern", () => {
    expect(doorFor("lead", "PUT", "/orgs/leads/{id}/followup-date")).toBe("lead.followup_date.set");
    expect(doorFor("lead", "GET", "/orgs/leads/{id}/followup-date")).toBe("lead.followup_date.read");
    expect(doorFor("lead", "DELETE", "/orgs/leads/{id}")).toBeNull();
    expect(windmillCasesSql("ai_meeting_booking_%", 30, 99999)).toContain("interval '7 days'");
    expect(() => windmillCasesSql("x'; drop", 1, 1)).toThrow();
  });
});

// MIGRATE-1105 S2: a whole campaign workflow (the cold email) becomes cases for the script that replaces it.
describe("caseFromFlow, a campaign workflow (S2)", () => {
  const start = call("start_run", "campaign", "POST", "/start-run", {}, { brandIds: ["b1"], offerId: "o1" });
  const inline: RecordedStep = { stepId: "who", runnablePath: null, args: {}, status: "success", result: {} };

  it("reads a service door's fields, a stored script step as an ASK of its Engine, door param names, the runner's end", () => {
    const steps: RecordedStep[] = [
      start,
      call("fetch_lead", "lead", "POST", "/orgs/buffer/next", { body: { namedLead: null, workflowSlug: "w" } }, { found: true, lead: { leadId: "L" } }),
      inline,
      call("brand_profile", "brand", "GET", "/internal/brands/{brandId}", { params: { brandId: "b1" } }, { brand: { name: "Reed" } }),
      call("writer", "workflow", "POST", "/orgs/scripts/run", { body: { outcome: "message_written", dynasty: "dy_w", units: { u: { content: {} } }, recordedBy: "content-generation" } }, { runId: "child", unit: { content: { subject: "S" } } }),
      call("pick", "features", "GET", "/internal/writer-pick", { query: { campaignId: "c1", workflowSlug: "w-v2" } }, { template: {} }),
      call("end_run", "campaign", "POST", "/end-run", { body: { success: true, stopCampaign: false } }, {}),
    ];
    const out = caseFromFlow({ ...flow, args: { campaignId: "c1" } }, steps, { fromOutcome: "lead_found", endAsRunner: true });
    if (!("case" in out)) throw new Error(out.excluded);
    expect(out.case.calls.map((c) => [c.name, c.args])).toEqual([
      ["lead.serve", {}],
      ["brand.profile", { params: { id: "b1" } }],
      ["features.writer_pick", { query: { campaignId: "c1" } }],
    ]);
    expect(out.case.asks).toEqual([{ units: { u: { content: {} } }, recordedBy: "content-generation" }]);
    expect(out.case.units).toEqual({ message_written: { runId: "child", unit: { content: { subject: "S" } } } });
    expect(out.case.request).toMatchObject({ campaignId: "c1", brandIds: ["b1"], offerId: "o1" });
    expect(out.case.expect).toEqual({ end: { success: true, stopCampaign: false } });
  });

  it("records a thrown step as the door's refusal and the run's failure, nothing after it", () => {
    const thrown = call("fetch_lead", "lead", "POST", "/orgs/buffer/next", { body: {} }, { error: { message: 'POST lead/orgs/buffer/next failed (500): {"error":"Lead serve setup failed"}' } }, "failure");
    const out = caseFromFlow({ ...flow, failed: true, error: "" }, [start, thrown, call("end_run_error", "campaign", "POST", "/end-run", { body: { success: false } }, {})], { endAsRunner: true });
    if (!("case" in out)) throw new Error(out.excluded);
    expect(out.case.calls).toEqual([{ name: "lead.serve", args: {}, answer: { ok: false, data: { error: 'POST lead/orgs/buffer/next failed (500): {"error":"Lead serve setup failed"}' } } }]);
    expect(out.case.expect).toEqual({ fails: '{"error":"Lead serve setup failed"}' });
  });

  it("matches a script by the end the runner would state (false flags read as absent)", async () => {
    const code = `export default function run(ctx) {
      const r = ctx.vendor.call("lead.serve", {});
      if (r.data.found !== true) return r.data.reason === "serve_timed_out" ? { unmade: r.data.reason, again: true } : { unmade: r.data.reason };
      return { content: { sent: true }, subject: { service: "lead-service", id: "L" } };
    }`;
    const c = (data: Record<string, unknown>, end: Record<string, unknown>) => ({ id: "x", units: {}, request: { trigger: null }, calls: [{ name: "lead.serve", args: {}, answer: { ok: true, data } }], expect: { end } });
    expect((await replayCase(code, c({ found: true }, { success: true, stopCampaign: false }))).match).toBe(true);
    expect((await replayCase(code, c({ found: false, reason: "audience_exhausted" }, { success: true, stopCampaign: true, noWorkAvailable: false }))).match).toBe(true);
    expect((await replayCase(code, c({ found: false, reason: "serve_timed_out" }, { success: true, stopCampaign: false, noWorkAvailable: false }))).match).toBe(true);
    expect((await replayCase(code, c({ found: false, reason: "credit_insufficient" }, { success: true, stopCampaign: false, noWorkAvailable: true }))).match).toBe(true);
    const wrong = await replayCase(code, c({ found: false, reason: "credit_insufficient" }, { success: true, stopCampaign: false }));
    expect(wrong.match).toBe(false);
    expect(wrong.diffs[0]).toMatch(/^end/);
  });
});
