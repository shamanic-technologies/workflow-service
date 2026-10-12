#!/usr/bin/env node
/**
 * Ops script: the workflow of the Social post pipe (`src/lib/industry-update-video-dag.ts`, 2026-10-12), the daily
 * industry update video. Created ON its pipe (`social-post|start_to_industry_update_video`): `POST /workflows` with
 * `pipeId` registers it through features-service's register route, active at once, like every workflow.
 *
 * Idempotent: creates when the channel has no active workflow, upgrades an active one whose stored DAG is behind
 * the current one (in its own dynasty, so the dynasty slug a campaign stores resolves forward to it), skips a
 * current one.
 * Usage, from inside the workflow-service container (`docker cp` it to /app/scripts/):
 *   node seed-industry-update-video-workflow.mjs            # dry run
 *   node seed-industry-update-video-workflow.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY (in the container), BASE_URL (default localhost:8080), ORG_ID, USER_ID, RUN_ID (a
 * REAL staff run: runs-service rejects an unknown parent run).
 */
import {
  INDUSTRY_UPDATE_DESCRIPTION,
  INDUSTRY_UPDATE_PIPE_ID,
  SOCIAL_POST_FEATURE_SLUG,
  buildIndustryUpdateVideoDag,
} from "../dist/lib/industry-update-video-dag.js";

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

/** Key-sorted JSON: a stored jsonb DAG comes back with its keys reordered. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const slug = SOCIAL_POST_FEATURE_SLUG;
const current = buildIndustryUpdateVideoDag();

const existing = await call("GET", `/workflows?featureSlug=${encodeURIComponent(slug)}&status=active`);
if (existing.status !== 200) throw new Error(`list ${slug}: ${existing.status} ${JSON.stringify(existing.payload)}`);
const rows = Array.isArray(existing.payload) ? existing.payload : (existing.payload.workflows ?? []);
if (rows.length > 1) throw new Error(`${slug}: ${rows.length} active workflows, expected at most one; resolve by hand`);

if (rows.length === 1) {
  const w = rows[0];
  if (canonical(w.dag) === canonical(current)) {
    console.log(`${slug}: ${w.workflowSlug} is current (skipped)`);
  } else if (!APPLY) {
    console.log(`${slug}: WOULD upgrade ${w.workflowDynastySlug} (${w.workflowSlug}: stored DAG is behind the current one)`);
  } else {
    const up = await call("POST", "/workflows/upgrade", { workflowDynastySlug: w.workflowDynastySlug, dag: current, description: INDUSTRY_UPDATE_DESCRIPTION });
    if (up.status !== 200 && up.status !== 201) throw new Error(`upgrade ${w.workflowDynastySlug}: ${up.status} ${JSON.stringify(up.payload)}`);
    console.log(`${slug}: upgraded ${w.workflowDynastySlug} -> ${up.payload.workflowSlug ?? up.payload.workflow?.workflowSlug} (${up.status})`);
  }
} else {
  const body = { featureSlug: slug, pipeId: INDUSTRY_UPDATE_PIPE_ID, description: INDUSTRY_UPDATE_DESCRIPTION, dag: current };
  if (!APPLY) {
    console.log(`${slug}: WOULD create on pipe ${INDUSTRY_UPDATE_PIPE_ID}`);
  } else {
    const created = await call("POST", "/workflows", body);
    if (created.status !== 201) throw new Error(`create ${slug}: ${created.status} ${JSON.stringify(created.payload)}`);
    console.log(`${slug}: created ${created.payload.workflowSlug} (dynasty ${created.payload.workflowDynastySlug}) on ${INDUSTRY_UPDATE_PIPE_ID}`);
  }
}
