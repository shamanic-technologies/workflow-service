#!/usr/bin/env node
/**
 * One-time backfill: give every ACTIVE lead-service-backed email workflow the
 * whole recipient-context set content-generation accepts.
 *
 * content-generation publishes two lists on a prompt read: `variables` (the
 * tokens the stored body declares) and `contextVariables` (optional lead +
 * organization facts every template accepts and renders into a "Recipient
 * context" block). A caller that sends none of the second list gets the prompt
 * it always got — so the fleet has been writing email off five lead facts while
 * lead-service serves thirty-three of them.
 *
 * The list is read LIVE from content-generation; nothing here hardcodes it. The
 * PATH each name resolves to comes from src/lib/lead-context-variables.ts and is
 * accepted only when it RESOLVES against lead-service's live OpenAPI response
 * schema — a name the served shape cannot satisfy is reported and left unmapped,
 * because a `$ref` the fetch node never returns renders as an empty string with
 * no error and no log line. Variables a workflow already maps are never touched.
 *
 * Every affected workflow is upgraded IN ITS OWN DYNASTY (POST /workflows/upgrade
 * with a client-supplied DAG, no LLM round-trip), so the dynasty slug
 * campaign-service holds keeps resolving. Nothing is forked; no prompt type and
 * no model changes.
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
 * Idempotent: a head that already carries every mappable name is skipped, so a
 * run interrupted by the creation rate limit is simply re-run.
 *
 * Run it from INSIDE the workflow-service container — Cloudflare 403s a
 * scripted request to the public host, and the compiled planner lives in
 * /app/dist:
 *
 *   docker cp scripts/backfill-lead-context-variables.mjs distribute-workflow-service-1:/tmp/
 *   docker exec distribute-workflow-service-1 sh -c \
 *     'WORKFLOW_SERVICE_URL=http://127.0.0.1:8080 \
 *      WORKFLOW_SERVICE_API_KEY=$WORKFLOW_SERVICE_API_KEY \
 *      BACKFILL_USER_ID=<uuid> node /tmp/backfill-lead-context-variables.mjs' </dev/null
 *
 * Add --apply to write. CONTENT_GENERATION_SERVICE_URL / _API_KEY and
 * API_REGISTRY_SERVICE_URL / _API_KEY are read from the container's own
 * environment.
 */

import { randomUUID } from "node:crypto";

const DIST = process.env.WORKFLOW_DIST_DIR ?? "/app/dist";
const { applyLeadContextVariables } = await import(`${DIST}/lib/lead-context-variables.js`);
const { fetchSpecsForServices } = await import(`${DIST}/lib/api-registry-client.js`);
const { extractHttpEndpoints } = await import(`${DIST}/lib/extract-http-endpoints.js`);

const BASE = process.env.WORKFLOW_SERVICE_URL;
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const USER_ID = process.env.BACKFILL_USER_ID;
const CONTENT_URL = process.env.CONTENT_GENERATION_SERVICE_URL;
const CONTENT_KEY = process.env.CONTENT_GENERATION_SERVICE_API_KEY;

if (!BASE || !API_KEY || !USER_ID || !CONTENT_URL || !CONTENT_KEY) {
  console.error(
    "WORKFLOW_SERVICE_URL, WORKFLOW_SERVICE_API_KEY, BACKFILL_USER_ID, CONTENT_GENERATION_SERVICE_URL and CONTENT_GENERATION_SERVICE_API_KEY are required",
  );
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

/**
 * The accepted context-variable names, read from the producer rather than
 * stated here. Every prompt type publishes the same catalog; the union is taken
 * across the types the fleet's DAGs actually request, so a type that grows its
 * own name later is picked up without a code change.
 */
async function fetchContextVariables(types) {
  const names = new Set();
  for (const type of types) {
    const res = await fetch(
      `${CONTENT_URL}/platform-prompts?type=${encodeURIComponent(type)}`,
      { headers: { "x-api-key": CONTENT_KEY } },
    );
    if (!res.ok) {
      throw new Error(`GET /platform-prompts?type=${type} -> ${res.status} ${await res.text()}`);
    }
    const prompt = await res.json();
    if (!Array.isArray(prompt.contextVariables)) {
      throw new Error(
        `content-generation published no contextVariables for "${type}" — refusing to guess the accepted set.`,
      );
    }
    for (const v of prompt.contextVariables) names.add(v.name);
  }
  return [...names];
}

/** The prompt types a DAG's content-generation nodes request. */
function templateTypes(dag) {
  const types = [];
  for (const node of dag.nodes ?? []) {
    if (node.config?.service !== "content-generation" || node.config?.path !== "/generate") continue;
    const mapped = node.inputMapping?.["body.type"];
    if (typeof mapped === "string" && !mapped.startsWith("$ref:")) types.push(mapped);
    else if (typeof node.config?.body?.type === "string") types.push(node.config.body.type);
  }
  return types;
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

  // Only a dynasty HEAD is backfilled — the version each lineage would execute.
  // `status=all` rather than `status=active` because the public list's "active"
  // means executable on BOTH axes, which hides the head of a retired dynasty;
  // that head still gets the mappings, or un-retiring it later restores a
  // workflow writing email off five facts. Predecessors are never executed and
  // are left alone, as are lineages whose every version is deprecated.
  const queue = listed.workflows.filter((w) => w.status === "active");
  const rows = [];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        rows.push(await call("GET", `/workflows/${item.id}`, probeOrg));
      }
    }),
  );

  const types = [...new Set(rows.flatMap((r) => templateTypes(r.dag)))];
  const contextVariables = await fetchContextVariables(types);
  console.log(
    `content-generation publishes ${contextVariables.length} context variable(s) across ${types.length} prompt type(s)`,
  );

  const services = [...new Set(rows.flatMap((r) => extractHttpEndpoints(r.dag).map((e) => e.service)))];
  const specs = await fetchSpecsForServices(services);
  console.log(`Fetched ${specs.size}/${services.length} OpenAPI spec(s)`);
  if (!specs.has("lead")) {
    // Without the served shape there is nothing to judge a path against, and
    // guessing is the exact failure this backfill exists to avoid.
    console.error("lead-service spec unavailable — refusing to guess a path. Aborting.");
    process.exit(1);
  }

  const plan = [];
  const unmappable = new Map();
  for (const row of rows) {
    if (ONLY && row.workflowDynastySlug !== ONLY) continue;
    const { dag, plan: p, changed } = applyLeadContextVariables(row.dag, specs, contextVariables);
    for (const s of p.skipped) {
      const key = `${s.variable} (${s.reason}${s.tried ? `: ${s.tried}` : ""})`;
      unmappable.set(key, (unmappable.get(key) ?? 0) + 1);
    }
    if (!changed) continue;
    plan.push({ row, dag, additions: p.additions });
  }

  if (unmappable.size > 0) {
    console.log("\nNames the served lead shape cannot satisfy (reported, not mapped):");
    for (const [key, count] of [...unmappable].sort()) console.log(`  ! ${key} — ${count} node(s)`);
  }

  plan.sort((a, b) => a.row.workflowDynastySlug.localeCompare(b.row.workflowDynastySlug));

  console.log(
    `\n${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} active workflows read, ${plan.length} need mappings\n`,
  );
  for (const p of plan) {
    p.shape = p.row.workflowDynastyStatus === "deprecated" ? "retired" : "live";
    console.log(
      `  ${p.shape.padEnd(8)} ${p.row.workflowDynastySlug.padEnd(46)} v${p.row.version}  +${p.additions.length}`,
    );
    for (const a of p.additions) console.log(`             ${a.key} -> ${a.ref}`);
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
    console.log(
      `  ok ${String(done).padStart(2)}/${plan.length}  ${p.shape.padEnd(8)} ${created.workflowSlug} (v${created.version})`,
    );

    if (done < plan.length) await sleep(UPGRADE_SPACING_MS);
  }

  console.log(`\n${done} dynasties upgraded.\n`);
}

await main();
