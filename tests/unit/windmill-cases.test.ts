import { describe, it, expect } from "vitest";
import { caseFromFlow, doorFor, windmillCasesSql, type RecordedStep } from "../../src/lib/scripts/windmill-cases.js";

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
      call("draft", "chat", "POST", "/complete", { body: { message: "m", systemPrompt: "s", provider: "anthropic", model: "opus" } }, { content: "hi", json: { decision: "answer" }, model: "opus", tokensInput: 3, tokensOutput: 4 }),
      call("send", "instantly", "POST", "/orgs/replies", { body: { email: "a@b.co" }, tolerateFailure: true }, { ok: false, status: 409, error: JSON.stringify({ error: "a human answered", code: "human_took_over" }) }),
      call("skipped", "crm", "POST", "/orgs/whatsapp/messages", { skip: true, body: {} }, { ok: false, skipped: true, notCalled: true }),
      call("lead", "lead", "GET", "/orgs/leads/{id}", { params: { id: "l1" } }, { lead: {} }),
      call("end_run", "campaign", "POST", "/end-run", { body: { success: true } }, { status: "completed" }),
    ];
    const out = caseFromFlow(flow, steps);
    if (!("case" in out)) throw new Error(out.excluded);
    expect(out.case.units).toEqual({ lead_event: { trigger: { person: { email: "a@b.co" } } }, campaign_run: { runId: "r", brief: "b" } });
    expect(out.case.calls.map((c) => c.name)).toEqual(["crm.person.thread", "llm.complete", "instantly.reply.send", "lead.detail"]);
    expect(out.case.calls[0]!.args).toEqual({ query: { personKey: "email:a@b.co" } });
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
