#!/usr/bin/env node
/**
 * Ops script: the workflows of the AI Instant Call pipes (`src/lib/ai-instant-call-dag.ts`: ring the brand's sales rep
 * about the person a positive reply or a form fill made due, AIC-COMMON-1015).
 *
 * "The workflows of the channel" are the dynasties features-service has ACTIVELY assigned to one of its pipes
 * (`AI_INSTANT_CALL_PIPE_IDS`). A workflow sits on ONE leg (owner 2026-10-19): a pipe running the same steps as
 * another runs its own one-leg copy (`POST /workflows/{id}/fork` with `pipeId`, ONE-LEG-FORKS-1020), never the same
 * dynasty registered twice.
 *
 * Two KINDS, told apart by their DAG (`ringsOnEmailRepliesOnly`): the DEFAULT one (rings on every positive reply and
 * form) and the EMAIL-ONLY copy (INSTANT-CALL-EMAIL-ONLY-1016: rings only on a reply received by email), which lives
 * on the positive-reply pipe only (a form item carries no channel).
 *
 * Idempotent: creates a kind ON the positive-reply pipe when no dynasty of that kind exists (`POST /workflows` with
 * `pipeId` registers it), upgrades each assigned dynasty whose stored DAG is behind its kind's (in its own dynasty,
 * keeping a copy's `forkedForPipe`), skips a current one, and names any pipe no workflow serves.
 * Usage, from inside the workflow-service container:
 *   node seed-ai-instant-call-workflow.mjs            # dry run
 *   node seed-ai-instant-call-workflow.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY, FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY (all in the container), BASE_URL
 * (default localhost:8080), ORG_ID, USER_ID, RUN_ID (a REAL staff run: runs-service rejects an unknown parent run).
 */
import {
  AI_INSTANT_CALL_DESCRIPTION,
  AI_INSTANT_CALL_FEATURE_SLUG,
  AI_INSTANT_CALL_PIPE_ID,
  AI_INSTANT_CALL_PIPE_IDS,
  EMAIL_REPLIES_ONLY_DESCRIPTION,
  buildAiInstantCallDag,
  ringsOnEmailRepliesOnly,
} from "../dist/lib/ai-instant-call-dag.js";

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
const KINDS = [
  { name: "default", emailOnly: false, dag: buildAiInstantCallDag(), description: AI_INSTANT_CALL_DESCRIPTION },
  {
    name: "email-only",
    emailOnly: true,
    dag: buildAiInstantCallDag({ emailRepliesOnly: true }),
    description: EMAIL_REPLIES_ONLY_DESCRIPTION,
  },
];

const assigned = await call(FEATURES_URL, FEATURES_KEY, "GET", `/internal/workflow-leg-assignments?featureSlug=${encodeURIComponent(slug)}`);
if (assigned.status !== 200) throw new Error(`assignments ${slug}: ${assigned.status} ${JSON.stringify(assigned.payload)}`);
const active = assigned.payload.assignments.filter((a) => a.state === "active" && AI_INSTANT_CALL_PIPE_IDS.includes(`${slug}|${a.legKey}`));
const dynasties = [...new Set(active.map((a) => a.workflowDynastySlug))];

const existing = await call(BASE_URL, API_KEY, "GET", `/workflows?featureSlug=${encodeURIComponent(slug)}&status=active`);
if (existing.status !== 200) throw new Error(`list ${slug}: ${existing.status} ${JSON.stringify(existing.payload)}`);
const rows = (Array.isArray(existing.payload) ? existing.payload : (existing.payload.workflows ?? [])).filter((r) =>
  dynasties.includes(r.workflowDynastySlug),
);
for (const d of dynasties) {
  if (!rows.some((r) => r.workflowDynastySlug === d)) throw new Error(`${d} is assigned to an AI Instant Call pipe but has no active version here`);
}

for (const kind of KINDS) {
  const mine = rows.filter((r) => ringsOnEmailRepliesOnly(r.dag) === kind.emailOnly);
  for (const w of mine) {
    const target = keepForkMark(kind.dag, w.dag);
    // Key-sorted: the stored DAG is jsonb, which reorders keys, so a raw stringify never matches.
    if (computeDAGSignature(w.dag) === computeDAGSignature(target) && w.description === kind.description) {
      console.log(`${slug}: ${kind.name} ${w.workflowSlug} is current (skipped)`);
    } else if (!APPLY) {
      console.log(`${slug}: WOULD upgrade ${kind.name} ${w.workflowDynastySlug} (stored DAG is behind the current one)`);
    } else {
      const up = await call(BASE_URL, API_KEY, "POST", "/workflows/upgrade", { workflowDynastySlug: w.workflowDynastySlug, dag: target, description: kind.description });
      if (up.status !== 200 && up.status !== 201) throw new Error(`upgrade ${w.workflowDynastySlug}: ${up.status} ${JSON.stringify(up.payload)}`);
      console.log(`${slug}: upgraded ${kind.name} ${w.workflowDynastySlug} -> ${(up.payload.workflow ?? up.payload).workflowSlug} (${up.status})`);
    }
  }
  if (mine.length > 0) continue;
  const body = { featureSlug: slug, pipeId: AI_INSTANT_CALL_PIPE_ID, description: kind.description, dag: kind.dag };
  if (!APPLY) {
    console.log(`${AI_INSTANT_CALL_PIPE_ID}: WOULD create the ${kind.name} one`);
    continue;
  }
  const created = await call(BASE_URL, API_KEY, "POST", "/workflows", body);
  if (created.status !== 201) throw new Error(`create ${kind.name}: ${created.status} ${JSON.stringify(created.payload)}`);
  console.log(`${AI_INSTANT_CALL_PIPE_ID}: created ${kind.name} ${created.payload.workflowSlug} (dynasty ${created.payload.workflowDynastySlug})`);
}

for (const pipeId of AI_INSTANT_CALL_PIPE_IDS) {
  const serving = active.filter((a) => `${slug}|${a.legKey}` === pipeId).map((a) => a.workflowDynastySlug);
  if (serving.length === 0) console.log(`${slug}: NO workflow on ${pipeId}: fork one onto it (POST /workflows/{id}/fork {pipeId})`);
  else console.log(`${slug}: ${pipeId} runs ${serving.join(", ")}`);
}
