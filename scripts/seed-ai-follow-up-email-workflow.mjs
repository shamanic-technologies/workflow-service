#!/usr/bin/env node
/**
 * Ops script: the workflow of the AI Follow-up Email pipe (`src/lib/ai-follow-up-email-dag.ts`, 2026-10-11),
 * created ON its pipe (`pipeId`), so `POST /workflows` registers it through features-service's register route,
 * active at once.
 *
 * Idempotent: creates when the channel has no active workflow, upgrades an active one whose stored DAG is behind
 * the current one, and skips a current one.
 * Usage, from inside the workflow-service container:
 *   node seed-ai-follow-up-email-workflow.mjs            # dry run
 *   node seed-ai-follow-up-email-workflow.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080), ORG_ID, USER_ID, RUN_ID (a REAL
 * staff run: runs-service rejects an unknown parent run).
 */
import {
  AI_FOLLOW_UP_EMAIL_DESCRIPTION,
  AI_FOLLOW_UP_EMAIL_FEATURE_SLUG,
  AI_FOLLOW_UP_EMAIL_PIPE_ID,
  buildAiFollowUpEmailDag,
} from "../dist/lib/ai-follow-up-email-dag.js";

import { computeDAGSignature } from "../dist/lib/dag-signature.js";

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

const slug = AI_FOLLOW_UP_EMAIL_FEATURE_SLUG;
const existing = await call("GET", `/workflows?featureSlug=${encodeURIComponent(slug)}&status=active`);
if (existing.status !== 200) throw new Error(`list ${slug}: ${existing.status} ${JSON.stringify(existing.payload)}`);
const rows = Array.isArray(existing.payload) ? existing.payload : (existing.payload.workflows ?? []);
const current = buildAiFollowUpEmailDag();
if (rows.length > 0) {
  // A stored DAG behind the current one is upgraded in its own dynasty (same slug lineage, new version).
  for (const w of rows) {
    // Key-sorted: the stored DAG is jsonb, which reorders keys, so a raw stringify never matches.
  if (computeDAGSignature(w.dag) === computeDAGSignature(current)) {
      console.log(`${slug}: ${w.workflowSlug} is current (skipped)`);
      continue;
    }
    if (!APPLY) {
      console.log(`${slug}: WOULD upgrade ${w.workflowDynastySlug} (stored DAG is behind the current one)`);
      continue;
    }
    const up = await call("POST", "/workflows/upgrade", { workflowDynastySlug: w.workflowDynastySlug, dag: current });
    if (up.status !== 200 && up.status !== 201) throw new Error(`upgrade ${w.workflowDynastySlug}: ${up.status} ${JSON.stringify(up.payload)}`);
    console.log(`${slug}: upgraded ${w.workflowDynastySlug} -> ${up.payload.workflowSlug} (${up.status})`);
  }
} else {
  const body = { featureSlug: slug, pipeId: AI_FOLLOW_UP_EMAIL_PIPE_ID, description: AI_FOLLOW_UP_EMAIL_DESCRIPTION, dag: current };
  if (!APPLY) {
    console.log(`${slug}: WOULD create on pipe ${body.pipeId}`);
  } else {
    const created = await call("POST", "/workflows", body);
    if (created.status !== 201) throw new Error(`create ${slug}: ${created.status} ${JSON.stringify(created.payload)}`);
    console.log(`${slug}: created ${created.payload.workflowSlug} on ${body.pipeId}`);
  }
}
