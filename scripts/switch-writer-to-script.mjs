#!/usr/bin/env node
/**
 * Ops script (FACTORY-P3 fleet writer switch, owner 2026-10-29 « 3.B »: the WHOLE fleet, no per-brand canary).
 *
 * For every ACTIVE workflow whose DAG calls content-generation's writer (`POST /generate`, exactly one call): UPGRADE
 * its dynasty (`POST /workflows/upgrade` with the DAG from `withScriptWriter`: same dynasty, next version, same
 * description, never a fork), under the row's OWN org, paced under `createRateLimit` (10/min/org), then record the
 * switch (`POST /internal/scripts/switches`) so the roll-back guard knows the version to re-activate. Idempotent: a
 * switched dynasty is skipped. Prints each dynasty old -> new version.
 *
 * Usage, from inside the workflow-service container (reads ../dist):
 *   node switch-writer-to-script.mjs            # dry run
 *   node switch-writer-to-script.mjs --apply [--only <dynasty-slug>[,<dynasty-slug>]]
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080), USER_ID + RUN_ID (a REAL staff run).
 */
import { switchableToScript, withScriptWriter } from "../dist/lib/scripts/script-writer-switch.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const USER_ID = process.env.USER_ID;
const RUN_ID = process.env.RUN_ID;
const APPLY = process.argv.includes("--apply");
const onlyArg = process.argv.indexOf("--only");
const ONLY = onlyArg > -1 ? new Set(process.argv[onlyArg + 1].split(",")) : null;
const PACE_MS = 6500;

if (!API_KEY || !USER_ID || !RUN_ID) {
  console.error("WORKFLOW_SERVICE_API_KEY, USER_ID and RUN_ID are required");
  process.exit(1);
}

async function call(method, path, orgId, body) {
  const headers = { "content-type": "application/json", "x-api-key": API_KEY, "x-user-id": USER_ID, "x-run-id": RUN_ID };
  if (orgId) headers["x-org-id"] = orgId;
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: res.status, payload };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STAFF_ORG = process.env.ORG_ID ?? "f0420eb5-8f72-4f0a-a150-f473746df1e6";
console.log(APPLY ? "=== APPLY ===" : "=== DRY RUN (no writes) ===");

// The runnable set across every org and channel (status=active = version AND dynasty active).
const listed = await call("GET", "/workflows?status=active", STAFF_ORG);
if (listed.status !== 200) throw new Error(`list: ${listed.status} ${JSON.stringify(listed.payload).slice(0, 300)}`);
const rows = Array.isArray(listed.payload) ? listed.payload : (listed.payload.workflows ?? []);
const done = [];
let failures = 0;
for (const w of rows) {
  if (!w.dag || !switchableToScript(w.dag)) continue;
  if (ONLY && !ONLY.has(w.workflowDynastySlug)) continue;
  const dag = withScriptWriter(w.dag);
  if (!APPLY) {
    console.log(`WOULD upgrade ${w.workflowDynastySlug} v${w.version} (${w.featureSlug}, org ${w.orgId})`);
    continue;
  }
  const up = await call("POST", "/workflows/upgrade", w.orgId, { workflowDynastySlug: w.workflowDynastySlug, dag });
  if (up.status !== 201) {
    failures++;
    console.error(`FAILED ${w.workflowDynastySlug}: ${up.status} ${JSON.stringify(up.payload).slice(0, 500)}`);
    await sleep(PACE_MS);
    continue;
  }
  const nw = up.payload.workflow;
  const sw = await call("POST", "/internal/scripts/switches", null, { toWorkflowId: nw.id });
  if (sw.status !== 201) {
    failures++;
    console.error(`UPGRADED but NOT RECORDED ${w.workflowDynastySlug} v${nw.version}: ${sw.status} ${JSON.stringify(sw.payload).slice(0, 300)}`);
  } else {
    done.push(`${w.workflowDynastySlug}: v${w.version} -> v${nw.version}`);
    console.log(`SWITCHED ${w.workflowDynastySlug}: v${w.version} -> v${nw.version}`);
  }
  await sleep(PACE_MS);
}
console.log(`\n${done.length} switched, ${failures} failed`);
for (const d of done) console.log(`  ${d}`);
process.exit(failures > 0 ? 1 : 0);
