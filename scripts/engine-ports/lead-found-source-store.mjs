#!/usr/bin/env node
/**
 * SERVE-SOURCE-AS-DATA-1124 (PLAN-RECURSIVE-PER-ENGINE-1124, owner 2026-11-24: « add the instructions in the brief, so
 * the source chosen is filtered by what the user wants »): every Lead found script states WHERE it finds people, as
 * data of the script: its tactic `serve` gains lead-service's `findPeopleIn` (sales-lead-service #1319), which the
 * script already passes to `POST /orgs/buffer/next` as stated. So the script serves from the same source when its run
 * names no channel, and features-service's judge reads the source off the script.
 *
 * ONE-TIME migration of stored data: the source each dynasty served from was carried ONLY by the channel it states, so
 * the value is read off that stated channel here, once (a channel is removed vocabulary; this table exists only to
 * translate what the stored scripts say today and is never read at run time). A script whose serve states a
 * `population` finds its people elsewhere (lead-service refuses `findPeopleIn` beside it): left as it is.
 *
 * Every dynasty is UPGRADED (never forked): a dynasty with recorded cases through upgrade-with-cases, each case's
 * `lead.serve` request restated with the same `findPeopleIn` (the call the world sees gains exactly that field); one
 * with none through a plain upgrade, same code.
 *
 * Input on stdin: the JSON the SQL below prints. Output: one op per line for scripts/post-catalogue-ops.mjs.
 *   --print-sql   prints the read-only SQL (workflow_service) to run on the box.
 */
const CHANNEL_SOURCE = {
  "lead-sourcing": "sources_picked_for_the_brand",
  "sourcing-apollo-cold-filters": "apollo_cold_filters",
  "sourcing-apollo-buying-signals": "apollo_buying_signals",
  "sourcing-linkedin-engagement-signals": "linkedin_post_engagement",
  "sourcing-crm-contacts": "client_crm_contacts",
};

const SQL = `select json_build_object(
  'scripts', (select json_agg(json_build_object('dynasty', dynasty, 'version', version, 'code', code, 'tactics', tactics))
              from scripts where outcome = 'lead_found' and status = 'active' and dynasty_status = 'active'),
  'cases', (select json_object_agg(dynasty, c) from (select dynasty, json_agg(body order by case_id) c
              from script_cases where outcome = 'lead_found' group by dynasty) x))`;

if (process.argv.includes("--print-sql")) {
  console.log(SQL.replace(/\s+/g, " "));
  process.exit(0);
}

/** PURE: the tactics a dynasty is upgraded to, or null when it states no source to carry (or carries it already). */
export function withSource(tactics) {
  const t = tactics ?? {};
  const serve = t.serve && typeof t.serve === "object" ? t.serve : null;
  const source = typeof t.channel === "string" ? CHANNEL_SOURCE[t.channel] : undefined;
  if (!serve || !source || serve.population !== undefined) return null;
  if (serve.findPeopleIn === source) return null;
  return { ...t, serve: { ...serve, findPeopleIn: source } };
}

/** PURE: a recorded case restated: every `lead.serve` request carries the source, nothing else moves. */
export function restateCase(c, source) {
  return { ...c, calls: (c.calls ?? []).map((call) => (call.name === "lead.serve" ? { ...call, args: { ...(call.args ?? {}), findPeopleIn: source } } : call)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const cases = input.cases ?? {};
  for (const s of input.scripts ?? []) {
    const tactics = withSource(s.tactics);
    if (!tactics) {
      console.error(`lead_found/${s.dynasty} v${s.version}: no source to state (${s.tactics?.serve?.population ? "serves a population" : s.tactics?.channel ? "already stated" : "states no channel"}), left as it is`);
      continue;
    }
    const held = cases[s.dynasty] ?? [];
    if (held.length > 0) {
      console.log(JSON.stringify({ op: "upgradeWithCases", outcome: "lead_found", dynasty: s.dynasty, code: s.code, tactics, source: "restated SERVE-SOURCE-AS-DATA-1124", cases: held.map((c) => restateCase(c, tactics.serve.findPeopleIn)) }));
    } else {
      console.log(JSON.stringify({ op: "upgrade", outcome: "lead_found", dynasty: s.dynasty, fromVersion: s.version, code: s.code, tactics }));
    }
    console.error(`lead_found/${s.dynasty} v${s.version}: findPeopleIn ${tactics.serve.findPeopleIn}${held.length ? ` (${held.length} cases restated)` : ""}`);
  }
}
