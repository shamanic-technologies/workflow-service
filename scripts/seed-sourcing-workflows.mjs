#!/usr/bin/env node
/**
 * Ops script: one workflow per SOURCING pipe (`src/lib/sourcing-dag.ts`, owner 2026-10-11), each created ON its
 * pipe (`pipeId`), so `POST /workflows` registers it through features-service's register route, active at once.
 *
 * Idempotent: creates when a channel has no active workflow; upgrades an active one whose stored DAG is behind
 * `buildSourcingDag()` in its OWN dynasty (a copy, e.g. a reachableBy or catch-all fork, is compared against the
 * current DAG plus the serve body IT states, `sourcingTargetOf`, so the seed never flattens a copy back) (`POST /workflows/upgrade`: new version, predecessor deprecated, the
 * dynasty slug units store resolves forward to it); a current one is skipped.
 * A channel in BUSINESS_ONLY_SOURCING_CHANNELS also gets its "business contacts only" dynasty (RELATIONSHIP-TAGS-1014):
 * a FORK of the generic one (`POST /workflows/dynasty/{slug}/fork`, the serve asks `relationships: "business_only"`),
 * so the generic dynasty stays the default play and features-service judges the tactic on the fork.
 * Usage, from inside the workflow-service container:
 *   node seed-sourcing-workflows.mjs            # dry run
 *   node seed-sourcing-workflows.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080), ORG_ID, USER_ID, RUN_ID (a REAL
 * staff run: runs-service rejects an unknown parent run).
 */
import {
  BUSINESS_ONLY_CHANGES,
  BUSINESS_ONLY_SOURCING_CHANNELS,
  BUSINESS_ONLY_SOURCING_DESCRIPTION,
  SOURCING_CHANNEL_SLUGS,
  SOURCING_DESCRIPTION,
  buildSourcingDag,
  servesBusinessOnly,
  sourcingPipeIdOf,
  sourcingTargetOf,
} from "../dist/lib/sourcing-dag.js";

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
      // A copy (reachableBy, catch-all) keeps the serve body it states and its own description.
      const { dag: target, stated } = sourcingTargetOf(w.dag, current);
      const description = stated ? w.description : SOURCING_DESCRIPTION;
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
    if (BUSINESS_ONLY_SOURCING_CHANNELS.includes(slug) && !rows.some((w) => servesBusinessOnly(w.dag))) {
      // Forked from the GENERIC row (its serve states no body), never from another copy.
      const source = rows.find((w) => !sourcingTargetOf(w.dag, current).stated);
      if (!source) throw new Error(`${slug}: no generic workflow to fork the business-only one from`);
      if (!APPLY) {
        console.log(`${slug}: WOULD fork ${source.workflowDynastySlug} into a business-only dynasty`);
        continue;
      }
      const fork = await call("POST", `/workflows/dynasty/${encodeURIComponent(source.workflowDynastySlug)}/fork`, {
        changes: BUSINESS_ONLY_CHANGES,
        description: BUSINESS_ONLY_SOURCING_DESCRIPTION,
      });
      if (fork.status !== 201) throw new Error(`fork ${source.workflowDynastySlug}: ${fork.status} ${JSON.stringify(fork.payload)}`);
      console.log(`${slug}: forked ${source.workflowDynastySlug} -> business-only dynasty ${fork.payload.workflow?.workflowDynastySlug}`);
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
