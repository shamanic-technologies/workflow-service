// SCRIPT-VALUE-RATING-1113-WF2 (owner 2026-11-13: « un pick = toujours un script », « le LLM et le template sont des
// tactics du script »): every active script that asks `llm.pick` / `template.pick` states the LLM (and template) it
// writes with as TACTICS, and every other combination production actually ran becomes a competing dynasty of the same
// Engine, so features-service's script pick compares them.
//   - The dynasty itself is UPGRADED (same code, next version, its history kept) onto its most-run combination.
//   - Every other combination is a FORK (new dynasty, zero history, explored by the draw).
// What production ran is read by the caller off features-service's records (the JSON on stdin, built by
// the read-only SQL `--print-sql` prints, run on features_service): each decision's writer LLM (its pick, else its only LLM) and the
// template it wrote with. Allowed = chat-service serves it today and features-service's fleet LLM universe keeps it
// (Claude Fable and Claude Opus out, owner 2026-11-12); a template must still have a live head in content-generation.
// A dynasty with no record of its own takes its Engine's recorded writer picks, else its Engine's most-run combination.
// Dry run by default; `--apply` writes. Idempotent: a dynasty whose active version already states `llm` is not upgraded
// again, an existing fork is skipped.
// Runs INSIDE the workflow-service container against dist:
//   docker exec -i distribute-workflow-service-1 node scripts/script-writer-tactics-1113.mjs [--apply] [--only <dynasty>] < combos.json
// The read-only query the owner's features-service database answers (print it, run it, pipe its one JSON value in).
const COMBOS_SQL = `
with calls as (
  select decision_run_id d, split_part(regexp_replace(script_slug,'/v[0-9]+\$',''),'/',2) dyn, llm_dynasty_slug llm
  from llm_call_copy where script_slug is not null and llm_dynasty_slug is not null
),
dec as (select d, dyn, count(distinct llm) n, min(llm) only_llm from calls group by d, dyn),
wpick as (select run_id d, min(llm_dynasty_slug) llm from engine_llm_picks where place in ('writer','split','judge','draft') group by run_id),
tpl as (select decision_run_id d, min(template_dynasty_slug) t from template_decisions group by decision_run_id),
rows as (
  select dec.dyn, coalesce(w.llm, case when dec.n=1 then dec.only_llm end) llm, tpl.t template, count(*) runs
  from dec left join wpick w on w.d=dec.d left join tpl on tpl.d=dec.d group by 1,2,3
),
picks as (select outcome, place, llm_dynasty_slug llm, count(*) runs from engine_llm_picks where place in ('writer','split','judge','draft') group by 1,2,3)
select json_build_object(
  'rows', (select json_agg(r) from rows r where r.llm is not null),
  'enginePicks', (select json_agg(p) from picks p),
  'universe', (select row_to_json(u) from engine_llm_universes u where outcome='*')
);
`;
if (process.argv.includes("--print-sql")) {
  console.log(COMBOS_SQL.trim());
  process.exit(0);
}
const { db } = await import("../dist/db/index.js");
const { scripts } = await import("../dist/db/schema.js");
const { activeVersion, upgradeScript, forkScript } = await import("../dist/lib/scripts/script-catalogue.js");
const { and, eq } = await import("drizzle-orm");

const apply = process.argv.includes("--apply");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;
const AUTHOR = "SCRIPT-VALUE-RATING-1113-WF2 (owner 2026-11-13)";
const SLUG_MAX = 63;

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const rows = input.rows ?? [];
const enginePicks = input.enginePicks ?? [];
const excluded = new Set(input.universe?.excluded ?? []);
const allowedOnly = input.universe?.allowed ? new Set(input.universe.allowed) : null;

async function getJson(base, key, path) {
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(60_000) });
  return { status: res.status, body: res.ok ? await res.json() : await res.text() };
}

const chat = await getJson(process.env.CHAT_SERVICE_URL, process.env.CHAT_SERVICE_API_KEY, "/internal/model-dynasties");
if (chat.status !== 200) throw new Error(`chat-service model dynasties unreadable: ${chat.status} ${String(chat.body).slice(0, 200)}`);
const llms = new Map((chat.body.dynasties ?? chat.body).filter((d) => d.servedToday === true).map((d) => [d.slug, d]));
const allowedLlm = (slug) => llms.has(slug) && !excluded.has(slug) && (!allowedOnly || allowedOnly.has(slug));

const liveTemplate = new Map();
async function templateLive(slug) {
  if (!liveTemplate.has(slug)) {
    const r = await getJson(process.env.CONTENT_GENERATION_SERVICE_URL, process.env.CONTENT_GENERATION_SERVICE_API_KEY, `/internal/template-dynasties/${encodeURIComponent(slug)}/head`);
    liveTemplate.set(slug, r.status === 200);
  }
  return liveTemplate.get(slug);
}

const token = (s) => s.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const initials = (s) => s.split(/[^a-z0-9]+/).filter(Boolean).map((w) => w[0]).join("");
function forkName(base, llm, template) {
  const candidates = template
    ? [`${base}__${token(llm)}__${token(template)}`, `${base}__${token(llm)}__${initials(template)}`, `${base}__${initials(llm)}__${initials(template)}`]
    : [`${base}__${token(llm)}`, `${base}__${initials(llm)}`];
  const name = candidates.find((c) => c.length <= SLUG_MAX);
  if (!name) throw new Error(`no dynasty name fits ${SLUG_MAX} chars for ${base} x ${llm} x ${template}`);
  return name;
}

/** Every combination one dynasty ran, most-run first: [{llm, template, runs}]. */
async function combosOf(row) {
  const writesWithTemplate = row.code.includes("template.pick");
  const merge = new Map();
  const add = (llm, template, runs) => {
    const k = `${llm}|${template ?? ""}`;
    merge.set(k, { llm, template: template ?? null, runs: (merge.get(k)?.runs ?? 0) + runs });
  };
  const fit = async (r) => allowedLlm(r.llm) && (!writesWithTemplate || (r.template && (await templateLive(r.template))));
  for (const r of rows.filter((x) => x.dyn === row.dynasty)) if (await fit(r)) add(r.llm, writesWithTemplate ? r.template : null, r.runs);
  let source = "own runs";
  if (merge.size === 0 && !writesWithTemplate) {
    for (const p of enginePicks.filter((x) => x.outcome === row.outcome)) if (allowedLlm(p.llm)) add(p.llm, null, p.runs);
    source = "its Engine's recorded picks";
  }
  if (merge.size === 0) {
    // The Engine's most-run combination among its other dynasties (one, never an invented one).
    const siblings = await db.select().from(scripts).where(and(eq(scripts.outcome, row.outcome), eq(scripts.status, "active")));
    const names = new Set(siblings.map((s) => s.dynasty).filter((d) => d !== row.dynasty));
    const best = [];
    for (const r of rows.filter((x) => names.has(x.dyn))) if (await fit(r)) best.push(r);
    best.sort((a, b) => b.runs - a.runs);
    if (best[0]) add(best[0].llm, writesWithTemplate ? best[0].template : null, 0);
    source = "its Engine's most-run combination";
  }
  return { combos: [...merge.values()].sort((a, b) => b.runs - a.runs || a.llm.localeCompare(b.llm) || String(a.template).localeCompare(String(b.template))), source, writesWithTemplate };
}

function tacticsFor(base, combo) {
  const l = llms.get(combo.llm);
  const t = { ...(base ?? {}), llm: { provider: l.provider, model: combo.llm, name: l.name ?? combo.llm } };
  delete t.llms;
  if (combo.template) t.template = combo.template;
  return t;
}

const targets = (await db.select().from(scripts).where(and(eq(scripts.status, "active"), eq(scripts.dynastyStatus, "active"))))
  .filter((r) => r.code.includes("llm.pick") || r.code.includes("template.pick"))
  .filter((r) => !only || r.dynasty === only)
  .sort((a, b) => `${a.outcome}/${a.dynasty}`.localeCompare(`${b.outcome}/${b.dynasty}`));

const report = [];
let failed = 0;
for (const row of targets) {
  const label = `${row.outcome}/${row.dynasty}`;
  if (row.tactics?.llm) {
    console.log(`${label}: v${row.version} already states its LLM (${row.tactics.llm.model}), skipped`);
    continue;
  }
  const { combos, source, writesWithTemplate } = await combosOf(row);
  if (combos.length === 0) {
    failed++;
    console.log(`${label}: NO allowed combination recorded (${source}): left as is`);
    continue;
  }
  const [head, ...rest] = combos;
  const what = (c) => `${c.llm}${writesWithTemplate ? ` x ${c.template}` : ""} (${c.runs} runs)`;
  console.log(`${label}: ${combos.length} combination(s) from ${source}: ${combos.map(what).join(", ")}`);
  try {
    if (apply) {
      const up = await upgradeScript(db, row.outcome, row.dynasty, { code: row.code, tactics: tacticsFor(row.tactics, head) }, { orgId: row.orgId, createdBy: AUTHOR });
      report.push(`${label} | UPGRADE | v${row.version} -> v${up.version} | ${what(head)}`);
    } else report.push(`${label} | UPGRADE | v${row.version} -> v${row.version + 1} | ${what(head)}`);
  } catch (e) {
    failed++;
    console.log(`${label}: UPGRADE REFUSED: ${e.message}`);
    continue;
  }
  for (const c of rest) {
    const name = forkName(row.dynasty, c.llm, writesWithTemplate ? c.template : null);
    if (await activeVersion(db, row.outcome, name)) {
      console.log(`  ${row.outcome}/${name}: exists, skipped`);
      continue;
    }
    const description = `${row.description} Writes with ${llms.get(c.llm).name ?? c.llm}${writesWithTemplate ? ` on the template ${c.template}` : ""}.`;
    try {
      if (apply) {
        const f = await forkScript(db, row.outcome, row.dynasty, { dynasty: name, description, code: row.code, tactics: tacticsFor(row.tactics, c) }, { orgId: row.orgId, createdBy: AUTHOR });
        report.push(`${row.outcome}/${name} | NEW DYNASTY (fork of ${row.dynasty}) | v${f.version} | ${what(c)}`);
      } else report.push(`${row.outcome}/${name} | NEW DYNASTY (fork of ${row.dynasty}) | v1 | ${what(c)}`);
    } catch (e) {
      failed++;
      console.log(`  ${row.outcome}/${name}: FORK REFUSED: ${e.message}`);
    }
  }
}
console.log(`\n${apply ? "APPLIED" : "DRY RUN"}: ${report.length} object(s), ${failed} problem(s)`);
for (const l of report) console.log(l);
const perEngine = new Map();
for (const l of report) {
  const o = l.split("/")[0];
  perEngine.set(o, (perEngine.get(o) ?? 0) + 1);
}
console.log("\nper Engine (dynasties writing with a stated LLM):", JSON.stringify(Object.fromEntries(perEngine)));
process.exit(failed ? 1 : 0);
