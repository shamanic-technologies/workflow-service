#!/usr/bin/env node
// MATCH25-COLD-1114 (src/lib/scripts/offer-today.ts): UPGRADES one follow-up dynasty so its writer reads our offer only
// as the FACTS state it today, its stored cases restated under the same edits (`upgrade-with-cases`, owner rule).
//
// Runs INSIDE the workflow-service container (reads dist). The dynasty's stored cases are piped in as one JSON array:
//   psql -Atc "select json_agg(body) from script_cases where outcome='<o>' and dynasty='<d>'" \
//     | docker exec -i -e ORG_ID=.. -e USER_ID=.. -e RUN_ID=.. -e STAFF_EMAIL=.. workflow-service \
//       node scripts/offer-today-upgrade.mjs --outcome <o> --dynasty <d> [--apply]
// Replay only (dryRun) unless --apply. A stored case the ACTIVE version does not replay is excluded by id, never restated.
import { readFileSync } from "node:fs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next !== undefined && !next.startsWith("--")) {
    args[a.slice(2)] = next;
    i++;
  } else args[a.slice(2)] = true;
}
const { outcome, dynasty } = args;
if (typeof outcome !== "string" || typeof dynasty !== "string") throw new Error("--outcome and --dynasty are required");

const key = process.env.WORKFLOW_SERVICE_API_KEY;
if (!key) throw new Error("WORKFLOW_SERVICE_API_KEY is required");
const { ORG_ID, USER_ID, RUN_ID, STAFF_EMAIL } = process.env;
if (!ORG_ID || !USER_ID || !RUN_ID || !STAFF_EMAIL) throw new Error("ORG_ID, USER_ID, RUN_ID and STAFF_EMAIL (a real staff identity: who decided) are required");
const identity = { "x-api-key": key, "x-org-id": ORG_ID, "x-user-id": USER_ID, "x-run-id": RUN_ID };
const base = (process.env.WORKFLOW_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");

const original = JSON.parse(readFileSync(0, "utf8"));
if (!Array.isArray(original) || original.length === 0) throw new Error("stdin: expected the dynasty's stored cases, a non-empty JSON array");

const { offerTodaySource, offerTodayCase } = await import("../dist/lib/scripts/offer-today.js");
const { replayAll } = await import("../dist/lib/scripts/replay.js");

const dyn = await fetch(`${base}/scripts/dynasty/${outcome}/${dynasty}`, { headers: identity }).then((r) => r.json());
const active = dyn.versions?.find((v) => v.runnable);
if (!active) throw new Error(`${outcome}/${dynasty} has no runnable version`);
const current = await fetch(`${base}/scripts/${active.id}`, { headers: identity }).then((r) => r.json());
const code = offerTodaySource(current.code);

const asRecorded = await replayAll(current.code, original);
const unreplayable = new Set(asRecorded.failures.map((f) => f.id));
const excluded = {};
const cases = [];
for (const c of original) {
  if (unreplayable.has(c.id)) {
    excluded[c.id] = "the active version does not replay the record";
    continue;
  }
  const r = offerTodayCase(c);
  if ("excluded" in r) excluded[c.id] = r.excluded;
  else cases.push(r.case);
}
const restated = cases.filter((c) => JSON.stringify(c) !== JSON.stringify(original.find((o) => o.id === c.id))).length;
console.log(`${outcome}/${dynasty} from ${active.scriptSlug}: ${original.length} stored cases, ${cases.length} kept (${restated} restated), excluded ${JSON.stringify(excluded)}${args.apply ? "" : " (replay only)"}`);

const res = await fetch(`${base}/internal/scripts/dynasty/${outcome}/${dynasty}/upgrade-with-cases`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": key },
  body: JSON.stringify({
    code,
    source: `the dynasty's stored cases ${new Date().toISOString().slice(0, 10)}, restated under MATCH25-COLD-1114 (our offer only as the FACTS state it today)`,
    cases,
    orgId: ORG_ID,
    createdBy: STAFF_EMAIL,
    dryRun: !args.apply,
  }),
});
const text = await res.text();
console.log(`  ${res.status} ${text.slice(0, 1500)}`);
process.exit(res.ok ? 0 : 1);
