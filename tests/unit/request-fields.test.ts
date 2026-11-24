import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readRequest, readRequestFields } from "../../src/lib/scripts/request-fields.js";

// ENGINE-GET-ASK-1123: the Request fields a script reads, read off its code (as its materials are), so a caller asking
// an Engine outside a campaign knows what to state in `request`.
const stored = (name: string) => readFileSync(join(__dirname, "../fixtures/stored-scripts", name), "utf8");

describe("readRequestFields", () => {
  it("direct reads: dot, optional chaining, a cast, a literal key, sorted and once each", () => {
    const code = `
export default function run(ctx) {
  const email = ctx.request.email;
  const sig = typeof (ctx.request as Record<string, unknown> | null)?.signature === "string" ? 1 : 0;
  const runId = ctx.request && typeof ctx.request.runId === "string" ? ctx.request.runId : "";
  const t = ctx.request?.topic || ctx.request["postText"] || ctx.request?.["now"];
  return { content: { email, sig, runId, t } };
}`;
    expect(readRequestFields(code)).toEqual(["email", "now", "postText", "runId", "signature", "topic"]);
  });

  it("an alias of the whole Request (typed, defaulted, in parentheses) and destructuring", () => {
    expect(readRequestFields(`export default function run(ctx) { const R: any = ctx.request ?? {}; return { content: { a: R.email, b: R?.brandIds, c: R["now"] } }; }`)).toEqual(["brandIds", "email", "now"]);
    expect(readRequestFields(`export default function run(ctx) { const req = (ctx.request ?? {}) as Record<string, any>; const { brief, offerId: offer, dryRun = false, ...rest } = req; return { content: { brief, offer, dryRun, rest, t: req.trigger.leadId } }; }`)).toEqual(["brief", "dryRun", "offerId", "trigger"]);
    expect(readRequestFields(`export default function run(ctx) { const { email, phone } = ctx.request || {}; return { content: { email, phone } }; }`)).toEqual(["email", "phone"]);
  });

  it("the context under the run function's own parameter name, or a variable it was copied to", () => {
    expect(readRequestFields(`let ctx_ = null;\nfunction now() { return ctx_.request.now; }\nexport default function run(c) { ctx_ = c;\n return { content: { n: now(), g: c.request.goal } }; }`)).toEqual(["goal", "now"]);
  });

  it("never another object's request, a string, a comment or a regex; an alias stops where its name is declared again", () => {
    const code = `
// reads ctx.request.commented
export default function run(ctx) {
  const r: any = ctx.request ?? {};
  const text = "ctx.request.inString and r.alsoInString";
  const m = String(r.message).match(/["'{]r\\.inRegex/);
  const made = ctx.vendor.call("x.request", { body: {} });
  const other = made.data.request.notOurs;
  function send() { const r = ctx.vendor.call("y", {}); return r.ok ? r.data : null; }
  const each = [1].map((r) => { return r.toFixed; });
  return { content: { text, m, other, s: send(), each, schema: r.strictResponseSchema } };
}`;
    expect(readRequestFields(code)).toEqual(["message", "strictResponseSchema"]);
  });

  it("not read (said in the served doc): the Request handed whole to an asked Engine or a function, a computed key", () => {
    expect(readRequestFields(`export default function run(ctx) { const R: any = ctx.request; if (!R) return { unmade: "no_request" }; ctx.ask({ units: {}, request: Object.assign({}, R, { goal: "g" }) }); const k = "email"; return { content: { v: R[k] } }; }`)).toEqual([]);
    expect(readRequestFields(`export default function run(ctx) { return { content: {} }; }`)).toEqual([]);
  });

  it("says when the Request is also used whole (handed on, spread, walked), never when another variable of that name is", () => {
    const whole = (code: string) => readRequest(`export default function run(ctx) { ${code} }`).whole;
    expect(whole(`const R: any = ctx.request; ctx.ask({ units: {}, request: Object.assign({}, R, { goal: "g" }) }); return {};`)).toBe(true);
    expect(whole(`const R = ctx.request ?? {}; const ask = { units: {}, request: R }; ctx.ask(ask); return {};`)).toBe(true);
    expect(whole(`const r = ctx.request ?? {}; const call = {}; for (const k of Object.keys(r)) call[k] = r[k]; return { content: call };`)).toBe(true);
    expect(whole(`return { content: step(ctx.request) };`)).toBe(true);
    expect(whole(`const copy = { ...ctx.request }; return { content: copy };`)).toBe(true);
    expect(whole(`const R = ctx.request ?? {}; if (!R) return null; function f() { const R = ctx.vendor.call("x", {}); return g(R); } return { content: { e: R.email, f: f() } };`)).toBe(false);
    expect(readRequest(stored("message_sent__dy_answer_lead.v15.ts.txt")).whole).toBe(true); // handed to the rep call it asks
  });

  it("on scripts as production stores them", () => {
    expect(readRequestFields(stored("message_sent__dy_answer_lead.v15.ts.txt"))).toEqual(["brandId", "brandIds", "brief", "campaignId", "goal", "now", "offerId", "trigger", "whatsappSenderPhone"]);
    expect(readRequestFields(stored("message_written__dy_answer_lead.v4.ts.txt"))).toEqual([]);
    const cold = readRequestFields(stored("email_sent__dy_cold_email.v14.ts.txt"));
    for (const f of ["brandIds", "campaignId", "now", "trigger"]) expect(cold).toContain(f);
  });
});
