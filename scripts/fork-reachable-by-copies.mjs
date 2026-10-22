#!/usr/bin/env node
/**
 * Ops script (LEAK-1012, owner 2026-10-14): copies of a sourcing pipe's generic workflow that state WHO they find
 * (`src/lib/reachable-by-copy.ts`). Generic over every sourcing channel; nothing here names one.
 *
 * For each requested `reachableBy` set, forks the channel's generic (non-copy) active workflow through
 * `POST /workflows/dynasty/{slug}/fork` with ONE change: every lead-serving node states `reachableBy`. The fork
 * registers the copy on its source's pipe (features-service, active), the same path the catch-all copies took;
 * features-service judges each copy's tactics in the same second. A copy that already exists (409, same
 * signature) is reused, so a re-run is idempotent. The generic workflow is never written.
 *
 * Usage, inside the workflow-service container (needs `dist`):
 *   node fork-reachable-by-copies.mjs --channel sourcing-crm-contacts --reachable phone --reachable email [--apply]
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080), ORG_ID, USER_ID, RUN_ID (a REAL
 * staff run: runs-service rejects an unknown parent run).
 */
import { reachableByChanges, reachableByDescription, reachableByOf, normalizeMethods } from "../dist/lib/reachable-by-copy.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const ORG_ID = process.env.ORG_ID ?? "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const USER_ID = process.env.USER_ID;
const RUN_ID = process.env.RUN_ID;
const APPLY = process.argv.includes("--apply");

const argValues = (name) => process.argv.flatMap((a, i) => (a === `--${name}` ? [process.argv[i + 1]] : []));
const CHANNEL = argValues("channel")[0];
const SETS = argValues("reachable").map((v) => normalizeMethods(v.split(",")));

if (!API_KEY || !USER_ID || !RUN_ID || !CHANNEL || SETS.length === 0) {
  console.error("WORKFLOW_SERVICE_API_KEY, USER_ID, RUN_ID, --channel <slug> and at least one --reachable <email|phone[,..]> are required");
  process.exit(1);
}

const headers = { "content-type": "application/json", "x-api-key": API_KEY, "x-org-id": ORG_ID, "x-user-id": USER_ID, "x-run-id": RUN_ID };
async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = text; }
  return { status: res.status, payload };
}

const listed = await call("GET", `/workflows?featureSlug=${encodeURIComponent(CHANNEL)}&status=active`);
if (listed.status !== 200) throw new Error(`list ${CHANNEL}: ${listed.status} ${JSON.stringify(listed.payload)}`);
const rows = Array.isArray(listed.payload) ? listed.payload : (listed.payload.workflows ?? []);
// A copy is told apart by what its DAG states, never by its description (descriptions are rewritten for people).
const generic = rows.filter((w) => reachableByOf(w.dag) === null);
if (generic.length !== 1) throw new Error(`${CHANNEL}: expected exactly one generic active workflow, found ${generic.length}`);
const source = (await call("GET", `/workflows/${generic[0].id}`)).payload;
console.log(`${APPLY ? "=== APPLY ===" : "=== DRY RUN ==="} source ${source.workflowSlug} (dynasty ${source.workflowDynastySlug})`);

const out = [];
for (const methods of SETS) {
  const changes = reachableByChanges(source.dag, methods);
  const description = reachableByDescription(source.description, methods);
  const existing = rows.find((w) => reachableByOf(w.dag)?.join(",") === methods.join(","));
  if (existing) {
    console.log(`reachableBy ${methods.join("+")}: already ${existing.workflowSlug} (${existing.id})`);
    out.push({ reachableBy: methods, workflowSlug: existing.workflowSlug, workflowDynastySlug: existing.workflowDynastySlug, id: existing.id });
    continue;
  }
  if (!APPLY) {
    console.log(`reachableBy ${methods.join("+")}: WOULD fork with ${JSON.stringify(changes)}`);
    continue;
  }
  const r = await call("POST", `/workflows/dynasty/${encodeURIComponent(source.workflowDynastySlug)}/fork`, { changes, description });
  let id;
  if (r.status === 201) id = r.payload.workflow.id;
  else if (r.status === 409 && r.payload?.existingWorkflowId) id = r.payload.existingWorkflowId;
  else throw new Error(`fork ${methods.join("+")}: ${r.status} ${JSON.stringify(r.payload)}`);
  const copy = (await call("GET", `/workflows/${id}`)).payload;
  if (reachableByOf(copy.dag)?.join(",") !== methods.join(",")) throw new Error(`copy ${copy.workflowSlug} does not state reachableBy ${methods.join(",")}`);
  console.log(`reachableBy ${methods.join("+")}: ${r.status === 201 ? "created" : "already existed"} ${copy.workflowSlug} (${id})`);
  out.push({ reachableBy: methods, workflowSlug: copy.workflowSlug, workflowDynastySlug: copy.workflowDynastySlug, id });
}
console.log(JSON.stringify(out, null, 2));
