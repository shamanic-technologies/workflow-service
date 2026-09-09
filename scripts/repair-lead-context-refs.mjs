#!/usr/bin/env node
/**
 * One-time repair: point every ACTIVE email workflow's lead `$ref`s at paths
 * lead-service actually serves.
 *
 * Seven LLM-authored workflows reference a FLAT lead shape that no longer
 * exists — `lead.data.organizationName`, `lead.data.organizationIndustry`,
 * `lead.data.title` and five siblings — while the served shape nests the
 * employer under `lead.data.organization` and names the job title
 * `lead.data.currentTitle`. A `$ref` to a missing path renders as an empty
 * string, raises nothing and logs nothing, so the prompt has been reading
 * `Company: ` on every run for months.
 *
 * Nothing here is templated. Each rewrite is derived from the workflow's OWN
 * mappings and accepted only when the repaired path RESOLVES against
 * lead-service's live OpenAPI response schema (see
 * src/lib/lead-context-mapping.ts) — a ref the fetch node never returns is
 * worse than the gap it replaces, so a leaf nothing resolves is reported and
 * left alone.
 *
 * Every affected workflow is upgraded IN ITS OWN DYNASTY (POST /workflows/upgrade
 * with a client-supplied DAG, no LLM round-trip), so the dynasty slug
 * campaign-service holds keeps resolving. Nothing is forked, no prompt type or
 * model changes.
 *
 * Two lifecycle shapes need two call sequences, because /workflows/upgrade
 * resolves a dynasty by its ACTIVE version and a retired lineage has none:
 *
 *   live     version active, dynasty active -> upgrade
 *   retired  dynasty deprecated             -> un-retire, upgrade, re-retire
 *
 * A parked lineage (dynasty active, every version deprecated) has no head to
 * repair and is out of scope — see the filter in main().
 *
 * Idempotent: a dynasty whose head already resolves every lead ref is skipped,
 * so a run interrupted by the creation rate limit is simply re-run.
 *
 * Run it from INSIDE the workflow-service container — Cloudflare 403s a
 * scripted request to the public host, and the compiled mapping lives in
 * /app/dist:
 *
 *   docker cp scripts/repair-lead-context-refs.mjs distribute-workflow-service-1:/tmp/
 *   docker exec distribute-workflow-service-1 sh -c \
 *     'WORKFLOW_SERVICE_URL=http://127.0.0.1:8080 \
 *      WORKFLOW_SERVICE_API_KEY=$WORKFLOW_SERVICE_API_KEY \
 *      REPAIR_USER_ID=<uuid> node /tmp/repair-lead-context-refs.mjs' </dev/null
 *
 * Add --apply to write. API_REGISTRY_SERVICE_URL / _API_KEY are read from the
 * container's own environment.
 */

import { randomUUID } from "node:crypto";

const DIST = process.env.WORKFLOW_DIST_DIR ?? "/app/dist";
const { applyLeadContextMapping } = await import(`${DIST}/lib/lead-context-mapping.js`);
const { fetchSpecsForServices } = await import(`${DIST}/lib/api-registry-client.js`);
const { extractHttpEndpoints } = await import(`${DIST}/lib/extract-http-endpoints.js`);

const BASE = process.env.WORKFLOW_SERVICE_URL;
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const USER_ID = process.env.REPAIR_USER_ID;

if (!BASE || !API_KEY || !USER_ID) {
  console.error("WORKFLOW_SERVICE_URL, WORKFLOW_SERVICE_API_KEY and REPAIR_USER_ID are required");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i === -1 ? null : process.argv[i + 1];
})();

/** Every feature whose workflows write email off a lead-service fetch. */
const FEATURE_SLUGS = [
  "sales-cold-email-outreach",
  "sales-crm-email-outreach",
  "vc-cold-email-outreach",
  "feedback-request-cold-email-outreach",
];

/**
 * POST /workflows/upgrade is rate limited to 10 creations per minute per org
 * (createRateLimit). Space the upgrades out rather than retrying a 429 in
 * process — a swallowed 429 would make a partially-applied run read as a clean
 * one. Anything that still fails is re-covered by re-running the script.
 */
const UPGRADE_SPACING_MS = 8_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers(orgId) {
  return {
    "content-type": "application/json",
    "x-api-key": API_KEY,
    "x-org-id": orgId,
    "x-user-id": USER_ID,
    "x-run-id": randomUUID(),
  };
}

async function call(method, path, orgId, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(orgId),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

async function main() {
  // The discovery org only has to satisfy requireIdentity — neither the public
  // list nor GET /workflows/:id is org-scoped. Writes use each row's OWN org, so
  // an upgraded version lands under the same org as the version it replaces.
  const probeOrg = randomUUID();

  const listed = await call(
    "GET",
    `/public/workflows?featureSlugs=${FEATURE_SLUGS.join(",")}&status=all`,
    probeOrg,
  );

  // Only a dynasty HEAD is repaired — the version each lineage would execute.
  // `status=all` rather than `status=active` because the public list's "active"
  // means executable on BOTH axes, which hides the head of a retired dynasty;
  // that head still has to be repaired, or un-retiring it later restores the
  // broken refs. Predecessors are never executed and are left alone, as are the
  // 367 lineages in this feature set whose every version is deprecated: a new
  // version for a lineage nobody runs is noise, not a repair.
  const queue = listed.workflows.filter((w) => w.status === "active");
  const rows = [];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        rows.push(await call("GET", `/workflows/${item.id}`, probeOrg));
      }
    }),
  );

  const services = [...new Set(rows.flatMap((r) => extractHttpEndpoints(r.dag).map((e) => e.service)))];
  const specs = await fetchSpecsForServices(services);
  console.log(`Fetched ${specs.size}/${services.length} OpenAPI spec(s)`);
  if (!specs.has("lead")) {
    // Without the served shape there is nothing to judge a rewrite against, and
    // guessing is the exact failure this repair exists to undo.
    console.error("lead-service spec unavailable — refusing to guess a path. Aborting.");
    process.exit(1);
  }

  const plan = [];
  for (const row of rows) {
    if (ONLY && row.workflowDynastySlug !== ONLY) continue;
    const { dag, plan: refs, changed } = applyLeadContextMapping(row.dag, specs);
    if (refs.unresolved.length > 0) {
      for (const u of refs.unresolved) {
        console.warn(
          `  ! ${row.workflowDynastySlug} ${u.nodeId} ${u.key} ${u.ref} — no candidate resolves (tried ${u.tried.join(", ")})`,
        );
      }
    }
    if (!changed) continue;
    plan.push({ row, dag, refs });
  }

  plan.sort((a, b) => a.row.workflowDynastySlug.localeCompare(b.row.workflowDynastySlug));

  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} active workflows read, ${plan.length} need repair\n`);
  for (const p of plan) {
    const dynastyRetired = p.row.workflowDynastyStatus === "deprecated";
    p.shape = dynastyRetired ? "retired" : "live";
    console.log(`  ${p.shape.padEnd(8)} ${p.row.workflowDynastySlug.padEnd(46)} v${p.row.version}  ${p.refs.rewrites.length} refs`);
    for (const r of p.refs.rewrites) {
      console.log(`             ${r.nodeId}.${r.key}\n               ${r.from}\n            -> ${r.to}`);
    }
  }

  if (!APPLY) {
    console.log(`\n${plan.length} would be upgraded. Re-run with --apply.\n`);
    return;
  }

  console.log("");
  let done = 0;
  for (const p of plan) {
    const org = p.row.orgId;
    const slug = p.row.workflowDynastySlug;

    if (p.shape === "retired") {
      await call("PUT", `/workflows/dynasty/${slug}/status`, org, { status: "active" });
    }

    const upgraded = await call("POST", "/workflows/upgrade", org, {
      workflowDynastySlug: slug,
      dag: p.dag,
    });
    const created = upgraded.workflow;

    if (p.shape === "retired") {
      await call("PUT", `/workflows/dynasty/${slug}/status`, org, { status: "deprecated" });
    }

    done += 1;
    console.log(`  ok ${String(done).padStart(2)}/${plan.length}  ${p.shape.padEnd(8)} ${created.workflowSlug} (v${created.version})`);

    if (done < plan.length) await sleep(UPGRADE_SPACING_MS);
  }

  console.log(`\n${done} dynasties upgraded.\n`);
}

await main();
