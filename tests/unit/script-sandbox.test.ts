import { describe, expect, it } from "vitest";
import { runScript, validateSource, transpile, SCRIPT_CPU_MS, type Bridge } from "../../src/lib/scripts/sandbox.js";

// FACTORY-P2-ENGINES isolation: a stored script reaches nothing of this process (no env, no DB, no network, no module),
// only the one bridge the host hands it; it is stopped at its compute and memory limits.
const spec = { subject: "lead-1", brand: "brand-1", day: 1, tactics: { a: 1 } };
const noHost: Bridge = () => ({ stop: "no host here" });

async function value(code: string, bridge: Bridge = noHost) {
  const out = await runScript(`export default function run(ctx) { ${code} }`, spec, bridge);
  if (out.kind !== "done") throw new Error(`${out.kind}: ${"message" in out ? out.message : out.reason}`);
  return out.result?.content;
}

describe("script sandbox isolation", () => {
  it("sees no Node, no env, no network, no module loader, no host object", async () => {
    process.env.SCRIPT_SANDBOX_SECRET = "s3cret";
    const content = await value(`
      var g = globalThis;
      var viaFunction = (function () { return Function("return typeof process")(); })();
      return { content: {
        process: typeof g.process, require: typeof g.require, fetch: typeof g.fetch, xhr: typeof g.XMLHttpRequest,
        setTimeout: typeof g.setTimeout, Buffer: typeof g.Buffer, module: typeof g.module, host: typeof g.__host, intlHost: typeof g.__intl,
        std: typeof g.std, os: typeof g.os, viaFunction: viaFunction,
        secretInGlobals: JSON.stringify(Object.getOwnPropertyNames(g)).indexOf("s3cret") >= 0,
      } };
    `);
    expect(content).toEqual({
      process: "undefined", require: "undefined", fetch: "undefined", xhr: "undefined", setTimeout: "undefined", Buffer: "undefined",
      module: "undefined", host: "undefined", intlHost: "undefined", std: "undefined", os: "undefined", viaFunction: "undefined", secretInGlobals: false,
    });
  });

  it("refuses a value import (a script imports types only)", async () => {
    expect(() => transpile(`import fs from "node:fs"; export default function run() { return fs.readFileSync("/etc/passwd"); }`)).toThrow(/import types/);
    expect(() => transpile(`import { Pool } from "pg"; export default function run() { return new Pool(); }`)).toThrow(/import types/);
    await expect(validateSource(`import type { X } from "@gtm-factory/core"; export default function run(ctx: X) { return null; }`)).resolves.toEqual({ materials: [], vendors: [] });
  });

  it("has no dynamic import or eval path out", async () => {
    const out = await runScript(`export default function run() { return { content: { x: eval("typeof process") } }; }`, spec, noHost);
    expect(out).toEqual({ kind: "done", result: { content: { x: "undefined" } } });
    const dyn = await runScript(`export default async function run() { await import("node:fs"); return null; }`, spec, noHost);
    expect(dyn.kind).not.toBe("done");
  });

  it("reaches the outside only through the bridge, with copied JSON, frozen", async () => {
    const seen: Array<[string, unknown[]]> = [];
    const bridge: Bridge = async (op, args) => {
      seen.push([op, args]);
      if (op === "get") return { v: { id: "u1", outcome: "lead_identified", subject: "lead-1", ageDays: 0, content: { name: "Ana" } } };
      if (op === "vendor") return { v: { ok: true, data: { json: { n: 2 } } } };
      return { v: null };
    };
    const content = await value(`
      var lead = ctx.get("lead_identified");
      var mutated = (function () { try { lead.content.name = "X"; return lead.content.name; } catch (e) { return "frozen"; } })();
      var a = ctx.vendor.call("llm.complete", { message: "hi " + lead.content.name });
      return { content: { name: lead.content.name, mutated: mutated, n: a.data.json.n, subject: ctx.subject, tactic: ctx.tactics.a } };
    `, bridge);
    expect(content).toEqual({ name: "Ana", mutated: "frozen", n: 2, subject: "lead-1", tactic: 1 });
    expect(seen.map(([op]) => op)).toEqual(["get", "vendor"]);
    expect(seen[1]![1]).toEqual(["llm.complete", { message: "hi Ana" }]);
  });

  it("reads a time zone's local time through Intl.DateTimeFormat (the host's, pure); a bad zone throws RangeError", async () => {
    const content = await value(`
      var f = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", hourCycle: "h23", hour: "2-digit", weekday: "short" });
      var parts = f.formatToParts(new Date(Date.UTC(2026, 9, 29, 6, 0)));
      var bad = (function () { try { new Intl.DateTimeFormat("en-US", { timeZone: "Mars/Olympus" }); return "accepted"; } catch (e) { return e instanceof RangeError ? "RangeError" : String(e); } })();
      return { content: { hour: parts.find(function (p) { return p.type === "hour"; }).value, weekday: parts.find(function (p) { return p.type === "weekday"; }).value, text: f.format(Date.UTC(2026, 9, 29, 6, 0)), bad: bad } };
    `);
    expect(content).toEqual({ hour: "11", weekday: "Thu", text: "Thu, 11", bad: "RangeError" });
  });

  it("stops a script that computes forever", async () => {
    const out = await runScript(`export default function run() { while (true) {} }`, spec, noHost);
    expect(out).toEqual({ kind: "error", message: `the script computed longer than its ${SCRIPT_CPU_MS} ms limit` });
  }, 15_000);

  it("stops a script that eats memory", async () => {
    const out = await runScript(`export default function run() { var a = []; while (true) a.push(new Array(100000).fill(1)); }`, spec, noHost);
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toMatch(/memory|computed longer/);
  }, 15_000);

  it("does not count time waiting on a vendor against the compute limit", async () => {
    const slow: Bridge = async () => {
      await new Promise((r) => setTimeout(r, SCRIPT_CPU_MS + 300));
      return { v: { ok: true, data: {} } };
    };
    const out = await runScript(`export default function run(ctx) { ctx.vendor.call("llm.complete", {}); return { content: { ok: true } }; }`, spec, slow);
    expect(out).toEqual({ kind: "done", result: { content: { ok: true } } });
  }, 15_000);

  it("a host stop ends the run as stopped, naming why", async () => {
    const out = await runScript(`export default function run(ctx) { ctx.get("email_found"); return { content: {} }; }`, spec, () => ({ stop: "not handed email_found" }));
    expect(out).toEqual({ kind: "stopped", reason: "not handed email_found" });
  });

  it("reads materials and vendors from literals, and refuses a computed material", async () => {
    await expect(
      validateSource(`export default function run(ctx) { ctx.get("lead_identified"); ctx.storage.get("t", "k"); ctx.vendor.call("llm.complete", {}); return null; }`),
    ).resolves.toEqual({ materials: ["lead_identified"], vendors: ["llm.complete"] });
    await expect(validateSource(`export default function run(ctx) { var o = "x"; return ctx.get(o); }`)).rejects.toThrow(/literal/);
    await expect(validateSource(`export const x = 1;`)).rejects.toThrow(/default export/);
  });
});
