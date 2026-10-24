#!/usr/bin/env node
/**
 * Ops script: the CLIENT CHECK-IN workflow (`src/lib/client-check-in-dag.ts`, CLIENT-CHECKIN-ON-LEAD-EVENT-1024), its
 * own dynasty on the follow-up channel's `start_to_paid_client` pipe (Lead event heads it). Created ON its pipe
 * (`POST /workflows` with `pipeId` registers it in features-service, active at once).
 *
 * "Its" dynasty = the active one whose stored DAG states the current clients claim policy AND that features-service
 * has actively assigned to the pipe (never told apart by its description).
 * Idempotent: creates when none, upgrades one whose stored DAG is behind the current one (in its own dynasty),
 * skips a current one.
 * Usage, from inside the workflow-service container:
 *   node seed-client-check-in-workflow.mjs            # dry run
 *   node seed-client-check-in-workflow.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY, FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY (all in the container), BASE_URL
 * (default localhost:8080), ORG_ID, USER_ID, RUN_ID (a REAL staff run: runs-service rejects an unknown parent run).
 */
import {
  CLIENT_CHECK_IN_DESCRIPTION,
  CLIENT_CHECK_IN_LEG_KEY,
  CLIENT_CHECK_IN_PIPE_ID,
  buildClientCheckInDag,
  isClientCheckInDag,
} from "../dist/lib/client-check-in-dag.js";
import { FOLLOW_UP_FEATURE_SLUG } from "../dist/lib/follow-up-dag.js";
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
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, "x-api-key": key }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: res.status, payload };
}

const slug = FOLLOW_UP_FEATURE_SLUG;
const current = buildClientCheckInDag();

const assigned = await call(FEATURES_URL, FEATURES_KEY, "GET", `/internal/workflow-leg-assignments?featureSlug=${encodeURIComponent(slug)}`);
if (assigned.status !== 200) throw new Error(`assignments ${slug}: ${assigned.status} ${JSON.stringify(assigned.payload)}`);
const onPipe = new Set(assigned.payload.assignments.filter((a) => a.legKey === CLIENT_CHECK_IN_LEG_KEY && a.state === "active").map((a) => a.workflowDynastySlug));
const existing = await call(BASE_URL, API_KEY, "GET", `/workflows?featureSlug=${encodeURIComponent(slug)}&status=active`);
if (existing.status !== 200) throw new Error(`list ${slug}: ${existing.status} ${JSON.stringify(existing.payload)}`);
const rows = Array.isArray(existing.payload) ? existing.payload : (existing.payload.workflows ?? []);
const mine = rows.filter((r) => onPipe.has(r.workflowDynastySlug) && isClientCheckInDag(r.dag));
if (mine.length > 1) throw new Error(`${CLIENT_CHECK_IN_PIPE_ID}: ${mine.length} client check-in dynasties (${mine.map((r) => r.workflowDynastySlug).join(", ")}); resolve by hand`);

if (mine.length === 1) {
  const w = mine[0];
  if (computeDAGSignature(w.dag) === computeDAGSignature(current)) {
    console.log(`${CLIENT_CHECK_IN_PIPE_ID}: ${w.workflowSlug} is current (skipped)`);
  } else if (!APPLY) {
    console.log(`${CLIENT_CHECK_IN_PIPE_ID}: WOULD upgrade ${w.workflowDynastySlug} (stored DAG is behind the current one)`);
  } else {
    const up = await call(BASE_URL, API_KEY, "POST", "/workflows/upgrade", { workflowDynastySlug: w.workflowDynastySlug, dag: current, description: CLIENT_CHECK_IN_DESCRIPTION });
    if (up.status !== 200 && up.status !== 201) throw new Error(`upgrade ${w.workflowDynastySlug}: ${up.status} ${JSON.stringify(up.payload)}`);
    console.log(`${CLIENT_CHECK_IN_PIPE_ID}: upgraded ${w.workflowDynastySlug} -> ${(up.payload.workflow ?? up.payload).workflowSlug} (${up.status})`);
  }
} else {
  const body = { featureSlug: slug, pipeId: CLIENT_CHECK_IN_PIPE_ID, description: CLIENT_CHECK_IN_DESCRIPTION, dag: current };
  if (!APPLY) {
    console.log(`${CLIENT_CHECK_IN_PIPE_ID}: WOULD create`);
  } else {
    const created = await call(BASE_URL, API_KEY, "POST", "/workflows", body);
    if (created.status !== 201) throw new Error(`create: ${created.status} ${JSON.stringify(created.payload)}`);
    console.log(`${CLIENT_CHECK_IN_PIPE_ID}: created ${created.payload.workflowSlug} (dynasty ${created.payload.workflowDynastySlug})`);
  }
}
