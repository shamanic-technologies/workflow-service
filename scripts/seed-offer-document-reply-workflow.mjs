#!/usr/bin/env node
/**
 * Ops script: the `ai-meeting-booking` conversation responder that attaches the most relevant offer document
 * (`src/lib/offer-document-reply-dag.ts`), created ON the conversation pipe beside the parent responders
 * (`POST /workflows` with `pipeId` registers it in features-service, active at once, so it is selectable on the leg
 * like any other workflow there).
 *
 * "This workflow" is the active dynasty of the feature whose DAG carries the `offer-documents` node, never the
 * channel's other responders (the parent seed, `seed-ai-meeting-booking.mjs`, leaves this one alone for the same
 * reason). Idempotent: creates when none exists, upgrades one whose stored DAG is behind the current one (in its own
 * dynasty, so it follows every later change of the parent DAG), skips a current one.
 *
 * Usage, from inside the workflow-service container:
 *   node seed-offer-document-reply-workflow.mjs            # dry run
 *   node seed-offer-document-reply-workflow.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY, BASE_URL (default localhost:8080), ORG_ID, USER_ID, RUN_ID (a REAL staff run).
 */
import { FEATURE_SLUG } from "../dist/lib/ai-meeting-booking-dag.js";
import { computeDAGSignature } from "../dist/lib/dag-signature.js";
import {
  DESCRIPTION,
  buildOfferDocumentReplyDag,
  isOfferDocumentResponder,
} from "../dist/lib/offer-document-reply-dag.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const ORG_ID = process.env.ORG_ID ?? "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const USER_ID = process.env.USER_ID;
const RUN_ID = process.env.RUN_ID;
const APPLY = process.argv.includes("--apply");

/** The parent's pipe: the reply to a prospect who answered, toward a booked meeting. */
const PIPE_ID = "ai-meeting-booking|conversation_to_meeting_booked";
/** The writer model, the parent's Opus cell (chat-service declares its cost). */
const CELL = { provider: "anthropic", model: "opus", omitTemperature: true };

if (!API_KEY || !USER_ID || !RUN_ID) {
  console.error("WORKFLOW_SERVICE_API_KEY, USER_ID and RUN_ID are required");
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "x-org-id": ORG_ID, "x-user-id": USER_ID, "x-run-id": RUN_ID },
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

const current = buildOfferDocumentReplyDag(CELL);

const existing = await call("GET", `/workflows?featureSlug=${encodeURIComponent(FEATURE_SLUG)}&status=active`);
if (existing.status !== 200) throw new Error(`list ${FEATURE_SLUG}: ${existing.status} ${JSON.stringify(existing.payload)}`);
const rows = (Array.isArray(existing.payload) ? existing.payload : (existing.payload.workflows ?? [])).filter((w) => isOfferDocumentResponder(w.dag));
if (rows.length > 1) throw new Error(`${rows.length} active offer-document responders (${rows.map((w) => w.workflowSlug).join(", ")}); resolve by hand`);

if (rows.length === 1) {
  const w = rows[0];
  if (computeDAGSignature(w.dag) === computeDAGSignature(current)) {
    console.log(`${w.workflowSlug} is current (skipped)`);
  } else if (!APPLY) {
    console.log(`WOULD upgrade ${w.workflowDynastySlug} (stored DAG is behind the current one)`);
  } else {
    const up = await call("POST", "/workflows/upgrade", { workflowDynastySlug: w.workflowDynastySlug, dag: current, description: DESCRIPTION });
    if (up.status !== 200 && up.status !== 201) throw new Error(`upgrade ${w.workflowDynastySlug}: ${up.status} ${JSON.stringify(up.payload)}`);
    console.log(`upgraded ${w.workflowDynastySlug} -> ${up.payload.workflowSlug} (${up.status})`);
  }
} else if (!APPLY) {
  console.log(`WOULD create on ${PIPE_ID}`);
} else {
  const created = await call("POST", "/workflows", {
    featureSlug: FEATURE_SLUG,
    pipeId: PIPE_ID,
    description: DESCRIPTION,
    tags: ["email", "meeting-booking", "reply", "offer-document", CELL.model],
    dag: current,
  });
  if (created.status !== 201) throw new Error(`create: ${created.status} ${JSON.stringify(created.payload)}`);
  console.log(`created ${created.payload.workflowSlug} (dynasty ${created.payload.workflowDynastySlug}) on ${PIPE_ID}`);
}
