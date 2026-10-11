#!/usr/bin/env node
/**
 * Ops script: one workflow per SOURCING pipe (`src/lib/sourcing-dag.ts`, owner 2026-10-11), each created ON its
 * pipe (`pipeId`), so `POST /workflows` registers it through features-service's register route, active at once.
 *
 * Idempotent: a channel that already has an active workflow is skipped (a duplicate DAG signature would 409).
 * Usage, from inside the workflow-service container:
 *   node seed-sourcing-workflows.mjs            # dry run
 *   node seed-sourcing-workflows.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080), ORG_ID, USER_ID, RUN_ID (a REAL
 * staff run: runs-service rejects an unknown parent run).
 */
import { SOURCING_CHANNEL_SLUGS, SOURCING_DESCRIPTION, buildSourcingDag, sourcingPipeIdOf } from "../dist/lib/sourcing-dag.js";

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

for (const slug of SOURCING_CHANNEL_SLUGS) {
  const existing = await call("GET", `/workflows?featureSlug=${encodeURIComponent(slug)}&status=active`);
  if (existing.status !== 200) throw new Error(`list ${slug}: ${existing.status} ${JSON.stringify(existing.payload)}`);
  const rows = Array.isArray(existing.payload) ? existing.payload : (existing.payload.workflows ?? []);
  if (rows.length > 0) {
    console.log(`${slug}: already has ${rows.map((w) => w.workflowSlug ?? w.slug).join(", ")} (skipped)`);
    continue;
  }
  const body = { featureSlug: slug, pipeId: sourcingPipeIdOf(slug), description: SOURCING_DESCRIPTION, dag: buildSourcingDag() };
  if (!APPLY) {
    console.log(`${slug}: WOULD create on pipe ${body.pipeId}`);
    continue;
  }
  const created = await call("POST", "/workflows", body);
  if (created.status !== 201) throw new Error(`create ${slug}: ${created.status} ${JSON.stringify(created.payload)}`);
  console.log(`${slug}: created ${created.payload.workflowSlug} on ${body.pipeId}`);
}
