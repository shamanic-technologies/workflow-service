#!/usr/bin/env node
/**
 * PERSON-ALREADY-EMAILED-1125: proves the « send in their thread » upgrade of the four cold email senders BEFORE
 * anything is stored, then prints the catalogue writes. It writes NOTHING itself (reads `scripts` and `script_cases`).
 *
 * Per sender: its ACTIVE stored code gets the edit (`addColdSenderThread`); every recorded case of the dynasty is
 * restated (`restateCaseForColdSenderThread`: a case whose recorded thread holds an email we sent them = its recorded
 * send states `followUp: true`; every other call as recorded), then the upgrade replays ALL its cases (`replayAll`).
 * One case that does not replay = exit 1. `--ops` prints one line per sender for `post-catalogue-ops.mjs`:
 * `upgradeWithCases` when a case moved, else `upgrade`. `--only <dynasty>` = one sender. `--envelope` = the second edit
 * (addColdSenderEnvelope: the writer told the envelope it writes in) on versions already carrying the first.
 *
 *   docker exec <container> node scripts/prove-cold-sender-thread.mjs [--only dy_cold_email] [--ops]
 */
import { and, eq } from "drizzle-orm";
import { db } from "../dist/db/index.js";
import { scriptCases, scripts } from "../dist/db/schema.js";
import { validateSource } from "../dist/lib/scripts/sandbox.js";
import { replayAll } from "../dist/lib/scripts/replay.js";
import { COLD_SENDER_THREAD_SENDERS, addColdSenderThread, restateCaseForColdSenderThread, addColdSenderEnvelope, restateCaseForColdSenderEnvelope } from "../dist/lib/scripts/cold-sender-thread.js";

const ops = process.argv.includes("--ops");
const i = process.argv.indexOf("--only");
const only = i >= 0 ? process.argv[i + 1] : null;
const log = (...a) => (ops ? console.error(...a) : console.log(...a));
// `--envelope`: the second edit (the writer is told the envelope it writes in), on versions already carrying the first.
const envelope = process.argv.includes("--envelope");
const MARK = envelope ? "PERSON-ALREADY-EMAILED-1125 envelope" : "PERSON-ALREADY-EMAILED-1125";
const edit = envelope ? addColdSenderEnvelope : addColdSenderThread;
const restate = envelope ? restateCaseForColdSenderEnvelope : restateCaseForColdSenderThread;

let failed = 0;
for (const { outcome, dynasty } of COLD_SENDER_THREAD_SENDERS) {
  if (only && only !== dynasty) continue;
  const active = (await db.select().from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty), eq(scripts.status, "active"))))[0];
  if (!active) throw new Error(`no active ${outcome}/${dynasty}`);
  if (active.code.includes(MARK)) {
    log(`${outcome}/${dynasty}/v${active.version} already sends in their thread: nothing to do`);
    continue;
  }
  const next = edit(active.code);
  await validateSource(next);
  const tactics = active.tactics ?? {};
  const rows = await db.select().from(scriptCases).where(and(eq(scriptCases.outcome, outcome), eq(scriptCases.dynasty, dynasty)));
  let changed = 0;
  const restated = rows.map((row) => {
    const r = restate({ ...row.body, id: row.body.id ?? row.caseId });
    if (r.changed) changed++;
    return r.case;
  });
  const summary = await replayAll(next, restated.map((c) => ({ ...c, tactics: { ...tactics, ...(c.tactics ?? {}) } })));
  log(`${outcome}/${dynasty}/v${active.version}: ${rows.length} cases, ${changed} now continue their thread; replay ${summary.matches}/${summary.cases}`);
  if (summary.matches !== summary.cases) {
    for (const f of summary.failures.slice(0, 10)) log(`FAILS ${f.id}: ${f.diffs.slice(0, 2).join(" | ").slice(0, 400)}`);
    failed++;
    continue;
  }
  if (!ops) continue;
  console.log(
    JSON.stringify(
      changed > 0
        ? { op: "upgradeWithCases", outcome, dynasty, code: next, tactics, source: `${MARK}: v${active.version}'s cases restated (a person whose thread holds our email: the send continues their thread, followUp; ${changed} of ${rows.length})`, cases: restated, excluded: {} }
        : { op: "upgrade", outcome, dynasty, fromVersion: active.version, code: next, tactics, skipIfIncludes: MARK },
    ),
  );
}
process.exit(failed > 0 ? 1 : 0);
