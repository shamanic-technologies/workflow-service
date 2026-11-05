/**
 * MIGRATE-1105 S4: turning a DAG step's Windmill code into a function of a stored script, unchanged. A Windmill step
 * is `export async function main(...)`; in a script it becomes a named synchronous function (the sandbox runs one
 * synchronous `run(ctx)`, vendors answer synchronously). Only these rewrites, nothing else in the step's text moves.
 */
export function asFunction(code: string, name: string): string {
  if (!/export async function main\(/.test(code)) throw new Error(`${name}: not a Windmill step (export async function main)`);
  if (/\bawait\b/.test(code)) throw new Error(`${name}: awaits something: a script function is synchronous, port it by hand`);
  return code.replace("export async function main(", `function ${name}(`);
}

/**
 * The shared head of every port: no console in the sandbox (the steps log; a script's words are its result), the
 * run's clock (`ctx.request.now`, never Date.now()), and the two ways a DAG step read a call's answer: thrown on
 * failure (`must`), or returned as `{ok: false, status, error}` when the step tolerated failure (`tolerated`).
 */
export const PORT_HEAD = `
const console = { log: (..._a: unknown[]) => {}, error: (..._a: unknown[]) => {} };
/** The sandbox ships no URL class: the one thing the steps read off a URL is its host name (throws like URL on garbage). */
const URL = function (this: { hostname: string; href: string }, u: string) {
  const m = /^[a-z][a-z0-9+.-]*:[/][/](?:[^@/?#]*@)?([^/?#:]+)(?::[0-9]+)?(?:[/?#]|$)/i.exec(String(u));
  if (!m) throw new TypeError("Invalid URL: " + String(u));
  this.hostname = m[1]!.toLowerCase();
  this.href = String(u);
} as unknown as new (u: string) => { hostname: string; href: string };
type Answer = { ok: boolean; data: Record<string, any> };
function must(ctx: any, name: string, args: Record<string, unknown>): any {
  const r: Answer = ctx.vendor.call(name, args);
  if (!r.ok) throw new Error(name + " failed (" + String(r.data.status ?? "") + "): " + String(r.data.error ?? "").slice(0, 500));
  return r.data;
}
function tolerated(ctx: any, name: string, args: Record<string, unknown>): any {
  const r: Answer = ctx.vendor.call(name, args);
  if (r.ok) return r.data;
  return { ok: false, status: r.data.status ?? null, error: r.data.body && Object.keys(r.data.body).length ? JSON.stringify(r.data.body) : String(r.data.error ?? "") };
}
/** The campaign's brief on a chat-service completion: appended to the system prompt (campaign-brief.ts, verbatim). */
function withBrief(body: Record<string, any>, brief: string): Record<string, any> {
  if (!brief) return body;
  const sys = typeof body.systemPrompt === "string" ? body.systemPrompt : "";
  const msg = typeof body.message === "string" ? body.message : "";
  if (sys.includes(brief) || msg.includes(brief)) return body;
  return { ...body, systemPrompt: (sys ? sys + "\\n\\n" : "") + BRIEF_HEADER + "\\n" + brief };
}
`;
