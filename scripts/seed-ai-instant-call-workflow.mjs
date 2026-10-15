#!/usr/bin/env node
/**
 * Ops script: the workflow of the `ai-instant-call|conversation_to_booking_call` pipe (`src/lib/ai-instant-call-dag.ts`:
 * ring the brand's sales rep about the person a positive reply or a form fill made due, AIC-COMMON-1015), created ON
 * its pipe (`POST /workflows` with `pipeId` registers it in features-service, active at once).
 *
 * "The workflow of this pipe" is the dynasty features-service has ACTIVELY assigned to this leg.
 *
 * Idempotent: creates when no dynasty is assigned to the pipe, upgrades the assigned one whose stored DAG is behind
 * the current one (in its own dynasty), skips a current one.
 * Usage, from inside the workflow-service container:
 *   node seed-ai-instant-call-workflow.mjs            # dry run
 *   node seed-ai-instant-call-workflow.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY, FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY (all in the container), BASE_URL
 * (default localhost:8080), ORG_ID, USER_ID, RUN_ID (a REAL staff run: runs-service rejects an unknown parent run).
 */
import {
  AI_INSTANT_CALL_DESCRIPTION,
  AI_INSTANT_CALL_FEATURE_SLUG,
  AI_INSTANT_CALL_LEG_KEY,
  AI_INSTANT_CALL_PIPE_ID,
  buildAiInstantCallDag,
} from "../dist/lib/ai-instant-call-dag.js";

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

const slug = AI_INSTANT_CALL_FEATURE_SLUG;
const current = buildAiInstantCallDag();

const assigned = await call(FEATURES_URL, FEATURES_KEY, "GET", `/internal/workflow-leg-assignments?featureSlug=${encodeURIComponent(slug)}`);
if (assigned.status !== 200) throw new Error(`assignments ${slug}: ${assigned.status} ${JSON.stringify(assigned.payload)}`);
const dynasties = [
  ...new Set(
    assigned.payload.assignments
      .filter((a) => a.legKey === AI_INSTANT_CALL_LEG_KEY && a.state === "active")
      .map((a) => a.workflowDynastySlug),
  ),
];
if (dynasties.length > 1) throw new Error(`${AI_INSTANT_CALL_PIPE_ID}: ${dynasties.length} active dynasties (${dynasties.join(", ")}); resolve by hand`);

if (dynasties.length === 1) {
  const existing = await call(BASE_URL, API_KEY, "GET", `/workflows?featureSlug=${encodeURIComponent(slug)}&status=active`);
  if (existing.status !== 200) throw new Error(`list ${slug}: ${existing.status} ${JSON.stringify(existing.payload)}`);
  const rows = Array.isArray(existing.payload) ? existing.payload : (existing.payload.workflows ?? []);
  const w = rows.find((r) => r.workflowDynastySlug === dynasties[0]);
  if (!w) throw new Error(`${dynasties[0]} is assigned to ${AI_INSTANT_CALL_PIPE_ID} but has no active version here`);
  // Key-sorted: the stored DAG is jsonb, which reorders keys, so a raw stringify never matches.
  if (computeDAGSignature(w.dag) === computeDAGSignature(current) && w.description === AI_INSTANT_CALL_DESCRIPTION) {
    console.log(`${AI_INSTANT_CALL_PIPE_ID}: ${w.workflowSlug} is current (skipped)`);
  } else if (!APPLY) {
    console.log(`${AI_INSTANT_CALL_PIPE_ID}: WOULD upgrade ${w.workflowDynastySlug} (stored DAG is behind the current one)`);
  } else {
    const up = await call(BASE_URL, API_KEY, "POST", "/workflows/upgrade", { workflowDynastySlug: w.workflowDynastySlug, dag: current, description: AI_INSTANT_CALL_DESCRIPTION });
    if (up.status !== 200 && up.status !== 201) throw new Error(`upgrade ${w.workflowDynastySlug}: ${up.status} ${JSON.stringify(up.payload)}`);
    console.log(`${AI_INSTANT_CALL_PIPE_ID}: upgraded ${w.workflowDynastySlug} -> ${up.payload.workflowSlug} (${up.status})`);
  }
} else {
  const body = { featureSlug: slug, pipeId: AI_INSTANT_CALL_PIPE_ID, description: AI_INSTANT_CALL_DESCRIPTION, dag: current };
  if (!APPLY) {
    console.log(`${AI_INSTANT_CALL_PIPE_ID}: WOULD create`);
  } else {
    const created = await call(BASE_URL, API_KEY, "POST", "/workflows", body);
    if (created.status !== 201) throw new Error(`create: ${created.status} ${JSON.stringify(created.payload)}`);
    console.log(`${AI_INSTANT_CALL_PIPE_ID}: created ${created.payload.workflowSlug} (dynasty ${created.payload.workflowDynastySlug})`);
  }
}
