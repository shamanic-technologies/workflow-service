#!/usr/bin/env node
/**
 * One-time repair: offer-scope every ACTIVE workflow's brand extract-fields
 * and content-generation /generate requests.
 *
 * brand-service refuses a brand-scoped read with 409 SEVERAL_OFFERS once a
 * brand holds more than one offer ("a brand-scoped call has no single
 * answer"). The DAG steps that ask brand-service for brand data (and the
 * content-generation step, which makes its own brand-service read) send no
 * offer, so every run of every multi-offer brand dies at that step. The
 * campaign's offer id is reported by campaign-service `/start-run` (`offerId`
 * on its response), and the conversion now threads it into these two callee
 * shapes automatically (src/lib/dag-to-openflow.ts) — but the ~50 existing
 * active workflows are DB-resident DATA: their stored dag carries no
 * inputMapping for it and their deployed Windmill flow was converted before
 * the rule existed.
 *
 * For every node the conversion rule would inject into, this script writes
 * the mapping by hand: `inputMapping["body.offerId"] =
 * "$ref:<start-run>.output.offerId"` — the same reference, in the same
 * convention the DAG already uses to pull other start-run response fields —
 * and upgrades each affected workflow IN ITS OWN DYNASTY (POST
 * /workflows/upgrade with a client-supplied DAG, no LLM round-trip), which
 * re-converts and redeploys the Windmill flow in place. The dynasty slug
 * campaign-service holds keeps resolving; nothing is forked.
 *
 * Selection mirrors the conversion rule exactly (do not widen it here without
 * widening it there): an http.call node to
 *   - brand /orgs/brands/extract-fields, or
 *   - content-generation (or content_generation) /generate
 * that is a BFS DESCENDANT of the campaign /start-run node (never
 * start-run itself or anything upstream — `results.start_run` does not
 * resolve there) and does not ALREADY state `body.offerId` in its
 * inputMapping. A node whose own mapping already names the offer is left
 * byte-identical. A workflow with no start-run node gets nothing (a
 * non-campaign DAG has no offer to thread).
 *
 * Idempotent: a workflow whose every candidate node already carries the
 * mapping is skipped, so a run interrupted by the creation rate limit is
 * simply re-run.
 *
 * Run it from INSIDE the workflow-service container — Cloudflare 403s a
 * scripted request to the public host:
 *
 *   docker cp scripts/repair-offer-scope-extract-fields.mjs distribute-workflow-service-1:/tmp/
 *   docker exec distribute-workflow-service-1 sh -c \
 *     'WORKFLOW_SERVICE_URL=http://127.0.0.1:8080 \
 *      WORKFLOW_SERVICE_API_KEY=$WORKFLOW_SERVICE_API_KEY \
 *      REPAIR_USER_ID=<uuid> node /tmp/repair-offer-scope-extract-fields.mjs' </dev/null
 *
 * Add --apply to write. --only <dynastySlug> limits to one dynasty.
 */

import { randomUUID } from "node:crypto";

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

// --- Selection rules, mirroring src/lib/dag-to-openflow.ts ---

function isHttpCall(node) {
  return node?.type === "http.call";
}

function findCampaignStartRunNode(dag) {
  for (const node of dag.nodes ?? []) {
    if (!isHttpCall(node)) continue;
    const service = node.config?.service;
    const path = node.config?.path;
    if (
      (service === "campaign" || service === "campaign-service") &&
      typeof path === "string" &&
      /start[-_]?run/i.test(path)
    ) {
      return node;
    }
  }
  return null;
}

function descendantIds(dag, startNodeId) {
  const adj = new Map();
  for (const edge of dag.edges ?? []) {
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }
  const seen = new Set();
  const queue = [...(adj.get(startNodeId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adj.get(current) ?? []) queue.push(next);
  }
  return seen;
}

function isOfferScopedCallee(node) {
  if (!isHttpCall(node)) return false;
  const service = node.config?.service;
  const path = node.config?.path;
  const isBrandExtractFields =
    service === "brand" &&
    typeof path === "string" &&
    path.includes("/orgs/brands/extract-fields");
  const isContentGeneration =
    (service === "content-generation" || service === "content_generation") &&
    typeof path === "string" &&
    /\/generate$/.test(path);
  return isBrandExtractFields || isContentGeneration;
}

/** Returns { dag, changes: [{nodeId, ref}] } — changes empty when nothing to do. */
function planForDag(dag) {
  const startNode = findCampaignStartRunNode(dag);
  if (!startNode) return { dag, changes: [] };
  const descendants = descendantIds(dag, startNode.id);
  const ref = `$ref:${startNode.id}.output.offerId`;
  const changes = [];
  const next = {
    ...dag,
    nodes: (dag.nodes ?? []).map((node) => {
      if (
        !isOfferScopedCallee(node) ||
        !descendants.has(node.id) ||
        node.inputMapping?.["body.offerId"]
      ) {
        return node;
      }
      changes.push({ nodeId: node.id, ref });
      return {
        ...node,
        inputMapping: { ...(node.inputMapping ?? {}), "body.offerId": ref },
      };
    }),
  };
  return { dag: next, changes };
}

async function main() {
  // The discovery org only has to satisfy the header builder — GET /workflows
  // is not org-scoped when no orgId filter is sent. Writes use each row's OWN
  // org, so an upgraded version lands under the same org as the version it
  // replaces.
  const probeOrg = randomUUID();

  // status=all: repair heads of RETIRED dynasties too (un-retire, upgrade,
  // re-retire), so un-retiring later does not restore the unscoped step.
  const listed = await call("GET", "/workflows?status=all", probeOrg);
  const active = (listed.workflows ?? []).filter(
    (w) => w.status === "active" && w.workflowDynastyStatus === "active",
  );

  const rows = [];
  const queue = [...active];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        rows.push(await call("GET", `/workflows/${item.id}`, probeOrg));
      }
    }),
  );

  const plan = [];
  for (const row of rows) {
    if (ONLY && row.workflowDynastySlug !== ONLY) continue;
    const { dag, changes } = planForDag(row.dag ?? { nodes: [], edges: [] });
    if (changes.length === 0) continue;
    plan.push({ row, dag, changes });
  }

  plan.sort((a, b) => a.row.workflowDynastySlug.localeCompare(b.row.workflowDynastySlug));

  console.log(
    `\n${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} active workflows read, ${plan.length} need repair\n`,
  );
  for (const p of plan) {
    console.log(`  ${p.row.workflowDynastySlug.padEnd(46)} v${p.row.version}  ${p.changes.length} node(s)`);
    for (const c of p.changes) {
      console.log(`             ${c.nodeId}\n            -> ${c.ref}`);
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

    const upgraded = await call("POST", "/workflows/upgrade", org, {
      workflowDynastySlug: slug,
      dag: p.dag,
    });
    const created = upgraded.workflow;

    done += 1;
    console.log(`  ok ${String(done).padStart(2)}/${plan.length}  ${created.workflowSlug} (v${created.version})`);

    if (done < plan.length) await sleep(UPGRADE_SPACING_MS);
  }

  console.log(`\n${done} dynasties upgraded.\n`);
}

await main();
