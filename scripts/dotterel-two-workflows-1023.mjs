#!/usr/bin/env node
/**
 * Ops script (DOTTEREL-TWO-WORKFLOWS-1023, owner 2026-10-23): the Cold Email "Lead found -> Positive reply" pipe runs
 * TWO workflows, Ballad and Keel (src/lib/dotterel-two-workflows.ts).
 *
 * 1. UPGRADE Ballad then Keel in their own dynasty (`POST /workflows/upgrade`, never a fork) with the full writer
 *    brief and a plain description, under each row's OWN org. A head already carrying the brief is skipped.
 * 2. Only once Ballad's new version is the active one: MERGE each of the six drifted copies into Ballad
 *    (`POST /workflows/dynasty/{slug}/merge`: both axes deprecated, Ballad named as successor, a held slug forwards
 *    to Ballad, history untouched, reversible with .../unmerge). An already-merged one answers 409 already_merged.
 * Prints the generate-input diff between the two new heads (must be Keel's website link only).
 *
 * Usage, from inside the workflow-service container (after `npm run build`, reads ../dist):
 *   node dotterel-two-workflows-1023.mjs            # dry run
 *   node dotterel-two-workflows-1023.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080), USER_ID + RUN_ID (a REAL staff run).
 */
import {
  DOTTEREL_ABSORBED,
  DOTTEREL_DESCRIPTIONS,
  DOTTEREL_KEPT,
  DOTTEREL_MERGE_REASON,
  DOTTEREL_SURVIVOR,
  FULL_BRIEF_MAPPINGS,
  generateInputDiff,
  withFullWriterBrief,
} from "../dist/lib/dotterel-two-workflows.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const USER_ID = process.env.USER_ID;
const RUN_ID = process.env.RUN_ID;
const STAFF_ORG = process.env.ORG_ID ?? "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const DECIDED_BY = "kevin@distribute.you (owner 2026-10-23, DOTTEREL-TWO-WORKFLOWS-1023)";
const APPLY = process.argv.includes("--apply");

if (!API_KEY || !USER_ID || !RUN_ID) {
  console.error("WORKFLOW_SERVICE_API_KEY, USER_ID and RUN_ID are required");
  process.exit(1);
}

async function call(method, path, orgId, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "x-org-id": orgId, "x-user-id": USER_ID, "x-run-id": RUN_ID },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: res.status, payload };
}

async function activeHead(dynastySlug) {
  const listed = await call("GET", `/workflows?featureSlug=sales-cold-email-outreach&status=active`, STAFF_ORG);
  if (listed.status !== 200) throw new Error(`list: ${listed.status} ${JSON.stringify(listed.payload)}`);
  const rows = Array.isArray(listed.payload) ? listed.payload : (listed.payload.workflows ?? []);
  const head = rows.find((w) => w.workflowDynastySlug === dynastySlug);
  if (!head) return null;
  const full = await call("GET", `/workflows/${head.id}`, head.orgId);
  if (full.status !== 200) throw new Error(`read ${head.id}: ${full.status}`);
  return full.payload;
}

const carriesBrief = (dag) => {
  const gen = dag.nodes.find((n) => n.config?.path === "/generate");
  return Object.entries(FULL_BRIEF_MAPPINGS).every(([k, v]) => gen?.inputMapping?.[k] === v);
};

console.log(APPLY ? "=== APPLY ===" : "=== DRY RUN (no writes) ===");
const heads = {};
for (const slug of DOTTEREL_KEPT) {
  const head = await activeHead(slug);
  if (!head) throw new Error(`${slug} has no active version: refusing to go on`);
  if (carriesBrief(head.dag) && head.description === DOTTEREL_DESCRIPTIONS[slug]) {
    console.log(`${slug}: ${head.workflowSlug} already carries the full brief`);
    heads[slug] = head;
    continue;
  }
  const dag = withFullWriterBrief(head.dag);
  if (!APPLY) {
    console.log(`${slug}: WOULD upgrade ${head.workflowSlug} v${head.version}`);
    heads[slug] = { ...head, dag };
    continue;
  }
  const up = await call("POST", "/workflows/upgrade", head.orgId, { workflowDynastySlug: slug, dag, description: DOTTEREL_DESCRIPTIONS[slug] });
  if (up.status !== 200 && up.status !== 201) throw new Error(`${slug}: upgrade FAILED ${up.status} ${JSON.stringify(up.payload)}`);
  const nw = up.payload.workflow ?? up.payload;
  console.log(`${slug}: upgraded ${head.workflowSlug} -> ${nw.workflowSlug} v${nw.version} (${up.status})`);
  heads[slug] = await activeHead(slug);
}

const [b, k] = DOTTEREL_KEPT.map((s) => heads[s]);
console.log(`generate-input diff ${b.workflowSlug} -> ${k.workflowSlug}:`);
for (const line of generateInputDiff(b.dag, k.dag)) console.log(`  ${line}`);

if (APPLY && !carriesBrief(heads[DOTTEREL_SURVIVOR].dag)) throw new Error("Ballad's new version is not live: nothing merged");
let failures = 0;
for (const slug of DOTTEREL_ABSORBED) {
  if (!APPLY) {
    console.log(`WOULD merge ${slug} into ${DOTTEREL_SURVIVOR}`);
    continue;
  }
  const m = await call("POST", `/workflows/dynasty/${slug}/merge`, STAFF_ORG, {
    intoWorkflowDynastySlug: DOTTEREL_SURVIVOR,
    reason: DOTTEREL_MERGE_REASON,
    decidedBy: DECIDED_BY,
  });
  if (m.status === 409 && m.payload?.code === "already_merged") {
    console.log(`${slug}: already merged (${m.payload.error})`);
  } else if (m.status !== 201) {
    failures++;
    console.error(`${slug}: merge FAILED ${m.status} ${JSON.stringify(m.payload)}`);
  } else {
    console.log(`${slug}: merged into ${DOTTEREL_SURVIVOR} (${m.payload.deprecatedVersions} version(s) deprecated)`);
  }
}
if (failures > 0) process.exit(1);
