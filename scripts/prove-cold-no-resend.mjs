#!/usr/bin/env node
/**
 * COLD-COPY-RESEND-1126: proves the « never send an already-written email to a person who holds our email » upgrade of
 * the four cold email senders BEFORE anything is stored, then prints the catalogue writes. Writes NOTHING itself.
 *
 * Per sender: its HIGHEST stored version (the one carrying PERSON-ALREADY-EMAILED-1125, parked by the emergency stop)
 * gets the edit (`addColdNoResend`); every recorded case is restated (`restateCaseForColdNoResend`), then the upgrade
 * replays ALL of them. One case that does not replay = exit 1. `--ops` prints one line per sender for
 * `post-catalogue-ops.mjs` (`upgradeWithCases` when a case moved, else `upgrade` from the ACTIVE version).
 *
 *   docker exec <container> node scripts/prove-cold-no-resend.mjs [--only dy_cold_email] [--ops]
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../dist/db/index.js";
import { scriptCases, scripts } from "../dist/db/schema.js";
import { validateSource } from "../dist/lib/scripts/sandbox.js";
import { replayAll } from "../dist/lib/scripts/replay.js";
import { endRunBodyOf } from "../dist/lib/scripts/engine-runner.js";
import { COLD_SENDER_THREAD_SENDERS } from "../dist/lib/scripts/cold-sender-thread.js";
import { addColdNoResend, restateCaseForColdNoResend } from "../dist/lib/scripts/cold-no-resend.js";

const ops = process.argv.includes("--ops");
const i = process.argv.indexOf("--only");
const only = i >= 0 ? process.argv[i + 1] : null;
const log = (...a) => (ops ? console.error(...a) : console.log(...a));
const MARK = "COLD-COPY-RESEND-1126";
const endOf = (unmade, c) => {
  const occurrence = !!(c.request && c.request.trigger && typeof c.request.trigger.leadId === "string");
  return endRunBodyOf({ status: "unmade", error: unmade, again: false }, occurrence);
};

let failed = 0;
for (const { outcome, dynasty } of COLD_SENDER_THREAD_SENDERS) {
  if (only && only !== dynasty) continue;
  const versions = await db.select().from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty))).orderBy(desc(scripts.version));
  const active = versions.find((v) => v.status === "active");
  const base = versions[0];
  if (!active || !base) throw new Error(`no active ${outcome}/${dynasty}`);
  if (base.code.includes(MARK)) {
    log(`${outcome}/${dynasty}/v${base.version} already carries the rule: nothing to do`);
    continue;
  }
  const next = addColdNoResend(base.code);
  await validateSource(next);
  const tactics = base.tactics ?? {};
  const rows = await db.select().from(scriptCases).where(and(eq(scriptCases.outcome, outcome), eq(scriptCases.dynasty, dynasty)));
  let changed = 0;
  const restated = rows.map((row) => {
    const r = restateCaseForColdNoResend({ ...row.body, id: row.body.id ?? row.caseId }, endOf);
    if (r.changed) changed++;
    return r.case;
  });
  const summary = await replayAll(next, restated.map((c) => ({ ...c, tactics: { ...tactics, ...(c.tactics ?? {}) } })));
  log(`${outcome}/${dynasty}: base v${base.version} (active v${active.version}), ${rows.length} cases, ${changed} now end before the send; replay ${summary.matches}/${summary.cases}`);
  if (summary.matches !== summary.cases) {
    for (const f of summary.failures.slice(0, 10)) log(`FAILS ${f.id}: ${f.diffs.slice(0, 2).join(" | ").slice(0, 400)}`);
    failed++;
    continue;
  }
  if (!ops) continue;
  console.log(
    JSON.stringify(
      changed > 0
        ? { op: "upgradeWithCases", outcome, dynasty, code: next, tactics, source: `${MARK}: v${base.version}'s cases restated (an already-written email to a person whose thread holds our email: nothing sent; ${changed} of ${rows.length})`, cases: restated, excluded: {} }
        : { op: "upgrade", outcome, dynasty, fromVersion: active.version, code: next, tactics, skipIfIncludes: MARK },
    ),
  );
}
process.exit(failed > 0 ? 1 : 0);
