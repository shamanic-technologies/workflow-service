#!/usr/bin/env node
/**
 * Applies catalogue writes printed by a store generator (one JSON line each on stdin), idempotently, through this
 * service's own script routes on localhost (INTRO-BOARDY-1114). Dry run by default (prints what it would do);
 * `--apply` writes. Run inside the workflow-service container with a real staff identity (who decided):
 *   docker exec -i -e ORG_ID=… -e USER_ID=… -e STAFF_EMAIL=… distribute-workflow-service-1 node scripts/post-catalogue-ops.mjs [--apply]
 * `merge` {absorbed, places, reason} (ONE-WRITER-N-MODELS-1116: POST /internal/scripts/merges; already merged = skipped).
 * `upgrade` {outcome, dynasty, fromVersion, code, tactics?, skipIfIncludes} (VERIFY-BEFORE-WRITE-1124: ONE dynasty's next
 * version, generated from its active version `fromVersion`; another active version = refused, nothing written).
 * `upgradeWithCases` {outcome, dynasty, code, tactics?, description?, source, cases} (ONE-WRITER-N-MODELS-1116-OTHERS:
 * a port's upgrade with its cases restated; the dry run replays them server-side and writes nothing).
 * Ops: `create` {body} (409 = already stored: UPGRADED to the generator's code/tactics/description unless the active version already is); `replace` {outcome, dynastyPrefix, from, to, skipIfIncludes}
 * (UPGRADE of every active dynasty of that prefix whose code holds `from` exactly once; `edits` [{from, to}] instead of
 * one pair = every anchor found exactly once, applied in order, in ONE upgrade; `dynasty` beside the prefix = that
 * exact dynasty only, LEAD-EVENT-FOUNDER-HELLO-DOUBLE-1124); `tag` {outcome, dynastyPrefix,
 * tactics} (UPGRADE with the same code and the tactics merged in; skipped when already carried). `includeRetired: true`
 * also takes a RETIRED dynasty's highest version (LOCAL-TIME-ANSWERER-1115: the catalogue stores its upgrade retired
 * too, so nothing runs until someone restores the dynasty).
 */
import { readFileSync } from "node:fs";

const apply = process.argv.includes("--apply");
const key = process.env.WORKFLOW_SERVICE_API_KEY;
const { ORG_ID, USER_ID, STAFF_EMAIL } = process.env;
if (!key || !ORG_ID || !USER_ID || !STAFF_EMAIL) throw new Error("WORKFLOW_SERVICE_API_KEY, ORG_ID, USER_ID and STAFF_EMAIL are required");
// The run these writes are made under: a platform run opened here and closed at the end (never a production run).
const runs = (process.env.RUNS_SERVICE_URL ?? "").replace(/\/$/, "");
const runsKey = process.env.RUNS_SERVICE_API_KEY ?? "";
const opened = await fetch(`${runs}/v1/platform-runs`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": runsKey, "x-service-name": "workflow-service" },
  body: JSON.stringify({ serviceName: "workflow", taskName: "catalogue-ops" }),
});
if (!opened.ok) throw new Error(`runs-service: ${opened.status} ${await opened.text()}`);
const RUN_ID = (await opened.json()).id;
const headers = { "x-api-key": key, "x-org-id": ORG_ID, "x-user-id": USER_ID, "x-run-id": RUN_ID, "x-email": STAFF_EMAIL, "content-type": "application/json" };
const base = (process.env.WORKFLOW_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");

/** A JSON value with its object keys sorted: jsonb reorders keys, so a stored value is compared by content. */
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const sameJson = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

async function activeOf(outcome, prefix, includeRetired) {
  const r = await call("GET", `/scripts?outcome=${encodeURIComponent(outcome)}${includeRetired ? "&status=all" : ""}`);
  if (r.status !== 200) throw new Error(`list ${outcome}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  const list = (Array.isArray(r.json) ? r.json : r.json.scripts ?? r.json.items ?? []).filter((s) => s.outcome === outcome && String(s.dynasty).startsWith(prefix));
  if (!includeRetired) return list.filter((s) => s.status === "active" && s.dynastyStatus !== "deprecated");
  // Per dynasty: its active version, else (a retired dynasty) its highest one, as the catalogue's upgrade reads it.
  const head = new Map();
  for (const s of list) {
    const h = head.get(s.dynasty);
    if (!h || s.version > h.version) head.set(s.dynasty, s);
  }
  return [...head.values()].filter((s) => s.status === "active" || s.dynastyStatus === "deprecated");
}

let failed = 0;
for (const line of readFileSync(0, "utf8").split("\n").filter(Boolean)) {
  const op = JSON.parse(line);
  if (op.op === "create") {
    const b = op.body;
    if (!apply) {
      console.log(`create ${b.outcome}/${b.dynasty} (${b.code.length} chars) (dry run)`);
      continue;
    }
    const r = await call("POST", "/scripts", b);
    console.log(`create ${b.outcome}/${b.dynasty}: ${r.status} ${r.status === 201 ? `v${r.json.version}` : JSON.stringify(r.json).slice(0, 300)}`);
    if (r.status === 409) {
      // Already stored: the generator's code is the next version unless it is already the active one.
      const active = (await activeOf(b.outcome, b.dynasty)).find((s) => s.dynasty === b.dynasty);
      const current = active ? (await call("GET", `/scripts/${active.id}`)).json : null;
      // TEAM-PAST-EMPLOYERS-1125: a generator's new name renames the whole dynasty (every version keeps one name).
      if (current && b.name && current.name !== b.name) {
        const n = await call("PUT", `/scripts/dynasty/${b.outcome}/${b.dynasty}/name`, { name: b.name });
        console.log(`  rename ${b.outcome}/${b.dynasty} "${current.name}" -> "${b.name}": ${n.status}${n.status === 200 ? "" : " " + JSON.stringify(n.json).slice(0, 300)}`);
        if (n.status !== 200) failed++;
      }
      if (current && current.dynasty === b.dynasty && current.code === b.code && sameJson(current.tactics, b.tactics) && current.description === b.description) {
        console.log(`  ${b.outcome}/${b.dynasty}: the active version is the generator's, skipped`);
        continue;
      }
      const u = await call("POST", `/scripts/dynasty/${b.outcome}/${b.dynasty}/upgrade`, { code: b.code, description: b.description, tactics: b.tactics });
      console.log(`  upgrade ${b.outcome}/${b.dynasty}: ${u.status} ${u.status === 201 ? `v${u.json.version}` : JSON.stringify(u.json).slice(0, 300)}`);
      if (u.status !== 201) failed++;
    } else if (r.status !== 201) failed++;
    continue;
  }
  if (op.op === "upgrade") {
    // VERIFY-BEFORE-WRITE-1124: one dynasty's next version, its code generated from the active version the op names.
    const active = (await activeOf(op.outcome, op.dynasty)).find((s) => s.dynasty === op.dynasty);
    const full = active ? await call("GET", `/scripts/${active.id}`) : null;
    if (!full || full.status !== 200) throw new Error(`read ${op.outcome}/${op.dynasty}: ${full ? full.status : "no active version"}`);
    if (op.skipIfIncludes && full.json.code.includes(op.skipIfIncludes)) {
      console.log(`upgrade ${op.outcome}/${op.dynasty} v${active.version}: already done, skipped`);
      continue;
    }
    if (active.version !== op.fromVersion) {
      console.log(`upgrade ${op.outcome}/${op.dynasty}: generated from v${op.fromVersion}, the active version is v${active.version}, NOT upgraded`);
      failed++;
      continue;
    }
    if (!apply) {
      console.log(`upgrade ${op.outcome}/${op.dynasty} v${active.version} -> v${active.version + 1} (${op.code.length} chars${op.tactics ? ", tactics stated" : ""}) (dry run)`);
      continue;
    }
    const r = await call("POST", `/scripts/dynasty/${op.outcome}/${op.dynasty}/upgrade`, { code: op.code, ...(op.tactics ? { tactics: op.tactics } : {}) });
    console.log(`upgrade ${op.outcome}/${op.dynasty}: ${r.status} ${r.status === 201 ? `v${r.json.version} replay=${JSON.stringify(r.json.replay ?? null)}` : JSON.stringify(r.json).slice(0, 300)}`);
    if (r.status !== 201) failed++;
    continue;
  }
  if (op.op === "upgradeWithCases") {
    // ONE-WRITER-N-MODELS-1116-OTHERS: a PORT upgraded under an owner rule, its recorded cases restated by the
    // generator (POST /internal/scripts/dynasty/{o}/{d}/upgrade-with-cases); a dry run REPLAYS them server-side, writes nothing.
    const r = await call("POST", `/internal/scripts/dynasty/${op.outcome}/${op.dynasty}/upgrade-with-cases`, {
      code: op.code,
      ...(op.description ? { description: op.description } : {}),
      ...(op.tactics ? { tactics: op.tactics } : {}),
      source: op.source,
      cases: op.cases,
      orgId: ORG_ID,
      createdBy: STAFF_EMAIL,
      dryRun: !apply,
    });
    const ok = apply ? r.status === 201 : r.status === 200 && r.json.matches === r.json.cases;
    console.log(`upgrade-with-cases ${op.outcome}/${op.dynasty} (${op.cases.length} cases${op.excluded ? `, ${Object.keys(op.excluded).length} excluded` : ""}): ${r.status} ${apply && r.status === 201 ? `v${r.json.version} replay=${JSON.stringify(r.json.replay)}` : JSON.stringify(r.json).slice(0, 600)}${apply ? "" : " (dry run: replayed only)"}`);
    if (!ok) failed++;
    continue;
  }
  if (op.op === "merge") {
    // ONE-WRITER-N-MODELS-1116: retire a per-model copy, its history placed on each survivor (already merged = skipped).
    if (!apply) {
      console.log(`merge ${op.absorbed} -> ${op.places.map((p) => p.survivor + (p.askedBy ? " (asked by " + p.askedBy + ")" : "")).join(", ")} (dry run)`);
      continue;
    }
    const r = await call("POST", "/internal/scripts/merges", { absorbed: op.absorbed, places: op.places, reason: op.reason });
    if (r.status === 409 && r.json.code === "already_merged") console.log(`merge ${op.absorbed}: already merged, skipped`);
    else {
      console.log(`merge ${op.absorbed}: ${r.status} ${r.status === 201 ? "merged" : JSON.stringify(r.json).slice(0, 300)}`);
      if (r.status !== 201) failed++;
    }
    continue;
  }
  for (const s of await activeOf(op.outcome, op.dynastyPrefix, op.includeRetired === true)) {
    // `dynasty` stated = that exact dynasty only (a prefix alone also takes every dynasty named after it).
    if (typeof op.dynasty === "string" && s.dynasty !== op.dynasty) continue;
    const full = await call("GET", `/scripts/${s.id}`);
    if (full.status !== 200) throw new Error(`read ${s.dynasty}: ${full.status}`);
    const code = full.json.code;
    let next;
    if (op.op === "replace") {
      if (code.includes(op.skipIfIncludes)) {
        console.log(`replace ${op.outcome}/${s.dynasty} v${s.version}: already done, skipped`);
        continue;
      }
      const edits = Array.isArray(op.edits) ? op.edits : [{ from: op.from, to: op.to }];
      let edited = code;
      const missed = [];
      for (const [i, e] of edits.entries()) {
        const n = edited.split(e.from).length - 1;
        if (n !== 1) missed.push(`edit ${i} found ${n} times`);
        else edited = edited.replace(e.from, () => e.to);
      }
      if (missed.length > 0) {
        console.log(`replace ${op.outcome}/${s.dynasty} v${s.version}: ${missed.join(", ")}, NOT upgraded`);
        failed++;
        continue;
      }
      next = { code: edited };
    } else if (op.op === "tag") {
      const tactics = full.json.tactics ?? {};
      if (Object.entries(op.tactics).every(([k, v]) => sameJson(tactics[k], v))) {
        console.log(`tag ${op.outcome}/${s.dynasty} v${s.version}: already carried, skipped`);
        continue;
      }
      next = { code, tactics: { ...tactics, ...op.tactics } };
    } else throw new Error(`unknown op ${op.op}`);
    if (!apply) {
      console.log(`${op.op} ${op.outcome}/${s.dynasty} v${s.version} -> v${s.version + 1}${s.dynastyStatus === "deprecated" ? " (retired, stays retired)" : ""} (dry run)`);
      continue;
    }
    const r = await call("POST", `/scripts/dynasty/${op.outcome}/${s.dynasty}/upgrade`, next);
    console.log(`${op.op} ${op.outcome}/${s.dynasty}: ${r.status} ${r.status === 201 ? `v${r.json.version}` : JSON.stringify(r.json).slice(0, 300)}`);
    if (r.status !== 201) failed++;
  }
}
await fetch(`${runs}/v1/platform-runs/${RUN_ID}`, { method: "PATCH", headers: { "content-type": "application/json", "x-api-key": runsKey }, body: JSON.stringify({ status: failed ? "failed" : "completed" }) });
process.exit(failed ? 1 : 0);
