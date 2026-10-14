#!/usr/bin/env node
/**
 * Ops script: one workflow per SOURCING pipe (`src/lib/sourcing-dag.ts`, owner 2026-10-11), each created ON its
 * pipe (`pipeId`), so `POST /workflows` registers it through features-service's register route, active at once.
 *
 * Idempotent: creates when a channel has no active workflow; upgrades an active one whose stored DAG is behind
 * `buildSourcingDag()` in its OWN dynasty (a copy stating who it finds, `src/lib/reachable-by-copy.ts`, is compared
 * against the current DAG plus ITS `reachableBy`, so the seed never flattens a copy back to the generic one) (`POST /workflows/upgrade`: new version, predecessor deprecated, the
 * dynasty slug units store resolves forward to it); a current one is skipped.
 * Usage, from inside the workflow-service container:
 *   node seed-sourcing-workflows.mjs            # dry run
 *   node seed-sourcing-workflows.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080), ORG_ID, USER_ID, RUN_ID (a REAL
 * staff run: runs-service rejects an unknown parent run).
 */
import { SOURCING_CHANNEL_SLUGS, SOURCING_DESCRIPTION, buildSourcingDag, sourcingPipeIdOf } from "../dist/lib/sourcing-dag.js";
import { isReachableByCopy, reachableByOf, withReachableBy, reachableByDescription } from "../dist/lib/reachable-by-copy.js";

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

const current = buildSourcingDag();

for (const slug of SOURCING_CHANNEL_SLUGS) {
  const existing = await call("GET", `/workflows?featureSlug=${encodeURIComponent(slug)}&status=active`);
  if (existing.status !== 200) throw new Error(`list ${slug}: ${existing.status} ${JSON.stringify(existing.payload)}`);
  const rows = Array.isArray(existing.payload) ? existing.payload : (existing.payload.workflows ?? []);
  if (rows.length > 0) {
    for (const w of rows) {
      const methods = isReachableByCopy(w.description) ? reachableByOf(w.dag) : null;
      if (isReachableByCopy(w.description) && !methods) throw new Error(`${w.workflowSlug}: a reachable-by copy whose DAG states no reachableBy`);
      const target = methods ? withReachableBy(current, methods) : current;
      const description = methods ? reachableByDescription(SOURCING_DESCRIPTION, methods) : SOURCING_DESCRIPTION;
      if (canonical(w.dag) === canonical(target)) {
        console.log(`${slug}: ${w.workflowSlug} is current (skipped)`);
        continue;
      }
      if (!APPLY) {
        console.log(`${slug}: WOULD upgrade ${w.workflowDynastySlug} (${w.workflowSlug}: stored DAG is behind the current one)`);
        continue;
      }
      const up = await call("POST", "/workflows/upgrade", { workflowDynastySlug: w.workflowDynastySlug, dag: target, description });
      if (up.status !== 200 && up.status !== 201) throw new Error(`upgrade ${w.workflowDynastySlug}: ${up.status} ${JSON.stringify(up.payload)}`);
      console.log(`${slug}: upgraded ${w.workflowDynastySlug} -> ${up.payload.workflow?.workflowSlug} v${up.payload.workflow?.version} (${up.status})`);
    }
    continue;
  }
  const body = { featureSlug: slug, pipeId: sourcingPipeIdOf(slug), description: SOURCING_DESCRIPTION, dag: current };
  if (!APPLY) {
    console.log(`${slug}: WOULD create on pipe ${body.pipeId}`);
    continue;
  }
  const created = await call("POST", "/workflows", body);
  if (created.status !== 201) throw new Error(`create ${slug}: ${created.status} ${JSON.stringify(created.payload)}`);
  console.log(`${slug}: created ${created.payload.workflowSlug} on ${body.pipeId}`);
}
