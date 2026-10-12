#!/usr/bin/env node
/**
 * Ops script: the workflow of the Cold WhatsApp Outreach pipes (`src/lib/cold-whatsapp-outreach-dag.ts`,
 * 2026-10-12). ONE workflow serves both pipes of the channel (same DAG, same precedent as
 * `ai-follow-up-email-algenib` on two legs): created ON the first pipe (`POST /workflows` with `pipeId` registers
 * it), then registered on every other pipe through features-service's register route (insert-if-absent).
 *
 * Idempotent: creates when the channel has no active workflow, upgrades an active one whose stored DAG is behind
 * the current one (in its own dynasty), skips a current one, and re-registers every pipe (a no-op when present).
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

let dynastySlug = null;
if (rows.length > 1) throw new Error(`${slug}: ${rows.length} active workflows, expected at most one; resolve by hand`);
if (rows.length === 1) {
  const w = rows[0];
  dynastySlug = w.workflowDynastySlug;
  if (JSON.stringify(w.dag) === JSON.stringify(current)) {
    console.log(`${slug}: ${w.workflowSlug} is current (skipped)`);
  } else if (!APPLY) {
    console.log(`${slug}: WOULD upgrade ${w.workflowDynastySlug} (stored DAG is behind the current one)`);
  } else {
    const up = await call(BASE_URL, API_KEY, "POST", "/workflows/upgrade", { workflowDynastySlug: w.workflowDynastySlug, dag: current });
    if (up.status !== 200 && up.status !== 201) throw new Error(`upgrade ${w.workflowDynastySlug}: ${up.status} ${JSON.stringify(up.payload)}`);
    console.log(`${slug}: upgraded ${w.workflowDynastySlug} -> ${up.payload.workflowSlug} (${up.status})`);
  }
} else {
  const body = { featureSlug: slug, pipeId: pipes[0], description: COLD_WHATSAPP_OUTREACH_DESCRIPTION, dag: current };
  if (!APPLY) {
    console.log(`${slug}: WOULD create on pipe ${pipes[0]}`);
  } else {
    const created = await call(BASE_URL, API_KEY, "POST", "/workflows", body);
    if (created.status !== 201) throw new Error(`create ${slug}: ${created.status} ${JSON.stringify(created.payload)}`);
    dynastySlug = created.payload.workflowDynastySlug;
    console.log(`${slug}: created ${created.payload.workflowSlug} on ${pipes[0]}`);
  }
}

for (const pipeId of pipes) {
  if (!dynastySlug || !APPLY) {
    console.log(`${slug}: WOULD register ${dynastySlug ?? "(new dynasty)"} on ${pipeId}`);
    continue;
  }
  const reg = await call(FEATURES_URL, FEATURES_KEY, "POST", "/internal/workflow-leg-assignments/register", {
    pipeId,
    workflowDynastySlug: dynastySlug,
    registeredBy: "workflow-service",
    note: "seed-cold-whatsapp-outreach-workflow: one workflow serves every pipe of the channel",
  });
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${dynastySlug} on ${pipeId}: ${reg.status} ${JSON.stringify(reg.payload)}`);
  console.log(`${slug}: ${dynastySlug} on ${pipeId} (${reg.status === 201 ? "registered" : "already there"})`);
}
