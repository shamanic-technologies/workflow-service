#!/usr/bin/env node
/**
 * NO-WRITER-FALLBACK-1030 — no live workflow keeps a default writer. A chat writer's `llm-plan` used to write with the
 * LLM its workflow stated whenever features-service ranked no LLM on the leg; it now throws instead
 * (`LLM_PLAN_CODE`, src/lib/leg-best-writer.ts). This UPGRADES (new version, never a fork) every executable dynasty
 * of the given channels whose stored DAG still carries an older `llm-plan`, to its own DAG with the current one and
 * NOTHING else changed (`withCurrentLlmPlan`). The upgrade route inserts the successor and deprecates the predecessor
 * in one transaction, so no dynasty is ever left without a runnable version. Idempotent: a current DAG is skipped.
 *
 * Usage (inside the workflow-service container, after `npm run build`):
 *   node scripts/drop-writer-fallback-1030.mjs [--features a,b] [--apply]
 * Env: WORKFLOW_SERVICE_API_KEY, UPGRADE_USER_ID + UPGRADE_RUN_ID (a REAL staff user and run: never a placeholder
 *      identity), LIST_ORG_ID (our org, for the reads), WORKFLOW_SERVICE_LOCAL_URL
 */
import { pathToFileURL } from "node:url";

export const DEFAULT_FEATURES = ["ai-follow-up-email", "ai-meeting-booking", "threads-post", "cold-whatsapp-outreach", "founder-hello", "ai-instant-call", "ai-lead-proposal", "email-sending", "social-post"];

async function call(base, key, method, path, body, identity) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key, ...(identity ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function run() {
  const { hasStaleLlmPlan, withCurrentLlmPlan } = await import(new URL("../dist/lib/leg-best-writer.js", import.meta.url).href);
  const i = process.argv.indexOf("--features");
  const FEATURES = i === -1 ? DEFAULT_FEATURES : process.argv[i + 1].split(",");
  const APPLY = process.argv.includes("--apply");
  const WS = process.env.WORKFLOW_SERVICE_LOCAL_URL ?? "http://localhost:8080";
  const { WORKFLOW_SERVICE_API_KEY: KEY, UPGRADE_USER_ID, UPGRADE_RUN_ID, LIST_ORG_ID } = process.env;
  if (!KEY || !UPGRADE_USER_ID || !UPGRADE_RUN_ID || !LIST_ORG_ID) throw new Error("WORKFLOW_SERVICE_API_KEY, UPGRADE_USER_ID, UPGRADE_RUN_ID and LIST_ORG_ID are required");
  const identity = (orgId) => ({ "x-org-id": orgId, "x-user-id": UPGRADE_USER_ID, "x-run-id": UPGRADE_RUN_ID });
  const report = { upgraded: [], current: 0, failed: [] };

  for (const featureSlug of FEATURES) {
    const listed = await call(WS, KEY, "GET", `/workflows/summaries?featureSlug=${featureSlug}&status=active`, undefined, identity(LIST_ORG_ID));
    if (listed.status !== 200) throw new Error(`summaries ${featureSlug}: ${listed.status}`);
    for (const summary of listed.body.workflows ?? listed.body) {
      const wf = (await call(WS, KEY, "GET", `/workflows/${summary.id}`, undefined, identity(LIST_ORG_ID))).body;
      if (!hasStaleLlmPlan(wf.dag)) {
        report.current += 1;
        continue;
      }
      if (!APPLY) {
        console.log(`would upgrade ${wf.workflowSlug}`);
        report.upgraded.push(wf.workflowSlug);
        continue;
      }
      const up = await call(WS, KEY, "POST", "/workflows/upgrade", { workflowDynastySlug: wf.workflowDynastySlug, dag: withCurrentLlmPlan(wf.dag) }, identity(wf.orgId));
      await new Promise((res) => setTimeout(res, 7000)); // createRateLimit: 10 per minute per org
      if (up.status === 200 || up.status === 201) {
        console.log(`upgraded ${wf.workflowSlug} -> ${up.body.workflow?.workflowSlug ?? up.body.workflowSlug ?? "(in place)"}`);
        report.upgraded.push(wf.workflowSlug);
      } else {
        console.log(`FAILED ${wf.workflowSlug}: ${up.status} ${JSON.stringify(up.body).slice(0, 400)}`);
        report.failed.push(wf.workflowSlug);
      }
    }
  }
  console.log(`\n${APPLY ? "upgraded" : "would upgrade"} ${report.upgraded.length}, already current ${report.current}, failed ${report.failed.length}`);
  if (report.failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
