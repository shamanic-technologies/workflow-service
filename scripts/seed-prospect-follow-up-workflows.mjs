#!/usr/bin/env node
/**
 * Ops script: the two PROSPECT FOLLOW-UP workflows (`src/lib/prospect-follow-up-dag.ts`, NEVER-NO-FOLLOWUP-1014),
 * each created ON its pipe (`POST /workflows` with `pipeId` registers it in features-service, active at once):
 *  - proactive: the first follow-up to a contacted pure prospect lead-service serves;
 *  - reactive: every next follow-up, fired at the date the previous one stated.
 *
 * "The workflow of a pipe" is the dynasty features-service has ACTIVELY assigned to that leg of the channel.
 *
 * Idempotent: creates when no dynasty is assigned to the pipe, upgrades the assigned one whose stored DAG is behind
 * the current one (in its own dynasty), skips a current one.
 * Usage, from inside the workflow-service container:
 *   node seed-prospect-follow-up-workflows.mjs            # dry run
 *   node seed-prospect-follow-up-workflows.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY, FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY (all in the container), BASE_URL
 * (default localhost:8080), ORG_ID, USER_ID, RUN_ID (a REAL staff run: runs-service rejects an unknown parent run).
 */
import {
  PROSPECT_FOLLOW_UP_FEATURE_SLUG,
  PROSPECT_FOLLOW_UP_PROACTIVE_DESCRIPTION,
  PROSPECT_FOLLOW_UP_PROACTIVE_LEG_KEY,
  PROSPECT_FOLLOW_UP_PROACTIVE_PIPE_ID,
  PROSPECT_FOLLOW_UP_REACTIVE_DESCRIPTION,
  PROSPECT_FOLLOW_UP_REACTIVE_LEG_KEY,
  PROSPECT_FOLLOW_UP_REACTIVE_PIPE_ID,
  buildProspectFollowUpProactiveDag,
  buildProspectFollowUpReactiveDag,
} from "../dist/lib/prospect-follow-up-dag.js";

import { computeDAGSignature } from "../dist/lib/dag-signature.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const FEATURES_URL = process.env.FEATURES_SERVICE_URL;
const FEATURES_KEY = process.env.FEATURES_SERVICE_API_KEY;
const ORG_ID = process.env.ORG_ID ?? "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const USER_ID = process.env.USER_ID;
const RUN_ID = process.env.RUN_ID;
const APPLY = process.argv.includes("--apply");

if (!API_KEY || !FEATURES_URL || !FEATURES_KEY || !USER_ID || !RUN_ID) {
  console.error("WORKFLOW_SERVICE_API_KEY, FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY, USER_ID and RUN_ID are required");
  process.exit(1);
}

const headers = { "content-type": "application/json", "x-org-id": ORG_ID, "x-user-id": USER_ID, "x-run-id": RUN_ID };

async function call(base, key, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, "x-api-key": key },
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

const slug = PROSPECT_FOLLOW_UP_FEATURE_SLUG;
const PIPES = [
  {
    pipeId: PROSPECT_FOLLOW_UP_PROACTIVE_PIPE_ID,
    legKey: PROSPECT_FOLLOW_UP_PROACTIVE_LEG_KEY,
    description: PROSPECT_FOLLOW_UP_PROACTIVE_DESCRIPTION,
    dag: buildProspectFollowUpProactiveDag(),
  },
  {
    pipeId: PROSPECT_FOLLOW_UP_REACTIVE_PIPE_ID,
    legKey: PROSPECT_FOLLOW_UP_REACTIVE_LEG_KEY,
    description: PROSPECT_FOLLOW_UP_REACTIVE_DESCRIPTION,
    dag: buildProspectFollowUpReactiveDag(),
  },
];

const assigned = await call(FEATURES_URL, FEATURES_KEY, "GET", `/internal/workflow-leg-assignments?featureSlug=${encodeURIComponent(slug)}`);
if (assigned.status !== 200) throw new Error(`assignments ${slug}: ${assigned.status} ${JSON.stringify(assigned.payload)}`);
const existing = await call(BASE_URL, API_KEY, "GET", `/workflows?featureSlug=${encodeURIComponent(slug)}&status=active`);
if (existing.status !== 200) throw new Error(`list ${slug}: ${existing.status} ${JSON.stringify(existing.payload)}`);
const rows = Array.isArray(existing.payload) ? existing.payload : (existing.payload.workflows ?? []);

for (const p of PIPES) {
  const dynasties = [
    ...new Set(assigned.payload.assignments.filter((a) => a.legKey === p.legKey && a.state === "active").map((a) => a.workflowDynastySlug)),
  ];
  if (dynasties.length > 1) throw new Error(`${p.pipeId}: ${dynasties.length} active dynasties (${dynasties.join(", ")}); resolve by hand`);
  if (dynasties.length === 1) {
    const w = rows.find((r) => r.workflowDynastySlug === dynasties[0]);
    if (!w) throw new Error(`${dynasties[0]} is assigned to ${p.pipeId} but has no active version here`);
    // Key-sorted: the stored DAG is jsonb, which reorders keys, so a raw stringify never matches.
    if (computeDAGSignature(w.dag) === computeDAGSignature(p.dag)) {
      console.log(`${p.pipeId}: ${w.workflowSlug} is current (skipped)`);
    } else if (!APPLY) {
      console.log(`${p.pipeId}: WOULD upgrade ${w.workflowDynastySlug} (stored DAG is behind the current one)`);
    } else {
      const up = await call(BASE_URL, API_KEY, "POST", "/workflows/upgrade", { workflowDynastySlug: w.workflowDynastySlug, dag: p.dag, description: p.description });
      if (up.status !== 200 && up.status !== 201) throw new Error(`upgrade ${w.workflowDynastySlug}: ${up.status} ${JSON.stringify(up.payload)}`);
      console.log(`${p.pipeId}: upgraded ${w.workflowDynastySlug} -> ${up.payload.workflowSlug} (${up.status})`);
    }
  } else if (!APPLY) {
    console.log(`${p.pipeId}: WOULD create`);
  } else {
    const created = await call(BASE_URL, API_KEY, "POST", "/workflows", { featureSlug: slug, pipeId: p.pipeId, description: p.description, dag: p.dag });
    if (created.status !== 201) throw new Error(`create ${p.pipeId}: ${created.status} ${JSON.stringify(created.payload)}`);
    console.log(`${p.pipeId}: created ${created.payload.workflowSlug} (dynasty ${created.payload.workflowDynastySlug})`);
  }
}
