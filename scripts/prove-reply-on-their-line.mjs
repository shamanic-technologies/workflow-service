#!/usr/bin/env node
/**
 * LEAD-REPLY-CHANNEL-1127: proves the reply-on-their-line upgrade of the four follow-up senders on each dynasty's
 * recorded cases (`script_cases`) BEFORE anything is stored, then prints the catalogue writes.
 *
 * Every recorded case is replayed on the upgrade (`replayCase`, every door answered from the record, nothing called,
 * nothing sent). A case that still matches = the run where nothing of theirs waited on us, or where the stored choice
 * already was their own app (kept as recorded). A case that no longer matches is one where the owner's rule changes
 * the run (their message waited on us on another app or line, or by email while WhatsApp was preferred): it is RESTATED
 * by running the upgrade on the same record (each door answered by the record's next call of that door; a call the
 * record never made is refused, except lead-service's follow-up writes, acknowledged), and kept only when the upgrade
 * then replays it 100 %. Prints counts, the plan's verdict per changed case, and case ids only (cases hold personal data).
 *
 * `--ops` prints one `upgradeWithCases` line per sender: pipe into `node scripts/post-catalogue-ops.mjs` (dry run
 * first). `--only <dynasty>`. `--store [--apply]` upgrades in this process (dy_brand_team's cases hold whole threads,
 * past the route's body limit); needs ORG_ID and STAFF_EMAIL (who decided).
 *
 * Inside the workflow-service container, from /app/scripts (it reads ../dist):
 *   docker exec <container> node scripts/prove-reply-on-their-line.mjs [--only dy_follow_up_due] [--ops]
 */
import { and, eq } from "drizzle-orm";
import { db } from "../dist/db/index.js";
import { scriptCases, scripts } from "../dist/db/schema.js";
import { runScript } from "../dist/lib/scripts/sandbox.js";
import { replayCase } from "../dist/lib/scripts/replay.js";
import { endRunBodyOf } from "../dist/lib/scripts/engine-runner.js";
import { REPLY_ON_THEIR_LINE_MARK, REPLY_ON_THEIR_LINE_SENDERS, REPLY_ON_THEIR_LINE_WRITERS, addChatAppToWriter, addReplyOnTheirLine } from "../dist/lib/scripts/reply-on-their-line.js";

const ops = process.argv.includes("--ops");
const i = process.argv.indexOf("--only");
const only = i >= 0 ? process.argv[i + 1] : null;
const log = (...a) => (ops ? console.error(...a) : console.log(...a));
const ACKNOWLEDGED = (name) => name.startsWith("lead.followup");
const SOURCE = (v) => `LEAD-REPLY-CHANNEL-1127: v${v}'s cases restated (a message of theirs waiting on us is answered on its own app and line, or not at all; the writer's counts read off its thread)`;
const json = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

let failed = 0;
// The writer halves first: their chat line names the conversation's app, the Copilot's medium is crm-service's app
// (none named = byte for byte). One `upgrade` op each, generated from the ACTIVE version (another active = refused).
if (ops && !only) {
  for (const { outcome, dynasty } of REPLY_ON_THEIR_LINE_WRITERS) {
    const w = (await db.select().from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty), eq(scripts.status, "active"))))[0];
    if (!w) throw new Error(`no active ${outcome}/${dynasty}`);
    if (w.code.includes("channel.app")) { log(`${outcome}/${dynasty}/v${w.version} already names the app`); continue; }
    console.log(JSON.stringify({ op: "upgrade", outcome, dynasty, fromVersion: w.version, code: addChatAppToWriter(w.code), tactics: w.tactics ?? {}, skipIfIncludes: "channel.app" }));
  }
}
for (const { outcome, dynasty } of REPLY_ON_THEIR_LINE_SENDERS) {
  if (only && only !== dynasty) continue;
  const active = (await db.select().from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty), eq(scripts.status, "active"))))[0];
  if (!active) throw new Error(`no active ${outcome}/${dynasty}`);
  if (active.code.includes(REPLY_ON_THEIR_LINE_MARK)) {
    log(`${outcome}/${dynasty}/v${active.version} already answers on their line: nothing to do`);
    continue;
  }
  const next = addReplyOnTheirLine(active.code);
  const rows = await db.select().from(scriptCases).where(and(eq(scriptCases.outcome, outcome), eq(scriptCases.dynasty, dynasty)));
  const count = { cases: rows.length, unchanged: 0, restated: 0, unfit: 0 };
  const verdicts = {};
  const cases = [];
  const excluded = {};
  for (const row of rows) {
    const c = { ...row.body, id: row.body.id ?? row.caseId, tactics: { ...(active.tactics ?? {}), ...(row.body.tactics ?? {}) } };
    const same = await replayCase(next, c);
    if (same.match) {
      count.unchanged++;
      cases.push(row.body);
      continue;
    }
    const r = await restate(next, c);
    if (process.env.DEBUG) log(`  CHANGED ${row.caseId}: ${same.diffs.slice(0, 2).join(" | ").slice(0, 400)} => ${r.ok ? r.verdict + " " + (r.reason ?? "") : r.why}`);
    if (!r.ok) {
      count.unfit++;
      excluded[row.caseId] = r.why.slice(0, 200);
      continue;
    }
    const check = await replayCase(next, r.case);
    if (!check.match) {
      count.unfit++;
      excluded[row.caseId] = "restated case does not replay: " + check.diffs.slice(0, 2).join(" | ").slice(0, 200);
      continue;
    }
    count.restated++;
    const v = r.verdict;
    verdicts[v] = (verdicts[v] ?? 0) + 1;
    const { tactics: _merged, ...kept } = r.case;
    cases.push(row.body.tactics !== undefined ? { ...kept, tactics: row.body.tactics } : kept);
  }
  log(`${outcome}/${dynasty}/v${active.version} -> upgrade: ${JSON.stringify(count)}`);
  log(`  changed runs, the channel plan's verdict: ${JSON.stringify(verdicts)}`);
  for (const [id, why] of Object.entries(excluded).slice(0, 10)) log(`  EXCLUDED ${id}: ${why}`);
  if (count.unfit > 0 && count.unfit * 10 > count.cases) {
    log(`${dynasty}: more than 10 % of the recorded cases cannot be restated: nothing may be stored`);
    failed++;
    continue;
  }
  if (process.argv.includes("--store")) {
    const { replayAll } = await import("../dist/lib/scripts/replay.js");
    const { upgradeScript } = await import("../dist/lib/scripts/script-catalogue.js");
    const summary = await replayAll(next, cases.map((c) => ({ ...c, tactics: { ...(active.tactics ?? {}), ...(c.tactics ?? {}) } })));
    log(`${dynasty}: the upgrade on its cases: ${summary.matches}/${summary.cases}`);
    if (summary.matches !== summary.cases) {
      failed++;
      continue;
    }
    if (process.argv.includes("--apply")) {
      const { ORG_ID, STAFF_EMAIL } = process.env;
      if (!ORG_ID || !STAFF_EMAIL) throw new Error("ORG_ID and STAFF_EMAIL (who decided) are required");
      const row = await upgradeScript(db, outcome, dynasty, { code: next, tactics: active.tactics ?? {}, replaceCases: { cases, source: SOURCE(active.version) } }, { orgId: ORG_ID, createdBy: STAFF_EMAIL });
      log(`upgraded ${row.outcome}/${row.dynasty}/v${row.version} replay=${JSON.stringify(row.replay)}`);
    }
  }
  if (ops) {
    console.log(JSON.stringify({ op: "upgradeWithCases", outcome, dynasty, code: next, tactics: active.tactics ?? {}, source: SOURCE(active.version), cases, excluded }));
  }
}
process.exit(failed > 0 ? 1 : 0);

/** The upgrade on the case's own record: each door answered by the record's next call of that door. */
async function restate(code, c) {
  const queue = new Map();
  for (const call of c.calls) {
    if (!queue.has(call.name)) queue.set(call.name, []);
    queue.get(call.name).push(call);
  }
  const calls = [];
  const asked = [];
  const gotten = new Map();
  const store = new Map();
  let plan = null;
  let why = null;
  const out = await runScript(code, { subject: c.subject ?? null, brand: "replay", day: c.day ?? 0, tactics: c.tactics ?? {}, request: c.request ?? null }, async (op, args) => {
    if (op === "vendor") {
      const name = String(args[0]);
      const sent = json(args[1] ?? {});
      const rec = queue.get(name)?.shift();
      if (rec) {
        calls.push({ name, ...(rec.args !== undefined ? { args: sent } : {}), answer: json(rec.answer) });
        return { v: json(rec.answer) };
      }
      if (ACKNOWLEDGED(name)) {
        const answer = { ok: true, data: {} };
        calls.push({ name, args: sent, answer });
        return { v: answer };
      }
      why = `called ${name}, which the record never called`;
      return { stop: why };
    }
    if (op === "get" || (op === "ask" && typeof args[0] === "string")) {
      const outcome = String(args[0]);
      const held = c.units?.[outcome];
      if (held === undefined) {
        why = `asked for ${outcome}, which the case does not hold`;
        return { stop: why };
      }
      const n = gotten.get(outcome) ?? 0;
      gotten.set(outcome, n + 1);
      const list = Array.isArray(held) ? held : [held];
      return { v: { id: `${c.id}:${outcome}:${n}`, outcome, subject: c.subject ?? "", ageDays: 0, content: list[Math.min(n, list.length - 1)] } };
    }
    if (op === "ask") {
      asked.push(json(args[0]));
      const cp = Object.values(args[0]?.units ?? {}).map((u) => u?.content?.channel_plan).find(Boolean) ?? null;
      if (cp) plan = cp;
      return { v: null };
    }
    if (op === "consume") return { v: null };
    const key = `${String(args[0])}\u0000${String(args[1])}`;
    if (op === "storage.get") return { v: store.get(key) ?? null };
    if (op === "storage.set") { store.set(key, args[2]); return { v: null }; }
    if (op === "storage.claim") { if (!store.has(key)) store.set(key, args[2] ?? null); return { v: store.get(key) ?? null }; }
    if (op === "storage.delete") { store.delete(key); return { v: null }; }
    why = `${String(op)} asked`;
    return { stop: why };
  });
  if (out.kind === "stopped") return { ok: false, why: why ?? out.reason };
  const failedMsg = out.kind === "error" ? out.message : null;
  const result = out.kind === "done" ? out.result : null;
  const setDate = calls.find((x) => x.name.startsWith("lead.followup") && x.args?.body?.nextFollowupAt);
  const verdict = plan?.channel
    ? `answered on ${plan.channel}${plan.onTheirLine ? " (their line)" : ""}`
    : setDate && /waits on us on (\w+)/.test(String(setDate.args.body.reason))
      ? `nothing sent: waits on ${String(setDate.args.body.reason).match(/waits on us on (\w+)/)[1]}`
      : "nothing sent";
  let expect;
  if (c.expect?.end !== undefined) {
    const unmade = typeof result?.unmade === "string" ? result.unmade : null;
    const status = failedMsg !== null ? "failed" : unmade !== null ? "unmade" : result?.content ? "made" : "nothing";
    const occurrence = !!(c.request && typeof c.request.trigger?.leadId === "string");
    expect = { end: endRunBodyOf({ status, error: failedMsg ?? unmade, again: result?.again === true, ...(result?.decided === "done" || result?.decided === "idle" ? { decided: result.decided } : {}) }, occurrence) };
  } else if (failedMsg !== null) expect = { fails: failedMsg.slice(0, 200) };
  else if (result?.content) expect = { content: json(result.content) };
  else if (typeof result?.unmade === "string") expect = { fails: result.unmade.slice(0, 200) };
  else expect = { nothing: true };
  const restated = { ...c, calls, expect, ...(c.asks !== undefined ? { asks: asked } : {}) };
  return { ok: true, case: restated, verdict, reason: String(setDate?.args?.body?.reason ?? "").slice(0, 200) };
}
