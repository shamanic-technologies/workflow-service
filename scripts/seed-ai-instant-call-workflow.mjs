#!/usr/bin/env node
/**
 * Ops script: the workflow of the `ai-instant-call|conversation_to_booking_call` pipe (`src/lib/ai-instant-call-dag.ts`:
 * ring the brand's sales rep about the person a positive reply or a form fill made due, AIC-COMMON-1015), created ON
 * its pipe (`POST /workflows` with `pipeId` registers it in features-service, active at once).
 *
 * "The workflow of this pipe" is the dynasty features-service has ACTIVELY assigned to this leg.
 *
 * TWO dynasties live on the pipe, told apart by their DAG (`ringsOnEmailRepliesOnly`): the DEFAULT one (rings on
 * every positive reply and form) and the EMAIL-ONLY copy (INSTANT-CALL-EMAIL-ONLY-1016: rings only on a reply
 * received by email), its own dynasty created ON the positive-reply pipe only (`POST /workflows` with `pipeId`; never
 * a fork, which registers the copy on every pipe its source serves, the form pipe included, whose items carry no
 * channel), so a strategy requiring the tactic selects it and no campaign on the default switches.
 *
 * Idempotent: creates either when absent, upgrades either whose stored DAG is behind the current one (in its own
 * dynasty), skips a current one, then registers the default on every AI Instant Call pipe (`AI_INSTANT_CALL_PIPE_IDS`:
 * the positive-reply leg and the form leg) and the copy on the positive-reply leg only (insert-if-absent).
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
  AI_INSTANT_CALL_PIPE_IDS,
  EMAIL_REPLIES_ONLY_DESCRIPTION,
  buildAiInstantCallDag,
  ringsOnEmailRepliesOnly,
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
const dynasties = [
  ...new Set(
    assigned.payload.assignments
      .filter((a) => a.legKey === AI_INSTANT_CALL_LEG_KEY && a.state === "active")
      .map((a) => a.workflowDynastySlug),
  ),
];

const existing = await call(BASE_URL, API_KEY, "GET", `/workflows?featureSlug=${encodeURIComponent(slug)}&status=active`);
if (existing.status !== 200) throw new Error(`list ${slug}: ${existing.status} ${JSON.stringify(existing.payload)}`);
const rows = (Array.isArray(existing.payload) ? existing.payload : (existing.payload.workflows ?? [])).filter((r) =>
  dynasties.includes(r.workflowDynastySlug),
);
for (const d of dynasties) {
  if (!rows.some((r) => r.workflowDynastySlug === d)) throw new Error(`${d} is assigned to ${AI_INSTANT_CALL_PIPE_ID} but has no active version here`);
}

/** The dynasty slug of each kind once this run is done (null = would be created on --apply). */
const dynastyOf = {};
for (const kind of KINDS) {
  const mine = rows.filter((r) => ringsOnEmailRepliesOnly(r.dag) === kind.emailOnly);
  if (mine.length > 1) throw new Error(`${AI_INSTANT_CALL_PIPE_ID}: ${mine.length} active ${kind.name} dynasties (${mine.map((r) => r.workflowDynastySlug).join(", ")}); resolve by hand`);
  const w = mine[0];
  if (w) {
    dynastyOf[kind.name] = w.workflowDynastySlug;
    // Key-sorted: the stored DAG is jsonb, which reorders keys, so a raw stringify never matches.
    if (computeDAGSignature(w.dag) === computeDAGSignature(kind.dag) && w.description === kind.description) {
      console.log(`${AI_INSTANT_CALL_PIPE_ID}: ${kind.name} ${w.workflowSlug} is current (skipped)`);
    } else if (!APPLY) {
      console.log(`${AI_INSTANT_CALL_PIPE_ID}: WOULD upgrade ${kind.name} ${w.workflowDynastySlug} (stored DAG is behind the current one)`);
    } else {
      const up = await call(BASE_URL, API_KEY, "POST", "/workflows/upgrade", { workflowDynastySlug: w.workflowDynastySlug, dag: kind.dag, description: kind.description });
      if (up.status !== 200 && up.status !== 201) throw new Error(`upgrade ${w.workflowDynastySlug}: ${up.status} ${JSON.stringify(up.payload)}`);
      console.log(`${AI_INSTANT_CALL_PIPE_ID}: upgraded ${kind.name} ${w.workflowDynastySlug} -> ${(up.payload.workflow ?? up.payload).workflowSlug} (${up.status})`);
    }
    continue;
  }
  const body = { featureSlug: slug, pipeId: AI_INSTANT_CALL_PIPE_ID, description: kind.description, dag: kind.dag };
  if (!APPLY) {
    console.log(`${AI_INSTANT_CALL_PIPE_ID}: WOULD create the ${kind.name} one`);
    dynastyOf[kind.name] = null;
    continue;
  }
  const created = await call(BASE_URL, API_KEY, "POST", "/workflows", body);
  if (created.status !== 201) throw new Error(`create ${kind.name}: ${created.status} ${JSON.stringify(created.payload)}`);
  console.log(`${AI_INSTANT_CALL_PIPE_ID}: created ${kind.name} ${created.payload.workflowSlug} (dynasty ${created.payload.workflowDynastySlug})`);
  dynastyOf[kind.name] = created.payload.workflowDynastySlug;
}

for (const kind of KINDS) {
  const dynastySlug = dynastyOf[kind.name];
  // The copy reads the reply channel: a form item carries none, so it never sits on the form pipe.
  for (const pipeId of kind.emailOnly ? [AI_INSTANT_CALL_PIPE_ID] : AI_INSTANT_CALL_PIPE_IDS) {
    if (!APPLY || !dynastySlug) {
      console.log(`${slug}: WOULD register ${kind.name} ${dynastySlug ?? "(new dynasty)"} on ${pipeId}`);
      continue;
    }
    const reg = await call(FEATURES_URL, FEATURES_KEY, "POST", "/internal/workflow-leg-assignments/register", {
      pipeId,
      workflowDynastySlug: dynastySlug,
      registeredBy: "workflow-service",
      note: `seed-ai-instant-call-workflow: the ${kind.name} AI Instant Call workflow`,
    });
    if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${dynastySlug} on ${pipeId}: ${reg.status} ${JSON.stringify(reg.payload)}`);
    console.log(`${slug}: ${kind.name} ${dynastySlug} on ${pipeId} (${reg.status === 201 ? "registered" : "already there"})`);
  }
}
