import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { addColdNoResend, restateCaseForColdNoResend, ALREADY_WRITTEN_CODE } from "../../src/lib/scripts/cold-no-resend.js";

// COLD-COPY-RESEND-1126 (prod 2026-11-26 10:03-10:43 UTC): 79 Living Vital prospects got their first cold email again,
// word for word, as a « Re: » in their thread: content-generation handed back the email already written for that lead
// (`existing`) and the sender, since PERSON-ALREADY-EMAILED-1125, sent it as a follow-up. Sender run 40fab1b4,
// writer run 41dd629e (dy_blind_intro_offer: 0 calls, content.existing = true).
const STORED = readFileSync(join(__dirname, "../fixtures/stored-scripts/cold-no-resend/email_sent__dy_cold_email_signed_sender_client_brand.v14.ts.txt"), "utf8");

describe("a cold sender never sends an already-written email to a person who holds our email", () => {
  it("adds the guard right after the writer's existing read, once, and the code still compiles", async () => {
    const next = addColdNoResend(STORED);
    expect(next.split("COLD-COPY-RESEND-1126").length - 1).toBeGreaterThanOrEqual(1);
    const at = next.indexOf("const existing = got.content.existing === true;");
    const guard = next.indexOf("if (existing && emailedBefore)");
    expect(guard).toBeGreaterThan(at);
    expect(guard).toBeLessThan(next.indexOf('ctx.vendor.call("content.generate"'));
    expect(next.replace(/\n  \/\/ COLD-COPY-RESEND-1126[\s\S]*?\n  }/, "")).toBe(STORED);
    await validateSource(next);
    expect(() => addColdNoResend(next)).toThrow(/already/);
    expect(() => addColdNoResend(STORED.replace("const existing = got.content.existing === true;", ""))).toThrow(/anchor/);
  });

  const ours = { name: "crm.person.thread", answer: { ok: true, data: { items: [{ kind: "message", channel: "email", direction: "outbound" }] } } };
  const theirsOnly = { name: "crm.person.thread", answer: { ok: true, data: { items: [{ kind: "message", channel: "email", direction: "inbound" }] } } };
  const after = [{ name: "content.generate", answer: { ok: true, data: {} } }, { name: "email.send", answer: { ok: true, data: {} } }];
  const endOf = (u: string) => ({ success: true, noWorkAvailable: true, reason: u });

  it("restates the recorded run of the bug: it ends before the send", () => {
    const c = { id: "c1", calls: [{ name: "lead.serve", answer: { ok: true, data: {} } }, ours, ...after], units: { message_written: { existing: true } }, expect: { end: { success: true } } };
    const r = restateCaseForColdNoResend(c, endOf);
    expect(r.changed).toBe(true);
    expect(r.case.calls.map((x) => x.name)).toEqual(["lead.serve", "crm.person.thread"]);
    expect(r.case.expect).toEqual({ end: endOf(ALREADY_WRITTEN_CODE) });
    expect(c.calls).toHaveLength(4); // the input is never written
  });

  it("leaves a written email, and an already-written one to a person we never emailed, as recorded", () => {
    for (const c of [
      { id: "a", calls: [ours, ...after], units: { message_written: { content: { text: "new" } } }, expect: { end: { success: true } } },
      { id: "b", calls: [theirsOnly, ...after], units: { message_written: { existing: true } }, expect: { end: { success: true } } },
    ]) {
      const r = restateCaseForColdNoResend(c, endOf);
      expect(r.changed).toBe(false);
      expect(r.case).toEqual(c);
    }
  });
});

import { addColdNextEmail } from "../../src/lib/scripts/cold-no-resend.js";
const STORED_V15 = readFileSync(join(__dirname, "../fixtures/stored-scripts/cold-no-resend/email_sent__dy_cold_email_signed_sender_client_brand.v15.ts.txt"), "utf8");

describe("a person who holds our email gets a newly written next message (content-generation alreadyEmailed)", () => {
  it("states alreadyEmailed + a key per run on the generation body, only when their thread holds our email; keeps the guard", async () => {
    const next = addColdNextEmail(STORED_V15);
    const at = next.indexOf("if (emailedBefore) {\n    genBody.alreadyEmailed = true;");
    expect(at).toBeGreaterThan(next.indexOf("const genBody: Record<string, unknown> = {"));
    expect(at).toBeLessThan(next.indexOf('ctx.ask({ units: { generation_request'));
    expect(next).toContain('genBody.idempotencyKey = "cold-next-email:" + String(req.runId');
    expect(next).toContain("if (existing && emailedBefore)");
    await validateSource(next);
    expect(() => addColdNextEmail(next)).toThrow(/already/);
    expect(() => addColdNextEmail(STORED)).toThrow(/guard/);
  });
});
