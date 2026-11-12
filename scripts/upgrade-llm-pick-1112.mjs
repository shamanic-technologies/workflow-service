// LLM-PICK-SCRIPTS-1112 (owner 2026-11-12): every active script that named a model or read the LLM of the legacy writer
// pick is UPGRADED (same dynasty, next version) so each of its LLM calls asks the Rating (`llm.pick`). A port with
// recorded cases is upgraded with its cases restated (one recorded pick inserted before each LLM call, answering what
// that call recorded): the new code must replay 100 % of them. Dry run by default (replays, prints the score and the
// first diffs); `--apply` stores. Skips a dynasty whose active version already calls `llm.pick`.
// Runs INSIDE the workflow-service container against dist (the cases are too large for the HTTP route):
//   docker exec distribute-workflow-service-1 node scripts/upgrade-llm-pick-1112.mjs [--apply] [--only <dynasty>]
const { db } = await import("../dist/db/index.js");
const { activeVersion, loadCases, upgradeScript } = await import("../dist/lib/scripts/script-catalogue.js");
const { replayAll } = await import("../dist/lib/scripts/replay.js");
const { LLM_PICK_UPGRADES, TEMPLATE_PICK_UPGRADES, WRITER_OWN_ENGINE_UPGRADES, restateCase, restateTemplateCase, restateOwnEngineCase, NAMED_MODEL } = await import("../dist/lib/scripts/llm-pick-upgrade.js");
// `--templates`: phase 2, the TEMPLATE of each writing call asks the Rating (`template.pick`) instead of the legacy writer pick.
const templates = process.argv.includes("--templates");
// `--writer-own-engine`: phase 3, the cold email's writer LLM is picked on its own Engine (where its history is filed).
const ownEngine = process.argv.includes("--writer-own-engine");
const UPGRADES = ownEngine ? WRITER_OWN_ENGINE_UPGRADES : templates ? TEMPLATE_PICK_UPGRADES : LLM_PICK_UPGRADES;
const restate = ownEngine ? restateOwnEngineCase : templates ? restateTemplateCase : restateCase;

const apply = process.argv.includes("--apply");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;
const SOURCE = ownEngine
  ? "LLM-RATING-PER-ENGINE-1112 phase 3: production records restated, the writer LLM picked on the script's own Engine (owner 2026-11-12)"
  : process.argv.includes("--templates")
  ? "LLM-RATING-PER-ENGINE-1112 phase 2: production records restated, the writer pick read as the template pick (owner 2026-11-12)"
  : "LLM-PICK-SCRIPTS-1112: production records restated, one llm.pick before each LLM call (owner 2026-11-12)";

let failed = 0;
for (const u of UPGRADES) {
  if (only && u.dynasty !== only) continue;
  const label = `${u.outcome}/${u.dynasty}`;
  const row = await activeVersion(db, u.outcome, u.dynasty);
  if (!row) {
    console.log(`${label}: no active version, skipped`);
    continue;
  }
  if (u.needs ? !row.code.includes(u.needs) : row.code.includes(u.marker ?? '"llm.pick"')) {
    console.log(`${label}: v${row.version} already asks ${u.marker ?? "llm.pick"}, skipped`);
    continue;
  }
  let code;
  try {
    code = u.code(row.code);
  } catch (e) {
    failed++;
    console.log(`${label}: v${row.version} EDIT REFUSED: ${e.message}`);
    continue;
  }
  const tactics = u.tactics ? u.tactics(row.tactics ?? {}) : undefined;
  const effective = tactics ?? row.tactics ?? {};
  const named = [code, JSON.stringify(effective)].flatMap((t) => t.split("\n")).filter((l) => NAMED_MODEL.test(l));
  if (named.length) console.log(`${label}: WARNING still names a model: ${named.map((l) => l.trim().slice(0, 120)).join(" | ")}`);
  const stored = await loadCases(db, u.outcome, u.dynasty);
  const own = u.keepCase ? stored.filter(u.keepCase) : stored;
  if (own.length !== stored.length) console.log(`${label}: ${stored.length - own.length} stored case(s) are another dynasty's records, left out`);
  const cases = own.map((c) => restate(u, c));
  let score = "no cases";
  if (cases.length) {
    const summary = await replayAll(code, cases.map((c) => ({ ...c, tactics: { ...effective, ...(c.tactics ?? {}) } })));
    score = `${summary.matches}/${summary.cases}`;
    if (summary.matches !== summary.cases) {
      failed++;
      console.log(`${label}: v${row.version} -> replay ${score}`);
      for (const f of summary.failures.slice(0, 3)) console.log(`  ${f.id}: ${f.diffs.slice(0, 2).map((d) => d.slice(0, 300)).join(" | ")}`);
      continue;
    }
  }
  if (!apply) {
    console.log(`${label}: v${row.version} -> v${row.version + 1} ready (replay ${score}, code ${row.code.length} -> ${code.length} chars${tactics ? ", tactics without a model" : ""})`);
    continue;
  }
  const next = await upgradeScript(
    db,
    u.outcome,
    u.dynasty,
    { code, ...(tactics ? { tactics } : {}), ...(cases.length ? { replaceCases: { cases, source: SOURCE } } : {}) },
    { orgId: row.orgId, createdBy: "LLM-PICK-SCRIPTS-1112 (owner 2026-11-12)" },
  );
  console.log(`${label}: UPGRADED v${row.version} -> v${next.version} (replay ${score})`);
}
console.log(failed ? `${failed} dynasty(ies) not upgraded` : "done");
process.exit(failed ? 1 : 0);
