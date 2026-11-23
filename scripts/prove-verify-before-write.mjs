#!/usr/bin/env node
/**
 * VERIFY-BEFORE-WRITE-1124: proves the look-before-writing upgrade of the four cold email senders BEFORE anything is
 * stored, then prints the catalogue writes. It writes NOTHING itself (reads `scripts` and `script_cases` only).
 *
 * Per sender: its ACTIVE stored code gets the look (`addVerifyBeforeWrite`, anchored edits) and the window tactic
 * (`verdictMaxAgeDays: 30`); every recorded case of the dynasty (`script_cases`) is restated under the rule
 * (`restateCaseForVerifyBeforeWrite`: nobody served = as recorded; a send that went out = the Provider read answering
 * the verdict the send's door accepted, every other call as recorded; a send refused on the verdict = the read and the
 * door's refusal, nothing after; a verdict the record does not hold = excluded with its reason), then the upgrade is
 * replayed on ALL its restated cases in the sandbox (`replayAll`, the catalogue's own proof). One case the upgrade
 * does not run, or one that does not replay = exit 1: nothing may be stored. Prints counts and case ids only.
 *
 * `--ops` prints one line per sender for `node scripts/post-catalogue-ops.mjs` (dry run first): `upgradeWithCases`
 * when a case was restated or excluded (the owner's rule: the port's cases are replaced by the restated ones), else a
 * plain `upgrade` (code + tactics; the catalogue replays the dynasty's cases as stored). `--only <dynasty>` = one sender.
 *
 * Inside the workflow-service container, from /app/scripts (it reads ../dist):
 *   docker exec <container> node scripts/prove-verify-before-write.mjs [--only dy_cold_email] [--ops]
 */
import { and, eq } from "drizzle-orm";
import { db } from "../dist/db/index.js";
import { scriptCases, scripts } from "../dist/db/schema.js";
import { runScript, validateSource } from "../dist/lib/scripts/sandbox.js";
import { replayAll } from "../dist/lib/scripts/replay.js";
import { VERIFY_BEFORE_WRITE_SENDERS, addVerifyBeforeWrite, restateCaseForVerifyBeforeWrite, verifyBeforeWriteTactics } from "../dist/lib/scripts/verify-before-write.js";

const ops = process.argv.includes("--ops");
const i = process.argv.indexOf("--only");
const only = i >= 0 ? process.argv[i + 1] : null;
const log = (...a) => (ops ? console.error(...a) : console.log(...a));
const MARK = "VERIFY-BEFORE-WRITE-1124";

let failed = 0;
for (const { outcome, dynasty } of VERIFY_BEFORE_WRITE_SENDERS) {
  if (only && only !== dynasty) continue;
  const active = (await db.select().from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty), eq(scripts.status, "active"))))[0];
  if (!active) throw new Error(`no active ${outcome}/${dynasty}`);
  if (active.code.includes(MARK)) {
    log(`${outcome}/${dynasty}/v${active.version} already looks at the address before writing: nothing to do`);
    continue;
  }
  const next = addVerifyBeforeWrite(active.code);
  await validateSource(next);
  const tactics = verifyBeforeWriteTactics(active.tactics ?? {});
  const rows = await db.select().from(scriptCases).where(and(eq(scriptCases.outcome, outcome), eq(scriptCases.dynasty, dynasty)));
  const count = { cases: rows.length, unchanged: 0, sent: 0, refused: 0, excluded: 0, different: 0 };
  const restated = [];
  const excluded = {};
  for (const row of rows) {
    const c = { ...row.body, id: row.body.id ?? row.caseId };
    const r = await restateCaseForVerifyBeforeWrite(next, c, tactics, runScript);
    count[r.kind]++;
    if (r.kind === "different") log(`DIFFERENT ${row.caseId}: ${r.reason.slice(0, 300)}`);
    else if (r.kind === "excluded") excluded[row.caseId] = r.reason;
    else restated.push(r.case);
  }
  log(`${outcome}/${dynasty}/v${active.version} -> upgrade (${next.length} chars, tactic verdictMaxAgeDays=${tactics.verdictMaxAgeDays}): ${JSON.stringify(count)}`);
  for (const [id, why] of Object.entries(excluded)) log(`EXCLUDED ${id}: ${why}`);
  if (count.different > 0) {
    log(`${dynasty}: the upgrade does not run on every recorded case: nothing may be stored`);
    failed++;
    continue;
  }
  // The catalogue's own proof: the upgrade replayed on every restated case, its tactics under each case's own.
  const summary = await replayAll(next, restated.map((c) => ({ ...c, tactics: { ...tactics, ...(c.tactics ?? {}) } })));
  log(`${dynasty}: the upgrade on its ${summary.cases} restated cases: ${summary.matches}/${summary.cases}`);
  if (summary.matches !== summary.cases) {
    for (const f of summary.failures.slice(0, 10)) log(`FAILS ${f.id}: ${f.diffs.slice(0, 2).join(" | ").slice(0, 400)}`);
    failed++;
    continue;
  }
  if (!ops) continue;
  const changed = count.sent + count.refused + count.excluded;
  console.log(
    JSON.stringify(
      changed > 0
        ? {
            op: "upgradeWithCases",
            outcome,
            dynasty,
            code: next,
            tactics,
            source: `${MARK}: v${active.version}'s cases restated under the owner's rule (the address' verdict read before the writer is asked; ${count.sent} sent, ${count.refused} refused on the verdict, ${count.excluded} excluded, ${count.unchanged} as recorded)`,
            cases: restated,
            excluded,
          }
        : { op: "upgrade", outcome, dynasty, fromVersion: active.version, code: next, tactics, skipIfIncludes: MARK },
    ),
  );
}
process.exit(failed > 0 ? 1 : 0);
