#!/usr/bin/env node
/**
 * Ops script: the workflows of the Cold WhatsApp Outreach pipes (`src/lib/cold-whatsapp-outreach-dag.ts`,
 * 2026-10-12). Every pipe of the channel runs the same steps, each through its OWN workflow: a workflow sits on ONE
 * leg (owner 2026-10-19), so the other pipes run one-leg copies (`POST /workflows/{id}/fork` with `pipeId`,
 * ONE-LEG-FORKS-1020), never the same dynasty registered twice.
 *
 * Idempotent: creates the first workflow ON the first pipe when the channel has none, upgrades every active one whose
 * stored DAG is behind the current one (in its own dynasty, keeping a copy's `forkedForPipe`), skips a current one,
 * and names any pipe of the channel no workflow serves (fork one onto it: never registered here).
 * Usage, from inside the workflow-service container:
 *   node seed-cold-whatsapp-outreach-workflow.mjs            # dry run
 *   node seed-cold-whatsapp-outreach-workflow.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY, FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY (all in the container), BASE_URL
 * (default localhost:8080), ORG_ID, USER_ID, RUN_ID (a REAL staff run: runs-service rejects an unknown parent run).
 */
import {
  COLD_WHATSAPP_OUTREACH_DESCRIPTION,
  COLD_WHATSAPP_OUTREACH_FEATURE_SLUG,
  COLD_WHATSAPP_OUTREACH_LEG_KEYS,
  buildColdWhatsappOutreachDag,
  coldWhatsappPipeIdOf,
} from "../dist/lib/cold-whatsapp-outreach-dag.js";

import { computeDAGSignature } from "../dist/lib/dag-signature.js";
import { keepForkMark } from "../dist/lib/fork-mark.js";

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

const headers = { "content-type": "application/json", "x-api-key": API_KEY, "x-org-id": ORG_ID, "x-user-id": USER_ID, "x-run-id": RUN_ID };

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

const slug = COLD_WHATSAPP_OUTREACH_FEATURE_SLUG;
const pipes = COLD_WHATSAPP_OUTREACH_LEG_KEYS.map(coldWhatsappPipeIdOf);
const current = buildColdWhatsappOutreachDag();

const existing = await call(BASE_URL, API_KEY, "GET", `/workflows?featureSlug=${encodeURIComponent(slug)}&status=active`);
if (existing.status !== 200) throw new Error(`list ${slug}: ${existing.status} ${JSON.stringify(existing.payload)}`);
const rows = Array.isArray(existing.payload) ? existing.payload : (existing.payload.workflows ?? []);

if (rows.length === 0) {
  const body = { featureSlug: slug, pipeId: pipes[0], description: COLD_WHATSAPP_OUTREACH_DESCRIPTION, dag: current };
  if (!APPLY) {
    console.log(`${slug}: WOULD create on pipe ${pipes[0]}`);
  } else {
    const created = await call(BASE_URL, API_KEY, "POST", "/workflows", body);
    if (created.status !== 201) throw new Error(`create ${slug}: ${created.status} ${JSON.stringify(created.payload)}`);
    console.log(`${slug}: created ${created.payload.workflowSlug} on ${pipes[0]}`);
  }
}

for (const w of rows) {
  const target = keepForkMark(current, w.dag);
  // Key-sorted: the stored DAG is jsonb, which reorders keys, so a raw stringify never matches.
  if (computeDAGSignature(w.dag) === computeDAGSignature(target)) {
    console.log(`${slug}: ${w.workflowSlug} is current (skipped)`);
  } else if (!APPLY) {
    console.log(`${slug}: WOULD upgrade ${w.workflowDynastySlug} (stored DAG is behind the current one)`);
  } else {
    const up = await call(BASE_URL, API_KEY, "POST", "/workflows/upgrade", {
      workflowDynastySlug: w.workflowDynastySlug,
      dag: target,
      // The judged description must say what the DAG does (WA-FOLLOWUP-LOOP-1015: follow-ups until they answer).
      description: COLD_WHATSAPP_OUTREACH_DESCRIPTION,
    });
    if (up.status !== 200 && up.status !== 201) throw new Error(`upgrade ${w.workflowDynastySlug}: ${up.status} ${JSON.stringify(up.payload)}`);
    console.log(`${slug}: upgraded ${w.workflowDynastySlug} -> ${(up.payload.workflow ?? up.payload).workflowSlug} (${up.status})`);
  }
}

const assigned = await call(FEATURES_URL, FEATURES_KEY, "GET", `/internal/workflow-leg-assignments?featureSlug=${encodeURIComponent(slug)}`);
if (assigned.status !== 200) throw new Error(`assignments ${slug}: ${assigned.status} ${JSON.stringify(assigned.payload)}`);
for (const pipeId of pipes) {
  const serving = assigned.payload.assignments.filter((a) => `${slug}|${a.legKey}` === pipeId && a.state === "active");
  if (serving.length === 0) console.log(`${slug}: NO workflow on ${pipeId}: fork one onto it (POST /workflows/{id}/fork {pipeId})`);
  else console.log(`${slug}: ${pipeId} runs ${serving.map((a) => a.workflowDynastySlug).join(", ")}`);
}
