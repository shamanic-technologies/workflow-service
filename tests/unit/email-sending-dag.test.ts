import { describe, it, expect, vi, afterEach } from "vitest";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  EMAIL_SENDING_PIPE_ID,
  HAS_EMAIL,
  NO_EMAIL,
  PUSHED_EMAIL_MISSING_REASON,
  PUSHED_EMAIL_REFUSED_REASON,
  PUSHED_EMAIL_SENT_REASON,
  REFUSED,
  RESOLVE_EMAIL_CODE,
  SENT,
  buildEmailSendingDag,
} from "../../src/lib/email-sending-dag.js";

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

afterEach(() => vi.restoreAllMocks());

const claim = { found: true, followup: { id: "row-1", leadId: "lead-1", email: "Jo@Example.com", dueAt: "2026-10-13T15:00:00.000Z" } };
const subject = "Quick question about your hiring in Leeds — 3 roles";
const bodyHtml = "<p>Hi Jo,</p>\n<p>Saw your <b>3 open roles</b> &amp; thought of you. Café? — Sam</p>";
const trigger = {
  eventId: "ev-1",
  triggerId: "email_pushed_via_api",
  leadId: "lead-1",
  person: { email: "jo@example.com", name: "Jo Smith" },
  item: { subject, bodyHtml },
};

describe("email sending DAG", () => {
  const dag = buildEmailSendingDag();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));

  it("lives on the Start -> Email sent pipe of the Email Sending channel", () => {
    expect(EMAIL_SENDING_PIPE_ID).toBe("email-sending|start_to_email_sent");
  });

  it("is a valid DAG that translates to Windmill with three top-level branchones", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    const flow = dagToOpenFlow(dag, "email-sending-test");
    const top = flow.value.modules.filter((m: { value: { type: string } }) => m.value.type === "branchone");
    expect(top).toHaveLength(3);
    for (const id of ["check-email", "check-sent"]) {
      expect(dag.edges.filter((e) => e.to === id).map((e) => e.from)).toContain("claim-followup");
    }
  });

  it("never calls a model: no chat-service, no content-generation", () => {
    for (const n of dag.nodes) {
      expect(["chat", "content-generation"]).not.toContain(n.config?.service);
    }
  });

  it("claims from THIS campaign's own queue; nobody due ends idle and cannot reach a send", () => {
    const claims = dag.nodes.filter((n) => String(n.config?.path ?? "").includes("claim-next"));
    expect(claims.map((n) => n.id)).toEqual(["claim-followup"]);
    expect(byId.get("claim-followup")?.inputMapping?.["params.campaignId"]).toBe("$ref:flow_input.campaignId");
    expect(descendants(dag, "end-run-nobody-due").size).toBe(0);
    expect(byId.get("end-run-nobody-due")?.config?.body).toEqual({ success: true, stopCampaign: false, noWorkAvailable: true });
  });

  it("sends the resolved email verbatim through the broadcast path, keyed on the occurrence", () => {
    expect(byId.get("resolve-email")?.inputMapping?.trigger).toBe("$ref:flow_input.trigger");
    const send = byId.get("send-email")!;
    expect(send.config).toMatchObject({ service: "email-gateway", method: "POST", path: "/orgs/send", body: { type: "broadcast" } });
    expect(send.config?.skipOnRefusalCodes).toEqual(["recent_brand_contact", "lead_opted_out"]);
    expect(send.inputMapping).toMatchObject({
      "body.to": "$ref:resolve-email.output.email",
      "body.subject": "$ref:resolve-email.output.subject",
      "body.sequence": "$ref:resolve-email.output.sequence",
      "body.idempotencyKey": "$ref:resolve-email.output.idempotencyKey",
      "body.campaignId": "$ref:flow_input.campaignId",
    });
  });

  it("records the send strictly after it, stopped (never handed) so the next push is sent too", () => {
    expect(dag.edges).toContainEqual({ from: "check-sent", to: "record-sent", condition: SENT });
    expect(byId.get("record-sent")?.config?.body).toEqual({ kind: "stopped", reason: PUSHED_EMAIL_SENT_REASON });
    expect(dag.nodes.some((n) => (n.config?.body as { kind?: string } | undefined)?.kind === "handed")).toBe(false);
  });

  it("a refused send and a missing email each stop the row with their reason; the missing one fails the run", () => {
    expect(byId.get("record-refused")?.config?.body).toEqual({ kind: "stopped", reason: PUSHED_EMAIL_REFUSED_REASON });
    expect(byId.get("record-missing")?.config?.body).toEqual({ kind: "stopped", reason: PUSHED_EMAIL_MISSING_REASON });
    expect(descendants(dag, "record-missing")).toEqual(new Set(["end-run-missing"]));
    expect(byId.get("end-run-missing")?.config?.body).toEqual({ success: false, stopCampaign: false });
    const ok = { "resolve-email": { ok: true } };
    expect(holds(SENT, { ...ok, "send-email": { success: true } })).toBe(true);
    expect(holds(REFUSED, { ...ok, "send-email": { success: true } })).toBe(false);
    expect(holds(REFUSED, { ...ok, "send-email": { ok: false, skipped: true, code: "lead_opted_out" } })).toBe(true);
    // On the missing path the send never ran: neither arm.
    for (const c of [SENT, REFUSED]) expect(holds(c, { "resolve-email": { ok: false } })).toBe(false);
    for (const c of [SENT, REFUSED, HAS_EMAIL, NO_EMAIL]) expect(holds(c, {})).toBe(false);
  });
});

describe("resolving the pushed email", () => {
  const main = loadMain(RESOLVE_EMAIL_CODE);

  it("passes subject and HTML body byte-equal, for the claimed person (case-folded)", async () => {
    const out = await main(claim, trigger);
    expect(out).toEqual({
      rowId: "row-1",
      leadId: "lead-1",
      email: "Jo@Example.com",
      ok: true,
      subject,
      sequence: [{ step: 1, bodyHtml, daysSinceLastStep: 0 }],
      idempotencyKey: "email-sending:ev-1",
    });
  });

  it("a text-only body is sent as written, with an escaped HTML twin", async () => {
    const bodyText = "Hi Jo,\n\nRoles <3> & more.\r\nSam";
    const out = await main(claim, { ...trigger, item: { subject, bodyText } });
    expect(out.sequence).toEqual([
      { step: 1, bodyHtml: "Hi Jo,<br><br>Roles &lt;3&gt; &amp; more.<br>Sam", bodyText, daysSinceLastStep: 0 },
    ]);
  });

  it("both bodies pushed: both sent untouched", async () => {
    const out = await main(claim, { ...trigger, item: { subject, bodyHtml, bodyText: "plain" } });
    expect(out.sequence).toEqual([{ step: 1, bodyHtml, bodyText: "plain", daysSinceLastStep: 0 }]);
  });

  it("never sends another person's email, nor one with no subject, body or event, and says why", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases = [
      [{ ...trigger, person: { email: "someone@else.com" } }, /names someone@else.com/],
      [{ ...trigger, item: { bodyHtml } }, /no subject/],
      [{ ...trigger, item: { subject, bodyHtml: "  " } }, /no body/],
      [{ ...trigger, eventId: undefined }, /no eventId/],
      [null, /no trigger/],
    ] as const;
    for (const [t, why] of cases) {
      const out = await main(claim, t);
      expect(out).toMatchObject({ ok: false, rowId: "row-1" });
      expect(out.why).toMatch(why);
    }
    expect(spy).toHaveBeenCalledTimes(cases.length);
  });

  it("throws on a claim with no row", async () => {
    await expect(main({ found: true, followup: {} }, trigger)).rejects.toThrow(/no id or email/);
  });
});
