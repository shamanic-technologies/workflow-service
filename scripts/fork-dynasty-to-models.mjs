#!/usr/bin/env node
/**
 * Ops script: fork ONE cold-email dynasty onto a named set of model aliases, so
 * the same template can be measured against several models at once.
 *
 * The model an email is generated with lives in the DAG, on the
 * content-generation `/generate` node (`config.body.model`); absent means the
 * chat-service default. A "same template, different model" variant is therefore
 * the same DAG with that one field rewritten — a changed signature on
 * `PUT /workflows/:id`, which is the FORK path. The source stays active and the
 * fork starts a new dynasty at version 1.
 *
 * Why this exists beside `fork-model-matrix.mjs`, which did the same thing in
 * bulk on 2026-08-16: that run hardcoded a snapshot of every dynasty's head id.
 * Heads move — every active cold-email dynasty gained a version the morning this
 * script was written, twice — so a stored id is stale by the time anyone reruns
 * it, and forking a stale id silently reproduces an OLD template. This one
 * resolves the head by DYNASTY SLUG at run time and forks whatever is currently
 * active, which is the only reading of "fork this template" that stays true.
 *
 * That same staleness is why the 2026-08-16 forks are not simply reactivated:
 * they snapshot an August DAG and predate the lead `$ref` repair (#400), the
 * recipient-context mapping (#402, #407), the timezone forward and the
 * `currentDate` fix. Rerunning them would benchmark a template nobody ships
 * against one we do, and read the difference as a model difference.
 *
 * Idempotent: a DAG that already exists as an active workflow collides on
 * signature and the route answers 409, recorded as "already covered". The dry
 * run and the real run walk the same code path.
 *
 * Usage (from inside the workflow-service container, which can reach its own
 * port and holds no psql):
 *
 *   node fork-dynasty-to-models.mjs --dynasty <slug> --org <uuid> --models a,b
 *   node fork-dynasty-to-models.mjs --dynasty <slug> --org <uuid> --models a,b --apply
 *
 * The org must be the one that owns the source workflow: a fork takes its org
 * from the CALLER's `x-org-id`, so the wrong value lands the variant under the
 * wrong scope. Note also `createRateLimit` (10 creations/min/org) — a set larger
 * than ten ends on 429s, and the right response is to rerun after the window,
 * not to retry in process.
 *
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080).
 */

import { randomUUID } from "node:crypto";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const APPLY = process.argv.includes("--apply");

const FEATURE_SLUG = "sales-cold-email-outreach";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const DYNASTY = arg("dynasty");
const ORG_ID = arg("org");
const MODELS = (arg("models") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

if (!API_KEY) {
  console.error("WORKFLOW_SERVICE_API_KEY is required");
  process.exit(1);
}
if (!DYNASTY || !ORG_ID || MODELS.length === 0) {
  console.error("usage: --dynasty <slug> --org <uuid> --models a,b [--apply]");
  process.exit(1);
}

function headers() {
  return {
    "content-type": "application/json",
    "x-api-key": API_KEY,
    "x-org-id": ORG_ID,
    "x-user-id": randomUUID(),
    "x-run-id": randomUUID(),
  };
}

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  return { status: res.status, payload };
}

/**
 * The content-generation call is the only node in these DAGs that posts to
 * `/generate`; that is where the model belongs. Locating it by path rather than
 * by node id keeps this working across DAGs, which do not agree on node naming.
 */
function findGenerateNode(dag) {
  return dag.nodes.find((n) => n.config?.path === "/generate" && n.config?.body?.type);
}

function withModel(dag, model) {
  const clone = structuredClone(dag);
  const node = findGenerateNode(clone);
  if (!node) throw new Error("no content-generation /generate node in DAG");
  node.config.body.model = model;
  return clone;
}

/** Resolve the dynasty's currently-active version. Exactly one exists, or none. */
async function resolveHead() {
  const listed = await call(
    "GET",
    `/public/workflows?featureSlugs=${FEATURE_SLUG}&status=active`,
  );
  if (listed.status !== 200) {
    throw new Error(`public list failed ${listed.status} ${JSON.stringify(listed.payload)}`);
  }
  const heads = (listed.payload.workflows ?? []).filter(
    (w) => w.workflowDynastySlug === DYNASTY,
  );
  if (heads.length === 0) {
    throw new Error(`no active version for dynasty "${DYNASTY}" — it is parked or retired`);
  }
  if (heads.length > 1) {
    throw new Error(`dynasty "${DYNASTY}" reports ${heads.length} active versions`);
  }
  return heads[0];
}

const head = await resolveHead();
const got = await call("GET", `/workflows/${head.id}`);
if (got.status !== 200) {
  throw new Error(`GET workflow ${head.id} failed ${got.status} ${JSON.stringify(got.payload)}`);
}

const dag = got.payload.dag;
const gen = findGenerateNode(dag);
const template = gen?.config?.body?.type;
const baseModel = gen?.config?.body?.model ?? "(chat-service default)";

const results = [];
for (const model of MODELS) {
  if (model === baseModel) {
    results.push({ model, outcome: "skipped — source already runs this model" });
    continue;
  }
  if (!APPLY) {
    results.push({ model, outcome: "would fork" });
    continue;
  }
  const put = await call("PUT", `/workflows/${head.id}`, { dag: withModel(dag, model) });
  if (put.status === 201) {
    results.push({ model, outcome: `created ${put.payload.workflowSlug}` });
  } else if (put.status === 409) {
    results.push({ model, outcome: `already covered by ${put.payload.existingWorkflowSlug}` });
  } else {
    results.push({ model, outcome: `FAILED ${put.status} ${JSON.stringify(put.payload)}` });
  }
}

console.log(APPLY ? "=== APPLY ===" : "=== DRY RUN (no writes) ===");
console.log(`source: ${head.workflowSlug} (v${head.version}, ${head.id})`);
console.log(`template: ${template} | base model: ${baseModel}`);
for (const r of results) console.log(`${r.model} | ${r.outcome}`);

const failed = results.filter((r) => String(r.outcome).includes("FAILED"));
console.log(`\n${results.length} operations, ${failed.length} failed`);
if (failed.length) process.exit(1);
