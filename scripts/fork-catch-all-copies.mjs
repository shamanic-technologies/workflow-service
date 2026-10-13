#!/usr/bin/env node
/**
 * Ops script (CATCHALL-SERVE-OPTION-1013, step 3, owner 2026-10-13): "Valid + Catch-all" copies of the best cold
 * email workflows on the pipe `sales-cold-email-outreach|lead_found_to_conversation`.
 *
 * A copy is its source DAG with ONE change: every lead-serving node (`POST /orgs/buffer/next`) states
 * `acceptedEmails: "valid_and_catch_all"` in its static body (lead-service v0.83.58: absent = valid only), and its
 * description says so plainly, because features-service's Jev judges the "Catch-all" tactic on what the workflow
 * DOES (its DAG and description), never on its name. Each copy is a new dynasty (fork); no existing workflow moves.
 *
 * ORDER IS THE SAFETY (features-service `lib/plays.ts`: a version NOT judged yet is ALLOWED by "Valid only"):
 *   1. fork every source (the copy is on no leg: nothing can pick it);
 *   2. assign each copy to the leg as `deprecated` (judged, never selectable), then kick the judgment through
 *      `workflow-leg-assignments/register` (insert-if-absent: an existing row is left untouched);
 *   3. poll features-service until Jev judged every copy Catch-all = yes;
 *   4. ONLY THEN assign each copy `active`. A copy judged "no" (or never judged) stays deprecated and the run fails.
 * Idempotent: a copy that already exists (409 same signature) is reused; a re-run resumes at the first missing step.
 *
 * "Top N" = the active workflow heads ordered by features-service's own fleet rank on the pipe (`GET
 * /internal/catalogue/workflows/{dynasty}?pipe=`, `rank`), keeping those active and selectable on it, skipping any
 * source whose content call runs a banned model (`BANNED_MODELS`) and any source that is already a copy.
 *
 * Usage (inside the workflow-service container; fetch only, no dependency):
 *   node fork-catch-all-copies.mjs --org <uuid> [--count 10] [--apply]
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const FEATURE_SLUG = "sales-cold-email-outreach";
export const LEG_KEY = "lead_found_to_conversation";
export const PIPE_ID = `${FEATURE_SLUG}|${LEG_KEY}`;
export const TACTIC_ID = "catch-all";
export const DECIDED_BY = "kevin";
export const ACCEPTED_EMAILS = "valid_and_catch_all";
export const SERVE_PATHS = ["/orgs/buffer/next", "/buffer/next"];
/** Owner rule: nothing goes to Haiku 4.5 (the bare `haiku` alias resolves to it). Haiku 5.5 is allowed. */
export const BANNED_MODELS = ["haiku", "claude-haiku-4-5"];
export const COPY_MARKER = "Valid + Catch-all copy.";
export const LEG_NOTE =
  "Owner decision 2026-10-13 (CATCHALL-SERVE-OPTION-1013): Valid + Catch-all copy of a top cold email workflow; active only once Jev judged it Catch-all.";

const isServeNode = (n) => n?.type === "http.call" && SERVE_PATHS.includes(n.config?.path);

/** PURE: the source DAG with every lead-serving node asking for valid AND catch-all addresses. Throws if none. */
export function withCatchAll(dag) {
  const clone = structuredClone(dag);
  const nodes = clone.nodes.filter(isServeNode);
  if (nodes.length === 0) throw new Error("no lead-serving node (POST /orgs/buffer/next) in DAG");
  for (const n of nodes) {
    if (n.inputMapping && Object.keys(n.inputMapping).some((k) => k === "body" || k === "body.acceptedEmails")) {
      throw new Error(`serving node ${n.id} already maps its body or acceptedEmails; refusing to override`);
    }
    n.config.body = { ...(n.config.body ?? {}), acceptedEmails: ACCEPTED_EMAILS };
  }
  return clone;
}

/** PURE: the copy's description: the source's own, then what the copy does differently, in plain words. */
export function copyDescription(sourceDescription) {
  const base = (sourceDescription ?? "").trim();
  const sentence =
    `${COPY_MARKER} Identical to the original except that it sends to confirmed addresses AND to catch-all addresses ` +
    "(mail servers that accept every address, so the mailbox cannot be confirmed): its lead-serving step asks for valid and catch-all emails.";
  return base === "" ? sentence : `${base} ${sentence}`;
}

export const isCopy = (description) => typeof description === "string" && description.includes(COPY_MARKER);

/** PURE: the content-call model of a DAG (absent = chat-service default), or null when it has no content call; `modelOf` answers undefined for a source with no loaded head. */
export function contentModel(dag) {
  const n = dag.nodes.find((x) => x.config?.path === "/generate" && x.config?.body?.type);
  return n ? (n.config.body.model ?? "pro") : null;
}

/** PURE: the first `count` rows (already in rank order) that are active and selectable, not copies, not on a banned model. */
export function pickSources(rows, count, modelOf, isCopyOf) {
  const out = [];
  const skipped = [];
  for (const r of rows) {
    if (out.length >= count) break;
    if (r.assignment !== "active" || r.selectable !== true) { skipped.push([r.id, "not active and selectable on the pipe"]); continue; }
    if (isCopyOf(r.id)) { skipped.push([r.id, "already a copy"]); continue; }
    const m = modelOf(r.id);
    if (m !== null && BANNED_MODELS.includes(m)) { skipped.push([r.id, `banned model ${m}`]); continue; }
    out.push(r.id);
  }
  return { picked: out, skipped };
}

/** PURE: every tactic verdict on the copies' CURRENT versions says yes; returns the dynasties not yet judged / judged no. */
export function judgmentState(verdicts, dynasties) {
  const pending = [];
  const no = [];
  for (const d of dynasties) {
    const vs = verdicts.filter((v) => v.workflowDynastySlug === d);
    const cur = vs.find((v) => v.versionActive) ?? vs.sort((a, b) => b.version - a.version)[0];
    if (!cur) pending.push(d);
    else if (!cur.follows) no.push(d);
  }
  return { pending, no };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

export async function run() {
  const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
  const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
  const FS_URL = process.env.FEATURES_SERVICE_URL;
  const FS_KEY = process.env.FEATURES_SERVICE_API_KEY;
  const APPLY = process.argv.includes("--apply");
  const ORG_ID = arg("org");
  const COUNT = Number(arg("count") ?? "10");
  if (!API_KEY || !FS_URL || !FS_KEY || !ORG_ID || !Number.isInteger(COUNT) || COUNT < 1) {
    console.error("WORKFLOW_SERVICE_API_KEY, FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY and --org <uuid> are required");
    process.exit(1);
  }
  async function request(url, method, headers, body) {
    const res = await fetch(url, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let payload = null;
    try { payload = await res.json(); } catch { payload = null; }
    return { status: res.status, payload };
  }
  const wf = (method, path, body) =>
    request(`${BASE_URL}${path}`, method, { "x-api-key": API_KEY, "x-org-id": ORG_ID, "x-user-id": randomUUID(), "x-run-id": randomUUID() }, body);
  const fs = (method, path, body) => request(`${FS_URL}${path}`, method, { "x-api-key": FS_KEY }, body);
  const must = (r, what, ok = [200, 201]) => {
    if (!ok.includes(r.status)) throw new Error(`${what} failed ${r.status} ${JSON.stringify(r.payload)}`);
    return r.payload;
  };

  console.log(APPLY ? "=== APPLY ===" : "=== DRY RUN (no writes) ===");

  // The active heads, each read at its fleet rank on the pipe (the detail route serves the rank of EVERY dynasty;
  // the list route is capped at 25 rows). A head the pipe does not know (404) is not on it.
  const listed = must(await wf("GET", `/public/workflows?featureSlugs=${FEATURE_SLUG}&status=active`), "public list");
  const heads = new Map();
  for (const w of listed.workflows ?? []) heads.set(w.workflowDynastySlug, w);
  const dags = new Map();
  for (const d of heads.keys()) {
    dags.set(d, must(await wf("GET", `/workflows/${heads.get(d).id}`), `GET ${heads.get(d).id}`));
  }
  const copyDynasties = new Set([...dags].filter(([, w]) => isCopy(w.description)).map(([d]) => d));
  const ranked = [];
  for (const d of heads.keys()) {
    const r = await fs("GET", `/internal/catalogue/workflows/${encodeURIComponent(d)}?pipe=${encodeURIComponent(PIPE_ID)}`);
    if (r.status === 404) continue;
    const j = must(r, `rank of ${d}`);
    ranked.push({ id: d, rank: j.rank, assignment: j.assignment, selectable: j.selectable, roi: j.roi ?? null });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  const { picked, skipped } = pickSources(ranked, COUNT, (id) => contentModel(dags.get(id).dag), (id) => copyDynasties.has(id));
  for (const [id, why] of skipped) console.log(`skipped ${id}: ${why}`);
  if (picked.length < COUNT) throw new Error(`only ${picked.length} eligible sources of ${COUNT}`);
  for (const id of picked) console.log(`source ${id} (${dags.get(id).workflowSlug}), rank ${ranked.find((r) => r.id === id).rank}, model ${contentModel(dags.get(id).dag)}`);
  const plan = picked.map((id) => ({ id, dag: withCatchAll(dags.get(id).dag), description: copyDescription(dags.get(id).description) }));
  if (!APPLY) {
    console.log(`would fork ${plan.length} copies, assign them deprecated, wait for Jev (${TACTIC_ID} = yes), then activate`);
    return;
  }

  // 1. Fork.
  const forks = [];
  for (const p of plan) {
    const src = dags.get(p.id);
    const put = await wf("PUT", `/workflows/${src.id}`, { dag: p.dag, description: p.description });
    let forkId;
    if (put.status === 201) forkId = put.payload.id;
    else if (put.status === 409 && put.payload?.existingWorkflowId) forkId = put.payload.existingWorkflowId;
    else throw new Error(`fork of ${p.id} failed ${put.status} ${JSON.stringify(put.payload)}`);
    const fork = must(await wf("GET", `/workflows/${forkId}`), `GET fork ${forkId}`);
    if (!JSON.stringify(fork.dag).includes(ACCEPTED_EMAILS)) throw new Error(`fork ${fork.workflowSlug} does not state ${ACCEPTED_EMAILS}`);
    console.log(`copy of ${p.id}: ${fork.workflowSlug} (dynasty ${fork.workflowDynastySlug}, id ${forkId}) ${put.status === 201 ? "created" : "already existed"}`);
    forks.push({ source: p.id, dynasty: fork.workflowDynastySlug, slug: fork.workflowSlug, id: forkId });
  }

  // 2. Assigned but NOT selectable, then kick the judgment.
  const legQuery = `/internal/workflow-leg-assignments?featureSlug=${FEATURE_SLUG}&legKey=${LEG_KEY}`;
  const before = must(await fs("GET", legQuery), "leg read").assignments;
  for (const f of forks) {
    const cur = before.find((a) => a.workflowDynastySlug === f.dynasty);
    if (!cur) {
      must(await fs("PUT", "/internal/workflow-leg-assignments", { featureSlug: FEATURE_SLUG, legKey: LEG_KEY, workflowDynastySlug: f.dynasty, state: "deprecated", decidedBy: DECIDED_BY, note: `${LEG_NOTE} (held until judged)` }), `assign ${f.dynasty} deprecated`);
    }
    must(await fs("POST", "/internal/workflow-leg-assignments/register", { pipeId: PIPE_ID, workflowDynastySlug: f.dynasty, registeredBy: DECIDED_BY }), `register ${f.dynasty}`, [200, 201]);
  }

  // 3. Wait for Jev: every copy judged Catch-all.
  const dynasties = forks.map((f) => f.dynasty);
  let state;
  for (let i = 0; i < 60; i++) {
    const t = must(await fs("GET", `/internal/catalogue/tactics/${TACTIC_ID}`), "tactic read");
    state = judgmentState(t.verdicts ?? [], dynasties);
    if (state.pending.length === 0) break;
    console.log(`waiting for Jev: ${state.pending.length} copies not judged yet`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
  if (state.pending.length > 0) throw new Error(`not judged after 30 min: ${state.pending.join(", ")} (left deprecated)`);
  if (state.no.length > 0) throw new Error(`Jev judged these copies NOT catch-all: ${state.no.join(", ")} (left deprecated)`);

  // 4. Active.
  for (const f of forks) {
    const cur = before.find((a) => a.workflowDynastySlug === f.dynasty);
    if (cur?.state === "active") { console.log(`${f.dynasty}: already active`); continue; }
    must(await fs("PUT", "/internal/workflow-leg-assignments", { featureSlug: FEATURE_SLUG, legKey: LEG_KEY, workflowDynastySlug: f.dynasty, state: "active", decidedBy: DECIDED_BY, note: LEG_NOTE }), `activate ${f.dynasty}`);
    console.log(`${f.dynasty}: active on ${LEG_KEY}`);
  }
  const after = must(await fs("GET", legQuery), "leg re-read").assignments;
  const moved = before.filter((b) => !dynasties.includes(b.workflowDynastySlug)).filter((b) => JSON.stringify(after.find((a) => a.workflowDynastySlug === b.workflowDynastySlug)) !== JSON.stringify(b));
  if (moved.length > 0) throw new Error(`other assignments moved: ${moved.map((m) => m.workflowDynastySlug).join(", ")}`);
  console.log(JSON.stringify(forks, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
