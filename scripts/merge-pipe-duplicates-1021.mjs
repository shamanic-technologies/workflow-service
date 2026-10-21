#!/usr/bin/env node
/**
 * TPL-DYNASTY-1021-WF (3) — merge every iso-pipe duplicate (same template dynasty + same writer model on the same
 * pipe) into its survivor through POST /workflows/dynasty/{slug}/merge (non-destructive, reversible: .../unmerge).
 * Survivor = the dynasty that sent the most emails (content-generation email_generations, 2026-10-21). The route
 * itself refuses anything across two pipes. Idempotent: an already-merged dynasty answers 409 already_merged.
 *
 * Usage (inside the workflow-service container):
 *   node scripts/merge-pipe-duplicates-1021.mjs [--only <absorbed>,<absorbed>] [--apply]
 * Env: WORKFLOW_SERVICE_API_KEY, MERGE_ORG_ID + UPGRADE_USER_ID + MERGE_RUN_ID (a REAL staff run of our own org: never a
 *      placeholder identity), WORKFLOW_SERVICE_LOCAL_URL
 */

const P = "sales-cold-email-outreach-";
export const MERGES = [
  // [absorbed, survivor, template dynasty, model]
  ["azalea", "mebsuta", "cold-reply-free-offer-blind", "pro"],
  ["sterrennacht", "alkarab", "cold-reply-free-offer-blind", "sonnet"],
  ["arcadia", "ballad", "cold-reply-observation-named", "pro"],
  ["baobab", "ballad", "cold-reply-observation-named", "pro"],
  ["muliphein", "rapeto", "cold-reply-observation-named", "sonnet"],
  ["marfik", "fuyue", "cold-reply-observation-named", "opus"],
  ["castula", "inquill", "cold-reply-observation-named", "haiku"],
  ["bronze-2", "lithium", "cold-reply-intro-offer-blind", "pro"],
  ["cirque", "lithium", "cold-reply-intro-offer-blind", "pro"],
  ["helm", "lithium", "cold-reply-intro-offer-blind", "pro"],
  ["chalawan", "caph", "cold-click-website-click-named", "haiku"],
  ["albaldah", "caph", "cold-click-website-click-named", "haiku"],
  ["kitalpha", "caph", "cold-click-website-click-named", "haiku"],
  ["hamal", "caph", "cold-click-website-click-named", "haiku"],
].map(([a, s, td, m]) => ({ absorbed: P + a, survivor: P + s, templateDynasty: td, model: m }));

const APPLY = process.argv.includes("--apply");
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i === -1 ? null : process.argv[i + 1].split(",");
})();
const WS = process.env.WORKFLOW_SERVICE_LOCAL_URL ?? "http://localhost:8080";
let failed = 0;
for (const m of MERGES) {
  if (ONLY && !ONLY.includes(m.absorbed)) continue;
  const reason = `Same template dynasty (${m.templateDynasty}) and same model (${m.model}) on the same pipe as ${m.survivor}: one workflow (owner 2026-10-21, TPL-DYNASTY-1021).`;
  if (!APPLY) {
    console.log(`would merge ${m.absorbed} into ${m.survivor}`);
    continue;
  }
  const res = await fetch(`${WS}/workflows/dynasty/${m.absorbed}/merge`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.WORKFLOW_SERVICE_API_KEY, "x-org-id": process.env.MERGE_ORG_ID, "x-user-id": process.env.UPGRADE_USER_ID, "x-run-id": process.env.MERGE_RUN_ID },
    body: JSON.stringify({ intoWorkflowDynastySlug: m.survivor, reason, decidedBy: "kevin@distribute.you" }),
  });
  const body = await res.text();
  if (res.status !== 201) failed++;
  console.log(`${m.absorbed} -> ${m.survivor}: ${res.status} ${body.slice(0, 300)}`);
}
if (failed) process.exitCode = 1;
