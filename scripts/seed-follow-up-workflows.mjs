#!/usr/bin/env node
/**
 * Ops script: the FOLLOW-UP channel's workflows (`src/lib/follow-up-dag.ts`, MULTICHANNEL-FOLLOWUP-1016). Every
 * dynasty features-service has ACTIVELY assigned to one of the channel's legs is UPGRADED in place (new version, never
 * a fork) to the multichannel DAG of its kind:
 *  - the PROACTIVE leg (`lead_found_to_conversation`): the served DAG (a "Lead follow-up due" source upstream);
 *  - every REACTIVE leg: the claimed DAG. The dynasty carrying the Copilot's instruction follow-ups
 *    (`FIGURES_LEGS`) reads figures; the others do not (two dynasties cannot share one signature).
 * Then the figures dynasty is registered on every leg in `--register <legKey>` (the Lead event leg, once
 * features-service declares it), insert-if-absent.
 *
 * Idempotent: a current DAG is skipped; a stored one behind the current one is upgraded in its own dynasty.
 * Usage, from inside the workflow-service container:
 *   node seed-follow-up-workflows.mjs                                # dry run
 *   node seed-follow-up-workflows.mjs --apply [--register <legKey>]
 * Env: WORKFLOW_SERVICE_API_KEY, FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY (all in the container), BASE_URL
 * (default localhost:8080), ORG_ID, USER_ID, RUN_ID (a REAL staff run: runs-service rejects an unknown parent run).
 */
import {
  FOLLOW_UP_FEATURE_SLUG,
  FOLLOW_UP_PROACTIVE_DESCRIPTION,
  FOLLOW_UP_PROACTIVE_LEG_KEY,
  FOLLOW_UP_REACTIVE_DESCRIPTION,
  FOLLOW_UP_REACTIVE_FIGURES_DESCRIPTION,
  buildFollowUpProactiveDag,
  buildFollowUpReactiveDag,
} from "../dist/lib/follow-up-dag.js";
import { computeDAGSignature } from "../dist/lib/dag-signature.js";
import { keepForkMark } from "../dist/lib/fork-mark.js";
import { isClientCheckInDag } from "../dist/lib/client-check-in-dag.js";

/** The legs whose dynasty serves the Copilot's instruction follow-ups: it reads the figures the instruction asks for. */
const FIGURES_LEGS = ["signup_to_paid_client"];

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const FEATURES_URL = process.env.FEATURES_SERVICE_URL;
const FEATURES_KEY = process.env.FEATURES_SERVICE_API_KEY;
const ORG_ID = process.env.ORG_ID ?? "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const USER_ID = process.env.USER_ID;
const RUN_ID = process.env.RUN_ID;
const APPLY = process.argv.includes("--apply");
const REGISTER = process.argv.flatMap((a, i, all) => (a === "--register" && all[i + 1] ? [all[i + 1]] : []));

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
const assigned = await call(FEATURES_URL, FEATURES_KEY, "GET", `/internal/workflow-leg-assignments?featureSlug=${encodeURIComponent(slug)}`);
if (assigned.status !== 200) throw new Error(`assignments ${slug}: ${assigned.status} ${JSON.stringify(assigned.payload)}`);
const existing = await call(BASE_URL, API_KEY, "GET", `/workflows?featureSlug=${encodeURIComponent(slug)}&status=active`);
if (existing.status !== 200) throw new Error(`list ${slug}: ${existing.status} ${JSON.stringify(existing.payload)}`);
const rows = Array.isArray(existing.payload) ? existing.payload : (existing.payload.workflows ?? []);

// One target per assigned dynasty, from the legs it serves.
const legsOf = new Map();
// A client check-in dynasty (CLIENT-CHECKIN-ON-LEAD-EVENT-1024) shares a leg of this channel but is its own workflow:
// `seed-client-check-in-workflow.mjs` keeps it, never this script.
const clientDynasties = new Set(rows.filter((r) => isClientCheckInDag(r.dag)).map((r) => r.workflowDynastySlug));
for (const a of assigned.payload.assignments.filter((x) => x.state === "active" && !clientDynasties.has(x.workflowDynastySlug))) {
  legsOf.set(a.workflowDynastySlug, [...(legsOf.get(a.workflowDynastySlug) ?? []), a.legKey]);
}
// A one-leg copy (ONE-LEG-FORKS-1020) keeps its `forkedForPipe`: the same steps on another pipe, its own signature.
const storedDagOf = (dynasty) => rows.find((r) => r.workflowDynastySlug === dynasty)?.dag;
const targets = [...legsOf].map(([dynasty, legs]) => {
  if (legs.includes(FOLLOW_UP_PROACTIVE_LEG_KEY)) {
    if (legs.length > 1) throw new Error(`${dynasty} serves the proactive leg AND ${legs.join(", ")}; resolve by hand`);
    return { dynasty, legs, dag: keepForkMark(buildFollowUpProactiveDag(), storedDagOf(dynasty)), description: FOLLOW_UP_PROACTIVE_DESCRIPTION };
  }
  const figures = legs.some((l) => FIGURES_LEGS.includes(l));
  return {
    dynasty,
    legs,
    figures,
    dag: keepForkMark(buildFollowUpReactiveDag({ readFigures: figures }), storedDagOf(dynasty)),
    description: figures ? FOLLOW_UP_REACTIVE_FIGURES_DESCRIPTION : FOLLOW_UP_REACTIVE_DESCRIPTION,
  };
});
// Two dynasties on DIFFERENT legs built to the same steps are not twins: an unmarked one-leg dynasty colliding with
// another states its own pipe (the inert one-leg mark), so each keeps its own signature.
for (const t of targets) {
  const twin = targets.some((o) => o !== t && computeDAGSignature(o.dag) === computeDAGSignature(t.dag));
  if (twin && !t.dag.forkedForPipe && t.legs.length === 1) t.dag = { ...t.dag, forkedForPipe: `${slug}|${t.legs[0]}` };
}
const sigs = targets.map((t) => computeDAGSignature(t.dag));
if (new Set(sigs).size !== sigs.length) throw new Error(`two dynasties would share one DAG: ${targets.map((t) => `${t.dynasty} (${t.legs})`).join("; ")}`);

for (const t of targets) {
  const w = rows.find((r) => r.workflowDynastySlug === t.dynasty);
  if (!w) throw new Error(`${t.dynasty} is assigned to ${t.legs.join(", ")} but has no active version here`);
  if (computeDAGSignature(w.dag) === computeDAGSignature(t.dag)) {
    console.log(`${t.dynasty} (${t.legs.join(", ")}): ${w.workflowSlug} is current (skipped)`);
  } else if (!APPLY) {
    console.log(`${t.dynasty} (${t.legs.join(", ")}): WOULD upgrade ${w.workflowSlug} v${w.version}`);
  } else {
    const up = await call(BASE_URL, API_KEY, "POST", "/workflows/upgrade", { workflowDynastySlug: t.dynasty, dag: t.dag, description: t.description });
    if (up.status !== 200 && up.status !== 201) throw new Error(`upgrade ${t.dynasty}: ${up.status} ${JSON.stringify(up.payload)}`);
    const nw = up.payload.workflow ?? up.payload;
    console.log(`${t.dynasty} (${t.legs.join(", ")}): upgraded ${w.workflowSlug} v${w.version} -> ${nw.workflowSlug} v${nw.version} (${up.status})`);
  }
}

const figuresDynasty = targets.find((t) => t.figures)?.dynasty;
for (const legKey of REGISTER) {
  if (!figuresDynasty) throw new Error("no figures dynasty to register");
  const pipeId = `${slug}|${legKey}`;
  if (!APPLY) {
    console.log(`WOULD register ${figuresDynasty} on ${pipeId}`);
    continue;
  }
  const reg = await call(FEATURES_URL, FEATURES_KEY, "POST", "/internal/workflow-leg-assignments/register", {
    pipeId,
    workflowDynastySlug: figuresDynasty,
    registeredBy: "workflow-service",
    note: "seed-follow-up-workflows (MULTICHANNEL-FOLLOWUP-1016): the reactive follow-up answers every lead event",
  });
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${figuresDynasty} on ${pipeId}: ${reg.status} ${JSON.stringify(reg.payload)}`);
  console.log(`${figuresDynasty} on ${pipeId} (${reg.status === 201 ? "registered" : "already there"})`);
}
