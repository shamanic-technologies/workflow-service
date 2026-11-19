#!/usr/bin/env node
/**
 * ANSWER-NOW-1119 (src/lib/scripts/answer-now.ts): UPGRADES every live dynasty that told its writer to wait for a
 * "sensible hour" (owner 2026-11-19: « Upgrade le script existant »). Per dynasty: the active version's source with the
 * three edits (`answerNowSource`, which refuses a source in an unexpected form), and, for a PORT (recorded cases), its
 * cases restated under the same edits (`answerNowCase`) so the upgrade replays 100 % of them (owner-decided behaviour
 * change = an upgrade carrying its restated cases). A case the ACTIVE version does not replay is left out, by id.
 *
 * In-process (`upgradeScript`, the catalogue route's own function): `paid_client/dy_brand_team`'s cases (80 MB of
 * threads) are past the route's body limit. The previous version is deprecated in the same transaction ("Upgraded:
 * replaced by version N"), only once its successor is stored. Dry run (replay only) by default; `--apply` writes.
 *
 * Inside the workflow-service container, from /app/scripts (it reads ../dist):
 *   docker exec -e ORG_ID=… -e STAFF_EMAIL=… <container> node scripts/answer-now-upgrade.mjs [--only <outcome>/<dynasty>] [--apply]
 */
import { and, eq } from "drizzle-orm";
import { db } from "../dist/db/index.js";
import { scriptCases, scripts } from "../dist/db/schema.js";
import { replayAll } from "../dist/lib/scripts/replay.js";
import { upgradeScript } from "../dist/lib/scripts/script-catalogue.js";
import { ANSWER_NOW_DYNASTIES, CLOCK_WAIT_PATTERN, answerNowCase, answerNowSource } from "../dist/lib/scripts/answer-now.js";

const apply = process.argv.includes("--apply");
const oi = process.argv.indexOf("--only");
const only = oi >= 0 ? process.argv[oi + 1] : null;
const { ORG_ID, STAFF_EMAIL } = process.env;
if (apply && (!ORG_ID || !STAFF_EMAIL)) throw new Error("ORG_ID and STAFF_EMAIL (who decided) are required with --apply");
const SOURCE = "ANSWER-NOW-1119: the dynasty's cases restated (the writer never waits for a sensible hour)";

let failed = 0;
for (const [outcome, dynasty] of ANSWER_NOW_DYNASTIES) {
  if (only && only !== `${outcome}/${dynasty}`) continue;
  const [active] = await db.select().from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty), eq(scripts.status, "active")));
  if (!active) {
    console.log(`${outcome}/${dynasty}: no active version, skipped`);
    continue;
  }
  if (!CLOCK_WAIT_PATTERN.test(active.code)) {
    console.log(`${outcome}/${dynasty} v${active.version}: already answers now, skipped`);
    continue;
  }
  const code = answerNowSource(active.code);
  const stored = (await db.select().from(scriptCases).where(and(eq(scriptCases.outcome, outcome), eq(scriptCases.dynasty, dynasty)))).map((r) => r.body);
  const tactics = active.tactics ?? {};
  const withTactics = (cs) => (Object.keys(tactics).length === 0 ? cs : cs.map((c) => ({ ...c, tactics: { ...tactics, ...(c.tactics ?? {}) } })));
  let replaceCases;
  if (stored.length > 0) {
    const asRecorded = await replayAll(active.code, withTactics(stored));
    const unreplayable = new Set(asRecorded.failures.map((f) => f.id));
    const excluded = {};
    const cases = [];
    for (const c of stored) {
      if (unreplayable.has(c.id)) {
        excluded[c.id] = "the active version does not replay the record";
        continue;
      }
      const r = answerNowCase(c);
      if ("excluded" in r) excluded[c.id] = r.excluded;
      else cases.push(r.case);
    }
    const restated = cases.filter((c) => JSON.stringify(c) !== JSON.stringify(stored.find((o) => o.id === c.id))).length;
    const summary = await replayAll(code, withTactics(cases));
    console.log(`${outcome}/${dynasty} v${active.version}: ${stored.length} cases, ${cases.length} kept (${restated} restated), new code replays ${summary.matches}/${summary.cases}, excluded ${JSON.stringify(excluded)}`);
    if (summary.matches !== summary.cases) {
      failed++;
      console.log(`  first failure: ${JSON.stringify(summary.failures[0]).slice(0, 800)}`);
      continue;
    }
    if (cases.length === 0) {
      failed++;
      console.log("  no case left to carry: nothing stored");
      continue;
    }
    replaceCases = { cases, source: SOURCE };
  } else console.log(`${outcome}/${dynasty} v${active.version}: no recorded case (not a port)`);
  if (!apply) continue;
  const row = await upgradeScript(db, outcome, dynasty, { code, ...(replaceCases ? { replaceCases } : {}) }, { orgId: ORG_ID, createdBy: STAFF_EMAIL });
  console.log(`  upgraded to v${row.version} (status ${row.status}) replay=${JSON.stringify(row.replay)}`);
}
process.exit(failed === 0 ? 0 : 1);
