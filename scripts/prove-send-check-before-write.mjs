#!/usr/bin/env node
/**
 * SEND-CHECK-BEFORE-WRITE-1120: proves the check-before-write upgrade of the three senders on each dynasty's recorded
 * cases (`script_cases`) BEFORE anything is stored, then prints the catalogue writes.
 *
 * For every recorded case: the active stored code and its upgrade (`addSendCheck`) run in the sandbox on the same
 * record (every door answered from it, nothing called, nothing sent; the check answered by what the record's own send
 * said about the person) and are compared (`compareSendCheckOnCase`): a send that went out = the same calls with the
 * same bodies plus the check of the very same address; a send refused on the person = no writer asked, no send, the
 * same date / row / end; no email channel = the very same run. One case that differs = exit 1: nothing may be stored.
 * Prints counts and case ids only (cases hold personal data).
 *
 * The lead follow-up's own cases hold few emails, so production's recorded runs of its last unsplit code (v8,
 * `writer_cases`, every door's answer + the model's) are replayed too: the active sender on that record, its active
 * writer answering from the recorded completion; each becomes a sender case (proof only, never stored).
 *
 * `--ops` prints one `upgradeWithCases` line per sender (its cases restated for the upgrade): pipe into
 * `node scripts/post-catalogue-ops.mjs` (dry run first). `--only <dynasty>` limits to one sender.
 * `--store [--apply]` makes the SAME upgrade in this process (`upgradeScript` with its cases replaced, as the route does):
 * dy_brand_team's restated cases hold whole threads (80 MB), past the route's 32 MB body limit. Dry = the upgrade replayed
 * on its restated cases, nothing written. Needs ORG_ID and STAFF_EMAIL (who decided).
 *
 * Inside the workflow-service container, from /app/scripts (it reads ../dist):
 *   docker exec <container> node scripts/prove-send-check-before-write.mjs [--only dy_follow_up_due] [--ops]
 */
import { and, eq } from "drizzle-orm";
import { db } from "../dist/db/index.js";
import { scriptCases, scripts, writerCases } from "../dist/db/schema.js";
import { runScript } from "../dist/lib/scripts/sandbox.js";
import { sameJson } from "../dist/lib/scripts/replay.js";
import { SEND_CHECK_DOOR, SEND_CHECK_SENDERS, addSendCheck, compareSendCheckOnCase } from "../dist/lib/scripts/send-check-before-write.js";

const ops = process.argv.includes("--ops");
const i = process.argv.indexOf("--only");
const only = i >= 0 ? process.argv[i + 1] : null;
const log = (...a) => (ops ? console.error(...a) : console.log(...a));

let failed = 0;
for (const { outcome, dynasty } of SEND_CHECK_SENDERS) {
  if (only && only !== dynasty) continue;
  const active = (await db.select().from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty), eq(scripts.status, "active"))))[0];
  if (!active) throw new Error(`no active ${outcome}/${dynasty}`);
  if (active.code.includes(`"${SEND_CHECK_DOOR}"`)) {
    log(`${outcome}/${dynasty}/v${active.version} already checks before writing: nothing to do`);
    continue;
  }
  const next = addSendCheck(active.code);
  const rows = await db.select().from(scriptCases).where(and(eq(scriptCases.outcome, outcome), eq(scriptCases.dynasty, dynasty)));
  const production = dynasty === "dy_follow_up_due" ? await productionCases(active, outcome, dynasty) : [];
  const count = { cases: rows.length, unfit: 0, unchecked: 0, passed: 0, refused: 0, different: 0, sendsCompared: 0, sendsOut: 0, writerAsksAvoided: 0 };
  const restated = [];
  const excluded = {};
  const different = [];
  for (const row of rows) {
    const c = { ...row.body, id: row.body.id ?? row.caseId };
    const r = await compareSendCheckOnCase(active.code, next, c, runScript, sameJson);
    if (r.kind === "unfit") {
      count.unfit++;
      excluded[row.caseId] = r.diff.slice(0, 200);
      continue;
    }
    if (!r.same) {
      count.different++;
      different.push(`${row.caseId}: ${r.diff}`);
      continue;
    }
    count[r.kind]++;
    const sends = r.old.steps.filter((s) => s.name === "email.send");
    count.sendsCompared += sends.length;
    if (r.kind === "passed") count.sendsOut += sends.length;
    if (r.kind === "refused") count.writerAsksAvoided += r.old.steps.filter((s) => s.kind === "ask").length;
    restated.push(r.restated);
  }
  log(`${outcome}/${dynasty}/v${active.version} -> upgrade: ${JSON.stringify(count)}`);
  if (production.length > 0) {
    const p = { cases: production.length, unfit: 0, unchecked: 0, passed: 0, refused: 0, different: 0, sendsCompared: 0, sendsOut: 0, writerAsksAvoided: 0, refusedCodes: {} };
    for (const c of production) {
      const r = await compareSendCheckOnCase(active.code, next, c, runScript, sameJson);
      if (r.kind === "unfit") { p.unfit++; continue; }
      if (!r.same) { p.different++; different.push(`production ${c.id}: ${r.diff}`); continue; }
      p[r.kind]++;
      const sends = r.old.steps.filter((x) => x.name === "email.send");
      p.sendsCompared += sends.length;
      if (r.kind === "passed") p.sendsOut += sends.length;
      if (r.kind === "refused") {
        p.writerAsksAvoided += r.old.steps.filter((x) => x.kind === "ask").length;
        const code = c.calls.find((x) => x.name === "email.send")?.answer?.data?.code;
        p.refusedCodes[code] = (p.refusedCodes[code] ?? 0) + 1;
      }
    }
    log(`${outcome}/${dynasty}/v${active.version} on production's recorded v8 runs: ${JSON.stringify(p)}`);
    for (const d of different.filter((x) => x.startsWith("production")).slice(0, 20)) log(`DIFFERENT ${d}`);
    if (p.different > 0) { log(`${dynasty}: the upgrade differs on production's runs: nothing may be stored`); failed++; continue; }
  }
  for (const d of different.slice(0, 20)) log(`DIFFERENT ${d}`);
  if (count.different > 0) {
    log(`${dynasty}: the upgrade does NOT do what the stored code did on every recorded case: nothing may be stored`);
    failed++;
    continue;
  }
  if (process.argv.includes("--store")) {
    const { replayAll } = await import("../dist/lib/scripts/replay.js");
    const { upgradeScript } = await import("../dist/lib/scripts/script-catalogue.js");
    const summary = await replayAll(next, restated.map((c) => ({ ...c, tactics: { ...(active.tactics ?? {}), ...(c.tactics ?? {}) } })));
    log(`${dynasty}: the upgrade on its restated cases: ${summary.matches}/${summary.cases}`);
    if (summary.matches !== summary.cases) {
      for (const f of summary.failures.slice(0, 5)) log(`FAILS ${f.id}: ${f.diffs.slice(0, 2).join(" | ")}`);
      failed++;
      continue;
    }
    if (process.argv.includes("--apply")) {
      const { ORG_ID, STAFF_EMAIL } = process.env;
      if (!ORG_ID || !STAFF_EMAIL) throw new Error("ORG_ID and STAFF_EMAIL (who decided) are required");
      const row = await upgradeScript(db, outcome, dynasty, { code: next, tactics: active.tactics ?? {}, replaceCases: { cases: restated, source: `SEND-CHECK-BEFORE-WRITE-1120: v${active.version}'s cases restated (the send's check asked before the writer)` } }, { orgId: ORG_ID, createdBy: STAFF_EMAIL });
      log(`upgraded ${row.outcome}/${row.dynasty}/v${row.version} replay=${JSON.stringify(row.replay)}`);
    }
  }
  if (ops) {
    console.log(
      JSON.stringify({
        op: "upgradeWithCases",
        outcome,
        dynasty,
        code: next,
        tactics: active.tactics ?? {},
        source: `SEND-CHECK-BEFORE-WRITE-1120: v${active.version}'s cases restated (the send's check asked before the writer)`,
        cases: restated,
        excluded,
      }),
    );
  }
}
process.exit(failed > 0 ? 1 : 0);

/**
 * Production's recorded runs of the last unsplit lead follow-up (v8: every door answered, the model's completion kept),
 * as cases of the ACTIVE sender: the sender replayed on the record, its active writer answering from the recorded
 * completion, the writer's answer kept as the sender's material. A run the pair cannot replay is left out.
 */
async function productionCases(sender, outcome, dynasty) {
  const writer = (await db.select().from(scripts).where(and(eq(scripts.outcome, "message_written"), eq(scripts.dynasty, dynasty), eq(scripts.status, "active"))))[0];
  if (!writer) return [];
  const v8 = (await db.select().from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty), eq(scripts.version, 8))))[0];
  if (!v8) return [];
  const { createHash } = await import("node:crypto");
  const md5 = createHash("md5").update(v8.code).digest("hex");
  const rows = (await db.select().from(writerCases).where(eq(writerCases.outcome, outcome))).filter((r) => r.codeMd5 === md5);
  const out = [];
  for (const row of rows) {
    const c = row.body;
    const completion = c.asked?.llm_completion ?? null;
    let next = 0;
    let pending = null;
    let said;
    const end = await runScript(sender.code, { subject: c.subject, brand: c.brand ?? "replay", day: c.day ?? 0, tactics: c.tactics ?? {}, request: c.request ?? null }, async (op, args) => {
      if (op === "vendor") {
        const rec = c.calls[next];
        if (!rec || rec.name !== String(args[0])) return { stop: "off the record" };
        next++;
        return { v: JSON.parse(JSON.stringify(rec.answer)) };
      }
      if (op === "ask") { pending = args[0]; return { v: null }; }
      if (op === "get" && String(args[0]) === "message_written" && pending) {
        const content = pending.units?.follow_up_requested?.content;
        const w = await runScript(writer.code, { subject: pending.subject?.id ?? null, brand: "replay", day: c.day ?? 0, tactics: {}, request: null }, async (wop, wargs) => {
          if (wop === "get" && String(wargs[0]) === "follow_up_requested") return { v: { id: "handed", outcome: "follow_up_requested", subject: "", ageDays: 0, content } };
          if (wop === "get" && String(wargs[0]) === "llm_completion" && completion) return { v: completion };
          if (wop === "ask") return { v: null };
          return { stop: `writer ${String(wop)}` };
        });
        if (w.kind !== "done") return { stop: "writer did not answer" };
        const result = w.result ?? {};
        said = result.content ?? result.answer;
        return { v: { id: "written", outcome: "message_written", subject: "", ageDays: 0, ...(result.content ? { content: result.content } : { unmade: result.unmade, answer: result.answer }) } };
      }
      if (String(op).startsWith("storage.")) return { v: null };
      return { stop: String(op) };
    });
    if (end.kind === "stopped" || next !== c.calls.length) continue;
    out.push({ id: row.runId, units: said !== undefined ? { message_written: said } : {}, request: c.request ?? null, tactics: c.tactics ?? {}, subject: c.subject ?? null, day: c.day ?? 0, calls: c.calls });
  }
  log(`production runs of ${outcome}/${dynasty}/v8 recorded: ${rows.length}, replayable as cases of v${sender.version}: ${out.length}`);
  return out;
}
