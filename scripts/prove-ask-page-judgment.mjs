#!/usr/bin/env node
/**
 * ENGINE-GET-ASK-1123: proves the upgrade that makes every stored script ASK the Page read and Judgment made Engines
 * (instead of the raw `scraping.page` / `jev.noul` / `chat.judgment` doors) BEFORE anything is stored, then prints the
 * catalogue writes. It writes NOTHING itself (reads `scripts` and `script_cases` only).
 *
 * Per script of `ASK_PAGE_JUDGMENT_SCRIPTS`: its ACTIVE stored code is rewritten (`askPageJudgmentSource`: mechanical,
 * a moved anchor = nothing generated), checked in the sandbox (it transpiles, and every material its code now reads is
 * an Engine its tactic `asks` states), then every recorded case of the dynasty (`script_cases`) is restated
 * (`restateCaseForAskedPageJudgment`: a recorded page read or judgment becomes the held Unit + the asked Request; a
 * record whose call made no Unit or had no answer is excluded with its reason; a case holding none is unchanged) and
 * the upgrade is replayed on ALL of them (`replayAll`, the catalogue's own proof). One case that does not replay =
 * exit 1 for that script: nothing may be stored. Prints counts and case ids only.
 *
 * `--ops` prints one line per script for `node scripts/post-catalogue-ops.mjs` (dry run first): `upgradeWithCases`
 * when a case was restated or excluded, else a plain `upgrade` (code + tactics; the catalogue replays the dynasty's
 * cases as stored). `--only <outcome>/<dynasty>` = one script.
 *
 * Inside the workflow-service container, from /app/scripts (it reads ../dist):
 *   docker exec <container> node scripts/prove-ask-page-judgment.mjs [--only paid_client/dy_brand_team] [--ops]
 */
import { and, eq } from "drizzle-orm";
import { db } from "../dist/db/index.js";
import { scriptCases, scripts } from "../dist/db/schema.js";
import { readMaterials, validateSource } from "../dist/lib/scripts/sandbox.js";
import { replayAll } from "../dist/lib/scripts/replay.js";
import {
  ASK_PAGE_JUDGMENT_MARK,
  ASK_PAGE_JUDGMENT_SCRIPTS,
  NOT_MIGRATED,
  askPageJudgmentSource,
  askPageJudgmentTactics,
  restateCaseForAskedPageJudgment,
} from "../dist/lib/scripts/ask-page-judgment.js";

const ops = process.argv.includes("--ops");
const i = process.argv.indexOf("--only");
const only = i >= 0 ? process.argv[i + 1] : null;
const log = (...a) => (ops ? console.error(...a) : console.log(...a));

let failed = 0;
for (const n of NOT_MIGRATED) log(`NOT MIGRATED ${n.outcome}/${n.dynasty}: ${n.reason}`);
for (const { outcome, dynasty } of ASK_PAGE_JUDGMENT_SCRIPTS) {
  const slug = `${outcome}/${dynasty}`;
  if (only && only !== slug) continue;
  const active = (await db.select().from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty), eq(scripts.status, "active"))))[0];
  if (!active) {
    log(`${slug}: no active version, NOT upgraded`);
    failed++;
    continue;
  }
  if (active.code.includes(ASK_PAGE_JUDGMENT_MARK)) {
    log(`${slug}/v${active.version} already asks its page reads and judgments: nothing to do`);
    continue;
  }
  let next;
  try {
    next = askPageJudgmentSource(active.code, slug);
    await validateSource(next.code);
  } catch (e) {
    log(`${slug}/v${active.version}: ${e instanceof Error ? e.message : String(e)}: NOT upgraded`);
    failed++;
    continue;
  }
  const tactics = askPageJudgmentTactics(active.tactics ?? {}, next.asks);
  // A material the code reads and nobody hands or asks makes the script undrawable: refused here.
  const before = readMaterials(active.code);
  const unfed = readMaterials(next.code).filter((m) => !before.includes(m) && !tactics.asks.includes(m));
  if (unfed.length > 0) {
    log(`${slug}: the upgrade reads ${unfed.join(", ")}, which its tactic asks does not state: NOT upgraded`);
    failed++;
    continue;
  }
  const rows = await db.select().from(scriptCases).where(and(eq(scriptCases.outcome, outcome), eq(scriptCases.dynasty, dynasty)));
  const count = { cases: rows.length, unchanged: 0, restated: 0, excluded: 0 };
  const cases = [];
  const excluded = {};
  for (const row of rows) {
    const r = restateCaseForAskedPageJudgment({ ...row.body, id: row.body.id ?? row.caseId });
    if ("excluded" in r) {
      excluded[row.caseId] = r.excluded;
      count.excluded++;
    } else {
      cases.push(r.case);
      if (r.restated > 0) count.restated++;
      else count.unchanged++;
    }
  }
  log(`${slug}/v${active.version} -> upgrade (${next.code.length} chars, asks ${next.asks.join(" + ")}): ${JSON.stringify(count)}`);
  for (const [id, why] of Object.entries(excluded)) log(`EXCLUDED ${id}: ${why}`);
  if (rows.length > 0) {
    if (cases.length === 0) {
      log(`${slug}: no case left to prove it on: NOT upgraded`);
      failed++;
      continue;
    }
    // The catalogue's own proof: the upgrade replayed on every case, its tactics under each case's own.
    const summary = await replayAll(next.code, cases.map((c) => ({ ...c, tactics: { ...tactics, ...(c.tactics ?? {}) } })));
    log(`${slug}: the upgrade on its ${summary.cases} cases: ${summary.matches}/${summary.cases}`);
    if (summary.matches !== summary.cases) {
      for (const f of summary.failures.slice(0, 10)) log(`FAILS ${f.id}: ${f.diffs.slice(0, 2).join(" | ").slice(0, 400)}`);
      failed++;
      continue;
    }
  } else log(`${slug}: no recorded case (not a port): the asked paths are proven on fakes only (tests/unit/ask-page-judgment.test.ts)`);
  if (!ops) continue;
  const changed = count.restated + count.excluded;
  console.log(
    JSON.stringify(
      changed > 0
        ? {
            op: "upgradeWithCases",
            outcome,
            dynasty,
            code: next.code,
            tactics,
            source: `ENGINE-GET-ASK-1123: v${active.version}'s cases restated (page reads and judgments asked of their Engines; ${count.restated} restated, ${count.excluded} excluded, ${count.unchanged} as recorded)`,
            cases,
            excluded,
          }
        : { op: "upgrade", outcome, dynasty, fromVersion: active.version, code: next.code, tactics, skipIfIncludes: ASK_PAGE_JUDGMENT_MARK },
    ),
  );
}
// A 60 KB+ op line is cut when the process exits before stdout drains: flush first.
process.stdout.write("", () => process.exit(failed > 0 ? 1 : 0));
