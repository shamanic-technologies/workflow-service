import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMaterials, runScript, validateSource } from "../../src/lib/scripts/sandbox.js";
import { sameJson } from "../../src/lib/scripts/replay.js";
import { SCRIPT_VENDORS, writesToPerson } from "../../src/lib/scripts/vendors.js";
import { SEND_CHECK_ANCHORS, SEND_CHECK_DOOR, addSendCheck, compareSendCheckOnCase, type SenderCase } from "../../src/lib/scripts/send-check-before-write.js";

// SEND-CHECK-BEFORE-WRITE-1120: the three senders (byte for byte as production stores them) ask the send's checks on
// the person before their writer. Proven on each dynasty's recorded cases by scripts/prove-send-check-before-write.mjs.
const STORED: Record<string, string> = {
  "lead_interested/dy_follow_up_due v12": readFileSync(join(__dirname, "../fixtures/follow-up-due-stored-v12.js"), "utf8"),
  "paid_client/dy_client_check_in v5": readFileSync(join(__dirname, "../fixtures/client-check-in-stored-v5.js"), "utf8"),
  "paid_client/dy_brand_team v5": readFileSync(join(__dirname, "../fixtures/brand-team-stored-v5.js"), "utf8"),
};

describe.each(Object.keys(STORED))("addSendCheck on %s", (name) => {
  const stored = STORED[name]!;
  const next = addSendCheck(stored);

  it("asks the check once, after the channel plan and before the writer branch", () => {
    expect(next.split(`"${SEND_CHECK_DOOR}"`).length - 1).toBe(1);
    const plan = next.indexOf(SEND_CHECK_ANCHORS.channelPlan);
    const check = next.indexOf(`"${SEND_CHECK_DOOR}"`);
    const ask = next.indexOf("ctx.ask(");
    expect(plan).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(plan);
    expect(ask).toBeGreaterThan(check);
    expect(next.indexOf("if (CHECK_REFUSED) results.send_email = results.send_check;")).toBeGreaterThan(next.indexOf(SEND_CHECK_ANCHORS.sendEmail));
  });

  it("keeps every stored line (the edit only adds)", () => {
    const kept = stored.split("\n").filter((l) => l !== "  if (results.channel_plan?.skipModel === true) {");
    const lines = new Set(next.split("\n"));
    for (const l of kept) expect(lines.has(l), l).toBe(true);
  });

  it("is a valid source on a door the catalogue allows, reading the same materials", async () => {
    await expect(validateSource(next)).resolves.toBeDefined();
    expect(readMaterials(next)).toEqual(readMaterials(stored));
    expect((SCRIPT_VENDORS as readonly string[]).includes(SEND_CHECK_DOOR)).toBe(true);
    expect(writesToPerson(next)).toBe(true);
  });

  it("refuses a code that already checks", () => {
    expect(() => addSendCheck(next)).toThrow(/already/);
  });
});

it("refuses a code whose anchor moved", () => {
  expect(() => addSendCheck("export default function run() {}")).toThrow(/nowhere/);
});

// A small sender with the stored senders' own lines around the edit: channel plan, writer, sends, outcome.
const MINI = `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";
function callStep(ctx: any, door: string, s: any, retries: number): any {
  if (s.skip === true) return { ok: false, skipped: true, notCalled: true };
  const r: any = ctx.vendor.call(door, { body: s.body });
  if (r.ok) return r.data;
  const code = r.data.code;
  if ((s.skipOnRefusalCodes ?? []).includes(code)) return { ok: false, skipped: true, code, reason: r.data.body.details };
  throw new Error(door + " failed");
}
const step_channel_plan = (p: any) => (p.email ? { channel: "email", skipModel: false, email: p.email } : { channel: null, skipModel: true });
export default function run(ctx: ScriptContext): ScriptResult {
  const results: any = {};
  results.resolve_person = callStep(ctx, "lead.serve", { body: {} }, 0);
  results.reach_check = null; results.read_state = null; results.person_thread = null;
${SEND_CHECK_ANCHORS.channelPlan.replace("step_channel_plan((results.resolve_person), (results.read_state), (results.reach_check), (results.person_thread))", "step_channel_plan((results.resolve_person), (results.read_state), (results.reach_check), (results.person_thread))")}  results.brand_profile = callStep(ctx, "brand.profile", { body: {}, skip: (results.channel_plan?.skipModel) }, 0);
${SEND_CHECK_ANCHORS.writerBranch}    results.finalize = { decision: "none", skipEmail: true };
  } else {
    ctx.ask({ units: { x_requested: { content: { to: results.channel_plan.email } } } });
    const w: any = ctx.get("message_written");
    results.finalize = { decision: "write", channel: "email", to: results.channel_plan.email, skipEmail: false, text: w.content.text };
  }
${SEND_CHECK_ANCHORS.sendEmail}{ body: { to: results.finalize?.to, text: results.finalize?.text }, skip: (results.finalize?.skipEmail), skipOnRefusalCodes: ["email_not_verified"] }, 0);
${SEND_CHECK_ANCHORS.afterSends}null);
  const sent = results.send_email?.skipped !== true;
  callStep(ctx, "lead.followup_date.set", { body: sent ? { days: 3 } : { days: 30, why: results.send_email.reason } }, 0);
  return sent ? { content: { sent: true } } : { unmade: "email_not_verified: " + results.send_email.reason };
}
function step_compose_rep_alert(..._a: any[]) { return null; }
`;

const ok = (data: Record<string, unknown>) => ({ ok: true, data });
const refusal = { ok: false, data: { status: 409, code: "email_not_verified", body: { code: "email_not_verified", details: "a@b.c was not sent: our verifier's verdict is invalid" } } };

describe("compareSendCheckOnCase (the proof)", () => {
  const next = addSendCheck(MINI);

  it("a send that went out: the same calls and ends, plus the check of the same address", async () => {
    const c: SenderCase = {
      id: "sent",
      units: { message_written: { text: "hi" } },
      calls: [
        { name: "lead.serve", answer: ok({ email: "a@b.c" }) },
        { name: "brand.profile", answer: ok({}) },
        { name: "email.send", args: { body: { to: "a@b.c", text: "hi" } }, answer: ok({ success: true }) },
        { name: "lead.followup_date.set", answer: ok({}) },
      ],
    };
    const r = await compareSendCheckOnCase(MINI, next, c, runScript, sameJson);
    expect(r.diff).toBeNull();
    expect(r.kind).toBe("passed");
    expect(r.restated!.calls.map((x) => x.name)).toEqual(["lead.serve", SEND_CHECK_DOOR, "brand.profile", "email.send", "lead.followup_date.set"]);
  });

  it("a send refused on an invalid address: no writer, no read for it, no send, the same date and end", async () => {
    const c: SenderCase = {
      id: "refused",
      units: { message_written: { text: "hi" } },
      asks: [{ units: { x_requested: { content: { to: "a@b.c" } } } }],
      calls: [
        { name: "lead.serve", answer: ok({ email: "a@b.c" }) },
        { name: "brand.profile", answer: ok({}) },
        { name: "email.send", args: { body: { to: "a@b.c", text: "hi" } }, answer: refusal },
        { name: "lead.followup_date.set", answer: ok({}) },
      ],
    };
    const r = await compareSendCheckOnCase(MINI, next, c, runScript, sameJson);
    expect(r.diff).toBeNull();
    expect(r.kind).toBe("refused");
    expect(r.next.steps.some((s) => s.kind === "ask")).toBe(false);
    expect(r.next.steps.map((s) => s.name)).toEqual(["lead.serve", SEND_CHECK_DOOR, "lead.followup_date.set"]);
    expect(r.next.steps[2]!.args).toEqual(r.old.steps.find((s) => s.name === "lead.followup_date.set")!.args);
    expect(r.restated!.asks).toEqual([]);
    expect(r.restated!.units).toEqual({});
  });

  it("no email channel: no check, the very same run", async () => {
    const c: SenderCase = {
      id: "wa",
      calls: [
        { name: "lead.serve", answer: ok({}) },
        { name: "lead.followup_date.set", answer: ok({}) },
      ],
    };
    const r = await compareSendCheckOnCase(MINI, next, c, runScript, sameJson);
    expect(r.kind).toBe("unchecked");
    expect(r.diff).toBeNull();
  });

  it("reports a difference: an upgrade that drops the refusal is not the same", async () => {
    const broken = next.replace("  if (CHECK_REFUSED) results.send_email = results.send_check;\n", "");
    const c: SenderCase = {
      id: "refused",
      units: { message_written: { text: "hi" } },
      calls: [
        { name: "lead.serve", answer: ok({ email: "a@b.c" }) },
        { name: "brand.profile", answer: ok({}) },
        { name: "email.send", args: { body: { to: "a@b.c", text: "hi" } }, answer: refusal },
        { name: "lead.followup_date.set", answer: ok({}) },
      ],
    };
    const r = await compareSendCheckOnCase(MINI, broken, c, runScript, sameJson);
    expect(r.same).toBe(false);
  });
});
