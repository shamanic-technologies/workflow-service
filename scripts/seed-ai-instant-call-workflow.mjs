#!/usr/bin/env node
/**
 * Ops script: the workflow of the AI Instant Call pipe (`src/lib/ai-instant-call-dag.ts`, owner 2026-10-11),
 * created ON its pipe (`pipeId`), so `POST /workflows` registers it through features-service's register route,
 * active at once.
 *
 * Idempotent: skipped when the channel already has an active workflow (a duplicate DAG signature would 409).
 * Usage, from inside the workflow-service container:
 *   node seed-ai-instant-call-workflow.mjs            # dry run
 *   node seed-ai-instant-call-workflow.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080), ORG_ID, USER_ID, RUN_ID (a REAL
 * staff run: runs-service rejects an unknown parent run).
 */
import {
  AI_INSTANT_CALL_DESCRIPTION,
  AI_INSTANT_CALL_FEATURE_SLUG,
  AI_INSTANT_CALL_PIPE_ID,
  buildAiInstantCallDag,
} from "../dist/lib/ai-instant-call-dag.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const ORG_ID = process.env.ORG_ID ?? "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const USER_ID = process.env.USER_ID;
const RUN_ID = process.env.RUN_ID;
const APPLY = process.argv.includes("--apply");

if (!API_KEY || !USER_ID || !RUN_ID) {
  console.error("WORKFLOW_SERVICE_API_KEY, USER_ID and RUN_ID are required");
  process.exit(1);
}

const headers = { "content-type": "application/json", "x-api-key": API_KEY, "x-org-id": ORG_ID, "x-user-id": USER_ID, "x-run-id": RUN_ID };

async function call(method, path, body) {
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

const slug = AI_INSTANT_CALL_FEATURE_SLUG;
const existing = await call("GET", `/workflows?featureSlug=${encodeURIComponent(slug)}&status=active`);
if (existing.status !== 200) throw new Error(`list ${slug}: ${existing.status} ${JSON.stringify(existing.payload)}`);
const rows = Array.isArray(existing.payload) ? existing.payload : (existing.payload.workflows ?? []);
if (rows.length > 0) {
  console.log(`${slug}: already has ${rows.map((w) => w.workflowSlug ?? w.slug).join(", ")} (skipped)`);
} else {
  const body = { featureSlug: slug, pipeId: AI_INSTANT_CALL_PIPE_ID, description: AI_INSTANT_CALL_DESCRIPTION, dag: buildAiInstantCallDag() };
  if (!APPLY) {
    console.log(`${slug}: WOULD create on pipe ${body.pipeId}`);
  } else {
    const created = await call("POST", "/workflows", body);
    if (created.status !== 201) throw new Error(`create ${slug}: ${created.status} ${JSON.stringify(created.payload)}`);
    console.log(`${slug}: created ${created.payload.workflowSlug} on ${body.pipeId}`);
  }
}
