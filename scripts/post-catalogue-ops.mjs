#!/usr/bin/env node
/**
 * Applies catalogue writes printed by a store generator (one JSON line each on stdin), idempotently, through this
 * service's own script routes on localhost (INTRO-BOARDY-1114). Dry run by default (prints what it would do);
 * `--apply` writes. Run inside the workflow-service container with a real staff identity (who decided):
 *   docker exec -i -e ORG_ID=… -e USER_ID=… -e STAFF_EMAIL=… distribute-workflow-service-1 node scripts/post-catalogue-ops.mjs [--apply]
 * Ops: `create` {body} (409 = already stored, skipped); `replace` {outcome, dynastyPrefix, from, to, skipIfIncludes}
 * (UPGRADE of every active dynasty of that prefix whose code holds `from` exactly once); `tag` {outcome, dynastyPrefix,
 * tactics} (UPGRADE with the same code and the tactics merged in; skipped when already carried).
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

async function activeOf(outcome, prefix) {
  const r = await call("GET", `/scripts?outcome=${encodeURIComponent(outcome)}`);
  if (r.status !== 200) throw new Error(`list ${outcome}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  const list = Array.isArray(r.json) ? r.json : r.json.scripts ?? r.json.items ?? [];
  return list.filter((s) => s.outcome === outcome && String(s.dynasty).startsWith(prefix) && s.status === "active" && s.dynastyStatus !== "deprecated");
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
    if (r.status !== 201 && r.status !== 409) failed++;
    continue;
  }
  for (const s of await activeOf(op.outcome, op.dynastyPrefix)) {
    const full = await call("GET", `/scripts/${s.id}`);
    if (full.status !== 200) throw new Error(`read ${s.dynasty}: ${full.status}`);
    const code = full.json.code;
    let next;
    if (op.op === "replace") {
      if (code.includes(op.skipIfIncludes)) {
        console.log(`replace ${op.outcome}/${s.dynasty} v${s.version}: already done, skipped`);
        continue;
      }
      const n = code.split(op.from).length - 1;
      if (n !== 1) {
        console.log(`replace ${op.outcome}/${s.dynasty} v${s.version}: anchor found ${n} times, NOT upgraded`);
        failed++;
        continue;
      }
      next = { code: code.replace(op.from, () => op.to) };
    } else if (op.op === "tag") {
      const tactics = full.json.tactics ?? {};
      if (Object.entries(op.tactics).every(([k, v]) => JSON.stringify(tactics[k]) === JSON.stringify(v))) {
        console.log(`tag ${op.outcome}/${s.dynasty} v${s.version}: already carried, skipped`);
        continue;
      }
      next = { code, tactics: { ...tactics, ...op.tactics } };
    } else throw new Error(`unknown op ${op.op}`);
    if (!apply) {
      console.log(`${op.op} ${op.outcome}/${s.dynasty} v${s.version} -> v${s.version + 1} (dry run)`);
      continue;
    }
    const r = await call("POST", `/scripts/dynasty/${op.outcome}/${s.dynasty}/upgrade`, next);
    console.log(`${op.op} ${op.outcome}/${s.dynasty}: ${r.status} ${r.status === 201 ? `v${r.json.version}` : JSON.stringify(r.json).slice(0, 300)}`);
    if (r.status !== 201) failed++;
  }
}
await fetch(`${runs}/v1/platform-runs/${RUN_ID}`, { method: "PATCH", headers: { "content-type": "application/json", "x-api-key": runsKey }, body: JSON.stringify({ status: failed ? "failed" : "completed" }) });
process.exit(failed ? 1 : 0);
