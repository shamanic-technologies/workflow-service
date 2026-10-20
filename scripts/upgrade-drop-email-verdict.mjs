#!/usr/bin/env node
/**
 * Ops script (DOTTEREL-EMAIL-FILTER-1020, owner 2026-10-20): no Cold Email workflow chooses which email verdicts it
 * accepts; that is the Lead Sourcing pipe's choice (src/lib/email-verdict-preference.ts).
 *
 * For every active workflow of each channel in EMAIL_VERDICT_FEATURE_SLUGS whose lead serve states `acceptedEmails`:
 * UPGRADE its dynasty (`POST /workflows/upgrade`, never a fork) with the key removed + the description cleaned, under
 * the row's OWN org, paced under `createRateLimit` (10/min/org). A 409 means the cleaned DAG is byte-identical to
 * ANOTHER active dynasty (a catch-all copy minus its one change IS its source): it is named, never forced, and the
 * run carries on. Idempotent: a re-run touches only what still states it.
 *
 * Usage, from inside the workflow-service container (after `npm run build`, reads ../dist):
 *   node upgrade-drop-email-verdict.mjs            # dry run
 *   node upgrade-drop-email-verdict.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080), USER_ID + RUN_ID (a REAL staff run).
 */
import {
  EMAIL_VERDICT_FEATURE_SLUGS,
  noEmailVerdictDescription,
  statesEmailVerdict,
  withoutEmailVerdict,
} from "../dist/lib/email-verdict-preference.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const USER_ID = process.env.USER_ID;
const RUN_ID = process.env.RUN_ID;
const APPLY = process.argv.includes("--apply");
const PACE_MS = 6500;

if (!API_KEY || !USER_ID || !RUN_ID) {
  console.error("WORKFLOW_SERVICE_API_KEY, USER_ID and RUN_ID are required");
  process.exit(1);
}

async function call(method, path, orgId, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "x-org-id": orgId, "x-user-id": USER_ID, "x-run-id": RUN_ID },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
const done = [];
const twins = [];
let failures = 0;

for (const slug of EMAIL_VERDICT_FEATURE_SLUGS) {
  const listed = await call("GET", `/workflows?featureSlug=${encodeURIComponent(slug)}&status=active`, STAFF_ORG);
  if (listed.status !== 200) throw new Error(`list ${slug}: ${listed.status} ${JSON.stringify(listed.payload)}`);
  const rows = Array.isArray(listed.payload) ? listed.payload : (listed.payload.workflows ?? []);
  for (const w of rows) {
    if (!statesEmailVerdict(w.dag)) continue;
    const dag = withoutEmailVerdict(w.dag);
    const description = noEmailVerdictDescription(w.description);
    if (!APPLY) {
      console.log(`${slug}: WOULD upgrade ${w.workflowDynastySlug} (${w.workflowSlug} v${w.version}, org ${w.orgId})`);
      continue;
    }
    const up = await call("POST", "/workflows/upgrade", w.orgId, { workflowDynastySlug: w.workflowDynastySlug, dag, description });
    if (up.status === 409 && up.payload?.existingWorkflowSlug) {
      twins.push(`${w.workflowSlug} = ${up.payload.existingWorkflowSlug}`);
      console.log(`${slug}: TWIN ${w.workflowSlug}: without its filter it is ${up.payload.existingWorkflowSlug} (left as is)`);
    } else if (up.status !== 200 && up.status !== 201) {
      failures++;
      console.error(`${slug}: FAILED ${w.workflowDynastySlug}: ${up.status} ${JSON.stringify(up.payload)}`);
    } else {
      const nw = up.payload.workflow ?? up.payload;
      done.push(`${nw.workflowSlug} v${nw.version}`);
      console.log(`${slug}: upgraded ${w.workflowSlug} -> ${nw.workflowSlug} v${nw.version} (${up.status})`);
    }
    await sleep(PACE_MS);
  }
}
console.log(`upgraded ${done.length}, twins ${twins.length}, failed ${failures}`);
for (const t of twins) console.log(`  twin: ${t}`);
if (failures > 0) process.exit(1);
