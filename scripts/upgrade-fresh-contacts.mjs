#!/usr/bin/env node
/**
 * Ops script (FRESH-CONTACTS-WF-1015, owner 2026-10-15): every live COLD workflow states tactic "Fresh contacts only"
 * on its lead serve (`excludeEmailedWithin: "3_months"`, src/lib/fresh-contacts.ts).
 *
 * For every active workflow of each channel in FRESH_CONTACTS_FEATURE_SLUGS: a DAG that already states it is skipped,
 * a DAG that is not a cold serve (no lead serve, or a serve stating a `population` of people already contacted) is
 * skipped and named, every other one is UPGRADED in its own dynasty (`POST /workflows/upgrade`, never a fork: owner
 * rule) with that one change + one plain sentence in its description (features-service's Jev judges the tactic on DAG
 * + description). The new row is written under the row's OWN org (`x-org-id`), and the upgrade route is rate limited
 * (10/min/org), so calls are paced. Idempotent: a re-run upgrades only what is still behind.
 *
 * Usage, from inside the workflow-service container (after `npm run build`, reads ../dist):
 *   node upgrade-fresh-contacts.mjs            # dry run
 *   node upgrade-fresh-contacts.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080), USER_ID + RUN_ID (a REAL staff run).
 */
import {
  FRESH_CONTACTS_FEATURE_SLUGS,
  freshContactsApplies,
  freshContactsDescription,
  statesFreshContacts,
  withFreshContacts,
} from "../dist/lib/fresh-contacts.js";

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
let failures = 0;

for (const slug of FRESH_CONTACTS_FEATURE_SLUGS) {
  const listed = await call("GET", `/workflows?featureSlug=${encodeURIComponent(slug)}&status=active`, STAFF_ORG);
  if (listed.status !== 200) throw new Error(`list ${slug}: ${listed.status} ${JSON.stringify(listed.payload)}`);
  const rows = Array.isArray(listed.payload) ? listed.payload : (listed.payload.workflows ?? []);
  for (const w of rows) {
    if (statesFreshContacts(w.dag)) {
      console.log(`${slug}: ${w.workflowSlug} already states it (skipped)`);
      continue;
    }
    if (!freshContactsApplies(w.dag)) {
      console.log(`${slug}: ${w.workflowSlug} is not a cold serve (no lead serve, or it serves a population of people already contacted): left alone`);
      continue;
    }
    const dag = withFreshContacts(w.dag);
    const description = freshContactsDescription(w.description);
    if (!APPLY) {
      console.log(`${slug}: WOULD upgrade ${w.workflowDynastySlug} (${w.workflowSlug} v${w.version}, org ${w.orgId})`);
      continue;
    }
    const up = await call("POST", "/workflows/upgrade", w.orgId, { workflowDynastySlug: w.workflowDynastySlug, dag, description });
    if (up.status !== 200 && up.status !== 201) {
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
console.log(`upgraded ${done.length}, failed ${failures}`);
if (failures > 0) process.exit(1);
